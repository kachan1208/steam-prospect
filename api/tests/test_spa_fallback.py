"""api/app/main.py's SPA catch-all (`spa_fallback`) — the hosted-mode route that serves
web/dist from the API's own origin, and the path-traversal hole that route once had.

WHY THIS FILE EXISTS
--------------------
The catch-all is registered LAST, matches `/{full_path:path}` (i.e. literally everything),
and hands the matched string to `_STATIC_DIR / full_path`. That combination had two teeth:

1. TRAVERSAL. uvicorn percent-decodes the request path BEFORE routing, so `GET
   /%2e%2e/secret.txt` reaches the handler as `full_path == "../secret.txt"` and the naive
   join resolved to a file one directory ABOVE the static root — in the container that is
   /app, i.e. the source tree, the mounted data dir and anything else readable by the
   process. `_STATIC_DIR / full_path` also silently DISCARDS the static root when
   `full_path` is absolute (`Path("/app/web/dist") / "/etc/passwd" == Path("/etc/passwd")`)
   — a vector with no ".." in it at all. main.py now rejects any ".." segment AND, defence
   in depth, only serves a file whose `.resolve()` is still inside `_STATIC_DIR.resolve()`.
2. SHADOWING. Being registered last is what keeps /api/*, /docs, /openapi.json and /metrics
   reachable — but /mcp is mounted CONDITIONALLY (settings.enable_mcp, off in this suite),
   so with the mount absent the catch-all would happily answer /mcp with index.html and a
   hosted user's MCP client would parse HTML as a JSON-RPC stream. main.py carries an
   explicit prefix guard for exactly that; these tests pin it.

The whole suite runs in hosted/SPA mode because conftest.py points PROSPECT_STATIC_DIR at a
scratch dir holding index.html + one real asset, with the traversal target (SPA_SECRET_FILE)
deliberately placed one level UP, OUTSIDE the static root. Every constant asserted here comes
from conftest so the tests check the exact bytes that were seeded.

THE INVARIANT, stated once: no request may ever put SPA_SECRET_CONTENT in a response body.
Some attack spellings below are normalised away by httpx/the ASGI router before main.py ever
sees them — those are kept anyway (an attacker uses a raw socket, not httpx, and today's
"harmless" spelling is one library upgrade away from arriving intact), but they are called
out per-case so nobody reads a green test as proof of a defence that never fired.
"""
from __future__ import annotations

import pytest

from app import main as app_main
from conftest import (
    INDEX_HTML_CONTENT,
    SPA_INDEX_FILE,
    SPA_SECRET_CONTENT,
    SPA_SECRET_FILE,
    STATIC_DIR,
    STATIC_FILE_CONTENT,
    STATIC_FILE_NAME,
)


# ---- canary ------------------------------------------------------------------------------

def test_the_suite_actually_runs_in_spa_mode():
    """Everything below is vacuous if the app booted WITHOUT the SPA routes.

    `_SERVE_SPA` is computed at import time from settings.static_dir + the existence of
    index.html on disk. If conftest's env/file setup ever drifts (wrong env var name, files
    written after `app.main` is imported, index.html renamed), the catch-all is simply never
    registered — every unknown path 404s and every traversal test in this file goes green
    while defending nothing. Fail loudly here instead."""
    assert app_main._SERVE_SPA is True, (
        "the app did not boot in SPA mode — conftest's PROSPECT_STATIC_DIR / index.html "
        "setup must run BEFORE `from app.main import app`; every test in this file is "
        "meaningless until it does"
    )
    assert SPA_INDEX_FILE.is_file(), "conftest's fixture index.html is missing"
    assert SPA_SECRET_FILE.is_file(), "conftest's traversal target is missing"
    # The premise of the whole file: the secret sits OUTSIDE the served root. If it ever
    # moved inside, serving it would be correct behaviour and the tests would be nonsense.
    assert SPA_SECRET_FILE.parent != STATIC_DIR, (
        "SPA_SECRET_FILE must live OUTSIDE the static dir — it is the traversal target"
    )


# ---- normal SPA serving ------------------------------------------------------------------

def test_real_static_asset_is_served_with_its_own_content(client):
    """A file that genuinely exists under the static root must be served AS ITSELF.

    Regression shape: the traversal fix is a set of rejections, and it is easy to make it
    one notch too strict (resolving through the macOS /var -> /private/var symlink, for
    instance, makes a correct `is_relative_to` comparison look like an escape). If that
    happened, every hashed Vite asset would silently become index.html — the app would load
    a blank page in production while the API stayed green, because HTML-instead-of-JS still
    returns 200."""
    r = client.get(f"/{STATIC_FILE_NAME}")
    assert r.status_code == 200, f"real static asset not served: {r.status_code}"
    assert r.text == STATIC_FILE_CONTENT, (
        f"/{STATIC_FILE_NAME} did not return the seeded file contents — got {r.text[:80]!r}; "
        "if this is index.html the resolve()/is_relative_to check is rejecting legitimate "
        "files (e.g. it is comparing an unresolved root against a resolved candidate)"
    )


@pytest.mark.parametrize("route", ["/niches", "/devlog", "/games/1001", "/a/deep/client/route"])
def test_unknown_non_api_path_falls_back_to_index_html(client, route):
    """Client-side routes must survive a HARD REFRESH.

    The SPA owns /niches, /devlog, … in the browser's History API; the server has never
    heard of them. If this fallback regressed to a 404, every in-app link would still work
    but reloading the page (or opening a shared URL) would show a bare JSON 404 — the
    classic "works until you press F5" hosted-SPA bug."""
    r = client.get(route)
    assert r.status_code == 200, f"{route} should fall back to index.html, got {r.status_code}"
    assert r.text == INDEX_HTML_CONTENT, (
        f"{route} did not return index.html — client-side routing will not survive a refresh"
    )


def test_root_serves_index_in_spa_mode(client):
    """`/` has its own route (`root()`), separate from the catch-all, that flips between
    index.html and the dev JSON pointer on `_SERVE_SPA`. In hosted mode it must be the app,
    not the {"name": …, "docs": …} discovery blob."""
    r = client.get("/")
    assert r.status_code == 200
    assert r.text == INDEX_HTML_CONTENT, (
        "root path served the dev JSON pointer while in SPA mode — hosted users would get "
        "an API description instead of the frontend"
    )


# ---- path traversal (the security case) --------------------------------------------------

# Attack spellings, paired with what they actually look like by the time main.py sees them.
# Verified against this exact client/router stack — see the comment on each.
_TRAVERSAL_PATHS = [
    # Reaches spa_fallback as full_path="../secret.txt". httpx leaves %2e alone on the wire,
    # and the ASGI layer percent-decodes before routing — exactly like uvicorn in prod. This
    # is the live vector the fix was written for.
    "/%2e%2e/secret.txt",
    # Same, with the separator encoded too (%2f -> "/"). uvicorn decodes %2f as well, so the
    # separator being encoded buys the attacker nothing.
    "/%2e%2e%2fsecret.txt",
    # Literal dots, encoded separator — the usual WAF-evasion spelling.
    "/..%2fsecret.txt",
    # Double-encoded. Under this TestClient stack it happens to be decoded twice and lands as
    # "../secret.txt"; under real uvicorn it arrives as the literal "%2e%2e/secret.txt" and is
    # harmless. Kept because which of the two you get depends on the proxy chain in front of
    # the app, and Caddy is free to change its mind on an upgrade.
    "/%252e%252e/secret.txt",
    # NORMALISED BY THE CLIENT: httpx collapses "/../" before sending, so the app is asked
    # for "/secret.txt" and answers index.html. It defends nothing here — a raw socket would
    # deliver it intact — but it costs nothing and documents the plain spelling.
    "/../secret.txt",
    # Same normalisation, nested and clamped at the root by httpx -> "/secret.txt".
    "/assets/../../secret.txt",
    # Windows-flavoured separator. POSIX treats "\" as an ordinary filename character, so
    # this lands as a request for a file literally named "..\secret.txt" inside the static
    # dir and misses the ".."-segment check entirely; the resolve()/is_relative_to check is
    # what would stop it on a platform where "\" separates.
    "/..%5csecret.txt",
    "/%2e%2e%5csecret.txt",
]


@pytest.mark.parametrize("path", _TRAVERSAL_PATHS)
def test_traversal_attempt_never_serves_the_secret(client, path):
    """THE invariant: no spelling of "go up one directory" may return the secret.

    Asserted on the BODY rather than the status code, because the interesting failure is
    not "wrong status" — it is 200-with-somebody-else's-file. Without main.py's guard the
    encoded variants above return 200 and this body IS SPA_SECRET_CONTENT."""
    r = client.get(path)
    assert SPA_SECRET_CONTENT not in r.text, (
        f"PATH TRAVERSAL: {path!r} leaked a file from OUTSIDE the static dir "
        f"({SPA_SECRET_FILE}) — status {r.status_code}. In production this reads any file "
        "the API process can open, starting with the sibling data/ mount."
    )
    # Only two outcomes are acceptable: rejected outright, or handed the SPA shell (the
    # request simply looks like an unknown client-side route). A 200 carrying anything else
    # means some file got served, which for a path containing ".." is never right.
    assert r.status_code in (200, 404), f"unexpected status {r.status_code} for {path!r}"
    if r.status_code == 200:
        assert r.text == INDEX_HTML_CONTENT, (
            f"{path!r} returned 200 with a body that is neither index.html nor a rejection: "
            f"{r.text[:120]!r} — some file was served for a traversal path"
        )


@pytest.mark.parametrize(
    "path",
    [
        "/%2e%2e/secret.txt",
        "/%2e%2e%2fsecret.txt",
        "/..%2fsecret.txt",
    ],
)
def test_dotdot_segment_is_rejected_outright(client, path):
    """The three spellings above are the ones that genuinely arrive at spa_fallback with a
    ".." SEGMENT in full_path, so they must hit the first line of the fix
    (`if ".." in full_path.split("/")`) and 404 — not fall through to index.html.

    This is the sharpest single assertion in the file: delete that two-line check from
    main.py and each of these turns into 200 + the secret. Distinguishing 404 from the
    index fallback matters because a "generous" rewrite (silently serving index.html for
    anything suspicious) would still pass the leak assertion above while quietly removing
    the explicit rejection that makes the attack visible in the access log."""
    r = client.get(path)
    assert r.status_code == 404, (
        f"{path!r} decodes to a '..' segment and must be rejected with 404, got "
        f"{r.status_code} — the '..'-segment check in main.py's spa_fallback is not firing"
    )
    assert SPA_SECRET_CONTENT not in r.text


def test_absolute_path_request_is_stopped_by_the_resolve_check(client):
    """An ABSOLUTE path contains no "..", so the segment check never fires — this one is
    stopped by `is_relative_to` alone.

    `Path("/app/web/dist") / "/var/tmp/secret.txt"` is `/var/tmp/secret.txt`: pathlib's "/"
    operator throws the left-hand side away when the right side is absolute. So `GET
    //var/tmp/secret.txt` (a doubled leading slash survives as a path, it is not a
    protocol-relative URL once the host is explicit) hands spa_fallback an absolute
    full_path that `is_file()` happily confirms. Remove the `.resolve().is_relative_to(...)`
    clause and this request returns the secret with a 200 — the ".."-rejection above does
    not cover it."""
    # Absolute URL on purpose: a bare "//var/..." would be parsed by httpx as
    # protocol-relative and the leading segment would become the HOSTNAME.
    r = client.get("http://testserver/" + str(SPA_SECRET_FILE))
    assert SPA_SECRET_CONTENT not in r.text, (
        "PATH TRAVERSAL: an absolute-path request escaped the static dir — pathlib's '/' "
        "join discards the static root for absolute operands, so only the "
        "resolve()/is_relative_to check can stop this"
    )
    assert r.status_code == 200 and r.text == INDEX_HTML_CONTENT


def test_symlink_inside_the_static_dir_is_not_followed_out(client):
    """Defence in depth against a symlink planted (or built) inside web/dist.

    `candidate.is_file()` FOLLOWS symlinks, so a link living legitimately inside the static
    root whose target is outside it passes every string-level check — there is no ".." and
    no absolute path in the request. Only comparing the RESOLVED candidate against the
    RESOLVED root catches it. Realistic because web/dist is generated by a third-party
    toolchain and Docker build contexts are routinely assembled with `cp -a`."""
    link = STATIC_DIR / "escape-link.txt"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(SPA_SECRET_FILE)
    try:
        r = client.get("/escape-link.txt")
        assert SPA_SECRET_CONTENT not in r.text, (
            "PATH TRAVERSAL: a symlink inside the static dir was followed out of it — the "
            "resolve()/is_relative_to check is missing or is comparing unresolved paths"
        )
        assert r.status_code == 200 and r.text == INDEX_HTML_CONTENT, (
            "a symlink escaping the static dir must fall through to index.html"
        )
    finally:
        # STATIC_DIR is shared by the whole session (conftest builds it once at module
        # import), so this must not leak into any other test.
        link.unlink()


# ---- the catch-all must not swallow the API surface --------------------------------------
#
# spa_fallback matches "/{full_path:path}" and is registered LAST. Ordering alone covers
# routes that exist; the explicit prefix guard in main.py covers the ones that DON'T (an
# unknown /api/* path, and /mcp when the MCP mount is disabled). Without the guard those
# become "200 text/html" and every API client downstream starts trying to parse index.html.

def test_unknown_api_path_still_behaves_like_an_api_route(client):
    """A typo'd or removed endpoint must 404 as JSON, not hand back the SPA shell.

    Without the `full_path.startswith(("api", …))` guard this returns 200 + index.html, and
    web/src/lib/api.ts's fetch wrapper would report "unexpected token '<'" instead of a
    clean 404 — the failure mode that makes a deleted endpoint take an afternoon to find."""
    r = client.get("/api/definitely-not-a-route")
    assert r.status_code == 404, f"unknown /api path returned {r.status_code}, not 404"
    assert r.text != INDEX_HTML_CONTENT, "the SPA catch-all swallowed an /api/* path"
    assert r.json()["detail"] == "Not Found"


def test_api_path_with_a_bad_param_still_validates(client):
    """A real API route with an unparseable path param must still produce FastAPI's 422.

    Pins that the catch-all is not shadowing a route that DOES exist: if /api/games/{appid}
    were reached via the catch-all instead, a non-integer appid would render index.html
    (200) rather than a validation error."""
    r = client.get("/api/games/not-an-integer")
    assert r.status_code == 422, (
        f"expected FastAPI validation 422, got {r.status_code} — /api/games/{{appid}} is "
        "being matched by the SPA catch-all instead of its own route"
    )
    assert r.json()["detail"][0]["loc"] == ["path", "appid"]


@pytest.mark.parametrize(
    ("path", "must_contain"),
    [
        ("/docs", "swagger"),          # Swagger UI shell
        ("/redoc", "redoc"),           # ReDoc shell
        ("/openapi.json", "openapi"),  # the schema itself
        ("/metrics", "# HELP"),        # Prometheus exposition (observability.py)
    ],
)
def test_builtin_endpoints_are_not_shadowed_by_the_spa(client, path, must_contain):
    """/docs, /redoc, /openapi.json and /metrics each own a real route, so registration
    order is what protects them — but "registered last" is a property of main.py's file
    layout, and a future edit that moves the SPA block above `setup_observability(app)` or
    the router includes would silently swallow all four. /metrics is the one that hurts
    quietly: Prometheus would scrape 200 text/html forever and the dashboards would just
    stop updating."""
    r = client.get(path)
    assert r.status_code == 200, f"{path} returned {r.status_code}"
    assert r.text != INDEX_HTML_CONTENT, f"{path} was answered by the SPA catch-all"
    assert must_contain.lower() in r.text.lower(), (
        f"{path} did not look like itself — got {r.text[:120]!r}"
    )


@pytest.mark.parametrize("path", ["/mcp", "/mcp/", "/mcp/anything"])
def test_mcp_prefix_is_never_answered_with_index_html(client, path):
    """/mcp is mounted only when settings.enable_mcp is true (it is FALSE in this suite), so
    ordering cannot protect it — the prefix guard is the only thing standing between a
    disabled MCP and the catch-all.

    Contract: a hosted user who points their Claude at /mcp while the mount is off gets an
    honest 404, not 200 text/html that their JSON-RPC client will fail on with a parse
    error several layers deep."""
    assert app_main._mcp_asgi is None, (
        "this test asserts the MCP-DISABLED behaviour; the mount is active, so it is "
        "measuring the mount rather than main.py's prefix guard"
    )
    r = client.get(path)
    assert r.status_code == 404, f"{path} returned {r.status_code} with the MCP mount off"
    assert r.text != INDEX_HTML_CONTENT, (
        f"{path} was answered with the SPA shell — an MCP client would parse HTML as a "
        "JSON-RPC stream"
    )
