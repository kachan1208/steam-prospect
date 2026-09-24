"""The mounted MCP must not run tool bodies on the event loop (one slow DuckDB read
would freeze every HTTP request on the worker), must keep logging calls, must rotate the
call log at its size cap without two workers destroying each other's archive, must refuse
to mount at all against a DB whose core marts are missing, and must close its DuckDB
connection via the shutdown hook.

The second half covers prospect_mcp's own tool contract (this is the suite CI runs over
it; mcp/smoke_test.py covers the real-data fixture): every description and the server
instructions fit Claude Code's ~2K-char cut, the wire carries compact JSON, every response
leads with the data_as_of / mart_version / score_version / warnings envelope, the analysis
rules ride the OUTPUT as server-computed flags, DECIMAL/DATE columns come back JSON-native,
players windows anchor to the mart's own last capture date, older marts get friendly
"rebuild" errors instead of Binder exceptions, and a mart swap is hot-reloaded.

Loads the real mcp/prospect_mcp.py through the real mount path, pointed at the committed
CI smoke fixture (.github/fixtures/mcp_smoke_mart.db) — prospect_mcp reads the
PROSPECT_ANALYTICS_DB_PATH env var at module-exec time, so monkeypatch.setenv is enough
to redirect each fresh load. Tests that need marts the fixture doesn't carry build a
throwaway DuckDB in tmp_path and load against that instead (the real mart types —
DECIMAL, HUGEINT, DATE — are used where the tools must survive them).
"""
from __future__ import annotations

import json
import os
import threading
from datetime import date, datetime, timedelta, timezone

import anyio
import duckdb
import pytest

from app import mcp_mount
from app.config import REPO_ROOT, settings

FIXTURE_DB = REPO_ROOT / ".github" / "fixtures" / "mcp_smoke_mart.db"

# mcp_mount caps the live log at ~5MB with a single .1 rollover.
LOG_CAP_BYTES = mcp_mount._MAX_LOG_BYTES


@pytest.fixture()
def mcp_server(monkeypatch, tmp_path):
    if not FIXTURE_DB.exists():
        pytest.skip("mcp smoke fixture not present")
    monkeypatch.setenv("PROSPECT_ANALYTICS_DB_PATH", str(FIXTURE_DB))
    monkeypatch.setattr(settings, "enable_mcp", True)
    log_path = tmp_path / "mcp_calls.jsonl"
    monkeypatch.setattr(settings, "mcp_call_log_path", str(log_path))
    server, asgi_app = mcp_mount.load_prospect_mcp()
    assert server is not None and asgi_app is not None
    try:
        yield server, log_path
    finally:
        mcp_mount.close_prospect_mcp()


def test_tool_calls_run_off_the_event_loop_and_are_logged(mcp_server):
    server, log_path = mcp_server

    # Spy on the loaded module's query() (every tool funnels through it) to record which
    # thread actually executes the blocking DB work.
    tool_fn = server._tool_manager.get_tool("tag_suggest").fn
    module_globals = tool_fn.__globals__
    orig_query = module_globals["query"]
    seen: dict = {}

    def spy_query(sql, params=None):
        seen["query_thread"] = threading.get_ident()
        return orig_query(sql, params)

    module_globals["query"] = spy_query
    try:
        async def drive():
            seen["loop_thread"] = threading.get_ident()
            # EXACTLY how FastMCP.call_tool invokes the manager in production — the two
            # keyword arguments are the part that has to survive partial() across the
            # loop boundary, and convert_result changes the returned shape.
            return await server._tool_manager.call_tool(
                "tag_suggest", {"q": "a"}, context=server.get_context(), convert_result=True
            )

        result = anyio.run(drive)
    finally:
        module_globals["query"] = orig_query

    assert "query_thread" in seen, "the tool body never ran"
    assert seen["query_thread"] != seen["loop_thread"], (
        "sync tool executed ON the event loop thread — the anyio.to_thread offload in "
        "mcp_mount._observed_call is not taking effect"
    )
    # convert_result=True must have been forwarded: the wrapper returns the CONVERTED
    # content blocks the low-level server expects, not the tool's raw dict.
    assert isinstance(result, list) and result, f"expected converted content blocks, got {result!r}"
    assert json.loads(result[0].text)["q"] == "a"

    # The logging behavior of the wrapper must be preserved by the offload.
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert lines, "call log not written"
    entry = json.loads(lines[-1])
    assert entry["tool"] == "tag_suggest"
    assert entry["ok"] is True
    assert isinstance(entry["ms"], int)


def test_tool_calls_use_a_dedicated_thread_limiter(mcp_server, monkeypatch):
    # Offloading to a thread is only half the fix: anyio's DEFAULT thread limiter is the
    # same 40 slots every sync FastAPI route handler runs in, so MCP calls drawing on it
    # could still starve normal HTTP traffic. They must use their own bounded limiter.
    server, _ = mcp_server
    import anyio.to_thread as to_thread

    orig_run_sync = to_thread.run_sync
    seen: dict = {}

    async def spy_run_sync(fn, *args, **kwargs):
        seen["limiter"] = kwargs.get("limiter")
        seen["default"] = to_thread.current_default_thread_limiter()
        return await orig_run_sync(fn, *args, **kwargs)

    monkeypatch.setattr(to_thread, "run_sync", spy_run_sync)

    async def drive():
        return await server._tool_manager.call_tool(
            "tag_suggest", {"q": ""}, context=server.get_context(), convert_result=True
        )

    anyio.run(drive)

    assert seen.get("limiter") is not None, (
        "MCP tool calls fell back to anyio's shared default thread pool"
    )
    assert seen["limiter"] is not seen["default"]
    assert seen["limiter"].total_tokens == mcp_mount._MCP_THREAD_LIMIT


def test_call_log_rotates_at_size_cap(mcp_server):
    server, log_path = mcp_server

    # Pre-fill the live log past the cap; the next logged call must roll it to .1 and
    # start a fresh file containing only the new entry.
    filler = ("x" * 1023 + "\n") * (LOG_CAP_BYTES // 1024 + 1)
    log_path.write_text(filler, encoding="utf-8")
    assert log_path.stat().st_size >= LOG_CAP_BYTES

    async def drive():
        return await server._tool_manager.call_tool(
            "tag_suggest", {"q": "a"}, context=server.get_context(), convert_result=True
        )

    anyio.run(drive)

    archive = log_path.parent / (log_path.name + ".1")
    assert archive.exists(), "no .1 rollover created"
    assert archive.stat().st_size >= LOG_CAP_BYTES
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1, "rotated live log should hold only the post-rotation entry"
    assert json.loads(lines[0])["tool"] == "tag_suggest"


def test_rotation_does_not_clobber_the_archive_a_peer_worker_just_made(tmp_path):
    # The two uvicorn workers share this file. Worker A rotates (5MB -> .1) and starts a
    # fresh log; worker B, which saw the over-cap size a moment earlier, must NOT then
    # replace the fresh log over A's archive. _rotate_log re-checks the size under its
    # lock, so B is a no-op — this is worker B's call, post-rotation.
    log_path = tmp_path / "mcp_calls.jsonl"
    archive = tmp_path / "mcp_calls.jsonl.1"
    archive.write_bytes(b"y" * LOG_CAP_BYTES)  # what worker A just rolled off
    log_path.write_text("fresh line\n", encoding="utf-8")

    mcp_mount._rotate_log(str(log_path))

    assert archive.stat().st_size == LOG_CAP_BYTES, "a full archive generation was destroyed"
    assert log_path.read_text(encoding="utf-8") == "fresh line\n"


def test_missing_core_marts_refuses_to_mount(monkeypatch, tmp_path):
    # With every capability probe lazy, nothing else queries the DB before a tool call —
    # so without the eager core-mart check the mount would succeed here and all 25 tools
    # would raise raw CatalogException inside the client. Contract: (None, None).
    empty_db = tmp_path / "martless.duckdb"
    conn = duckdb.connect(str(empty_db))
    conn.execute("CREATE TABLE junk (a INTEGER)")
    conn.close()
    monkeypatch.setenv("PROSPECT_ANALYTICS_DB_PATH", str(empty_db))
    monkeypatch.setattr(settings, "enable_mcp", True)
    monkeypatch.setattr(settings, "mcp_call_log_path", str(tmp_path / "calls.jsonl"))
    try:
        assert mcp_mount.load_prospect_mcp() == (None, None)
        assert mcp_mount._loaded_module is None, "the refused module's conn must be closed"
    finally:
        mcp_mount.close_prospect_mcp()


def test_channel_buzz_lean_output_equals_full_output_minus_series(monkeypatch, tmp_path):
    # The CI smoke fixture carries no channel marts, so the smoke test can only assert
    # that channel_buzz degrades. Seed the two marts here to actually exercise the
    # include_series=False rewrite (per-(term, channel) SUM in SQL) against the
    # include_series=True path (Python roll-up of the per-period detail): the cheap path
    # must produce exactly the expensive path minus the `series` field.
    db = tmp_path / "channels.duckdb"
    conn = duckdb.connect(str(db))
    conn.execute("CREATE TABLE mart_game (appid INTEGER)")
    conn.execute("INSERT INTO mart_game VALUES (1)")
    conn.execute("CREATE TABLE mart_niche (dimension VARCHAR)")
    conn.execute("INSERT INTO mart_niche VALUES ('tag')")
    conn.execute(
        "CREATE TABLE mart_channel_buzz_summary (term VARCHAR, direction VARCHAR, "
        "total_mentions BIGINT, total_weighted DOUBLE, recent_avg_weighted DOUBLE, "
        "prior_avg_weighted DOUBLE, slope_weighted DOUBLE)"
    )
    conn.execute(
        "INSERT INTO mart_channel_buzz_summary VALUES "
        "('cozy sim', 'rising', 30, 30.0, 7.5, 2.5, 5.0), "
        "('deck builder', 'rising', 18, 18.0, 4.0, 2.0, 2.0)"
    )
    conn.execute(
        "CREATE TABLE mart_channel_buzz (term VARCHAR, channel VARCHAR, period VARCHAR, "
        "n_mentions BIGINT, reach_weighted_score DOUBLE)"
    )
    # Two channels x three periods per term, so both the per-channel totals and the
    # per-period series are real roll-ups rather than one row passed through.
    rows = []
    for term, base in (("cozy sim", 3), ("deck builder", 2)):
        for ch_i, channel in enumerate(("press", "youtube")):
            for p_i, period in enumerate(("2026-05", "2026-06", "2026-07")):
                n = base + ch_i + p_i
                rows.append(f"('{term}', '{channel}', '{period}', {n}, {n}.5)")
    conn.execute("INSERT INTO mart_channel_buzz VALUES " + ", ".join(rows))
    conn.close()

    monkeypatch.setenv("PROSPECT_ANALYTICS_DB_PATH", str(db))
    monkeypatch.setattr(settings, "enable_mcp", True)
    monkeypatch.setattr(settings, "mcp_call_log_path", str(tmp_path / "calls.jsonl"))
    server, _ = mcp_mount.load_prospect_mcp()
    assert server is not None
    try:
        module = mcp_mount._loaded_module
        lean = module.channel_buzz("rising", limit=5)
        full = module.channel_buzz("rising", limit=5, include_series=True)
        assert "error" not in lean and "error" not in full
        assert [t["term"] for t in lean["terms"]] == [t["term"] for t in full["terms"]] == [
            "cozy sim",
            "deck builder",
        ]

        def _norm(term: dict) -> dict:
            # by_channel is ordered by reach, which ties are free to break either way in
            # the two code paths; the VALUES are the invariant.
            out = {k: v for k, v in term.items() if k != "series"}
            out["by_channel"] = sorted(out["by_channel"], key=lambda c: c["channel"])
            return out

        for lean_t, full_t in zip(lean["terms"], full["terms"]):
            assert "series" not in lean_t, "include_series=False must not ship the series"
            assert full_t["series"], "include_series=True must attach a non-empty series"
            assert _norm(lean_t) == _norm(full_t), (
                f"channel_buzz(include_series=False) diverged from the full path for "
                f"{lean_t['term']!r}: {_norm(lean_t)} != {_norm(full_t)}"
            )
        # Guard the roll-up itself: press over the three periods is 3+4+5 for 'cozy sim'.
        press = next(c for c in lean["terms"][0]["by_channel"] if c["channel"] == "press")
        assert press["n_mentions"] == 12 and press["reach_weighted_score"] == 13.5
    finally:
        mcp_mount.close_prospect_mcp()


def test_close_hook_closes_module_connection(mcp_server):
    server, _ = mcp_server
    module = mcp_mount._loaded_module
    assert module is not None

    mcp_mount.close_prospect_mcp()
    assert mcp_mount._loaded_module is None
    # Idempotent: safe to call again (the fixture teardown will too).
    mcp_mount.close_prospect_mcp()
    # The module's own close() is idempotent as well.
    module.close()
    with pytest.raises(Exception):
        module.query("SELECT 1")


# =========================================================================================
# prospect_mcp's tool contract, against small synthetic marts.
# =========================================================================================

# The mart_niche columns the niche tools read, with the REAL mart's types (HUGEINT review
# sums, BOOLEAN demand_emerging). V2_PARTS are the 2026-08-31 score-rebuild columns: a
# mart without them is a "v1-legacy" mart.
NICHE_COLS = {
    "dimension": "VARCHAR", "key": "VARCHAR", "win": "VARCHAR", "min_reviews": "INTEGER",
    "n_games": "BIGINT", "n_recent": "BIGINT", "median_rev": "DOUBLE", "p90_rev": "DOUBLE",
    "total_owners": "DOUBLE", "total_reviews": "HUGEINT", "winner_concentration": "DOUBLE",
    "hit_rate_200k": "DOUBLE", "hit_rate_500k": "DOUBLE", "saturation_yoy": "DOUBLE",
    "n_recent_year": "BIGINT", "n_prior_year": "BIGINT", "demand": "DOUBLE",
    "competition": "DOUBLE", "quality_gap": "DOUBLE", "opportunity": "DOUBLE",
    "entrant_ratio": "DOUBLE", "solo_viability": "DOUBLE", "solo_tier": "VARCHAR",
    "tier": "VARCHAR", "decline_gate": "DOUBLE", "momentum": "DOUBLE", "supply_room": "DOUBLE",
    "revenue_spread": "DOUBLE", "market_pull": "DOUBLE", "supply_brake": "DOUBLE",
    "opportunity_v2": "DOUBLE", "total_players_now": "BIGINT",
    "players_trend_7d_pct": "DOUBLE", "players_coverage": "DOUBLE",
    "median_players_now": "DOUBLE", "players_top5_share": "DOUBLE",
    "reviews_24m": "HUGEINT", "reviews_prev_24m": "HUGEINT", "demand_trend_24m_pct": "DOUBLE",
    "reviews_24m_new_share": "DOUBLE", "demand_emerging": "BOOLEAN",
}
V2_PARTS = ("momentum", "supply_room", "revenue_spread", "market_pull", "supply_brake", "solo_tier")

GAME_COLS = {
    "appid": "BIGINT", "name": "VARCHAR", "name_lower": "VARCHAR", "release_year": "BIGINT",
    "release_date": "VARCHAR", "price_initial": "DOUBLE", "is_free": "BIGINT",
    "primary_genre": "VARCHAR", "developers": "VARCHAR", "publishers": "VARCHAR",
    "self_published": "BIGINT", "is_indie": "BIGINT", "owners_mid": "DOUBLE",
    "total_reviews": "BIGINT", "positive_ratio": "DOUBLE", "est_rev_reviews": "DOUBLE",
    "est_rev_owners": "DOUBLE", "metacritic_score": "BIGINT", "achievements_count": "BIGINT",
    "avg_playtime_forever": "BIGINT", "short_description": "VARCHAR", "header_image": "VARCHAR",
    "first_seen": "VARCHAR", "rev_pct_in_genre": "DOUBLE", "reviews_pct_in_genre": "DOUBLE",
    "owners_pct_in_genre": "DOUBLE", "top_tags": "VARCHAR[]", "n_reviews_sampled": "BIGINT",
    "n_reviews_first_30d": "BIGINT", "n_reviews_first_90d": "BIGINT",
    "n_reviews_first_365d": "BIGINT", "n_reviews_trailing_30d": "BIGINT",
    "playtime_p25": "DOUBLE", "playtime_p50": "DOUBLE", "playtime_p75": "DOUBLE",
    "live_players": "BIGINT", "players_7d_avg": "DOUBLE", "players_trend_7d_pct": "DOUBLE",
    "lifetime_months": "BIGINT", "lifetime_alive": "BOOLEAN",
}

# One 24m x 50 row per flag the rules must raise (plus a clean pick), all on a v2 mart.
# Defaults describe a healthy micro niche; each row overrides exactly what its flag reads.
_HEALTHY = dict(
    dimension="tag", win="24m", min_reviews=50, n_games=120, n_recent=120, median_rev=90000.0,
    p90_rev=900000.0, total_owners=5e6, total_reviews=100000, winner_concentration=0.6,
    hit_rate_200k=0.3, hit_rate_500k=0.1, saturation_yoy=0.05, n_recent_year=110,
    n_prior_year=105, demand=60.0, competition=60.0, quality_gap=50.0, opportunity=40.0,
    entrant_ratio=1.2, solo_viability=0.97, solo_tier="solo", tier="micro", decline_gate=1.0,
    momentum=80.0, supply_room=100.0, revenue_spread=90.0, market_pull=60.0, supply_brake=1.0,
    total_players_now=5000, players_trend_7d_pct=1.0, players_coverage=0.9,
    median_players_now=3.0, players_top5_share=0.4, reviews_24m=50000, reviews_prev_24m=40000,
    demand_trend_24m_pct=25.0, reviews_24m_new_share=0.4, demand_emerging=False,
)
FLAG_ROWS = {
    # key: (overrides, expected flags in the tool's severity order)
    "Clean Pick": (dict(opportunity_v2=90.0), []),
    "Declining Micro": (dict(opportunity_v2=85.0, saturation_yoy=-0.2, competition=20.0,
                             demand_trend_24m_pct=-40.0), ["decline_signature", "demand_falling"]),
    "Hit Driven": (dict(opportunity_v2=80.0, winner_concentration=0.9, demand_trend_24m_pct=60.0),
                   ["winner_take_most"]),
    "Team Game": (dict(opportunity_v2=75.0, solo_viability=0.5, solo_tier="team"),
                  ["multiplayer_dependent"]),
    "Cheap Entrants": (dict(opportunity_v2=70.0, entrant_ratio=0.8), ["low_newcomer_economics"]),
    "Young Tag": (dict(opportunity_v2=65.0, demand_emerging=True, demand_trend_24m_pct=5000.0,
                       saturation_yoy=0.9, momentum=None), ["emerging_unquotable"]),
    "Tiny": (dict(opportunity_v2=60.0, n_games=35, n_recent=35), ["thin_sample"]),
    "Flooded": (dict(opportunity_v2=55.0, saturation_yoy=0.4), ["supply_flooding"]),
    "Mixed Crowd": (dict(opportunity_v2=50.0, solo_viability=0.85, solo_tier="mixed"),
                    ["multiplayer_minority"]),
    "Snowy": (dict(opportunity_v2=95.0, tier="theme"), ["theme_tag"]),
    "Open World": (dict(opportunity_v2=99.0, tier="umbrella"), ["umbrella_or_meta_tag"]),
    "Unknown Solo": (dict(opportunity_v2=40.0, solo_viability=None, solo_tier=None), []),
}


def _table(conn, name: str, cols: dict[str, str], rows: list[dict], drop: tuple = ()) -> None:
    keep = {c: t for c, t in cols.items() if c not in drop}
    conn.execute(f"CREATE TABLE {name} ({', '.join(f'{c} {t}' for c, t in keep.items())})")
    if rows:
        conn.executemany(
            f"INSERT INTO {name} VALUES ({', '.join('?' for _ in keep)})",
            [[r.get(c) for c in keep] for r in rows],
        )


def _game(appid: int, **kw) -> dict:
    name = kw.pop("name", f"Game {appid}")
    return {
        **dict(
            appid=appid, name=name, name_lower=name.lower(), release_year=2025,
            release_date="2025-03-01", price_initial=14.99, is_free=0, primary_genre="Action",
            developers="Dev", publishers="Pub", self_published=0, is_indie=1, owners_mid=50000.0,
            total_reviews=500, positive_ratio=0.9, est_rev_reviews=150000.0,
            est_rev_owners=160000.0, short_description="x",
            header_image="https://example.test/h.jpg", first_seen="2025-01-01",
            top_tags=["Action", "Indie"], n_reviews_sampled=100, playtime_p50=600.0,
            live_players=10, players_7d_avg=9.0, players_trend_7d_pct=2.0, lifetime_months=12,
            lifetime_alive=True,
        ),
        **kw,
    }


def _build_mart(path, *, v2: bool = True, built_at: datetime | None = None,
                meta: dict | None = None, game_drop: tuple = (), extra=None) -> None:
    """A small but schema-faithful mart: mart_meta, mart_game, mart_niche (the FLAG_ROWS on
    the 24m x 50 cut plus an all x 50 row per key) and the niche satellites. `extra(conn)`
    adds whatever else a test needs."""
    built_at = built_at or datetime.now(timezone.utc)
    conn = duckdb.connect(str(path))
    kv = {"built_at": built_at.isoformat(timespec="seconds"),
          "mart_version": built_at.strftime("%Y%m%d"), **(meta or {})}
    _table(conn, "mart_meta", {"key": "VARCHAR", "value": "VARCHAR"},
           [{"key": k, "value": v} for k, v in kv.items()])
    _table(conn, "mart_game", GAME_COLS,
           [_game(1, name="Alpha Quest"), _game(2, name="Beta Rogue", is_indie=0)], drop=game_drop)
    rows = []
    for key, (over, _) in FLAG_ROWS.items():
        row = {**_HEALTHY, "key": key, **over}
        rows.append(row)
        rows.append({**row, "win": "all", "n_games": row["n_games"] * 3})
    _table(conn, "mart_niche", NICHE_COLS, rows, drop=() if v2 else V2_PARTS)
    _table(conn, "mart_niche_trend", {"dimension": "VARCHAR", "key": "VARCHAR", "year": "BIGINT",
                                      "n_releases": "BIGINT", "n_scored": "BIGINT",
                                      "median_rev": "DOUBLE"},
           [{"dimension": "tag", "key": "Clean Pick", "year": y, "n_releases": y - 2000,
             "n_scored": 5, "median_rev": 1000.0} for y in range(2010, 2026)])
    _table(conn, "mart_niche_hist", {"dimension": "VARCHAR", "key": "VARCHAR",
                                     "bucket_index": "INTEGER", "x_min": "DOUBLE",
                                     "x_max": "DOUBLE", "count": "BIGINT"}, [])
    _table(conn, "mart_niche_top", {"dimension": "VARCHAR", "key": "VARCHAR",
                                    "rank_in_niche": "BIGINT", "appid": "BIGINT",
                                    "name": "VARCHAR", "release_year": "BIGINT",
                                    "price_initial": "DOUBLE", "total_reviews": "BIGINT",
                                    "positive_ratio": "DOUBLE", "est_rev_reviews": "DOUBLE",
                                    "self_published": "BIGINT"},
           [{"dimension": "tag", "key": "Clean Pick", "rank_in_niche": 1, "appid": 1,
             "name": "Alpha Quest", "release_year": 2012, "est_rev_reviews": 1e6}])
    if extra:
        extra(conn)
    conn.close()


@pytest.fixture()
def load_mcp(monkeypatch, tmp_path):
    """Load prospect_mcp through the real mount path against a given DB; returns the module
    (its tool names are the direct-call wrappers — exactly what the wire serialises)."""
    monkeypatch.setattr(settings, "enable_mcp", True)
    monkeypatch.setattr(settings, "mcp_call_log_path", str(tmp_path / "calls.jsonl"))

    def _load(db_path):
        monkeypatch.setenv("PROSPECT_ANALYTICS_DB_PATH", str(db_path))
        server, _ = mcp_mount.load_prospect_mcp()
        assert server is not None, "mount refused the synthetic mart"
        return mcp_mount._loaded_module

    try:
        yield _load
    finally:
        mcp_mount.close_prospect_mcp()


def _wire(module, name: str, args: dict):
    """Call a tool the way a client does (through the mounted, offloaded tool manager) and
    return the raw text the client receives."""
    server = module.mcp

    async def drive():
        return await server._tool_manager.call_tool(
            name, args, context=server.get_context(), convert_result=True
        )

    result = anyio.run(drive)
    return result[0].text


# ---- descriptions / wire ------------------------------------------------------------------

def test_every_description_and_the_instructions_fit_the_client_cut(mcp_server):
    # Claude Code truncates each tool description and the server instructions at ~2,048
    # chars; anything past the cut never reaches the model (find_niches' falsification
    # rules used to start at char ~2,773). Budgeted at 1,900 with the rules first.
    server, _ = mcp_server
    module = mcp_mount._loaded_module
    budget = module.DESCRIPTION_BUDGET
    assert budget <= 1900
    tools = server._tool_manager.list_tools()
    assert len(tools) >= 27
    over = {t.name: len(t.description) for t in tools if len(t.description) > budget}
    assert not over, f"descriptions over the {budget}-char budget: {over}"
    assert len(server.instructions) <= budget
    # The rules come FIRST where they matter most.
    fn = next(t for t in tools if t.name == "find_niches").description
    assert fn.index("RULES") < 200
    assert server.instructions.index("rules") < 600
    for t in tools:
        assert t.annotations.readOnlyHint and t.annotations.idempotentHint
        assert t.annotations.openWorldHint is False
        assert t.output_schema is None, f"{t.name} would ship a second structured copy"


def test_wire_output_is_compact_json_led_by_the_envelope(mcp_server):
    module = mcp_mount._loaded_module
    text = _wire(module, "find_niches", {"limit": 2})
    parsed = json.loads(text)
    assert text == json.dumps(parsed, ensure_ascii=False, separators=(",", ":")), "not compact"
    assert list(parsed)[:4] == ["data_as_of", "mart_version", "score_version", "warnings"]
    # The fixture is the 2026-08-14 mart: legacy score AND stale — both must be said.
    assert parsed["score_version"] == "v1-legacy"
    assert any("predates opportunity v2" in w for w in parsed["warnings"])
    assert any("days old" in w for w in parsed["warnings"])
    # Schema-level bounds reach the client too: a 0-100 min_positive is rejected with the
    # fix in the message rather than silently matching nothing.
    with pytest.raises(Exception, match="0-1 FRACTION"):
        _wire(module, "game_search", {"min_positive": 80})


# ---- envelope -------------------------------------------------------------------------------

def test_envelope_fresh_v2_mart_has_no_warnings(load_mcp, tmp_path):
    db = tmp_path / "fresh.duckdb"
    _build_mart(db)
    m = load_mcp(db)
    out = m.market_benchmarks()
    assert out["score_version"] == "v2"
    assert out["warnings"] == []
    assert out["data_as_of"] and out["mart_version"]
    # Errors carry it too — a stale mart must not hide behind an error.
    err = m.niche_detail("tag", "No Such Niche")
    assert "error" in err and err["score_version"] == "v2"


def test_envelope_flags_legacy_stale_and_lagging_owner_estimates(load_mcp, tmp_path):
    db = tmp_path / "old.duckdb"
    built = datetime.now(timezone.utc) - timedelta(days=10)
    _build_mart(db, v2=False, built_at=built,
                meta={"owners_as_of": (built - timedelta(days=60)).date().isoformat()})
    m = load_mcp(db)
    out = m.find_niches()
    assert out["score_version"] == "v1-legacy"
    assert out["owners_as_of"] == (built - timedelta(days=60)).date().isoformat()
    joined = " | ".join(out["warnings"])
    assert "predates opportunity v2" in joined
    assert "10 days old" in joined
    assert "Owner/revenue estimates date from" in joined
    # v1-legacy rows show the OLD score's own parts, and the rules say so.
    row = out["niches"][0]
    for part in ("opportunity", "decline_gate", "demand", "competition", "quality_gap"):
        assert part in row
    assert "momentum" not in row
    assert any("v1-legacy" in r for r in out["rules"])


# ---- flags + rules ---------------------------------------------------------------------------

def test_find_niches_flags_every_rule_and_defaults_to_micro(load_mcp, tmp_path):
    db = tmp_path / "flags.duckdb"
    _build_mart(db)
    m = load_mcp(db)
    out = m.find_niches(limit=50)
    by_key = {n["key"]: n for n in out["niches"]}
    # Default include_tiers is micro ONLY: themes/umbrella never headline.
    assert "Snowy" not in by_key and "Open World" not in by_key
    assert out["include_tiers"] == ["micro"]
    for key, (_, expected) in FLAG_ROWS.items():
        if key in ("Snowy", "Open World"):
            continue
        assert by_key[key]["flags"] == expected, (key, by_key[key]["flags"])
    # The legend defines exactly the flags that fired, after the general rules.
    fired = {f for n in out["niches"] for f in n["flags"]}
    legend = [r.split(":", 1)[0] for r in out["rules"] if ":" in r.split(" ", 1)[0]]
    assert set(legend) == fired
    assert out["rules"][0].startswith("Bearish reading first")
    # Core rows carry the score's parts + the rule inputs, never the lone number.
    row = by_key["Clean Pick"]
    for f in ("opportunity_v2", "momentum", "market_pull", "revenue_spread", "quality_gap",
              "supply_room", "supply_brake", "saturation_yoy", "n_recent_year",
              "n_prior_year", "competition", "entrant_ratio", "winner_concentration", "solo_tier"):
        assert f in row
    assert "header_image" not in row and "demand_emerging" not in row
    # An emerging niche's trend % is withheld in core rows (never quote it)...
    assert by_key["Young Tag"]["demand_trend_24m_pct"] is None
    # ...but fields="all" returns the raw column.
    wide = {n["key"]: n for n in m.find_niches(fields="all", limit=50)["niches"]}
    assert wide["Young Tag"]["demand_trend_24m_pct"] == 5000.0
    # Themes can be asked for — and come back flagged as modifiers.
    themed = {n["key"]: n for n in m.find_niches(include_tiers=["micro", "theme"], limit=50)["niches"]}
    assert themed["Snowy"]["flags"] == ["theme_tag"]
    everything = {n["key"]: n for n in m.find_niches(include_tiers=None, limit=50)["niches"]}
    assert everything["Open World"]["flags"] == ["umbrella_or_meta_tag"]


def test_find_niches_solo_only_order_and_emerging_trend_sort(load_mcp, tmp_path):
    db = tmp_path / "sorts.duckdb"
    _build_mart(db)
    m = load_mcp(db)
    solo = {n["key"] for n in m.find_niches(solo_only=True, limit=50)["niches"]}
    assert "Team Game" not in solo, "singleplayer share < 0.8 must drop"
    assert "Unknown Solo" not in solo, "NULL singleplayer share = unknown = excluded"
    assert "Mixed Crowd" in solo  # 0.85 clears the 0.8 bar
    # sort=competition used to return the MOST crowded first with no way to flip it.
    asc = m.find_niches(sort="competition", order="asc", limit=50)["niches"]
    assert asc[0]["competition"] == min(n["competition"] for n in asc)
    desc = m.find_niches(sort="competition", limit=50)["niches"]
    assert desc[0]["competition"] == max(n["competition"] for n in desc)
    # An emerging niche's % is not comparable: it must never top a trend ranking.
    trend = m.find_niches(sort="demand_trend_24m_pct", limit=50)["niches"]
    assert trend[0]["key"] == "Hit Driven" and trend[-1]["key"] == "Young Tag"
    assert m.find_niches(limit=3)["n_matching"] == 10  # micro rows on the 24m x 50 cut


def test_niche_detail_headline_is_the_24m_cut_with_matching_flags(load_mcp, tmp_path):
    db = tmp_path / "detail.duckdb"
    _build_mart(db)
    m = load_mcp(db)
    d = m.niche_detail("tag", "hit driven")  # a unique case-insensitive match resolves
    assert d["key"] == "Hit Driven" and "case-insensitively" in d["key_note"]
    assert d["cut"] == {"window": "24m", "min_reviews": 50}
    assert d["headline"]["window"] == "24m" and d["headline"]["n_games"] == 120
    assert d["hit_rates"]["cut"] == d["cut"] and d["hit_rates"]["n_games"] == 120
    assert d["flags"] == ["winner_take_most"]
    assert any(r.startswith("winner_take_most:") and "never rings it 'enter'" in r for r in d["rules"])
    # The other cuts come back compact; hit rates / representative games are labelled.
    assert [v["window"] for v in d["variants"]] == ["all"]
    assert "saturation_yoy" not in d["variants"][0]
    assert "all-time" in d["representative_games_cut"]  # no mart_niche_game on this mart
    assert d["revenue_histogram_cut"] == {"window": "all", "min_reviews": 50}
    # window="all" is honoured — and flagged as context, not the entry market.
    allcut = m.niche_detail("tag", "Hit Driven", window="all")
    assert allcut["cut"]["window"] == "all" and allcut["headline"]["n_games"] == 360
    assert any("full history" in w for w in allcut["warnings"])
    # A cut the niche lacks falls back — and says so.
    missing = m.niche_detail("tag", "Hit Driven", min_reviews=100)
    assert missing["cut"] == {"window": "24m", "min_reviews": 50}
    assert any("not materialised" in w for w in missing["warnings"])
    # Emerging: the headline withholds the trend % in core, keeps it in fields="all".
    young = m.niche_detail("tag", "Young Tag")
    assert young["flags"] == ["emerging_unquotable"]
    assert young["headline"]["demand_trend_24m_pct"] is None
    assert m.niche_detail("tag", "Young Tag", fields="all")["headline"]["demand_trend_24m_pct"] == 5000.0
    assert len(m.niche_detail("tag", "Clean Pick")["saturation_trend"]) == 10
    assert len(m.niche_detail("tag", "Clean Pick", fields="all")["saturation_trend"]) == 16


# ---- niche_games + alias resolution -------------------------------------------------------

def _niche_game_marts(conn):
    _table(conn, "mart_niche_game", {"dimension": "VARCHAR", "key": "VARCHAR", "win": "VARCHAR",
                                     "min_reviews": "INTEGER", "appid": "INTEGER"},
           [{"dimension": "tag", "key": "Clean Pick", "win": w, "min_reviews": 50, "appid": a}
            for w in ("24m", "all") for a in (1, 2)])
    _table(conn, "mart_tag_alias", {"dimension": "VARCHAR", "alias": "VARCHAR",
                                    "canonical": "VARCHAR"},
           [{"dimension": "tag", "alias": "Roguelite", "canonical": "Clean Pick"}])


def test_niche_games_stats_scope_sort_and_cut_validation(load_mcp, tmp_path):
    db = tmp_path / "games.duckdb"
    _build_mart(db, extra=_niche_game_marts)
    m = load_mcp(db)
    out = m.niche_games("tag", "Clean Pick")
    assert out["window"] == "24m" and out["min_reviews"] == 50
    assert out["stats"]["n_games"] == 2 and out["n_returned"] == 2
    assert {g["appid"] for g in out["games"]} == {1, 2}
    indie = m.niche_games("tag", "Clean Pick", scope="indie")
    assert indie["stats"]["n_games"] == 1 and indie["games"][0]["appid"] == 1
    by_name = m.niche_games("tag", "Clean Pick", sort="name", order="asc")
    assert [g["name"] for g in by_name["games"]] == ["Alpha Quest", "Beta Rogue"]
    bad = m.niche_games("tag", "Clean Pick", min_reviews=100)
    assert "not materialised" in bad["error"] and "(24m, 50)" in bad["error"]
    # Aliases resolve through mart_tag_alias when the mart carries it.
    aliased = m.niche_games("tag", "Roguelite")
    assert aliased["key"] == "Clean Pick" and "alias" in aliased["key_note"]
    # ...and niche_detail's representative games become cut-aware.
    d = m.niche_detail("tag", "Roguelite")
    assert d["key"] == "Clean Pick"
    assert d["representative_games_cut"] == {"window": "24m", "min_reviews": 50}
    assert [g["appid"] for g in d["representative_games"]] == [1, 2]


def test_niche_games_on_a_mart_without_membership_says_rebuild(load_mcp, tmp_path):
    db = tmp_path / "nomembership.duckdb"
    _build_mart(db)
    m = load_mcp(db)
    assert "mart_niche_game" in m.niche_games("tag", "Clean Pick")["error"]


# ---- JSON-native values --------------------------------------------------------------------

def _decimal_channel_marts(conn):
    # The real mart's types (etl/marts/mart_channel_buzz.sql): DECIMAL(38,1) weights and a
    # HUGEINT total — `float += Decimal` crashed include_series, and the SDK's str()
    # fallback shipped "55.0" strings on the default path.
    conn.execute(
        "CREATE TABLE mart_channel_buzz_summary (term VARCHAR, total_mentions HUGEINT, "
        "total_weighted DECIMAL(38,1), recent_avg_weighted DOUBLE, prior_avg_weighted DOUBLE, "
        "slope_weighted DOUBLE, direction VARCHAR)"
    )
    conn.execute("INSERT INTO mart_channel_buzz_summary VALUES ('cozy sim', 55, 55.0, 7.3, 3.0, 4.3, 'rising')")
    conn.execute(
        "CREATE TABLE mart_channel_buzz (term VARCHAR, channel VARCHAR, period VARCHAR, "
        "month_idx BIGINT, n_mentions BIGINT, reach_weighted_score DECIMAL(38,1))"
    )
    conn.execute(
        "INSERT INTO mart_channel_buzz VALUES ('cozy sim', 'press', '2026-07', 1, 20, 20.0), "
        "('cozy sim', 'press', '2026-08', 2, 35, 35.0)"
    )


def test_decimal_columns_come_back_as_numbers_everywhere(load_mcp, tmp_path):
    db = tmp_path / "decimal.duckdb"
    _build_mart(db, extra=_decimal_channel_marts)
    m = load_mcp(db)
    full = m.channel_buzz("rising", include_series=True)  # used to raise TypeError
    term = full["terms"][0]
    assert term["total_weighted"] == 55.0 and isinstance(term["total_weighted"], float)
    assert term["by_channel"] == [{"channel": "press", "n_mentions": 55, "reach_weighted_score": 55.0}]
    assert [p["reach_weighted_score"] for p in term["series"]] == [20.0, 35.0]
    lean = m.channel_buzz("rising")
    assert {k: v for k, v in term.items() if k != "series"} == lean["terms"][0]
    # On the wire: JSON numbers, not "55.0" strings — and the press-only reality is said.
    wire = json.loads(_wire(m, "channel_buzz", {}))
    assert wire["terms"][0]["total_weighted"] == 55.0
    assert "buzz_trends" in wire["caveats"][0]


# ---- players windows anchored to the mart --------------------------------------------------

def _players_marts(conn):
    conn.execute("CREATE TABLE mart_game_players_daily (appid BIGINT, date DATE, players BIGINT, n_captures BIGINT)")
    # Game 1 measured 2025-01-01..20 (players = day of month); game 2 only in early December.
    conn.executemany("INSERT INTO mart_game_players_daily VALUES (?, ?, ?, 1)",
                     [[1, date(2025, 1, d), d] for d in range(1, 21)]
                     + [[2, date(2024, 12, d), 100] for d in range(1, 6)])
    conn.execute("CREATE TABLE mart_niche_players (dimension VARCHAR, key VARCHAR, date DATE, "
                 "total_players BIGINT, measured_players BIGINT, n_games_measured BIGINT, "
                 "n_games_covered BIGINT, n_games_panel BIGINT)")
    conn.executemany("INSERT INTO mart_niche_players VALUES ('tag', 'Clean Pick', ?, ?, ?, 10, 10, 12)",
                     [[date(2025, 1, d), d * 10, d * 10] for d in range(1, 21)])
    conn.execute("CREATE TABLE mart_game_players_history (appid BIGINT, date DATE, grain VARCHAR, "
                 "source VARCHAR, avg_players DOUBLE, peak_players BIGINT)")
    conn.executemany("INSERT INTO mart_game_players_history VALUES (1, ?, 'monthly', 'steamcharts_monthly', 50.0, 90)",
                     [[date(y, mo, 1)] for y in (2023, 2024) for mo in range(1, 13)] + [[date(2025, 1, 1)]])


def test_player_windows_anchor_to_the_marts_last_capture(load_mcp, tmp_path):
    # A mart whose captures end 2025-01-20: anchored to CURRENT_DATE this returned zero rows
    # plus "likely rotated out or delisted", and window_peak.date was the string "None".
    db = tmp_path / "players.duckdb"
    _build_mart(db, extra=_players_marts)
    m = load_mcp(db)
    g = m.game_player_history(1, days=7)
    assert g["summary"]["as_of"] == "2025-01-20"
    assert [r["date"] for r in g["series"]] == [f"2025-01-{d}" for d in range(14, 21)]
    assert g["summary"]["window_peak"] == {"date": "2025-01-20", "players": 20}
    assert g["summary"]["latest"] == {"date": "2025-01-20", "players": 20}
    # The monthly (steamcharts) block is bounded by the same window.
    assert [r["month"] for r in g["monthly"]] == ["2025-01-01"]
    assert len(m.game_player_history(1, days=400)["monthly"]) == 14  # 2023-12 .. 2025-01
    # A game genuinely absent from the window: empty series, a real null peak, honest note.
    stale = m.game_player_history(2, days=7)
    assert stale["series"] == []
    assert stale["summary"]["window_peak"] == {"date": None, "players": None}
    assert any("none in the 7 days up to the mart's last capture (2025-01-20)" in c for c in stale["caveats"])
    n = m.niche_player_history("tag", "clean pick", days=7)
    assert n["key"] == "Clean Pick" and n["summary"]["as_of"] == "2025-01-20"
    assert len(n["series"]) == 7 and n["series"][-1] == {
        "date": "2025-01-20", "total_players": 200, "measured_players": 200, "n_games_measured": 10}


# ---- older marts: gated, never a raw Binder error ------------------------------------------

def test_older_mart_shapes_degrade_instead_of_raising(load_mcp, tmp_path):
    db = tmp_path / "old_game.duckdb"
    _build_mart(db, game_drop=("first_seen", "lifetime_months", "lifetime_alive", "name_lower",
                               "short_description"))
    m = load_mcp(db)
    found = m.game_search(q="alpha")
    assert [g["appid"] for g in found["games"]] == [1], found
    assert "game-lifetime" in m.game_search(sort="lifetime_months")["error"]
    assert "first_seen" in m.game_search(sort="first_seen")["error"]
    # game_profile always selects short_description: the Binder error becomes a named,
    # actionable message, still wrapped in the envelope.
    prof = m.game_profile(1)
    assert "`short_description`" in prof["error"] and "Rebuild" in prof["error"]
    assert prof["score_version"] == "v2"
    # min_positive is a FRACTION; direct callers get the same hint the schema gives.
    assert "did you mean 0.8" in m.game_search(min_positive=80)["error"]


def test_bounded_blocks_and_opt_in_curves(load_mcp, tmp_path):
    def extra(conn):
        conn.execute("CREATE TABLE mart_game_reviews_timeline (appid BIGINT, period VARCHAR, "
                     "n_reviews HUGEINT, n_positive HUGEINT, cum_reviews HUGEINT, cum_positive HUGEINT, "
                     "cum_positive_share DOUBLE, trailing_reviews HUGEINT, trailing_positive_share DOUBLE)")
        periods = [f"{2022 + i // 12}-{i % 12 + 1:02d}" for i in range(40)]
        conn.executemany("INSERT INTO mart_game_reviews_timeline VALUES (1, ?, 10, 9, ?, ?, 0.9, 30, 0.9)",
                         [[p, 10 * (i + 1), 9 * (i + 1)] for i, p in enumerate(periods)])
        for t, cols in (("mart_game_reviews_lang", "language VARCHAR, n BIGINT, share DOUBLE"),
                        ("mart_game_reviews_playtime", "pctile VARCHAR, value DOUBLE")):
            conn.execute(f"CREATE TABLE {t} (appid BIGINT, {cols})")
        conn.execute("CREATE TABLE mart_game_launch_curve (appid BIGINT, day BIGINT, cum_fraction DOUBLE, "
                     "sample_first_year_reviews BIGINT)")
        conn.executemany("INSERT INTO mart_game_launch_curve VALUES (1, ?, ?, 100)",
                         [[d, min(1.0, d / 365)] for d in (0, 7, 14, 30, 60, 90, 180, 365)])
        conn.execute("CREATE TABLE mart_market_lifetime (t BIGINT, n_observable BIGINT, share_alive DOUBLE)")
        conn.executemany("INSERT INTO mart_market_lifetime VALUES (?, 1000, ?)",
                         [[t, 1 - t / 100] for t in range(73)])

    db = tmp_path / "bounded.duckdb"
    _build_mart(db, extra=extra)
    m = load_mcp(db)
    s = m.game_reviews_summary(1)
    assert len(s["timeline"]) == 24 and s["timeline"][-1]["period"] == "2025-04"
    assert s["timeline_summary"]["n_months"] == 40 and s["timeline_summary"]["cum_reviews"] == 400
    assert "launch_curve" not in s and len(s["launch_shape_windows"]) == 7
    assert len(m.game_reviews_summary(1, months=6)["timeline"]) == 6
    assert len(m.game_reviews_summary(1, include_launch_curve=True)["launch_curve"]) == 8
    lc = m.lifetime_curve()
    assert "curve" not in lc and lc["milestones"]["m12"] == 0.88 and lc["median_months"] == 50
    assert len(m.lifetime_curve(include_curve=True)["curve"]) == 73


# ---- hot reload ----------------------------------------------------------------------------

def test_mart_swap_is_hot_reloaded_and_probes_rerun(load_mcp, tmp_path):
    # The nightly ETL publishes by retargeting data/current.duckdb. A process that opened
    # the old file must notice (at most every RELOAD_CHECK_S), reopen, and re-probe — the
    # score_version flip below only happens if the cached column probes were invalidated.
    old, new = tmp_path / "prospect_a.duckdb", tmp_path / "prospect_b.duckdb"
    _build_mart(old, v2=False, built_at=datetime(2026, 8, 1, tzinfo=timezone.utc))
    _build_mart(new, v2=True, built_at=datetime.now(timezone.utc))
    link = tmp_path / "current.duckdb"
    os.symlink(old, link)
    m = load_mcp(link)
    before = m.find_niches()
    assert before["mart_version"] == "20260801" and before["score_version"] == "v1-legacy"
    assert "momentum" not in before["niches"][0]

    tmp_link = tmp_path / "current.duckdb.tmp"
    os.symlink(new, tmp_link)
    os.replace(tmp_link, link)  # the atomic swap the ETL does
    # Within the check interval nothing is re-statted (the check is cheap on purpose)...
    assert m.find_niches()["mart_version"] == "20260801"
    # ...once it elapses, the next call reopens the new file.
    m.RELOAD_CHECK_S = 0.0
    after = m.find_niches()
    assert after["mart_version"] == datetime.now(timezone.utc).strftime("%Y%m%d")
    assert after["score_version"] == "v2" and after["warnings"] == []
    assert "momentum" in after["niches"][0]
    assert m._generation == 1
    # No swap -> no reopen.
    m.find_niches()
    assert m._generation == 1


def test_same_day_rebuild_over_the_same_name_is_reloaded(load_mcp, tmp_path):
    # A same-day rebuild os.replace()s a NEW prospect_YYYYMMDD.duckdb over the SAME name, so
    # the resolved path doesn't change — only the inode does. duckdb.connect(path) would hand
    # back DuckDB's per-process cached instance of the OLD file while the old connection is
    # still open (it is, during the swap), silently serving yesterday's data under a fresh
    # generation. The private-instance ATTACH in _open() must read the file on disk now.
    versioned = tmp_path / "prospect_20260801.duckdb"
    _build_mart(versioned, v2=False, built_at=datetime(2026, 8, 1, tzinfo=timezone.utc))
    link = tmp_path / "current.duckdb"
    os.symlink(versioned.name, link)
    m = load_mcp(link)
    assert m.find_niches()["score_version"] == "v1-legacy"

    rebuilt = tmp_path / "prospect_20260801.duckdb.building"
    _build_mart(rebuilt, v2=True, built_at=datetime(2026, 8, 1, 23, tzinfo=timezone.utc))
    os.replace(rebuilt, versioned)  # same name, new inode — the light-build/nightly collision
    m.RELOAD_CHECK_S = 0.0
    after = m.find_niches()
    assert after["score_version"] == "v2", "reload returned the cached OLD instance"
    assert "momentum" in after["niches"][0]
    assert m._generation == 1


def test_studio_dominated_flag_and_the_indie_lens_on_an_older_mart(load_mcp, tmp_path):
    # The solo/indie evidence (mart_niche_indie.sql): a niche whose $100K+ games mostly come
    # from bigger teams carries studio_dominated; a mart without the column can't raise it,
    # and asking for the lens there is a clear rebuild error, never a silent fallback.
    path = tmp_path / "prospect_20260901.duckdb"
    _build_mart(path, v2=True, built_at=datetime.now(timezone.utc))
    m = load_mcp(path)
    assert "studio_dominated" in m._niche_flags({"indie_friendly": False, "solo_tier": "solo"})
    assert "studio_dominated" not in m._niche_flags({"indie_friendly": True, "solo_tier": "solo"})
    assert "studio_dominated" not in m._niche_flags({"solo_tier": "solo"})
    out = m.find_niches(indie_friendly=True)
    assert "predates the solo/indie evidence" in out["error"]
