"""Prospect API entrypoint."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from . import analytics_db
from .config import settings
from .observability import setup_observability
from .routers import (
    analytics, entities, games, health, market, niches, refresh, seasonality, timing, trends,
)
from .mcp_mount import close_prospect_mcp, load_prospect_mcp

# Optionally load the standalone Prospect MCP (mcp/prospect_mcp.py) as a Streamable-HTTP app
# so hosted users can add Prospect to their own Claude. (None, None) when disabled/unavailable
# — the API is unaffected. Mounted below; its session manager is driven in the lifespan.
_prospect_mcp, _mcp_asgi = load_prospect_mcp()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Analytics plane: open the read-only marts. Fail loud if the ETL hasn't run.
    try:
        analytics_db.init(settings.analytics_db_path, settings.analytics_pool_size)
    except FileNotFoundError as exc:
        # Keep the app up so /docs and a clear error are reachable; endpoints will 503.
        print(f"[api] WARNING: {exc}")
    # The mounted MCP's Streamable-HTTP transport needs its session manager running for the
    # whole app lifetime; drive it here when the MCP is enabled.
    if _prospect_mcp is not None:
        async with _prospect_mcp.session_manager.run():
            yield
    else:
        yield
    analytics_db.close()
    close_prospect_mcp()  # the mounted MCP module's own DuckDB conn (no-op when disabled)


app = FastAPI(title=settings.api_title, version=settings.api_version, lifespan=lifespan)

# Body-size cap for the two public WRITE surfaces (the analytics collect endpoint and the
# /mcp mount). Everything else is read-only over precomputed marts and already bounded, so
# it is left un-capped. Registered FIRST (add_middleware makes the LAST-added outermost),
# i.e. innermost: a 413 still passes the rate limiter and RequestContextMiddleware on the
# way out, so it gets an X-Request-ID + access-log line like a 429 does, and CORS (added
# last below) still wraps it — same convention as the rate limiter's placement.
_MAX_WRITE_BODY_BYTES = 64 * 1024
_WRITE_PATH_PREFIXES = ("/api/analytics/collect", "/mcp")


class BodyLimitMiddleware:
    """Pure-ASGI (same idiom as RateLimitMiddleware — nothing here buffers bodies).

    Only the declared Content-Length is checked. Requests WITHOUT a Content-Length
    (chunked transfer) are let through: the collect body is pydantic-validated to a small
    batch and the MCP transport bounds its own frames, and buffering the stream just to
    measure it would spend the memory this middleware exists to save."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("path", "").startswith(_WRITE_PATH_PREFIXES):
            content_length: int | None = None
            for name, value in scope.get("headers") or []:
                if name == b"content-length":
                    try:
                        content_length = int(value.decode("latin-1"))
                    except ValueError:
                        content_length = None
                    break
            if content_length is not None and content_length > _MAX_WRITE_BODY_BYTES:
                body = json.dumps({"detail": "request body too large"}).encode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 413,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


app.add_middleware(BodyLimitMiddleware)

# O3 (metrics /metrics + structured request logging + env-gated Sentry) + O4 (per-IP
# rate limiter on POST /api/analytics/collect and /mcp — rate_limit.py, env-tunable via
# PROSPECT_RATE_LIMIT_PER_MIN, 0 disables). Registered BEFORE CORSMiddleware below:
# Starlette's add_middleware() makes the LAST-added middleware outermost, so calling this
# first keeps CORS wrapping everything else (including a 429 from the rate limiter) — see
# observability.py.
setup_observability(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(niches.router)
app.include_router(market.router)
app.include_router(seasonality.router)
app.include_router(timing.router)
app.include_router(games.router)
app.include_router(entities.router)
app.include_router(refresh.router)
app.include_router(trends.router)
app.include_router(analytics.router)


# Mount the Prospect MCP (Streamable HTTP) at /mcp so users can add it to their own Claude.
# Registered before the SPA catch-all below so /mcp routes to the MCP, not to index.html.
if _mcp_asgi is not None:
    app.mount("/mcp", _mcp_asgi)


# ---- Serve the built SPA when running as a single hosted service -------------------------
# In the container image PROSPECT_STATIC_DIR points at the Vite build (web/dist), so this
# service also serves the frontend from the same origin (no CORS, one deployable). Unset in
# local dev — Vite serves the SPA and proxies /api — leaving everything below inert.
_STATIC_DIR = Path(settings.static_dir) if settings.static_dir else None
_INDEX_HTML = (_STATIC_DIR / "index.html") if _STATIC_DIR else None
_SERVE_SPA = bool(_STATIC_DIR and _INDEX_HTML and _INDEX_HTML.exists())


@app.get("/", include_in_schema=False)
def root():
    # Hosted mode: the root path is the app itself. Local/dev: a small JSON pointer.
    if _SERVE_SPA:
        return FileResponse(str(_INDEX_HTML))
    return {
        "name": settings.api_title,
        "version": settings.api_version,
        "docs": "/docs",
        "health": "/api/health",
    }


if _SERVE_SPA:
    # Hashed JS/CSS/images emitted by Vite live under /assets.
    _assets_dir = _STATIC_DIR / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")

    # SPA fallback — registered LAST so it never shadows /api/*, /docs, /openapi.json,
    # /metrics (each matched by its own route above). Any other path returns a real static
    # file if one exists (favicon, etc.), otherwise index.html so client-side routes
    # (/niches, /devlog, …) survive a hard refresh.
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        # Compare the first path SEGMENT, not a bare string prefix. startswith(("api", ...))
        # also swallows /apiary, /metricsboard, /docsearch, /mcpx and /redocs-guide — so any
        # future client-side route whose name merely BEGINS with one of these words would 404
        # on a hard refresh while working fine on in-app navigation, which is a maddening
        # class of bug to track down. These names are reserved as whole segments, not prefixes.
        if full_path.split("/", 1)[0] in {
            "api", "docs", "redoc", "openapi.json", "metrics", "mcp",
        }:
            raise HTTPException(status_code=404)
        # Path traversal: uvicorn percent-decodes the path BEFORE routing, so a request
        # like GET /%2e%2e/secret.txt arrives here as "../secret.txt" and the naive
        # `_STATIC_DIR / full_path` join served any readable file on the box. Reject any
        # ".." segment outright...
        if ".." in full_path.split("/"):
            raise HTTPException(status_code=404)
        candidate = _STATIC_DIR / full_path
        # ...and defense-in-depth: only ever serve a file that RESOLVES inside the static
        # dir (symlinks and any other normalization included); anything else falls through
        # to index.html instead of being served.
        if (
            full_path
            and candidate.is_file()
            and candidate.resolve().is_relative_to(_STATIC_DIR.resolve())
        ):
            return FileResponse(str(candidate))
        return FileResponse(str(_INDEX_HTML))
