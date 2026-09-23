"""Prospect MCP server — Steam market-intelligence marts exposed as agent tools.

Mirrors the pattern in steam-scraper/steam_scraper/mcp_server.py (FastMCP, read-only DB,
`python <this file>` / stdio transport) but reads Prospect's CURATED DuckDB marts
(data/current.duckdb in the main `prospect` app, built by `task etl`) instead of the raw
source catalog — answers are precomputed, so they're both fast and token-cheap. This file
owns its own thin read queries against the marts; it deliberately does NOT import or
refactor api/app/* (that's a separate, concurrently-edited part of the app) — some query
and constant duplication vs. the FastAPI routers is intentional, see api/app/routers/*.py
and api/app/benchmarks.py for the endpoints this mirrors.

Every tool goes through `_tool` (see "Tool plumbing" below), which gives it:
  - HOT RELOAD: a mart swap (data/current.duckdb retargeted by the nightly ETL) is noticed
    within RELOAD_CHECK_S and the connection reopened; capability probes are re-run.
  - An ENVELOPE leading every response — data_as_of / mart_version / score_version /
    warnings — so a stale or pre-v2 mart can never answer silently.
  - JSON-safe values (DECIMAL -> float, DATE -> ISO string, NaN -> null, magnitude-based
    rounding) and COMPACT JSON on the wire (pretty-printing cost ~29% of every response).
  - A friendly "this mart predates <column>; rebuild" error instead of a raw DuckDB
    Binder/Catalog exception when an older mart lacks something.

Claude Code truncates every tool description and the server instructions at ~2,048 chars,
so each stays under DESCRIPTION_BUDGET with the analysis RULES FIRST; parameter docs live
in the JSON schema (Annotated[..., Field(description=...)]); the long methodology lives in
the `methodology` tool and the prospect-data-dictionary resource. The rules are also
enforced in the OUTPUT: find_niches / niche_detail rows carry server-computed `flags` and a
`rules` legend, so they reach the model even if every description were truncated.
"""
from __future__ import annotations

import functools
import inspect
import json
import math
import os
import re
import statistics
import sys
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone
from datetime import time as dt_time
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Iterable, Literal
from uuid import UUID

import duckdb
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import AfterValidator, Field

# ----------------------------------------------------------------------------------------
# DB connection — one read-only connection + lock (same idiom as api/app/analytics_db.py;
# this file's only relationship to that module is mirroring its idiom, not importing it).
# ----------------------------------------------------------------------------------------
DB_PATH = Path(
    os.environ.get(
        "PROSPECT_ANALYTICS_DB_PATH",
        # Default: this repo's own data/current.duckdb, computed relative to this file
        # (mcp/ -> repo root) so any checkout or worktree resolves it without a hardcoded
        # user path. The env var still overrides (CI fixture, hosted container).
        str(Path(__file__).resolve().parent.parent / "data" / "current.duckdb"),
    )
)

if not DB_PATH.exists():
    raise FileNotFoundError(
        f"Analytics DB not found at {DB_PATH}. Build it in the main `prospect` checkout "
        "first (`task etl`), or set PROSPECT_ANALYTICS_DB_PATH to point at a built "
        "current.duckdb."
    )

# HOT RELOAD. The nightly ETL publishes a new mart by atomically retargeting
# data/current.duckdb (a symlink) at a freshly built prospect_YYYYMMDD.duckdb. A connection
# opened once at import keeps reading the file it was opened on for the life of the
# process, so a long-lived stdio session or /mcp worker silently served an old mart until
# someone restarted it. Mirrors the API's reload idea independently (no api/ import, per
# the header): at most every RELOAD_CHECK_S a tool call stats DB_PATH, and when it now
# resolves to a different file (realpath or inode changed) the connection is reopened under
# the query lock. Every capability probe / cached lookup is keyed on _generation, so an
# answer computed against the old file can never be served for the new one.
RELOAD_CHECK_S = 30.0


def _db_identity() -> tuple[str, int, int] | None:
    """(resolved path, st_dev, st_ino) of the file DB_PATH points at right now; None while it
    is missing (mid-swap). Both halves matter: a symlink retarget changes the resolved path,
    an os.replace() of a plain file keeps the path but changes the inode."""
    try:
        real = os.path.realpath(DB_PATH)
        st = os.stat(real)
    except OSError:
        return None
    return real, st.st_dev, st.st_ino


# The catalog name the mart is ATTACHed under; every cursor `USE`s it (see _open).
_MART = "mart"


def _open(path: str) -> duckdb.DuckDBPyConnection:
    """A private in-memory DuckDB instance with the mart file ATTACHed read-only.

    NOT duckdb.connect(path): DuckDB caches one database instance per path per process, so
    after a same-day rebuild (a NEW prospect_YYYYMMDD.duckdb os.replace()d over the SAME
    name) a plain connect hands back the cached instance — the OLD file's data — for as
    long as any connection to it is open (measured on 1.5.5; api/app/analytics_db.py hit
    the same trap and uses the same cure). Here the old connection is still open while the
    new one is made, so a reload would swap in yesterday's data under a fresh generation.
    An in-memory connection is never cached and ATTACH opens the file on disk right now."""
    conn = duckdb.connect(
        ":memory:",
        # An in-memory instance would otherwise spill into ./.tmp of whatever cwd the stdio
        # client launched us from.
        config={"temp_directory": os.path.join(tempfile.gettempdir(), "prospect-mcp.tmp")},
    )
    try:
        conn.execute(f"ATTACH '{path.replace(chr(39), chr(39) * 2)}' AS {_MART} (READ_ONLY)")
        conn.execute(f"USE {_MART}")
    except Exception:
        conn.close()
        raise
    return conn


_identity = _db_identity()
# Opened on the RESOLVED path so the connection reads exactly the file _identity describes,
# even if the symlink is retargeted between the stat and the connect.
_conn = _open(_identity[0] if _identity else str(DB_PATH))
_lock = threading.Lock()  # serialises every read on the shared connection
_reload_lock = threading.Lock()  # one reload check / swap at a time
_generation = 0  # bumped on every swap; every cache below is keyed on it
_last_reload_check = time.monotonic()
_closed = False


def _log(msg: str) -> None:
    # stderr, never stdout: stdout IS the MCP protocol stream in stdio mode.
    print(f"[prospect-mcp] {msg}", file=sys.stderr, flush=True)


def _maybe_reload(force: bool = False) -> bool:
    """Reopen the connection if DB_PATH now resolves to a different mart. Returns at once
    unless RELOAD_CHECK_S passed since the last check (or force=True), so it costs one
    monotonic() read per tool call. A failed reopen keeps serving the old mart and retries
    at the next check. Returns True when a swap happened."""
    global _conn, _identity, _generation, _last_reload_check
    if _closed or (not force and time.monotonic() - _last_reload_check < RELOAD_CHECK_S):
        return False
    with _reload_lock:
        if _closed or (not force and time.monotonic() - _last_reload_check < RELOAD_CHECK_S):
            return False
        _last_reload_check = time.monotonic()
        new_identity = _db_identity()
        if new_identity is None or new_identity == _identity:
            return False
        try:
            new_conn = _open(new_identity[0])
        except duckdb.Error as exc:
            _log(f"mart swap to {new_identity[0]} seen but reopen failed ({exc!r}); "
                 f"still serving {_identity[0] if _identity else DB_PATH}")
            return False
        with _lock:
            if _closed:
                new_conn.close()
                return False
            old, _conn = _conn, new_conn
            _identity = new_identity
            # Bumped AFTER _conn is replaced: a reader that sees the new generation is
            # guaranteed to query the new connection.
            _generation += 1
        try:
            old.close()
        except Exception:  # noqa: BLE001 — the old conn is abandoned either way
            pass
        _log(f"mart swapped -> {new_identity[0]} (generation {_generation})")
        return True


# Column types whose Python values are not JSON-native. DuckDB hands back DECIMAL as
# decimal.Decimal (the SDK's str() fallback then shipped "55.0" strings, and
# `float += Decimal` crashed channel_buzz) and DATE as datetime.date — coerced HERE, once,
# for every tool, instead of per call site.
_COERCE_TYPES = ("DECIMAL", "DATE", "TIME", "INTERVAL", "UUID")


def _to_json_native(v: Any) -> Any:
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (datetime, date, dt_time)):
        return v.isoformat()
    if isinstance(v, timedelta):
        return v.total_seconds()
    if isinstance(v, UUID):
        return str(v)
    if isinstance(v, (list, tuple)):
        return [_to_json_native(x) for x in v]
    if isinstance(v, dict):
        return {k: _to_json_native(x) for k, x in v.items()}
    return v


@lru_cache(maxsize=256)
def _needs_coercion(type_name: str) -> bool:
    return any(t in type_name for t in _COERCE_TYPES)


def query(sql: str, params: list[Any] | None = None) -> list[dict]:
    with _lock:
        cur = _conn.cursor()
        # A cursor is a new connection whose default catalog is the empty ":memory:" one.
        cur.execute(f"USE {_MART}")
        cur.execute(sql, params or [])
        desc = cur.description or []
        rows = cur.fetchall()
    cols = [d[0] for d in desc]
    coerce = [_needs_coercion(str(d[1])) for d in desc]
    if not any(coerce):
        return [dict(zip(cols, row)) for row in rows]
    return [
        {c: (_to_json_native(v) if f and v is not None else v) for c, f, v in zip(cols, coerce, row)}
        for row in rows
    ]


def query_one(sql: str, params: list[Any] | None = None) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def close() -> None:
    """Close the module-global read-only DuckDB connection. Idempotent — the hosted API
    calls this from its shutdown path (api/app/main.py lifespan); standalone stdio runs
    simply exit and never need it. After close(), query() raises (and no hot reload
    reopens it), so it must be the last thing this module does."""
    global _closed
    with _lock:
        if _closed:
            return
        _closed = True
        _conn.close()


# ----------------------------------------------------------------------------------------
# Schema-capability probes — which additive marts/columns this current.duckdb carries.
# LAZY on purpose (evaluated on first use): the hosted API imports this module at startup,
# and running every probe per worker at import time taxed each cold start. Cached per
# _generation — ONE information_schema read per table per mart — so a hot-reloaded mart is
# re-probed from scratch and a probe answered against the old file is never read again.
# None of these feed docstrings or registration-time logic (docstrings are static).
# ----------------------------------------------------------------------------------------
@lru_cache(maxsize=None)
def _table_columns(gen: int, table: str) -> frozenset[str]:
    return frozenset(
        r["column_name"]
        for r in query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?", [table]
        )
    )


@lru_cache(maxsize=None)
def _tables(gen: int) -> frozenset[str]:
    return frozenset(r["table_name"] for r in query("SELECT table_name FROM information_schema.tables"))


def _cols(table: str) -> frozenset[str]:
    """The columns `table` has in the CURRENT mart (empty when the table is absent)."""
    return _table_columns(_generation, table)


def _has_column(table: str, column: str) -> bool:
    return column in _cols(table)


def _has_table(table: str) -> bool:
    return table in _tables(_generation)


def _has_name_lower() -> bool:
    """mart_game.name_lower (persisted lower(name)); if present game_search filters via
    the cheaper contains(name_lower, ?) rather than name ILIKE '%q%'."""
    return _has_column("mart_game", "name_lower")


def _has_players() -> bool:
    """Live-player (CCU) marts/columns (mart_players.sql — daily per-game history, niche
    rollup, and the players_* summary columns on mart_game/mart_niche). Both column sets
    land in the same ETL build; checked together so a half-present state (impossible via
    the atomic mart swap) still degrades safely."""
    return _has_column("mart_game", "players_7d_avg") and _has_column(
        "mart_niche", "total_players_now"
    )


def _has_players_history() -> bool:
    return _has_table("mart_game_players_history")


def _has_players_dist() -> bool:
    return _has_column("mart_niche", "players_top5_share")


def _has_lifetime() -> bool:
    """Game-lifetime columns/table (mart_players.sql _game_lifetime/_niche_lifetime +
    mart_market_lifetime): how long a game keeps an audience once it has one — t0 = first
    calendar month averaging >= 100 concurrent players, death = first FULL month after t0
    averaging < 10 (steamcharts monthly, top-8k-by-reviews coverage). Three probes
    (_has_lifetime/_has_lifetime_game/_has_lifetime_curve) because the columns land on
    different marts."""
    return _has_column("mart_niche", "lifetime_survival_12m")


def _has_lifetime_game() -> bool:
    return _has_column("mart_game", "lifetime_months")


def _has_lifetime_curve() -> bool:
    return _has_table("mart_market_lifetime")


def _has_dev_socials() -> bool:
    """Dev-socials columns: mart_game.dev_x_handle (the game's most prominent official X
    handle, harvested from its developer-CONTROLLED pages — store page + dev website —
    never from X itself) and the majority-vote mart_entity.x_handle built from it. Both
    land in the same ETL build; checked together, same idiom as _has_players."""
    return _has_column("mart_game", "dev_x_handle") and _has_column(
        "mart_entity", "x_handle"
    )


def _has_demo() -> bool:
    """DEMO flag (mart_game.has_demo/demo_appid — the game's playable Steam demo, from
    its own appdetails). has_demo is TRI-STATE: NULL means the game's appdetails has not
    been re-read since demo capture landed, i.e. "not checked", never "no demo"."""
    return _has_column("mart_game", "has_demo")


def _has_all_socials() -> bool:
    """Every harvested social platform (Discord/YouTube/Bluesky + the X profile URL)
    rather than only dev_x_handle. The harvest always collected all four; older marts
    simply dropped everything but X."""
    return _has_column("mart_game", "dev_discord_url")


def _has_metacritic_url() -> bool:
    """metacritic_url (the Metacritic page Steam links in appdetails). The SCORE needs no
    gate — every mart has it; only the outbound link is conditional."""
    return _has_column("mart_game", "metacritic_url")


def _has_game_reviews() -> bool:
    """Per-game review marts behind game_reviews_summary / aspect_reviews. Probed like
    the other additive marts so an older analytics DB degrades with a message instead of
    a SQL error."""
    return _has_table("mart_game_reviews_timeline")


def _has_aspect_reviews() -> bool:
    return _has_table("mart_game_aspect_reviews")


def _has_niche_p90() -> bool:
    """Revenue percentiles per niche (p25/p75/p90_rev). The median is the wrong target for
    someone deciding what to build: it is dragged down by asset flips and abandoned
    projects, while p90 is what a niche pays when the game actually lands."""
    return _has_column("mart_niche", "p90_rev")


def _has_demand24m() -> bool:
    """24-month demand trend per niche (reviews_24m / reviews_prev_24m /
    demand_trend_24m_pct, plus the emerging pair reviews_24m_new_share / demand_emerging
    — one ETL build, one probe). These REPLACED the earlier 12-month columns outright
    (which had replaced the 90-day ones), so a mart carrying only those old columns probes
    False here and the fields are simply omitted."""
    return _has_column("mart_niche", "demand_trend_24m_pct")


def _has_v2_parts() -> bool:
    """opportunity_v2's sub-scores (momentum / supply_room / revenue_spread / market_pull
    / supply_brake) plus solo_tier — the 2026-08-31 score rebuild, one ETL build, one
    probe. It also decides the envelope's score_version: without them the mart's
    opportunity_v2 is the OLD formula (opportunity x decline_gate), which ranked the
    opposite way to the Radar's rings."""
    return _has_column("mart_niche", "supply_brake")


@lru_cache(maxsize=None)
def _no_floor_cut(gen: int) -> bool:
    # Row probe, not a schema probe: the min_reviews=0 (no-floor) cut adds ROWS to
    # mart_niche, not columns, so its presence is detected by looking for one.
    return bool(query("SELECT 1 FROM mart_niche WHERE min_reviews = 0 LIMIT 1"))


def _has_no_floor_cut() -> bool:
    return _no_floor_cut(_generation)


@lru_cache(maxsize=None)
def _max_date(gen: int, table: str) -> date | None:
    """MAX(date) of a daily players mart — the ANCHOR every players window is measured
    back from. Anchoring to CURRENT_DATE made an older mart look empty ("likely rotated
    out or delisted") for games it has plenty of history for. Table names are this
    module's own literals, never caller input."""
    row = query_one(f"SELECT MAX(date) AS d FROM {table}")
    d = row["d"] if row else None
    return date.fromisoformat(d) if d else None


_PLAYERS_MISSING = (
    "this analytics DB predates the live-player (CCU) marts (mart_game_players_daily / "
    "mart_niche_players and the players_* columns on mart_game/mart_niche) — it was built "
    "by an older ETL. Re-run the ETL (`task etl` in the main prospect checkout) and retry."
)

_LIFETIME_MISSING = (
    "This mart predates the game-lifetime columns (an older ETL build). Re-run the ETL "
    "(`task etl` in the main prospect checkout) and retry."
)

_DEMO_MISSING = (
    "This mart predates the demo columns (has_demo/demo_appid, an older ETL build). Re-run "
    "the ETL (`task etl` in the main prospect checkout) and retry."
)

_NO_FLOOR_MISSING = (
    "This mart predates the no-floor (min_reviews=0) cut of mart_niche (an older ETL "
    "build). Use min_reviews=50 or 100, or re-run the ETL (`task etl`) and retry."
)


def _column_missing(table: str, column: str) -> str:
    return (
        f"This mart predates {table}.{column} (an older ETL build). Rebuild the mart "
        "(`task etl` in the main prospect checkout) and retry."
    )


# The two marts EVERY tool path ultimately reads. Not a capability probe: their absence is
# not a degradable feature gap, it is a broken analytics DB.
_CORE_MARTS = ("mart_game", "mart_niche")


def missing_core_marts() -> list[str]:
    """Names from _CORE_MARTS this DB does not carry as a NON-EMPTY table ([] = healthy).

    The deliberate exception to the laziness above, and the one query this module runs
    before a tool is called. The hosted API (api/app/mcp_mount.py) calls it once at load
    time and refuses to mount /mcp when it returns anything: with every capability probe
    lazy, a mart-less or half-built current.duckdb (failed/OOM-killed nightly ETL) would
    otherwise import cleanly, advertise every tool, and then raise raw
    duckdb.CatalogException inside every connected Claude client with nothing in the
    startup log to say the MCP was broken. Two cheap queries (catalog lookup + COUNT).
    Standalone stdio runs never call it — a human running `python prospect_mcp.py`
    against a broken DB sees the CatalogException directly, which is the right answer
    there.
    """
    marks = ", ".join("?" for _ in _CORE_MARTS)
    present = {
        r["table_name"]
        for r in query(
            f"SELECT table_name FROM information_schema.tables WHERE table_name IN ({marks})",
            list(_CORE_MARTS),
        )
    }
    missing = [t for t in _CORE_MARTS if t not in present]
    if missing:
        return missing
    # Table names are this module's own literals, never caller input — safe to inline.
    counts = query_one(
        "SELECT " + ", ".join(f'(SELECT COUNT(*) FROM {t}) AS "{t}"' for t in _CORE_MARTS)
    ) or {}
    return [t for t in _CORE_MARTS if not counts.get(t)]


# Shared caveats for every players/CCU read — the two ways these series lie if unstated.
_PLAYERS_POINT_SAMPLE_CAVEAT = (
    "players values are nightly point samples (one capture per game per day, ~21-22:00 UTC "
    "sweep) — NOT daily peaks. SteamDB-style peak numbers run higher (our sample is "
    "typically ~60-90% of the daily peak)."
)
_PLAYERS_HISTORY_CAVEAT = (
    "History starts 2026-07-18. Games outside the top-8k-by-reviews head are captured on a "
    "~3-8 night rotation, so their daily series have gaps — a gap means UNMEASURED, never "
    "zero. Tail games are especially sparse before ~2026-08-14 (pre-rotation collector); "
    "do not read that sparsity as player decline."
)


# ----------------------------------------------------------------------------------------
# JSON-safe rounding. Magnitude-based so no field carries garbage digits: >= 1000 -> whole
# number (revenue, owners, review counts — they are estimates anyway), >= 1 -> 2 decimals
# (0-100 scores, ratios, prices), below 1 -> 4 decimals (shares). NaN/inf -> null (JSON
# has no NaN, and a strict client rejects the whole response over one).
# ----------------------------------------------------------------------------------------
def _num(v: float) -> float | int | None:
    if not math.isfinite(v):
        return None
    a = abs(v)
    if a >= 1000:
        return int(round(v))
    if a >= 1:
        return round(v, 2)
    return round(v, 4)


def _jsonable(v: Any) -> Any:
    if isinstance(v, float):
        return _num(v)
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, Decimal):
        return _num(float(v))
    if isinstance(v, (datetime, date, dt_time)):
        return v.isoformat()
    return v


def clean(row: dict) -> dict:
    """Round floats (recursively) so DuckDB float noise like 75524.40000000001 doesn't
    burn agent context on garbage digits."""
    return _jsonable(row)


def clean_rows(rows: list[dict]) -> list[dict]:
    return _jsonable(rows)


def _usd(v: Any) -> str:
    """'$1,234' for a revenue figure, 'n/a' when it is NULL (free games carry no revenue
    estimate, so a free-dominated niche/pair can have a NULL median)."""
    return f"${v:,.0f}" if isinstance(v, (int, float)) else "n/a"


# ----------------------------------------------------------------------------------------
# Researched indie-market benchmark constants — mirrors api/app/benchmarks.py's CITED
# figures (VG Insights / GameDiscoverCo / Boxleiter-method research), duplicated
# intentionally per this file's header (own thin reads, not a shared import).
# ----------------------------------------------------------------------------------------
MEDIAN_INDIE_GROSS_USD = 249
PCT_NEW_RELEASES_OVER_100K = 0.085
BOTTOM_30_PCT_GROSS_USD = 37
REVIEWS_1000_REVENUE_USD = 150_000

BOXLEITER_OWNERS_PER_REVIEW_MIN = 20
BOXLEITER_OWNERS_PER_REVIEW_MID = 30
BOXLEITER_OWNERS_PER_REVIEW_MAX = 55

WISHLIST_CONVERSION_FIRST_WEEK = 0.10
WISHLIST_CONVERSION_RANGE = (0.08, 0.12)
FIRST_WEEK_TO_FIRST_YEAR_MULT = 5

STEAM_REVENUE_SHARE_TO_DEV = 0.70

DEV_TIERS = [
    {"label": "Hobby", "min_copies": 2_000, "max_copies": 20_000, "revenue_anchor_usd": 50_000},
    {"label": "Small", "min_copies": 20_000, "max_copies": 200_000, "revenue_anchor_usd": 1_000_000},
    {"label": "Middle", "min_copies": 200_000, "max_copies": 1_000_000, "revenue_anchor_usd": 10_000_000},
    {"label": "Triple-I", "min_copies": 1_000_000, "max_copies": None, "revenue_anchor_usd": 50_000_000},
]


def _tier_for_copies(copies: float | None) -> str:
    if copies is None:
        return "Unknown"
    if copies < DEV_TIERS[0]["min_copies"]:
        return "Below Hobby"
    for tier in DEV_TIERS:
        hi = tier["max_copies"]
        if hi is None or copies < hi:
            return tier["label"]
    return DEV_TIERS[-1]["label"]


def _genre_owners_per_review(genre: str | None) -> tuple[str, float]:
    """(genre_used, mid owners/review) from the fitted Boxleiter slope for `genre`,
    clamped to the cited 20-55 band; falls back to the catalog-wide ('__all__') slope,
    then the cited mid. The web estimator's owner math lives client-side now (the old
    api/app/routers/estimate.py it once mirrored is gone); this is the MCP's own copy."""
    lo, hi = float(BOXLEITER_OWNERS_PER_REVIEW_MIN), float(BOXLEITER_OWNERS_PER_REVIEW_MAX)
    default = float(BOXLEITER_OWNERS_PER_REVIEW_MID)
    for candidate in [genre, "__all__"]:
        if not candidate:
            continue
        row = query_one("SELECT genre, slope FROM mart_market_boxleiter WHERE genre = ?", [candidate])
        if row and row["slope"] is not None:
            return (row["genre"], max(lo, min(hi, float(row["slope"]))))
    return ("__all__", default)


# ----------------------------------------------------------------------------------------
# The analysis rules + the flags that enforce them. ONE source for the server instructions,
# the find_niches/niche_detail `rules` legend, and methodology('rules'). Thresholds mirror
# web/src/lib/radarVerdict.ts (WC_WINNER_TAKE_MOST, SAT_FLOOD_YOY, DEMAND_HOLD_PCT,
# ENTRANT_RATIO_PAR, SOLO_FRIENDLY_MIN / SOLO_MIXED_MIN) and api/app/routers/niches.py
# (RADAR_SOLO_FRIENDLY_MIN) — keep them in lockstep.
# ----------------------------------------------------------------------------------------
WINNER_TAKE_MOST = 0.85
SAT_FLOOD_YOY = 0.15
DEMAND_FALLING_PCT = -10.0  # the Radar's "holding" bar; <= -30 is its "declining" ring
ENTRANT_RATIO_PAR = 1.0
SOLO_FRIENDLY_MIN = 0.8  # singleplayer share; below = solo_tier 'team'
SOLO_MIXED_MAX = 0.9  # 0.80-0.90 = solo_tier 'mixed'
LOW_COMPETITION = 50.0  # competition is a 0-100 percentile; below the median = "low"
THIN_SAMPLE_GAMES = 50
PLAYERS_TOP5_HITS = 0.6  # the players-lens falsification bar (methodology 'falsification')

# Severity order — bearish-first: a disqualifier before a warning before a caveat.
_FLAG_RULES: dict[str, str] = {
    "multiplayer_dependent": "solo_tier 'team' (singleplayer share < 0.80) — needs netcode, "
    "servers and a live player base: disqualify for a solo dev.",
    "umbrella_or_meta_tag": "a genre container or reception tag (Open World, Great "
    "Soundtrack) — not buildable, never a pick.",
    "decline_signature": "saturation_yoy < 0 with competition < 50 — releases shrinking in an "
    "uncrowded niche: everyone stopped entering. Read as DECLINE, not an open market.",
    "demand_falling": "24-month demand trend below -10% (<= -30% is the Radar's 'declining' "
    "ring).",
    "winner_take_most": "winner_concentration > 0.85 — revenue sits in a few hits: red flag, "
    "expect the median outcome, not the winners. The Radar never rings it 'enter' (it rings "
    "'watch': demand surging, but winner-take-most revenue).",
    "low_newcomer_economics": "entrant_ratio < 1.0 — games from the last 24 months earn less "
    "than the niche's back catalog (catalog norm ~0.79); require >= 1.0.",
    "newcomer_economics_unverified": "entrant_ratio unknown — recent-entrant pay is "
    "unverified; do not assume it passes.",
    "supply_flooding": "releases up > 15% YoY (the Radar's crowding bar) — entrants arriving "
    "faster than the niche grows.",
    "theme_tag": "a setting/aesthetic — attach it as a MODIFIER to a micro-genre pick "
    "(tag_combos), never the headline.",
    "emerging_unquotable": "young / low-base tag: its prior 24-month window is near zero by "
    "construction, so demand_trend_24m_pct is withheld — judge absolute reviews_24m.",
    "thin_sample": "fewer than 50 games in this cut — a median over few games is weak "
    "evidence.",
    "multiplayer_minority": "solo_tier 'mixed' (0.80-0.90) — a real multiplayer minority; "
    "check the top games before a solo pick.",
    "players_in_hits": "players_top5_share > 0.6 — the niche's live players are its top 5 "
    "games' audience, not demand a new entrant gets (check median_players_now).",
}
_FLAG_ORDER = tuple(_FLAG_RULES)

_GENERAL_RULES = [
    "Bearish reading first: state each flag before any score.",
    "Never quote opportunity_v2 alone: give momentum, market_pull, revenue_spread, "
    "quality_gap and supply_brake, and say which one carried it.",
    "Build decisions use window=24m; window=all is history, not the market you would enter.",
]
_GENERAL_RULES_V1 = [
    _GENERAL_RULES[0],
    "score_version is v1-legacy: opportunity_v2 here is opportunity x decline_gate (the old "
    "formula, which ranked shrinking niches on top). Quote opportunity with demand / "
    "competition / quality_gap and recommend rebuilding the mart before trusting a ranking.",
    _GENERAL_RULES[2],
]

_OWNER_RULES = [
    "Use the 24-month window (window='24m', the default) — the market a new entrant faces; "
    "window='all' is history.",
    "Negative saturation_yoy + low competition = DECLINE (everyone stopped entering), not "
    "an opportunity.",
    "Verify recent-entrant economics: entrant_ratio >= 1.0 (catalog norm ~0.79).",
    "Headline picks are micro-genres. Themes are modifiers to attach to a pick (tag_combos "
    "finds pairings); umbrella and meta tags are never picks.",
    "Multiplayer-dependent niches (solo_tier 'team', singleplayer share < 0.80) are out "
    "for solo devs.",
    "winner_concentration > 0.85 (winner-take-most) is a red flag: expect the median, not "
    "the hits.",
    "Present the bearish reading of any ambiguous metric first.",
    "Always show opportunity_v2's components (momentum, market_pull, revenue_spread, "
    "quality_gap, supply_room -> supply_brake) — never a lone number.",
    "demand_emerging niches: never quote demand_trend_24m_pct; judge absolute reviews_24m.",
]


def _niche_flags(r: dict) -> list[str]:
    """The rules above, evaluated on one mart_niche row (any cut). A flag only fires on
    evidence the row carries — a column an older mart lacks simply cannot raise its flag
    (except entrant_ratio, whose NULL is itself a finding)."""
    fired: set[str] = set()
    emerging = r.get("demand_emerging") is True
    solo = r.get("solo_tier")
    if solo is None and isinstance(r.get("solo_viability"), (int, float)):
        sv = r["solo_viability"]
        solo = "team" if sv < SOLO_FRIENDLY_MIN else "mixed" if sv < SOLO_MIXED_MAX else "solo"
    if solo == "team":
        fired.add("multiplayer_dependent")
    elif solo == "mixed":
        fired.add("multiplayer_minority")
    tier = r.get("tier")
    if tier in ("umbrella", "meta"):
        fired.add("umbrella_or_meta_tag")
    elif tier == "theme":
        fired.add("theme_tag")
    sat, comp = r.get("saturation_yoy"), r.get("competition")
    if sat is not None and comp is not None and sat < 0 and comp < LOW_COMPETITION:
        fired.add("decline_signature")
    trend = r.get("demand_trend_24m_pct")
    if not emerging and trend is not None and trend < DEMAND_FALLING_PCT:
        fired.add("demand_falling")
    # The Radar pre-empts its crowding arms for emerging niches (youth distorts the
    # release counts too), so this flag does the same.
    if not emerging and sat is not None and sat > SAT_FLOOD_YOY:
        fired.add("supply_flooding")
    wc = r.get("winner_concentration")
    if wc is not None and wc > WINNER_TAKE_MOST:
        fired.add("winner_take_most")
    if "entrant_ratio" in r:
        er = r["entrant_ratio"]
        if er is None:
            fired.add("newcomer_economics_unverified")
        elif er < ENTRANT_RATIO_PAR:
            fired.add("low_newcomer_economics")
    if emerging:
        fired.add("emerging_unquotable")
    n = r.get("n_games")
    if n is not None and n < THIN_SAMPLE_GAMES:
        fired.add("thin_sample")
    # Only where the row shows the players lens (niche_detail, or a players sort/filter in
    # find_niches) — the column is simply absent from other core rows.
    top5 = r.get("players_top5_share")
    if top5 is not None and top5 > PLAYERS_TOP5_HITS:
        fired.add("players_in_hits")
    return [c for c in _FLAG_ORDER if c in fired]


def _rules_for(flags: Iterable[str]) -> list[str]:
    """The general rules + a one-line definition of every flag that actually fired —
    short enough to ride every response, specific enough that the model can't miss it."""
    seen = set(flags)
    general = _GENERAL_RULES if _has_v2_parts() else _GENERAL_RULES_V1
    return general + [f"{c}: {_FLAG_RULES[c]}" for c in _FLAG_ORDER if c in seen]


# ----------------------------------------------------------------------------------------
# The envelope — leads every response. data_as_of is mart_meta.built_at; score_version is
# "v2" (the 2026-08-31 rebuild, components present) or "v1-legacy". warnings carry
# everything that should change how the rest of the answer is read.
# ----------------------------------------------------------------------------------------
STALE_AFTER_DAYS = 3

_V1_LEGACY_WARNING = (
    "This mart predates opportunity v2 (the 2026-08-31 score rebuild): opportunity_v2 here is "
    "the OLD formula — it ranked shrinking niches on top and has no components, so rankings "
    "differ from the Radar. Rebuild the mart (task etl) before recommending."
)


@lru_cache(maxsize=None)
def _meta(gen: int) -> dict[str, str]:
    """mart_meta as {key: value} for mart generation `gen` ({} when the mart predates it)."""
    try:
        rows = query("SELECT key, value FROM mart_meta")
    except duckdb.Error:  # absent (very old mart) or shaped differently — no metadata
        return {}
    return {str(r["key"]): r["value"] for r in rows if r["key"] is not None}


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    s = str(value)
    for candidate in (s, s[:10]):
        try:
            dt = datetime.fromisoformat(candidate)
        except ValueError:
            continue
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def _as_of_date() -> date:
    """The mart's own 'today' (mart_meta.built_at's date), so date windows describe the
    snapshot the mart holds rather than the wall clock — an older mart would otherwise
    answer 'released in the last 30 days' with nothing."""
    dt = _parse_ts(_meta(_generation).get("built_at"))
    return dt.date() if dt else datetime.now(timezone.utc).date()


def envelope() -> dict:
    meta = _meta(_generation)
    built_at = meta.get("built_at")
    v2 = _has_v2_parts()
    env: dict[str, Any] = {
        "data_as_of": built_at,
        "mart_version": meta.get("mart_version"),
        "score_version": "v2" if v2 else "v1-legacy",
    }
    warnings: list[str] = []
    if not v2:
        warnings.append(_V1_LEGACY_WARNING)
    built_dt = _parse_ts(built_at)
    if built_dt is None:
        warnings.append(
            "Mart build time unknown (no mart_meta.built_at) — treat every number as possibly "
            "stale."
        )
    else:
        age = (datetime.now(timezone.utc) - built_dt).days
        if age > STALE_AFTER_DAYS:
            warnings.append(
                f"Data is {age} days old (built {built_dt.date().isoformat()}) — live players, "
                "demand trends and review velocity describe that date. Rebuild the mart "
                "(task etl) for current numbers."
            )
    owners_as_of = meta.get("owners_as_of")
    if owners_as_of:
        # Capability-gated: newer ETLs stamp when the SteamSpy owner estimates were taken,
        # which can lag the build itself.
        env["owners_as_of"] = owners_as_of
        owners_dt = _parse_ts(owners_as_of)
        if owners_dt and built_dt and (built_dt - owners_dt).days > 30:
            warnings.append(
                f"Owner/revenue estimates date from {owners_dt.date().isoformat()} — "
                f"{(built_dt - owners_dt).days} days older than the rest of the mart."
            )
    env["warnings"] = warnings
    return env


def _with_envelope(result: Any) -> dict:
    env = envelope()
    if not isinstance(result, dict):
        return {**env, "result": result}
    extra = result.get("warnings") or []
    body = {k: v for k, v in result.items() if k != "warnings"}
    env["warnings"] = env["warnings"] + list(extra)
    return {**env, **body}


def _predates_error(exc: Exception) -> str:
    """A DuckDB Binder/Catalog error means this (older) mart lacks a column/table the tool
    reads — say that, name it, and say how to fix it, instead of a raw stack message."""
    msg = str(exc)
    m = re.search(r'column "([^"]+)"', msg) or re.search(r"Table with name (\w+)", msg)
    what = f"`{m.group(1)}`" if m else "a column or table this tool reads"
    version = _meta(_generation).get("mart_version") or "unknown build"
    return (
        f"This mart ({version}) predates {what}, which a newer ETL added. Rebuild the mart "
        "(`task etl` in the main prospect checkout) and retry; other tools still work."
    )


# ==========================================================================================
# Server + tool plumbing
# ==========================================================================================
# Claude Code cuts tool descriptions and server instructions at ~2,048 chars
# (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH) and appends "… [truncated]". Everything past the
# cut never reaches the model — which is how find_niches' falsification rules (10.8K chars
# in, starting at char ~2,773) went unseen. Budgeted with headroom; enforced by tests.
DESCRIPTION_BUDGET = 1900

INSTRUCTIONS = """\
Prospect: Steam market intelligence for solo/indie devs, read from curated DuckDB marts.
Every response opens with data_as_of, mart_version, score_version and warnings — read the warnings first: a stale or v1-legacy mart ranks niches differently.

"What should I build" -> find_niches (its defaults encode the rules), then niche_detail and niche_games on a shortlist. The owner's analysis rules — apply every time; find_niches/niche_detail rows carry server-computed `flags` for them:
1. Use the 24-month window — the market a new entrant faces.
2. Negative saturation_yoy + low competition = decline (everyone stopped entering), not opportunity.
3. Verify recent-entrant economics: entrant_ratio >= 1.0.
4. Umbrella/meta/theme tags are never headline picks; attach themes as modifiers (tag_combos).
5. Multiplayer-dependent niches (solo_tier 'team') are out for solo devs.
6. winner_concentration > 0.85 is a red flag (winner-take-most).
7. Present the bearish reading of any ambiguous metric first.
8. Show opportunity_v2's components, never the lone number.
9. demand_emerging niches: never quote the demand trend %.

Games: game_search -> game_profile, find_comparables, game_teardown, game_reviews_summary. Money: market_benchmarks, revenue_distribution, estimate_revenue (Boxleiter-style ESTIMATES — give ranges). Timing: best_launch_timing, launch_shape. Live players: find_niches sort=total_players_now, niche_player_history, game_player_history (nightly point samples, not peaks). Partners/press: entity_profile, publisher_pitch_list, press_pitch_list, buzz_trends.
Formulas, thresholds and caveats: methodology(topic) or the prospect-data-dictionary resource."""

mcp = FastMCP("prospect-market-intel", instructions=INSTRUCTIONS)

_TOOL_ANNOTATIONS = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)


def _dumps(obj: Any) -> str:
    # Compact (no indent): the SDK's default indent=2 added ~29% to every response.
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)


def _tool(fn):
    """Register `fn` as an MCP tool and return the DIRECT-call wrapper.

    The direct wrapper (bound to the module attribute, so `prospect_mcp.find_niches()` in
    tests/smoke runs gets exactly what the wire gets) hot-reloads the mart if it was
    swapped, runs the tool, turns an older mart's Binder/Catalog error into a rebuild
    message, prepends the envelope and makes every value JSON-safe. The MCP-facing entry
    point serialises that to compact JSON text; structured_output=False keeps the SDK from
    also shipping a second (structured) copy of every payload. The description is the
    docstring, cleandoc'd (indentation no longer counts against the ~2K budget)."""

    @functools.wraps(fn)
    def call(*args, **kwargs):
        _maybe_reload()
        try:
            result = fn(*args, **kwargs)
        except (duckdb.BinderException, duckdb.CatalogException) as exc:
            _log(f"{fn.__name__}: {type(exc).__name__}: {exc}")
            result = {"error": _predates_error(exc)}
        return _jsonable(_with_envelope(result))

    @functools.wraps(fn)
    def mcp_entry(*args, **kwargs):
        return _dumps(call(*args, **kwargs))

    mcp.add_tool(
        mcp_entry,
        name=fn.__name__,
        description=inspect.cleandoc(fn.__doc__ or "").strip(),
        annotations=_TOOL_ANNOTATIONS,
        structured_output=False,
    )
    return call


# Shared schema pieces (parameter docs live in the schema, not the description).
Dimension = Annotated[
    Literal["tag", "genre"],
    Field(description="tag = Steam community tags (niche-level, preferred); genre = Steam's ~15 broad genres."),
]
NicheKey = Annotated[
    str,
    Field(description="Exact niche key from find_niches / tag_suggest (e.g. 'Roguelike Deckbuilder'). A unique case-insensitive match or a known alias is resolved automatically."),
]
Window = Annotated[
    Literal["24m", "all"],
    Field(description="24m = games released in the last 24 months: the market a new entrant faces (use for build decisions). all = full history, context only."),
]
MinReviews = Annotated[
    Literal[0, 50, 100],
    Field(description="Per-game review floor of the precomputed cut: 50 (default) or 100 (stricter). 0 = no floor — honest tag SIZE, not for revenue conclusions."),
]
Fields = Annotated[
    Literal["core", "all"],
    Field(description="core = lean rows (score components, rule inputs, flags); all = every mart column."),
]
Order = Annotated[Literal["desc", "asc"], Field(description="desc = highest first; asc = lowest first.")]


def _limit(default_max: int, what: str = "rows") -> Any:
    return Field(ge=1, le=default_max, description=f"Max {what} returned (1-{default_max}).")


def _fraction_0_1(v: float | None) -> float | None:
    if v is not None and not 0 <= v <= 1:
        hint = f" — did you mean {v / 100:g}?" if 1 < v <= 100 else ""
        raise ValueError(
            f"min_positive is a 0-1 FRACTION of positive reviews (0.8 = 80% positive), got {v:g}{hint}"
        )
    return v


# ==========================================================================================
# Methodology — the long-form docs that used to live in (and overflow) the descriptions.
# One source for the prospect-data-dictionary resource and the `methodology` tool.
# ==========================================================================================
_DOCS: dict[str, str] = {}

_DOCS["rules"] = (
    "## Analysis rules (the owner's — apply every time)\n\n"
    + "\n".join(f"{i}. {r}" for i, r in enumerate(_OWNER_RULES, 1))
    + "\n\n## Flags (server-computed on every find_niches / niche_detail row)\n\n"
    + "\n".join(f"- **{c}**: {t}" for c, t in _FLAG_RULES.items())
    + """

## The envelope (leads every tool response)

- **data_as_of** = mart_meta.built_at (when the mart was built); **mart_version** = its
  build date; **owners_as_of** (newer marts) = when the SteamSpy owner estimates were taken.
- **score_version** = `v2` (the 2026-08-31 opportunity rebuild, components present) or
  `v1-legacy` (an older mart: opportunity_v2 = opportunity x decline_gate, which ranked
  shrinking niches on top — rebuild before trusting a ranking).
- **warnings** — stale data (> 3 days old), legacy score, lagging owner estimates, a cut
  that fell back to another. Read them before the numbers.
"""
)

_DOCS["scores"] = """## The opportunity score (mart_niche)

For each niche (a Steam community `tag` or a Steam `genre`), computed at 6 cuts —
`window` in {`all`, `24m`} x `min_reviews` in {`0`, `50`, `100`} — as percentile ranks
(0-100) against every other niche in the SAME cut:

- **demand** = 0.4 x percentile(median revenue) + 0.3 x percentile(median owners) +
  0.3 x percentile(recent 24m review velocity). Higher = bigger, hotter market.
- **competition** = 0.6 x percentile(n_recent, count of recently-released games) +
  0.4 x percentile(winner_concentration, share of niche revenue held by the top ~10% of
  games). Higher = more crowded / more winner-take-most — BAD for a new entrant. On the
  24m cut its n_recent term is mostly niche SIZE, so read it with n_games.
- **quality_gap** (aka `beatable_share`) = percentile(share of incumbents that are weak:
  low rating OR thin review count). Higher = easier to out-execute the field.
- **opportunity** = clamp(0.5 x demand - 0.35 x competition + 0.3 x quality_gap, 0, 100).
  The ORIGINAL score, kept for continuity. KNOWN FAILURE MODES: it rewards low competition
  without asking WHY it's low (a niche everyone abandoned scores like an open market), and
  its competition term punishes big growing markets. Do not sort by it.
- **opportunity_v2** = `find_niches`' default ranking metric. REBUILT 2026-08-31 (it is
  no longer `opportunity x decline_gate`; the old form ranked BACKWARDS against the Radar
  board's ring verdicts — median score by ring ran enter 17.6 < watch 17.8 < crowded 20.9 <
  declining 23.4 on 219 live niches):

      opportunity_v2 = opp_core x supply_brake

  where opp_core is the weighted mean of four 0-100 sub-scores (returned on every row) —
  renormalised over whichever ones exist, so a missing input never counts as 0:

  - **momentum** (weight 0.40) — DEMAND FLOW, the headline term. 50 at flat demand, 88.1
    at +40%/24m (the Radar's "enter" bar), 10.7 at -30%/24m (its "declining" bar). NULL
    for emerging niches: their prior window is near zero by construction, so no honest
    trend claim exists in either direction.
  - **market_pull** (0.22) — 0.6 x demand + 0.4 x market_size. The money LEVEL, kept as a
    supporting term rather than the headline.
  - **revenue_spread** (0.20) — from winner_concentration; exactly 50 at the 0.85
    winner-take-most bar, 100 at 0.70, 0 at 1.00.
  - **quality_gap** (0.18) — unchanged.

  and **supply_brake** = 0.35 + 0.65 x supply_room/100 (1.0 when unknown — missing data is
  never a penalty). **supply_room** is the WORSE of two supply reads, so either alone can
  sink a score: the release pipeline's growth measured AGAINST demand growth (50 when
  supply outgrows demand by the Radar's +15%/yr flooding bar), and entrant_room (0 at
  entrant_ratio 0.5, 100 at the catalog norm 0.79, capped there).

  READ THE PARTS, NOT JUST THE TOTAL: "Deckbuilding 71.9" is momentum 99 + supply_room 100
  (demand +119%/24m outrunning a +36% release pipeline), while "Hunting 77.2" is momentum
  92 + market_pull 86 but revenue_spread 17 (winner-take-most: expect the median outcome,
  not the hits). Those are different recommendations.

  saturation_yoy is read AGAINST demand inside the score: a shrinking pipeline earns no
  credit by itself (the Naval/Transportation failure mode); it only shows up as room when
  demand is holding while supply leaves.
- **decline_gate** = 1 - 0.5 x max(sat_severity, entrant_severity), where
  sat_severity = clamp(-saturation_yoy / 0.30, 0, 1) and
  entrant_severity = clamp((1 - entrant_ratio) / 0.5, 0, 1). A FALSIFICATION TELL, NOT A
  SCORE FACTOR since 2026-08-31 (it used to multiply opportunity_v2). Near 1.0 = neither
  decline signal fired.

### Score vs the Radar board's rings

Since 2026-08-31 the score reads the same demand and concentration bars as the Radar's
rings: at the rebuild the score's median by ring was enter 67.6 > watch 50.2 > crowded 39.1
> declining 19.5, and >= 65 is the "scores like an enter" bar (~16% of the default cut).
They are not interchangeable: the rings encode distinct failure MODES (crowded vs
declining), the score also weighs the money, and they read supply differently (the ring:
releases > +15% YoY, absolute; the score's brake: supply growth net of demand growth, plus
entrant_ratio). A winner-take-most niche (winner_concentration > 0.85) NEVER rings "enter":
with surging demand it rings "watch" ("demand surging, but winner-take-most revenue"),
with sustained demand decline "declining", otherwise "crowded" — yet it can still score
well. When they disagree, say which one you are quoting.

### Interpretation playbook for "what should I build"

Keep the 24m default window (that IS the market a new entrant faces), read WHICH sub-score
carried the score (momentum vs market_pull is the difference between "this is growing" and
"this is already big"), require the decline gate near 1.0 or understand exactly why it
isn't, verify recent entrants get paid (entrant_ratio >= 1.0, 24m median_rev,
hit_rate_200k, n_games), check winner_concentration (> 0.85 = winner-take-most: expect the
median outcome, not the hits), and check solo_tier when the asker builds solo.
"""

_DOCS["fields"] = """## Niche fields (mart_niche)

- **p25_rev / p75_rev / p90_rev** = revenue percentiles of the niche's own games. Prefer
  **p90_rev** over median_rev when the question is "what can this niche pay": the median is
  dragged down by asset flips and abandoned projects, and a competent solo dev is not the
  median entrant. Sortable.
- **entrant_ratio** = (24m median_rev) / (all-time median_rev) for the same (dimension,
  key, min_reviews) — same value on both window rows. INTERPRET AGAINST THE NORM: the
  catalog-median tag sits at ~0.79 (with Early Access graduates dated from their EA
  launch, recent entrants typically earn less than a niche's back catalog), so >= 1.0 —
  the owner's bar — is genuinely good, ~0.8-1.0 is typical, and well under ~0.8 is a real
  warning that newcomers earn less than the back catalog did; a high ratio over a
  SHRINKING pipeline (few self-selected survivors) is not health. NULL = no 24m cut or a zero/missing all-time median.
- **solo_viability** = share of the cut's scored games playable single-player (Steam's own
  `categories` field, community-tag fallback), per cut. **A FLAG, NOT A SCALE.** Measured
  over 219 live niches (tag / 24m / min50):

      min 0.353 | p05 0.853 | p10 0.913 | p25 0.953 | MEDIAN 0.975 | p75 0.990 | max 1.000
      below 0.90: 7.8%     below 0.80: 3.2%

  Three quarters of the catalog sits inside a 0.047-wide band, so the number CANNOT rank
  the options a solo dev is choosing between. What it does perfectly is spot the ~3% that
  are inherently multiplayer: Social Deduction 0.35, MMORPG 0.45, Party Game 0.50, Party
  0.64, Battle Royale 0.70, Extraction Shooter 0.71, eSports 0.79 — not solo-buildable
  without netcode/servers/a live player base. (0.9 is the 10th PERCENTILE, not the norm.)
  It is a no-netcode proxy, not a production-scope measure. find_niches' `solo_only`
  keeps singleplayer share >= 0.80 (NULL = unknown = excluded), mirroring the API.
- **solo_tier** = the same signal as a flag: `'team'` (< 0.80, multiplayer-dependent,
  ~3%), `'mixed'` (0.80-0.90 — clears the bar but has a real multiplayer minority),
  `'solo'` (>= 0.90, ~92%). NULL on marts built before 2026-08-31.
- **tier** (tags; genre rows get 'genre') = 'micro' (buildable game concept: Colony Sim,
  Souls-like), 'theme' (setting/aesthetic you attach TO a game: Vikings, Pixel Graphics),
  'umbrella' (genre/mechanic/mode container: Open World, Sandbox — NOT buildable), 'meta'
  (reception/store tags: Great Soundtrack — never buildable). `find_niches` defaults to
  micro only; pass include_tiers to see themes (as modifiers) or the rest.
- **saturation_yoy** = (n_recent_year - n_prior_year) / n_prior_year — the release
  pipeline's year-over-year change over every game carrying the key (no review floor).
  n_recent_year / n_prior_year are the counts behind it (tiny counts = noisy ratio).
- **n_free / n_price_unknown** (newer marts) = games whose revenue estimate is NULL (free,
  or no known price) and therefore excluded from the revenue stats.

### Absolute market size (the "pie") — separate from `demand`

`demand` is a percentile of PER-GAME MEDIANS, so a narrow niche of strong titles scores
high `demand` yet has a tiny total audience. These give the ABSOLUTE size, summed over the
niche's scored population (min_reviews floor applies):

- **total_owners** = SUM(owners_mid); **total_rev** = SUM(est_rev_reviews);
  **total_reviews** = SUM(total_reviews).
- **market_size** = total_owners as a 0-100 percentile vs other niches in the same cut.
  Use it (or min_total_owners) to prefer a small slice of a big pie over a big slice of a
  small one — the solo-dev sizing lens.
"""

_DOCS["falsification"] = """## Falsification rules — how each metric lies

1. Low competition + negative saturation_yoy usually means a market in DECLINE — everyone
   STOPPED entering — not a cracked-open opportunity (this exact failure put
   Naval/Transportation/Diplomacy at the top of the old ranking). Still your job under v2:
   a niche whose demand AND supply are both falling nets out neutral on supply_room, and
   only momentum catches it — read momentum, not just the total.
2. entrant_ratio reads AGAINST THE NORM (~0.79), not against 1.0 alone; a high ratio over
   a shrinking pipeline (few, self-selected survivors) is NOT health.
3. Verify recent entrants actually get paid: with window="24m", median_rev IS the
   recent-entrant median. Cross-check hit_rate_200k and n_games (a great median over 30
   games is thinner evidence than a good median over 300).
4. winner_concentration > 0.85 = winner-take-most: the MEDIAN outcome (not the visible
   winners) is what a new entrant should expect. Check niche_detail's revenue_histogram.
5. Solo devs: solo_viability is a flag, not a scale (see fields) — only 'team'/'mixed'
   carry information.
6. tier: umbrella and meta keys are not buildable ("build an Open World game" is not a
   plan); a theme means "make a game ABOUT this" and needs a micro-genre attached.
7. Players lens: big total_players_now + players_top5_share above ~0.6 + a tiny median
   means the audience belongs to the HITS — not demand available to a new entrant.
8. Lifetime: lifetime_survival_12m below ~0.5 marks a hit-churn niche — a short revenue
   window (front-load the launch, don't plan year-two updates).
9. demand_emerging: young Steam tags crystallize around new games only, so their prior
   window is near zero BY CONSTRUCTION and a huge trend % is the label's age, not demand
   growth. Never quote it; judge absolute reviews_24m.
"""

_DOCS["players"] = """## Live players (CCU) — current traction, not an estimate

Unlike owners/revenue (lifetime ESTIMATES), live players are direct measurements: Steam's
keyless GetNumberOfCurrentPlayers, captured by a nightly ~21-22:00 UTC sweep since
2026-07-18.

- **Point sample, not peak**: one capture per game per day (the LAST of the UTC date) —
  typically ~60-90% of a SteamDB-style daily peak. Compare values to each other only.
- **Coverage model**: the top-8k games by reviews are captured EVERY night (~99% of all
  Steam CCU); the rest of the >=50-review universe rotates every ~3-8 nights. A missing day
  = unmeasured, never zero. Tail games are sparse before ~2026-08-14.
- **Windows are anchored to the mart's last capture date** (MAX(date)), not the wall
  clock, so an older mart still returns its own last N days.
- **Niche rollup (mart_niche_players)**: total_players sums scored member games' values
  with each game's last capture carried forward up to 7 days (LOCF); games staler than 7d
  drop out. measured_players / n_games_measured are the no-carry reality check.
- **mart_niche columns** (one value per key, identical on all cut rows): total_players_now,
  players_trend_7d_pct (last-7d vs prior-7d, SAME-PANEL — only games measured in both
  windows count), players_coverage (share measured <= 2d fresh), median_players_now,
  players_top5_share. Newer marts add players_trend_7d_market_pct (the whole market's
  same-panel trend) and players_trend_7d_rel_pct (this niche vs the market) — prefer the
  relative one: the raw trend moves with Steam-wide seasonality.
- **mart_game columns**: live_players (latest capture), players_7d_avg,
  players_trend_7d_pct (+ the market/rel pair on newer marts).
- **Interpretation trap**: a niche's total is its HITS — top-heavy by construction.
- **Deep history** (mart_game_players_history / mart_niche_players_monthly): steamcharts
  monthly averages + true peaks back to 2012, top-8k games only — a different MEASURE,
  returned as a separate `monthly` block; never blend it with the daily series.
"""

_DOCS["lifetime"] = """## Game lifetime — how long a game keeps an audience once it has one

From steamcharts MONTHLY averages (top-8k-by-reviews coverage only, not our nightly
samples):

- **mart_game**: lifetime_first_100_month (t0 = first calendar month averaging >= 100
  concurrent players), lifetime_died_month (first FULL month after t0 averaging < 10; NULL
  while alive), lifetime_months (death - t0, or months-so-far while alive),
  lifetime_alive. NULL on all = UNKNOWN (no coverage or never reached 100+) — never zero.
- **mart_niche** (one value per key): lifetime_n_games (covered 100+-reaching games),
  lifetime_survival_12m (fixed-horizon share still averaging 10+ twelve months after t0,
  among games observable >= 12 months — censoring-safe), lifetime_median_dead_months
  (median lifetime of the ALREADY-DEAD games — biased LOW; never read it without
  lifetime_survival_12m). NULL = fewer than 5 covered games.
- **mart_market_lifetime** -> `lifetime_curve`: the catalog-wide fixed-horizon survival
  curve. SURVIVORSHIP: the cohort is games that DID reach 100+ concurrent players — most
  Steam releases never do — so it answers "once a game has an audience, how long does it
  keep it", never "will my game find one".
"""

_DOCS["demand"] = """## 24-month demand trend (mart_niche; one value per key, identical on every cut)

- **reviews_24m / reviews_prev_24m**: the niche's review inflow (Steam's own monthly
  review histogram — true counts, games with 50+ reviews) over the last 24 complete months
  and the 24 before them.
- **demand_trend_24m_pct**: the percent change between them — the Radar's primary axis
  (enter >= +40%, declining <= -30%, holding >= -10%). A launch spike or sale week cannot
  move it the way it moved the old 90-day trend. NULL = no prior-window baseline (a
  genuinely new niche), never "flat". When sorting by it, emerging niches rank last (their
  % is not comparable).
- **demand_emerging** (+ reviews_24m_new_share): the prior base is below 1,000 reviews, OR
  >= 80% of reviews_24m comes from games released in the last 24 months. Young tags
  crystallize around new games only, so their prior window is near zero BY CONSTRUCTION —
  do NOT quote the trend % (find_niches/niche_detail withhold it in core rows); judge the
  niche by its absolute reviews_24m.
"""

_DOCS["cuts"] = """## Cuts (window x min_reviews)

Only the precomputed cuts exist: window in {"24m", "all"} x min_reviews in {0, 50, 100}
(the 0 cut only on marts built after the no-floor cut landed — older marts return a
rebuild error for it).

- window="24m" restricts to games released in the last 24 months — the market a new
  entrant faces. Use it for build decisions. window="all" scores full history: context.
- min_reviews is the per-game review floor before a title counts: 50 = the default, 100 =
  stricter/cleaner, 0 = NO floor — n_games there is the honest full tag size (unreviewed
  releases included) while revenue medians still skip games with no estimable revenue;
  use it for "how big is this tag really", not for revenue conclusions.
- Niche rows need >= 30 qualifying games (MIN_NICHE_GAMES), so a small niche can be
  missing from a strict cut; niche_detail then falls back and says so.
- mart_niche_game (niche_games, niche_detail's representative games) materialises
  membership for exactly the same cuts.
"""

_DOCS["revenue"] = """## Revenue & owners estimates

`est_rev_reviews` (the primary revenue figure) = owners_mid x price_initial, where
owners_mid comes from SteamSpy's owner-range midpoint (itself modeled from review counts
via the "Boxleiter method": ~20-55 owners per review, genre-dependent). This is GROSS
lifetime box revenue — not net of Steam's cut, not first-year-only. Free games carry no
revenue estimate (NULL on newer marts), so revenue medians describe the paid population.
See `market_benchmarks` for cited vs computed figures and why they differ (cited =
first-year/net over ALL releases; computed = gross-lifetime over games clearing the review
floor). estimate_revenue returns {low, mid, high} ranges — always report the range.
"""

_DOCS["marts"] = """## The marts (grouped by tool)

- **mart_niche / mart_niche_top / mart_niche_hist / mart_niche_trend / mart_niche_game** —
  niche scores per cut, the all-time top games, a revenue histogram (all/50 cut only), a
  yearly release/saturation trend, and per-cut game membership. -> `find_niches`,
  `niche_detail`, `niche_games`.
- **mart_tag_alias** (newer marts) — alias -> canonical tag keys; niche tools resolve
  aliases through it.
- **mart_tag_lift** — pairwise tag-combination performance: one row per unordered pair of
  community tags (each game's top-10 tags; games with >= 50 reviews; pairs with >= 15
  games), with the pair's median est. revenue, hit_rate_200k, both tags' solo medians
  (mart_niche all/50 baselines) and lift = pair median / better solo median. -> `tag_combos`.
- **mart_niche_themes** — per (niche, aspect): review-aspect praise/complaint shares pooled
  to niche level, with deltas vs the all-catalog baseline. -> `niche_review_themes`.
- **mart_market_pct / mart_market_hist / mart_market_boxleiter / mart_market_tiers /
  mart_meta** — catalog-wide (or per-genre) distributions, the fitted owners-per-review
  slope per genre, dev-tier counts, global stats. -> `market_benchmarks`,
  `revenue_distribution`, `estimate_revenue`.
- **mart_launch_curve / mart_game_launch_curve** — cumulative share of first-year reviews
  by day-since-release, per genre / per game. -> `launch_shape`, `game_reviews_summary`.
- **mart_timing_demand / mart_timing_congestion / mart_timing_decay** — launch-window
  intelligence over the TRUE uncapped monthly review histograms. -> `best_launch_timing`.
- **mart_game** — one row per game: metadata, revenue/owners, percentile-vs-genre, top
  tags, review velocity, live players, lifetime, official socials (harvested from
  developer-CONTROLLED pages, never the platforms), demo flag. -> `game_search`,
  `game_profile`, `find_comparables` (tag-Jaccard within the same primary genre + a price
  band, computed on demand).
- **mart_game_players_daily / mart_niche_players / mart_game_players_history /
  mart_niche_players_monthly** — daily CCU point samples + steamcharts deep history.
  -> `game_player_history`, `niche_player_history`.
- **mart_market_lifetime** — the catalog-wide survival curve. -> `lifetime_curve`.
- **mart_entity / mart_entity_games** — developers/publishers normalized out of mart_game's
  comma-joined strings (no fuzzy identity resolution). -> `entity_profile`,
  `publisher_pitch_list`.
- **mart_game_review_aspects / mart_genre_aspect_baseline / mart_game_press_*** —
  per-game praise/complaint aspect mining + press footprint. -> `game_teardown`,
  `aspect_reviews`.
- **mart_press_outlet_genre / mart_press_author** — outlet x genre and journalist x genre
  coverage. -> `press_pitch_list`.
- **mart_buzz_trends(_summary)** — rising/cooling concept bigrams from article titles.
  -> `buzz_trends`.
- **mart_channel_mix / mart_channel_buzz(_summary)** — PRESS-ONLY since 2026-08-25 (the
  creator platforms were decommissioned): channel_mix's shares are 1.0 by construction and
  channel_buzz carries the same terms as buzz_trends at 1 weight per mention. Kept for shape
  stability, not as a multi-channel read. -> `channel_mix`, `channel_buzz`.
"""

_DOCS["caveats"] = """## Caveats that apply broadly

- **Sampling**: reviews/press are SAMPLES of the true Steam data, recency-biased toward
  older/popular titles (reviews) or the last ~365 days (press backfill).
- **Selection bias**: press coverage and "top games" lists reflect games that were
  already notable — descriptive of what happened, not predictive/causal.
- **Correlational, not causal**: `game_teardown`'s "why it works" framing, and any
  press-coverage-vs-outcome read, is evidence toward an explanation, never proof.
- **English-outlet skew**: review-text mining and press analysis both skew English-
  language / Western-outlet.
- Genre = Steam's own small, fixed, EXACT-match genre field (marts use the PRIMARY genre
  unless noted). Tag = SteamSpy's much larger community-tag vocabulary — more specific,
  better for niche-finding.
"""

_DOC_TOPICS = tuple(_DOCS)


def _data_dictionary_text() -> str:
    return (
        "# Prospect data dictionary\n\n"
        "Prospect's marts are built from a Steam catalog snapshot + SteamSpy owner estimates +\n"
        "sampled reviews + press/news articles, via DuckDB ETL (`etl/marts/*.sql`). All figures\n"
        "are ESTIMATES, several with real biases — read the caveats before treating any number\n"
        "as ground truth.\n\n"
        + "\n".join(_DOCS[t] for t in _DOC_TOPICS)
    )


# ==========================================================================================
# Resource — data dictionary
# ==========================================================================================
@mcp.resource(
    "data://prospect/data-dictionary",
    name="prospect-data-dictionary",
    title="Prospect data dictionary",
    description="Analysis rules, flags, score formulas, field definitions, cuts and caveats. The same text the methodology tool serves by topic.",
    mime_type="text/markdown",
)
def data_dictionary() -> str:
    return _data_dictionary_text()


# ==========================================================================================
# Niche / opportunity tools
# ==========================================================================================
NicheSort = Literal[
    "opportunity_v2", "momentum", "market_pull", "revenue_spread", "quality_gap",
    "supply_room", "supply_brake", "opportunity", "decline_gate", "demand", "competition",
    "market_size", "total_owners", "total_rev", "total_reviews",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity", "p25_rev", "p75_rev", "p90_rev",
    "n_games", "n_recent", "n_recent_year", "n_prior_year", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "self_pub_share", "winner_concentration",
    "entrant_ratio", "solo_viability",
    "total_players_now", "players_trend_7d_pct", "players_trend_7d_rel_pct",
    "players_trend_7d_market_pct", "players_coverage", "median_players_now",
    "players_top5_share", "lifetime_survival_12m", "lifetime_median_dead_months",
    "reviews_24m", "reviews_prev_24m", "demand_trend_24m_pct",
]
_NICHE_SORTABLE = frozenset(NicheSort.__args__)
# Column families, for the "this mart predates X" message a gated sort/filter returns.
_NICHE_PLAYERS_COLS = {
    "total_players_now", "players_trend_7d_pct", "players_coverage",
    "median_players_now", "players_top5_share",
}
_NICHE_PLAYERS_FAMILY = (
    "total_players_now", "players_trend_7d_pct", "players_trend_7d_rel_pct",
    "players_trend_7d_market_pct", "players_coverage", "median_players_now",
    "players_top5_share",
)
_NICHE_LIFETIME_COLS = ("lifetime_n_games", "lifetime_survival_12m", "lifetime_median_dead_months")
_NICHE_DEMAND24M_COLS = {"reviews_24m", "reviews_prev_24m", "demand_trend_24m_pct"}
_NICHE_V2_PARTS_COLS = {"momentum", "supply_room", "revenue_spread", "market_pull", "supply_brake"}
_V2_PARTS_MISSING = (
    "This mart predates the opportunity_v2 sub-scores (momentum / supply_room / "
    "revenue_spread / market_pull / supply_brake — the 2026-08-31 score rebuild). "
    "opportunity_v2 itself is still sortable, but on that mart it carries the OLD formula, "
    "which ranked opposite to the Radar's rings. Re-run the ETL (`task etl` in the main "
    "prospect checkout) and retry."
)
_DEMAND24M_MISSING = (
    "This mart predates the 24-month demand columns (reviews_24m / reviews_prev_24m / "
    "demand_trend_24m_pct, an older ETL build). Re-run the ETL (`task etl` in the main "
    "prospect checkout) and retry."
)
_NICHE_TIERS = ("micro", "theme", "umbrella", "meta")
# Default tier filter (tags only): buildable micro-genres ONLY. Themes are settings/
# aesthetics you attach TO a micro pick (the owner's rule: never a headline pick — six of
# the old micro+theme default's top 25 were themes, e.g. Snow at saturation_yoy -0.28);
# umbrella containers and meta/reception tags aren't buildable at all. Pass include_tiers
# explicitly to see themes (they come back flagged theme_tag) or everything (None).
_DEFAULT_INCLUDE_TIERS = ["micro"]
# The niche-score v2 columns every niche tool needs (present since 2026-08-14).
_NICHE_V2_REQUIRED = frozenset({"opportunity_v2", "tier", "entrant_ratio", "solo_viability", "decline_gate"})

# Shared soft-fail message: the v2 columns only exist once the ETL that added them has
# rebuilt current.duckdb. Same degrade-cleanly idiom as tag_combos/mart_tag_lift.
_NICHE_V2_MISSING = (
    "mart_niche is missing the niche-score v2 columns (opportunity_v2 / entrant_ratio / "
    "solo_viability / tier / decline_gate) — this analytics DB was built by an older ETL. "
    "Re-run the ETL (`task etl` in the main prospect checkout) and retry."
)

# find_niches' lean row: the score + EVERY component (never a lone number), the inputs the
# rules run on, and size/money. Filtered to what the mart carries.
_NICHE_CORE = (
    "opportunity_v2", "momentum", "market_pull", "revenue_spread", "quality_gap",
    "supply_room", "supply_brake",
    "demand_trend_24m_pct", "reviews_24m", "saturation_yoy", "n_recent_year", "n_prior_year",
    "competition", "entrant_ratio", "winner_concentration", "solo_tier",
    "n_games", "median_rev", "p90_rev", "hit_rate_200k",
)
# A v1-legacy mart has no v2 components: show the old score's own parts instead.
_NICHE_CORE_V1 = ("opportunity", "decline_gate", "demand")
# Everything a flag reads (selected even when it isn't a core output field).
_NICHE_FLAG_INPUTS = (
    "tier", "n_games", "saturation_yoy", "competition", "winner_concentration",
    "entrant_ratio", "solo_tier", "solo_viability", "demand_trend_24m_pct", "demand_emerging",
)
# niche_detail's compact per-cut rows (fields="core").
_NICHE_VARIANT_CORE = (
    "window", "min_reviews", "n_games", "opportunity_v2", "competition", "median_rev",
    "p90_rev", "hit_rate_200k", "entrant_ratio", "winner_concentration", "solo_viability",
)


def _niche_sort_missing(col: str) -> str:
    if col in _NICHE_PLAYERS_COLS:
        return _PLAYERS_MISSING
    if col in _NICHE_LIFETIME_COLS:
        return _LIFETIME_MISSING
    if col in _NICHE_DEMAND24M_COLS:
        return _DEMAND24M_MISSING
    if col in _NICHE_V2_PARTS_COLS:
        return _V2_PARTS_MISSING
    return _column_missing("mart_niche", col)


def _dedupe(seq: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(seq))


def _niche_core_fields(cols: frozenset[str], extra: Iterable[str] = ()) -> list[str]:
    fields = [c for c in _NICHE_CORE if c in cols]
    if "supply_brake" not in cols:
        # v1-legacy: right after the score, the parts it is actually made of.
        fields[1:1] = [c for c in _NICHE_CORE_V1 if c in cols]
    if "solo_tier" not in cols and "solo_viability" in cols:
        fields.append("solo_viability")
    return _dedupe(fields + [c for c in extra if c in cols])


def _shape_niche_row(r: dict, fields: str, core: list[str]) -> dict:
    """One output row: key, tier, the server-computed flags, then the fields. In core
    rows an emerging niche's demand_trend_24m_pct is WITHHELD (null) — the owner's rule is
    never to quote it, and a number in front of a model gets quoted."""
    flags = _niche_flags(r)
    head = {"key": r["key"], "tier": r.get("tier"), "flags": flags}
    if fields == "all":
        rest = {k: v for k, v in r.items() if k not in ("key", "tier")}
        return {**head, **rest}
    out = {**head, **{c: r.get(c) for c in core}}
    if r.get("demand_emerging") is True and "demand_trend_24m_pct" in out:
        out["demand_trend_24m_pct"] = None
    return out


@lru_cache(maxsize=1024)  # keyed on caller input — bounded
def _niche_keys_ci(gen: int, dimension: str, key_lower: str) -> tuple[str, ...]:
    return tuple(
        r["key"]
        for r in query(
            "SELECT DISTINCT key FROM mart_niche WHERE dimension = ? AND lower(key) = ? LIMIT 2",
            [dimension, key_lower],
        )
    )


def _resolve_niche_key(dimension: str, key: str) -> tuple[str | None, str | None]:
    """(key to query, note). An exact mart_niche key wins; then mart_tag_alias (when this
    mart carries it — newer ETLs); then a UNIQUE case-insensitive match. (None, error
    message) when nothing matches."""
    if query_one(
        "SELECT 1 AS one FROM mart_niche WHERE dimension = ? AND key = ? LIMIT 1", [dimension, key]
    ):
        return key, None
    if _has_table("mart_tag_alias"):
        try:
            row = query_one(
                "SELECT canonical FROM mart_tag_alias WHERE dimension = ? "
                "AND (alias = ? OR lower(alias) = lower(?)) ORDER BY (alias = ?) DESC LIMIT 1",
                [dimension, key, key, key],
            )
        except duckdb.Error:  # an alias mart shaped differently than expected — skip it
            row = None
        canonical = row["canonical"] if row else None
        if canonical and query_one(
            "SELECT 1 AS one FROM mart_niche WHERE dimension = ? AND key = ? LIMIT 1",
            [dimension, canonical],
        ):
            return canonical, f"{key!r} is an alias of {canonical!r} (mart_tag_alias)."
    matches = _niche_keys_ci(_generation, dimension, key.lower())
    if len(matches) == 1:
        return matches[0], f"{key!r} matched {matches[0]!r} case-insensitively."
    return None, (
        f"no niche found for dimension={dimension!r} key={key!r}. Use tag_suggest(q) or "
        "find_niches for exact keys."
    )


def _resolve_tag(tag: str | None) -> tuple[str | None, str | None]:
    """A tag FILTER value (game_search / tag_combos): resolved like a niche key when that
    finds a match, otherwise used as given (a tag below the niche floor can still be on
    games' top_tags)."""
    if not tag:
        return tag, None
    resolved, note = _resolve_niche_key("tag", tag)
    return (resolved, note) if resolved is not None else (tag, None)


@_tool
def find_niches(
    dimension: Dimension = "tag",
    window: Window = "24m",
    min_reviews: MinReviews = 50,
    sort: Annotated[
        NicheSort,
        Field(description="Field to rank by (default opportunity_v2). Players/lifetime/demand/sub-score fields need a mart that carries them."),
    ] = "opportunity_v2",
    order: Annotated[
        Literal["desc", "asc"],
        Field(description="desc = highest first. asc for 'least crowded' (sort=competition) or 'smallest'."),
    ] = "desc",
    include_tiers: Annotated[
        list[Literal["micro", "theme", "umbrella", "meta"]] | None,
        Field(description="Tag tiers to include (tags only). Default ['micro'] = buildable concepts. Add 'theme' to see settings/aesthetics to ATTACH to a micro pick (flagged theme_tag); umbrella/meta are never picks. null = all tiers."),
    ] = _DEFAULT_INCLUDE_TIERS,
    solo_only: Annotated[
        bool,
        Field(description="Keep only niches whose singleplayer share (solo_viability) >= 0.8; NULL = unknown = excluded. A no-netcode proxy, not a scope measure — same rule as the API's solo_only."),
    ] = False,
    min_median_rev: Annotated[float | None, Field(ge=0, description="Post-filter: median_rev >= this (USD).")] = None,
    max_competition: Annotated[float | None, Field(ge=0, le=100, description="Post-filter: competition percentile <= this.")] = None,
    min_total_owners: Annotated[float | None, Field(ge=0, description="Post-filter: total_owners >= this (the size-of-the-pie lens).")] = None,
    min_total_players: Annotated[float | None, Field(ge=0, description="Post-filter: total_players_now >= this (needs the players columns).")] = None,
    fields: Fields = "core",
    limit: Annotated[int, _limit(50, "niches")] = 15,
) -> dict:
    """Rank niches (Steam community tags or genres) for "what should I build" — start here.

    RULES (rows carry server-computed `flags`; the response's `rules` defines each one that fired):
    - Bearish reading first: state every flag before any score.
    - Never quote opportunity_v2 alone: give momentum, market_pull, revenue_spread, quality_gap and supply_brake, and say which carried it.
    - Negative saturation_yoy + low competition = DECLINE, not opportunity (decline_signature).
    - Recent entrants must get paid: entrant_ratio >= 1.0 (catalog norm ~0.79).
    - winner_concentration > 0.85 = winner-take-most: red flag; the Radar never rings it 'enter'.
    - Solo devs: drop solo_tier 'team' (multiplayer_dependent), or pass solo_only=true.
    - Headline picks are micro-genres (the default include_tiers). Themes are modifiers to attach to a pick; umbrella/meta tags are never picks.
    - demand_emerging rows: the trend % is withheld — judge absolute reviews_24m.
    - Decide on window='24m' (the default); 'all' is history.

    SCORE: opportunity_v2 = weighted mean of momentum (0.40; 50 = flat demand, 88 = +40%/24m), market_pull (0.22), revenue_spread (0.20; 50 at the 0.85 winner-take-most bar) and quality_gap (0.18), times supply_brake (0.35-1.0, from supply_room). >= 65 scores like a Radar 'enter'. score_version 'v1-legacy' means the old formula (no components): rebuild before ranking.

    Rows are lean (fields='core'); fields='all' returns every mart column. Players lens: sort='total_players_now' or 'players_trend_7d_pct' (nightly point samples; totals are the hits' players). Next: niche_detail(dimension, key), niche_games(dimension, key). Formulas: methodology('scores').
    """
    cols = _cols("mart_niche")
    if not _NICHE_V2_REQUIRED <= cols:
        return {"error": _NICHE_V2_MISSING}
    if sort not in _NICHE_SORTABLE:
        return {"error": f"sort must be one of {sorted(_NICHE_SORTABLE)}"}
    if sort not in cols:
        return {"error": _niche_sort_missing(sort)}
    if min_total_players is not None and "total_players_now" not in cols:
        return {"error": _PLAYERS_MISSING}
    if min_reviews == 0 and not _has_no_floor_cut():
        return {"error": _NO_FLOOR_MISSING}
    if order not in ("asc", "desc"):
        return {"error": "order must be 'asc' or 'desc'"}
    if include_tiers is not None:
        bad = [t for t in include_tiers if t not in _NICHE_TIERS]
        if bad:
            return {"error": f"include_tiers entries must be in {list(_NICHE_TIERS)}, got {bad}"}
        if not include_tiers:
            return {"error": "include_tiers must be None or a non-empty list"}

    where = ["dimension = ?", "win = ?", "min_reviews = ?"]
    params: list = [dimension, window, min_reviews]
    filter_cols: list[str] = []
    if min_median_rev is not None:
        where.append("median_rev >= ?")
        params.append(min_median_rev)
    if max_competition is not None:
        where.append("competition <= ?")
        params.append(max_competition)
    if min_total_owners is not None:
        where.append("total_owners >= ?")
        params.append(min_total_owners)
        filter_cols.append("total_owners")
    if min_total_players is not None:
        where.append("total_players_now >= ?")
        params.append(min_total_players)
        filter_cols.append("total_players_now")
    if solo_only:
        # NULL solo_viability fails >= (SQL three-valued logic): unknown is NOT
        # solo-friendly — the same deliberate reading as api/app/routers/niches.py.
        where.append("solo_viability >= ?")
        params.append(SOLO_FRIENDLY_MIN)
        filter_cols.append("solo_viability")
    tiers_applied = None
    if dimension == "tag" and include_tiers is not None:
        tiers_applied = list(include_tiers)
        where.append(f"tier IN ({','.join('?' for _ in tiers_applied)})")
        params.extend(tiers_applied)
    limit = max(1, min(limit, 50))
    where_sql = " AND ".join(where)

    extra = [sort, *filter_cols]
    if sort in _NICHE_PLAYERS_FAMILY or min_total_players is not None:
        extra += list(_NICHE_PLAYERS_FAMILY)
    if sort in _NICHE_LIFETIME_COLS:
        extra += list(_NICHE_LIFETIME_COLS)
    core = _niche_core_fields(cols, extra)
    if fields == "all":
        select = "* EXCLUDE (dimension, win, min_reviews)"
    else:
        select = ", ".join(c for c in _dedupe(["key", *core, *_NICHE_FLAG_INPUTS]) if c in cols)
    # An emerging niche's trend % is not comparable (its prior window is ~0 by
    # construction): it must never top a trend ranking.
    order_expr = sort
    if sort == "demand_trend_24m_pct" and "demand_emerging" in cols:
        order_expr = "CASE WHEN demand_emerging THEN NULL ELSE demand_trend_24m_pct END"
    rows = query(
        f"SELECT {select} FROM mart_niche WHERE {where_sql} "
        f"ORDER BY {order_expr} {order.upper()} NULLS LAST, n_games DESC, key LIMIT ?",
        params + [limit],
    )
    total = query_one(f"SELECT COUNT(*) AS n FROM mart_niche WHERE {where_sql}", params)
    niches = [_shape_niche_row(r, fields, core) for r in rows]
    fired = {f for n in niches for f in n["flags"]}
    warnings = []
    if window == "all":
        warnings.append(
            "window='all' ranks full history — context only; build decisions use window='24m'."
        )
    return {
        "dimension": dimension,
        "window": window,
        "min_reviews": min_reviews,
        "include_tiers": tiers_applied,
        "solo_only": solo_only,
        "sort": sort,
        "order": order,
        "fields": fields,
        "n_matching": int(total["n"]) if total else 0,
        "n_returned": len(niches),
        "rules": _rules_for(fired),
        "niches": niches,
        "warnings": warnings,
    }


def _pick_cut(variants: list[dict], window: str, min_reviews: int) -> dict:
    by_cut = {(v["window"], v["min_reviews"]): v for v in variants}
    for cut in ((window, min_reviews), ("24m", 50), ("all", 50)):
        if cut in by_cut:
            return by_cut[cut]
    return variants[0]


def _cut_label(window: str, min_reviews: int) -> dict:
    return {"window": window, "min_reviews": min_reviews}


@_tool
def niche_detail(
    dimension: Dimension,
    key: NicheKey,
    window: Window = "24m",
    min_reviews: MinReviews = 50,
    fields: Annotated[
        Literal["core", "all"],
        Field(description="core = compact other-cut rows + the last 10 trend years; all = every column of every cut + the full trend."),
    ] = "core",
) -> dict:
    """Deep dive on one niche (key from find_niches or tag_suggest; a known alias or a unique case-insensitive match is resolved and noted).

    Read `flags` and `rules` first — the same server-computed flags as find_niches, for the headline cut. Then:
    - headline: every mart column for the requested cut (default window='24m', min_reviews=50 — the market a new entrant faces), incl. opportunity_v2 and ALL its components; quote the components, never the lone score. An emerging niche's demand_trend_24m_pct is withheld (null).
    - hit_rates: $200K/$500K hit rates, median revenue, n_games and winner_concentration for the SAME cut.
    - variants: the other precomputed cuts (compact unless fields='all').
    - representative_games: top games by est. revenue WITHIN the headline cut; marts without mart_niche_game fall back to the all-time top 8, labelled so.
    - saturation_trend: yearly releases carrying the key (no review floor) + scored median/p90 revenue — a shrinking pipeline is decline even when competition looks low.
    - revenue_histogram: log-scale est. revenue buckets, window='all' x min_reviews=50 only (labelled).
    - players: latest live-player snapshot (nightly point samples, not peaks) + history bounds; niche_player_history has the series.
    Member games: niche_games(dimension, key). Formulas: methodology('scores').
    """
    cols = _cols("mart_niche")
    if not _NICHE_V2_REQUIRED <= cols:
        return {"error": _NICHE_V2_MISSING}
    resolved, note = _resolve_niche_key(dimension, key)
    if resolved is None:
        return {"error": note}
    # `win` is selected un-aliased (and renamed in Python) because `window` is a reserved
    # word in DuckDB SQL — same reason api/app/routers/niches.py renames it after the fetch.
    variants = query(
        "SELECT * EXCLUDE (dimension, key) FROM mart_niche WHERE dimension = ? AND key = ? "
        "ORDER BY win, min_reviews",
        [dimension, resolved],
    )
    if not variants:
        return {"error": f"no niche found for dimension={dimension!r} key={key!r}."}
    variants = [{"window": v.pop("win"), **v} for v in variants]
    headline = _pick_cut(variants, window, min_reviews)
    cut = _cut_label(headline["window"], headline["min_reviews"])
    warnings: list[str] = []
    if (headline["window"], headline["min_reviews"]) != (window, min_reviews):
        warnings.append(
            f"Cut window={window}, min_reviews={min_reviews} is not materialised for this niche "
            f"(under the 30-game floor) — the headline shows window={cut['window']}, "
            f"min_reviews={cut['min_reviews']} instead."
        )
    if headline["window"] == "all":
        warnings.append("The headline cut is window='all' (full history) — context, not the entry market.")
    flags = _niche_flags(headline)
    head = dict(headline)
    if fields == "core" and head.get("demand_emerging") is True and "demand_trend_24m_pct" in head:
        head["demand_trend_24m_pct"] = None
    others = [v for v in variants if v is not headline]
    if fields == "core":
        others = [{c: v.get(c) for c in _NICHE_VARIANT_CORE if c in v} for v in others]

    trend: list[dict] = []
    if _has_table("mart_niche_trend"):
        trend_cols = "year, n_releases, n_scored, median_rev" + (
            ", p90_rev" if _has_column("mart_niche_trend", "p90_rev") else ""
        )
        trend = query(
            f"SELECT {trend_cols} FROM mart_niche_trend WHERE dimension = ? AND key = ? ORDER BY year",
            [dimension, resolved],
        )
        if fields == "core":
            trend = trend[-10:]
    hist: list[dict] = []
    if _has_table("mart_niche_hist"):
        hist = query(
            "SELECT x_min, x_max, count FROM mart_niche_hist "
            "WHERE dimension = ? AND key = ? ORDER BY bucket_index",
            [dimension, resolved],
        )

    # Representative games: cut-aware when the mart carries per-cut membership, so the
    # list describes the same population as the headline numbers (mart_niche_top is ONE
    # cut-independent all-time top 8 — measured on Souls-like 24m/50 it listed two games
    # that are not in that cut at all).
    games: list[dict] = []
    games_cut: Any = "all-time top 8 by est. revenue (cut-independent; this mart predates mart_niche_game)"
    if _has_table("mart_niche_game"):
        games = query(
            "SELECT g.appid, g.name, g.release_year, g.price_initial, g.total_reviews, "
            "g.positive_ratio, g.est_rev_reviews, g.self_published "
            "FROM mart_niche_game m JOIN mart_game g ON g.appid = m.appid "
            "WHERE m.dimension = ? AND m.key = ? AND m.win = ? AND m.min_reviews = ? "
            "ORDER BY g.est_rev_reviews DESC NULLS LAST, g.appid LIMIT 8",
            [dimension, resolved, cut["window"], cut["min_reviews"]],
        )
        games_cut = cut
    elif _has_table("mart_niche_top"):
        games = query(
            "SELECT appid, name, release_year, price_initial, total_reviews, positive_ratio, "
            "est_rev_reviews, self_published FROM mart_niche_top "
            "WHERE dimension = ? AND key = ? ORDER BY rank_in_niche LIMIT 8",
            [dimension, resolved],
        )

    # Live-player snapshot (daily series lives in niche_player_history; here just the
    # latest row + bounds). None when the mart predates CCU or the niche was never
    # measured — a real answer, not an error.
    players = None
    if _has_players() and _has_table("mart_niche_players"):
        latest = query_one(
            "SELECT date, total_players, measured_players, n_games_measured, "
            "n_games_covered, n_games_panel FROM mart_niche_players "
            "WHERE dimension = ? AND key = ? ORDER BY date DESC LIMIT 1",
            [dimension, resolved],
        )
        if latest is not None:
            bounds = query_one(
                "SELECT MIN(date) AS first_date, MAX(date) AS last_date, "
                "COUNT(*) AS n_days FROM mart_niche_players WHERE dimension = ? AND key = ?",
                [dimension, resolved],
            ) or {}
            players = {**latest, "history": bounds}

    out: dict[str, Any] = {"dimension": dimension, "key": resolved}
    if note:
        out["key_note"] = note
    out.update(
        {
            "tier": headline.get("tier"),
            "cut": cut,
            "flags": flags,
            "rules": _rules_for(flags),
            "headline": head,
            "hit_rates": {
                "cut": cut,
                "hit_rate_200k": headline.get("hit_rate_200k"),
                "hit_rate_500k": headline.get("hit_rate_500k"),
                "median_rev": headline.get("median_rev"),
                "n_games": headline.get("n_games"),
                "winner_concentration": headline.get("winner_concentration"),
            },
            "variants": others,
            "saturation_trend": trend,
            "revenue_histogram_cut": _cut_label("all", 50),
            "revenue_histogram": hist,
            "representative_games_cut": games_cut,
            "representative_games": games,
            "players": players,
            "warnings": warnings,
        }
    )
    return out


_NICHE_GAMES_MISSING = (
    "This mart predates mart_niche_game (per-cut niche membership, an older ETL build). "
    "Rebuild the mart (`task etl`) and retry; niche_detail's representative_games still "
    "lists the all-time top games."
)
# Request-side sort names -> mart_game columns (whitelisted; mirrors the API's _GAME_SORT).
_NICHE_GAME_SORT = {
    "revenue": "g.est_rev_reviews",
    "price": "g.price_initial",
    "reviews": "g.total_reviews",
    "release_year": "g.release_year",
    "name": "g.name",
}


@lru_cache(maxsize=None)
def _niche_game_cuts(gen: int) -> frozenset[tuple[str, int]]:
    return frozenset(
        (str(r["win"]), int(r["min_reviews"]))
        for r in query("SELECT DISTINCT win, min_reviews FROM mart_niche_game")
    )


@_tool
def niche_games(
    dimension: Dimension,
    key: NicheKey,
    window: Window = "24m",
    min_reviews: MinReviews = 50,
    scope: Annotated[
        Literal["all", "indie"],
        Field(description="all = every member game; indie = Steam-tagged indie games only."),
    ] = "all",
    sort: Annotated[
        Literal["revenue", "price", "reviews", "release_year", "name"],
        Field(description="revenue = est. gross lifetime revenue (default)."),
    ] = "revenue",
    order: Order = "desc",
    limit: Annotated[int, _limit(50, "games")] = 15,
) -> dict:
    """Member games of one niche cut — who actually sells in it — mirroring the web niche page's games table.

    window/min_reviews select the same precomputed cut as find_niches (default 24m x 50 = games released in the last 24 months with >= 50 reviews). `stats` summarises the WHOLE cut (n_games, median/p90 est. revenue, $200K hit rate, median price) so a page of rows is never read as the population; the rows are one sorted page of it. With scope='indie' both stats and rows cover indie games only.
    Read the rows bearish-first: a niche whose revenue sits in its top two rows is winner-take-most whatever its median says. Revenue is a Boxleiter-style ESTIMATE (gross lifetime; free games carry none). Needs mart_niche_game — older marts return a rebuild error.
    """
    if not _has_table("mart_niche_game"):
        return {"error": _NICHE_GAMES_MISSING}
    resolved, note = _resolve_niche_key(dimension, key)
    if resolved is None:
        return {"error": note}
    cuts = _niche_game_cuts(_generation)
    if (window, min_reviews) not in cuts:
        return {
            "error": f"cut (window={window}, min_reviews={min_reviews}) is not materialised in "
            "mart_niche_game; available: " + ", ".join(f"({w}, {m})" for w, m in sorted(cuts))
        }
    if sort not in _NICHE_GAME_SORT or order not in ("asc", "desc"):
        return {"error": f"sort must be one of {sorted(_NICHE_GAME_SORT)} and order asc|desc"}
    limit = max(1, min(limit, 50))
    base = (
        "FROM mart_niche_game m JOIN mart_game g ON g.appid = m.appid "
        "WHERE m.dimension = ? AND m.key = ? AND m.win = ? AND m.min_reviews = ?"
    )
    params: list = [dimension, resolved, window, min_reviews]
    if scope == "indie":
        base += " AND g.is_indie = 1"
    stats = query_one(
        "SELECT COUNT(*) AS n_games, median(g.est_rev_reviews) AS median_rev, "
        "quantile_cont(g.est_rev_reviews, 0.9) AS p90_rev, "
        "AVG(CASE WHEN g.est_rev_reviews > 200000 THEN 1.0 ELSE 0.0 END) AS hit_rate_200k, "
        f"median(g.price_initial) AS median_price {base}",
        params,
    ) or {}
    live = ", g.live_players" if _has_column("mart_game", "live_players") else ""
    rows = query(
        "SELECT g.appid, g.name, g.release_year, g.price_initial, "
        "g.est_rev_reviews AS est_revenue, g.total_reviews, g.positive_ratio, g.is_indie, "
        f"g.self_published{live} {base} "
        f"ORDER BY {_NICHE_GAME_SORT[sort]} {order.upper()} NULLS LAST, g.appid LIMIT ?",
        params + [limit],
    )
    out: dict[str, Any] = {"dimension": dimension, "key": resolved}
    if note:
        out["key_note"] = note
    out.update(
        {
            "window": window,
            "min_reviews": min_reviews,
            "scope": scope,
            "sort": sort,
            "order": order,
            "stats": stats,
            "n_returned": len(rows),
            "games": rows,
            "caveats": [
                "est_revenue is a Boxleiter-style gross lifetime ESTIMATE (owners x price); "
                "free games carry none.",
                "Membership = the games mart_niche scores for this exact cut (tag = any of "
                "the game's community tags, genre = its genres), so n_games matches find_niches.",
            ],
        }
    )
    return out


@_tool
def tag_combos(
    tag: Annotated[str, Field(description="Exact community tag (tag_suggest resolves spelling); aliases/case resolved when unambiguous.")],
    limit: Annotated[int, _limit(50, "pairs per list")] = 15,
) -> dict:
    """Which co-tags does one Steam community tag perform best/worst WITH? The theme-as-modifier tool: pair a micro-genre pick with the theme/tag that lifts it.

    LIFT = the pair's median est. revenue / the BETTER of the two tags' solo medians (mart_niche all-time x min_reviews=50 baselines) — > 1 means the combination out-earns the stronger tag alone, so pairing a strong tag with a weak one can't game it. Pairs come from each game's top-10 community tags, games with >= 50 reviews, and need >= 15 games (below that a median is noise). Lift is null (and the pair unranked) when both solo medians are $0/unknown (free-to-play-dominated tags).

    Bearish reading first: weigh n_games (a pair near the 15-game floor is often a few famous titles wearing both tags, not a repeatable pattern); correlation, not causation; ALL-TIME baselines (not the 24m entry window). Revenue is a Boxleiter-style ESTIMATE. Returns solo context, best_combos (highest lift first), worst_combos (lowest first, no overlap) and a one-line headline. An unknown tag returns an error — get tags from tag_suggest / find_niches.
    """
    limit = max(1, min(limit, 50))
    tag, note = _resolve_tag(tag)
    try:
        rows = query(
            """
            SELECT
                CASE WHEN tag_a = ? THEN tag_b ELSE tag_a END AS partner,
                n_games,
                median_rev AS pair_median_rev,
                hit_rate_200k AS pair_hit_rate_200k,
                CASE WHEN tag_a = ? THEN tag_a_solo_median_rev ELSE tag_b_solo_median_rev END AS tag_solo_median_rev,
                CASE WHEN tag_a = ? THEN tag_b_solo_median_rev ELSE tag_a_solo_median_rev END AS partner_solo_median_rev,
                best_solo_median_rev,
                lift
            FROM mart_tag_lift
            WHERE tag_a = ? OR tag_b = ?
            ORDER BY lift DESC NULLS LAST
            """,
            [tag, tag, tag, tag, tag],
        )
    except duckdb.CatalogException:
        return {
            "error": "mart_tag_lift is not present in this analytics DB — it is built by a "
            "newer ETL than the one that produced this current.duckdb. Rebuild the marts "
            "(`task etl` in the main prospect checkout) and retry."
        }

    solo = query_one(
        "SELECT n_games, median_rev, hit_rate_200k FROM mart_niche "
        "WHERE dimension = 'tag' AND win = 'all' AND min_reviews = 50 AND key = ?",
        [tag],
    )
    if not rows and solo is None:
        return {
            "error": f"tag {tag!r} not found — it has neither a solo baseline in mart_niche "
            "nor any pairs meeting the 15-game floor. Get valid tags from tag_suggest(q) "
            "or find_niches(dimension='tag')."
        }

    ranked = [r for r in rows if r["lift"] is not None]
    unranked_free = len(rows) - len(ranked)  # both-solo-medians-$0 (free-to-play) pairs
    best = ranked[:limit]
    worst = list(reversed(ranked[limit:]))[:limit]  # lowest lift first, never overlaps best

    headline = None
    if best:
        b = best[0]
        headline = (
            f"'{tag}' pairs best with '{b['partner']}': the combo's median est. revenue is "
            f"{_usd(b['pair_median_rev'])} across {b['n_games']} games — {b['lift']:.2f}x the "
            f"better solo tag's median ({_usd(b['best_solo_median_rev'])})."
        )
        if worst:
            w = worst[0]
            headline += (
                f" It pairs worst with '{w['partner']}' ({w['lift']:.2f}x, "
                f"median {_usd(w['pair_median_rev'])} across {w['n_games']} games)."
            )
    elif solo is not None:
        headline = (
            f"'{tag}' has no tag pairs meeting the 15-game reliability floor — solo baseline "
            f"only (median est. revenue {_usd(solo['median_rev'])} across {solo['n_games']} games)."
        )

    caveats = [
        "Revenue is est_rev_reviews — a Boxleiter-style estimate (gross lifetime), not ground "
        "truth; lift compares pair median vs the BETTER solo tag's median (mart_niche all/50 cut).",
        "Correlation, not causation: good games choose these tag combinations as much as the "
        "combinations make games good.",
        "Weigh n_games — a pair near the 15-game floor is often a few famous titles wearing "
        "both tags, not a repeatable pattern.",
        "Tags are SteamSpy community tags (crowd-applied, top-10-per-game, vote-floored) — "
        "coverage is imperfect, especially for small/new games.",
    ]
    if unranked_free:
        caveats.append(
            f"{unranked_free} pair(s) omitted from the ranking: lift is undefined because both "
            "tags' solo medians are $0/unknown (free-to-play-dominated tags have no box revenue)."
        )

    out: dict[str, Any] = {"tag": tag}
    if note:
        out["key_note"] = note
    out.update(
        {
            "solo": {
                "n_games": solo["n_games"] if solo else None,
                "median_rev": solo["median_rev"] if solo else None,
                "hit_rate_200k": solo["hit_rate_200k"] if solo else None,
            },
            "n_pairs": len(rows),
            "headline": headline,
            "best_combos": best,
            "worst_combos": worst,
            "caveats": caveats,
        }
    )
    return out


_NICHE_THEME_CAVEATS = [
    "Aspect mining is keyword-lexicon based (10 fixed aspects), not semantic — any review "
    "containing e.g. \"boss\" counts toward Combat & Bosses regardless of what it meant.",
    "praise_share/complaint_share are VOTE-based (share of aspect-mentioning reviews that "
    "were thumbs-up/down OVERALL — they sum to 1, and complaint delta = -praise delta); "
    "text_praise_rate/text_complaint_rate are VADER sentiment of the local text window "
    "around the keyword — coarse lexicon scoring, sarcasm-blind, English-only, with a "
    "neutral band so the two rates do NOT sum to 1.",
    "Pooled, review-volume-weighted: heavily-reviewed games dominate their niche's shares. "
    "When n_games is low or one hit dwarfs the niche, a \"niche theme\" can really be one "
    "game's theme — check n_games/n_reviews_sampled.",
    "Niche membership is NARROWER than find_niches': tag = appears in the game's top-10 "
    "community tags; genre = the game's PRIMARY genre only. n_games here is therefore "
    "smaller than the same key's n_games in find_niches.",
    "Deltas vs the all-catalog pooled baseline are typically small (±0.01-0.06) — read "
    "them as leanings, not verdicts. Correlational, not causal.",
]


@_tool
def niche_review_themes(dimension: Dimension, key: NicheKey) -> dict:
    """What a whole NICHE praises vs complains about — per-aspect review sentiment pooled across every review-mined game in one tag/genre niche, each share with its delta vs the all-catalog baseline. It turns quality_gap into a concrete gap statement ("Souls-likes complain about Map & Navigation more than games in general — ship a great map").

    complaint_themes: sorted by text_complaint_delta_vs_catalog (what this niche complains about MORE than games in general first); praise_themes: by text_praise_delta_vs_catalog. Each row carries the vote-based praise_share/complaint_share (+ delta) and the VADER text rates (+ deltas), plus n_games / n_reviews_sampled / total_mentions to judge depth. An aspect can top BOTH lists (polarized).

    Caveats: keyword-lexicon aspects; review-volume weighted (one big hit can BE the niche's theme); membership is narrower than find_niches' (top-10 tags / primary genre); games need >= 20 sampled English reviews and an aspect >= 10 games. Empty lists with a `note` = too little review text, not an error.
    """
    resolved, note = _resolve_niche_key(dimension, key)
    if resolved is None:
        return {"error": note}
    try:
        rows = query(
            """
            SELECT aspect, n_games, n_reviews_sampled, total_mentions,
                   praise_share, complaint_share, praise_delta_vs_catalog,
                   n_text_scored, text_praise_rate, text_complaint_rate,
                   text_praise_delta_vs_catalog, text_complaint_delta_vs_catalog
            FROM mart_niche_themes
            WHERE dimension = ? AND key = ?
            """,
            [dimension, resolved],
        )
    except duckdb.Error as e:
        # An older mart won't carry mart_niche_themes until the next ETL run builds it —
        # degrade to a clear error instead of crashing the tool call.
        return {
            "error": "mart_niche_themes is missing from this analytics DB — it is built by "
            "etl/marts/mart_niche_themes.sql; re-run the ETL (`task etl`) so current.duckdb "
            f"includes it. ({type(e).__name__})"
        }

    out: dict[str, Any] = {"dimension": dimension, "key": resolved}
    if note:
        out["key_note"] = note
    if not rows:
        out.update(
            {
                "praise_themes": [],
                "complaint_themes": [],
                "note": "Niche exists but no aspect cleared the reliability floors (>= 10 games "
                "with >= 20 sampled English text reviews each mentioning the aspect) — too few "
                "review-mined games in this niche for a reliable theme read.",
                "caveats": _NICHE_THEME_CAVEATS,
            }
        )
        return out

    def _delta_sorted(field: str) -> list[dict]:
        return sorted(
            rows,
            key=lambda r: r[field] if r[field] is not None else float("-inf"),
            reverse=True,
        )[:5]

    out.update(
        {
            "n_aspects": len(rows),
            "praise_themes": _delta_sorted("text_praise_delta_vs_catalog"),
            "complaint_themes": _delta_sorted("text_complaint_delta_vs_catalog"),
            "caveats": _NICHE_THEME_CAVEATS,
        }
    )
    return out


# ==========================================================================================
# Market / revenue tools
# ==========================================================================================
@_tool
def market_benchmarks() -> dict:
    """Reference anchors for judging any revenue/owners number — call before quoting a dollar figure.

    - cited: public indie-market research (VG Insights / GameDiscoverCo / Boxleiter method) — median indie gross ~$249, ~8.5% of releases clear $100K, 20-55 owners per review (mid 30), wishlist-conversion assumptions, Steam's ~70%-to-dev share, and the 4 dev tiers (Hobby/Small/Middle/Triple-I) by lifetime copies.
    - computed: this catalog's own figures (median revenue, fitted Boxleiter slope, % over $100K, population sizes).
    - boxleiter_by_genre: fitted owners-per-review per genre (what estimate_revenue uses).
    - dev_tier_population: catalog games per dev tier.
    Cited and computed medians differ ON PURPOSE: cited = first-year/net over ALL releases; computed = Boxleiter gross-lifetime over games clearing the >= 10-review floor. Quote the bearish (cited, all-releases) anchor first when sizing a solo dev's likely outcome.
    """
    meta = _meta(_generation)

    def f(k: str) -> float | None:
        v = meta.get(k)
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    boxleiter = query(
        "SELECT genre, n, owners_per_review_median, owners_per_review_p25, "
        "owners_per_review_p75, slope FROM mart_market_boxleiter ORDER BY n DESC LIMIT 25"
    )
    tiers = query("SELECT tier, tier_order, count, pct FROM mart_market_tiers ORDER BY tier_order")

    return {
        "cited": {
            "median_indie_gross_usd": MEDIAN_INDIE_GROSS_USD,
            "pct_new_releases_over_100k": PCT_NEW_RELEASES_OVER_100K,
            "bottom_30_pct_gross_usd": BOTTOM_30_PCT_GROSS_USD,
            "reviews_1000_revenue_usd": REVIEWS_1000_REVENUE_USD,
            "boxleiter_owners_per_review": {
                "min": BOXLEITER_OWNERS_PER_REVIEW_MIN,
                "mid": BOXLEITER_OWNERS_PER_REVIEW_MID,
                "max": BOXLEITER_OWNERS_PER_REVIEW_MAX,
            },
            "wishlist_conversion_first_week": WISHLIST_CONVERSION_FIRST_WEEK,
            "first_week_to_first_year_mult": FIRST_WEEK_TO_FIRST_YEAR_MULT,
            "steam_revenue_share_to_dev": STEAM_REVENUE_SHARE_TO_DEV,
            "dev_tiers": DEV_TIERS,
        },
        "computed": {
            "median_revenue_scored": f("global_median_revenue"),
            "median_revenue_paid": f("global_median_revenue_paid"),
            "boxleiter_owners_per_review_slope": f("boxleiter_owners_per_review"),
            "pct_over_100k_scored": f("pct_over_100k"),
            "n_games_total": f("n_games_total"),
            "n_games_scored": f("n_games_scored"),
            "population_note": (
                "computed medians/pct are Boxleiter gross over games with >=10 reviews "
                "(paid = price>0, >=1 review); cited $249/8.5% are first-year/net over "
                "ALL releases"
            ),
        },
        "boxleiter_by_genre": boxleiter,
        "dev_tier_population": tiers,
    }


@_tool
def revenue_distribution(
    metric: Annotated[
        Literal["revenue", "reviews", "owners", "price"],
        Field(description="revenue = est. lifetime gross; reviews = total review count; owners = SteamSpy owners_mid; price = launch price (paid games only)."),
    ] = "revenue",
    genre: Annotated[str, Field(description="'__all__' for the whole catalog, or an exact Steam genre label (e.g. 'RPG').")] = "__all__",
    window: Annotated[Literal["all", "24m"], Field(description="all = every scored game; 24m = released in the last 24 months.")] = "all",
) -> dict:
    """Market-wide distribution of one metric for a genre and window: percentiles (p10..p99) plus a histogram (log-scale bins for revenue/reviews/owners, linear $2.50 bins for price).

    Use it to see the FULL shape of outcomes, not one average: revenue has a long tail of hits pulling the mean far above the median, so quote the median and the low percentiles first (the bearish reading), then the tail. Pair with market_benchmarks for cited reference points. window='24m' is the recent-entrant population.
    """
    pcts = query(
        "SELECT pctile, value, n FROM mart_market_pct WHERE metric = ? AND genre = ? AND win = ? ORDER BY value",
        [metric, genre, window],
    )
    if not pcts:
        return {
            "error": f"no data for metric={metric!r} genre={genre!r} window={window!r}. "
            "genre must be an exact Steam genre label or '__all__'."
        }
    buckets = query(
        "SELECT x_min, x_max, count FROM mart_market_hist WHERE metric = ? AND genre = ? AND win = ? ORDER BY bucket_index",
        [metric, genre, window],
    )
    return {
        "metric": metric,
        "genre": genre,
        "window": window,
        "n": int(pcts[0]["n"]),
        "percentiles": pcts,
        "histogram": buckets,
    }


@_tool
def estimate_revenue(
    price: Annotated[float, Field(ge=0, description="Launch price in USD.")],
    reviews: Annotated[int | None, Field(ge=0, description="Review count (Boxleiter path). Give exactly one of reviews / wishlists.")] = None,
    wishlists: Annotated[int | None, Field(ge=0, description="Wishlist count (earlier-stage, rougher path).")] = None,
    genre: Annotated[str | None, Field(description="Exact Steam genre label — strongly recommended: owners-per-review varies a lot by genre.")] = None,
) -> dict:
    """Estimate lifetime owners + gross/net revenue from EITHER a review count OR a wishlist count (exactly one), plus the launch price.

    reviews path (Boxleiter): owners = reviews x 20-55 owners/review, with this catalog's fitted per-genre slope as the mid (clamped to the cited band; falls back to the catalog-wide slope, then the cited mid 30). wishlists path: owners = wishlists x ~8-12% first-week conversion x 5 (first-week -> first-year) — rougher.

    Returns owners and revenue as {low, mid, high} RANGES (an order-of-magnitude estimate, not a forecast), revenue_net_usd (after Steam's ~30% cut) and dev_tier for the mid. Always report the range, low end first — never just the midpoint.
    """
    if (reviews is None) == (wishlists is None):
        return {"error": "Provide exactly one of `reviews` or `wishlists`."}

    lo, hi = float(BOXLEITER_OWNERS_PER_REVIEW_MIN), float(BOXLEITER_OWNERS_PER_REVIEW_MAX)
    genre_used, opr_mid = _genre_owners_per_review(genre)
    notes: list[str] = []

    if reviews is not None:
        basis = "reviews"
        owners = {"low": reviews * lo, "mid": reviews * opr_mid, "high": reviews * hi}
        notes.append(
            f"Owners = reviews x Boxleiter ({lo:.0f}-{hi:.0f} owners/review; "
            f"fitted mid for '{genre_used}' = {opr_mid:.0f})."
        )
    else:
        basis = "wishlists"
        wl_lo, wl_hi = WISHLIST_CONVERSION_RANGE
        wl_mid = WISHLIST_CONVERSION_FIRST_WEEK
        mult = FIRST_WEEK_TO_FIRST_YEAR_MULT
        owners = {
            "low": wishlists * wl_lo * mult,
            "mid": wishlists * wl_mid * mult,
            "high": wishlists * wl_hi * mult,
        }
        notes.append(
            f"Sales = wishlists x first-week conversion ({wl_lo:.0%}-{wl_hi:.0%}, mid "
            f"{wl_mid:.0%}) x first-year multiplier ({mult}x)."
        )
        notes.append("owners_per_review shown for reference only (not used on the wishlist path).")

    revenue_gross = {k: v * price for k, v in owners.items()}
    share = STEAM_REVENUE_SHARE_TO_DEV
    revenue_net = {k: v * share for k, v in revenue_gross.items()}
    notes.append(f"Net = gross x {share:.0%} (after Steam's ~30% cut, before taxes/refunds).")
    notes.append(f"Gross revenue = owners x ${price:.2f} price (box revenue, lifetime).")

    return {
        "basis": basis,
        "genre": genre_used,
        "owners_per_review_used": {"low": lo, "mid": opr_mid, "high": hi},
        "owners": owners,
        "revenue_gross_usd": revenue_gross,
        "revenue_net_usd": revenue_net,
        "dev_tier": _tier_for_copies(owners["mid"]),
        "notes": notes,
    }


@_tool
def lifetime_curve(
    include_curve: Annotated[
        bool,
        Field(description="Also return the raw 73-point monthly curve (t = 0..72). Off by default — quote the milestones."),
    ] = False,
) -> dict:
    """How long does a Steam game keep an audience once it has one? The catalog-wide survival curve: for every game whose steamcharts monthly history ever averaged 100+ concurrent players (that month = its t0), share_alive at month t = the share still averaging 10+ t months later, at FIXED horizons (only games observable >= t months count — right-censoring safe).

    SURVIVORSHIP FIRST: the cohort is games that DID reach 100+ concurrent players (top-8k-by-reviews coverage); most Steam releases never get there, so this answers "once a game has an audience, how long does it keep it" — NEVER "will my game find an audience".

    Returns milestones (m3/m6/m12/m24/m36/m60 shares — quote those), median_months (first month half the cohort has died; null = never within 72 months) and the methodology. A steep early drop means an audience is a launch-window phenomenon: plan revenue for that window. Per-niche: find_niches' lifetime_survival_12m; per-game: game_profile.
    """
    if not _has_lifetime_curve():
        return {"error": _LIFETIME_MISSING}
    rows = query("SELECT t, n_observable, share_alive FROM mart_market_lifetime ORDER BY t")
    by_t = {int(r["t"]): r["share_alive"] for r in rows}
    median_months = next(
        (int(r["t"]) for r in rows
         if r["share_alive"] is not None and r["share_alive"] <= 0.5),
        None,
    )
    out: dict[str, Any] = {
        "milestones": {f"m{m}": by_t.get(m) for m in (3, 6, 12, 24, 36, 60)},
        "median_months": median_months,
        "n_cohort": rows[0]["n_observable"] if rows else None,
        "methodology": (
            "t0 = a game's first calendar month averaging >= 100 concurrent players; "
            "death = the first FULL month after t0 averaging < 10 (the current partial "
            "month never counts). share_alive at month t is a FIXED-horizon share — only "
            "games observable >= t months since t0 count, so right-censoring never reads "
            "as death. Source: steamcharts.com monthly averages, top-8k-by-reviews games "
            "only — a monthly AVERAGE, not our nightly point samples, so a point-in-time "
            "dip can't kill a game. Games never reaching 100+ (most of Steam) are simply "
            "not in the cohort."
        ),
    }
    if include_curve:
        out["curve"] = rows
    return out


# ==========================================================================================
# Launch timing tools
# ==========================================================================================
_LAUNCH_WINDOWS = [
    ("1w", 0, 7),
    ("2w", 7, 14),
    ("3-4w", 14, 30),
    ("2m", 30, 60),
    ("3m", 60, 90),
    ("4-6m", 90, 180),
    ("7-12m", 180, 365),
]


def _windowed_shape(cum: dict[int, float]) -> list[dict]:
    """Marginal share of first-year reviews per launch window, from a cumulative curve.
    Day 0 is pinned to 0.0 (the curve's own day-0 value, if any, belongs to week 1)."""
    cum = {**cum, 0: 0.0}
    out = []
    for label, a, b in _LAUNCH_WINDOWS:
        fa, fb = cum.get(a), cum.get(b)
        share = max(0.0, fb - fa) if fa is not None and fb is not None else None
        out.append({"window": label, "share_of_first_year_reviews": share})
    return out


@_tool
def launch_shape(
    genre: Annotated[str, Field(description="'__all__' for the whole catalog, or an exact Steam genre label.")] = "__all__",
) -> dict:
    """How a genre's first-year review volume accumulates after launch, as a MARGINAL windowed shape (share of first-year reviews landing in 1w, 2w, 3-4w, 2m, 3m, 4-6m, 7-12m) — not a cumulative curve (which always climbs to 100% and looks alike for every genre).

    Tall early bars = front-loaded: success hinges on the launch-week splash (wishlists, a big first-week push). A flatter spread = slow-burn: post-launch marketing, word of mouth and updates pay off over months. Only genres with enough 365+-day-old games are present — check n_games. Per-game version: game_reviews_summary.
    """
    rows = query(
        "SELECT day, median_cum_fraction, n_games FROM mart_launch_curve WHERE genre = ? ORDER BY day",
        [genre],
    )
    if not rows:
        return {"error": f"no launch-curve data for genre={genre!r}. Try '__all__' or an exact Steam genre label."}
    cum = {int(r["day"]): r["median_cum_fraction"] for r in rows}
    return {"genre": genre, "n_games": rows[0]["n_games"], "windows": _windowed_shape(cum)}


_TIMING_MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@_tool
def best_launch_timing(
    genre: Annotated[str, Field(description="'__all__' for the whole catalog, or an exact Steam genre label.")] = "__all__",
) -> dict:
    """When to launch in a genre, from the TRUE uncapped monthly review histograms (Steam's own per-month totals for ~40K games).

    CAVEATS FIRST: seasonality is SECOND-ORDER vs game quality and wishlist momentum — timing tilts odds, it never rescues a weak game; congestion is genre-wide, not niche-level; reviews proxy sales; everything is correlational.

    - demand_by_month: share of the genre's pooled review velocity per calendar month over the last 5 complete years — when players actually buy (each game's first 2 months excluded so launch spikes can't fake seasonality).
    - congestion_by_month: average releases (and $200K+ releases) per calendar month over the last 3 complete years.
    - decay: median share of a game's first-24-months reviews in months 0-2 / 3-5 / 6-11 / 12-23 (per-game normalized) — how much of the payoff rides on the window.
    - recommendation: per-month score = demand_share/(1/12) - avg_releases/mean(avg_releases), both parts returned so the arithmetic is auditable, with the best 2-3 months and a rationale.
    """
    try:
        demand = query(
            "SELECT month, demand_share, n_games FROM mart_timing_demand "
            "WHERE genre = ? ORDER BY month",
            [genre],
        )
        congestion = query(
            "SELECT month, avg_releases, avg_big_releases, n_years FROM mart_timing_congestion "
            "WHERE genre = ? ORDER BY month",
            [genre],
        )
        decay = query(
            "SELECT month_since_release, median_share, n_games FROM mart_timing_decay "
            "WHERE genre = ? ORDER BY month_since_release",
            [genre],
        )
    except duckdb.CatalogException:
        return {
            "error": "mart_timing_demand/mart_timing_congestion/mart_timing_decay are not "
            "present in this analytics DB — they are built by a newer ETL than the one that "
            "produced it. Re-run `task etl` in the prospect checkout (needs a source "
            "steam_games.db with the review_histogram table), then retry."
        }
    if not demand and not congestion and not decay:
        return {
            "error": f"no timing data for genre={genre!r} — it may be below the per-genre "
            "size floors. Try '__all__' or an exact Steam genre label."
        }

    for d in demand:
        d["month_name"] = _TIMING_MONTH_NAMES[int(d["month"])]
    for c in congestion:
        c["month_name"] = _TIMING_MONTH_NAMES[int(c["month"])]

    # Transparent window score — same arithmetic as /api/timing/overview.
    recommendation = None
    d_by_m = {int(d["month"]): d for d in demand if d["demand_share"] is not None}
    c_by_m = {int(c["month"]): c for c in congestion}
    if len(d_by_m) == 12 and len(c_by_m) == 12:
        mean_rel = sum(c["avg_releases"] for c in c_by_m.values()) / 12
        months = []
        for m in range(1, 13):
            demand_index = d_by_m[m]["demand_share"] * 12
            congestion_index = c_by_m[m]["avg_releases"] / mean_rel if mean_rel > 0 else None
            months.append({
                "month": m,
                "month_name": _TIMING_MONTH_NAMES[m],
                "demand_index": demand_index,
                "congestion_index": congestion_index,
                "score": demand_index - congestion_index if congestion_index is not None else None,
            })
        scored = [w for w in months if w["score"] is not None]
        if scored:
            best = sorted(scored, key=lambda w: w["score"], reverse=True)[:3]
            top = best[0]
            label = "the catalog" if genre == "__all__" else genre
            recommendation = {
                "best_months": [w["month_name"] for w in best],
                "method": "score = demand_share/(1/12) - avg_releases/mean(avg_releases)",
                "rationale": (
                    f"{', '.join(w['month_name'] for w in best)} look best for {label}: in "
                    f"{top['month_name']}, players do {top['demand_index']:.2f}x an average "
                    f"month's buying while release traffic runs "
                    f"{top['congestion_index']:.2f}x the monthly average — demand outruns "
                    "crowding there. Timing tilts odds; it doesn't rescue a weak game."
                ),
                "months": months,
            }

    # Decay condensed to windows (the full 24-point curve lives on /api/timing/overview).
    decay_summary = None
    med = {int(r["month_since_release"]): r["median_share"] for r in decay
           if r["median_share"] is not None}
    total = sum(med.values())
    if med and total > 0:
        def _win(a: int, b: int) -> float:  # [a, b) renormalized share
            return sum(s for m, s in med.items() if a <= m < b) / total
        decay_summary = {
            "n_games": decay[0]["n_games"],
            "month_0_median_share": med.get(0),
            "share_of_first_24m_reviews": {
                "months_0_2": _win(0, 3),
                "months_3_5": _win(3, 6),
                "months_6_11": _win(6, 12),
                "months_12_23": _win(12, 24),
            },
            "note": "per-game normalized medians, renormalized to sum to 1 across the 24 months",
        }

    return {
        "genre": genre,
        "recommendation": recommendation,
        "demand_by_month": demand,
        "congestion_by_month": congestion,
        "decay": decay_summary,
        "caveats": (
            "Seasonal effects are second-order vs. game quality; congestion is genre-wide, "
            "not niche-level; reviews proxy sales; correlational throughout."
        ),
    }


# ==========================================================================================
# Game tools
# ==========================================================================================
GameSort = Literal[
    "total_reviews", "est_rev_reviews", "owners_mid", "positive_ratio", "price_initial",
    "release_year", "release_date", "name", "rev_pct_in_genre", "reviews_pct_in_genre",
    "owners_pct_in_genre", "n_reviews_trailing_30d", "metacritic_score", "live_players",
    "first_seen", "lifetime_months",
]
_GAME_SORTABLE = frozenset(GameSort.__args__)
# game_search's lean row (fields="core"); columns a mart lacks are simply omitted. Dropped
# from core on purpose: header_image (a URL no model needs), first_seen / release_date
# (release_year carries the signal), metacritic_score (null for ~97% of games).
_GAME_CORE = (
    "appid", "name", "primary_genre", "release_year", "price_initial", "is_free", "is_indie",
    "self_published", "owners_mid", "total_reviews", "positive_ratio", "est_rev_reviews",
    "live_players", "top_tags", "lifetime_months", "lifetime_alive", "has_demo", "dev_x_handle",
)
_GAME_ALL = (
    "appid", "name", "primary_genre", "release_year", "release_date", "first_public_date",
    "release_date_1_0", "is_ea_graduate", "price_initial", "is_free", "is_indie",
    "self_published", "owners_mid", "total_reviews", "positive_ratio", "est_rev_reviews",
    "metacritic_score", "live_players", "players_7d_avg", "players_trend_7d_pct",
    "first_seen", "header_image", "top_tags", "lifetime_months", "lifetime_alive",
    "dev_x_handle", "has_demo",
)
PositiveFraction = Annotated[
    float | None,
    Field(
        description="Floor on positive_ratio as a 0-1 FRACTION (0.8 = at least 80% positive).",
        json_schema_extra={"minimum": 0, "maximum": 1},
    ),
    AfterValidator(_fraction_0_1),
]


@_tool
def game_search(
    q: Annotated[str | None, Field(description="Case-insensitive substring of the game name.")] = None,
    tag: Annotated[str | None, Field(description="Exact community tag the game carries in its top tags (tag_suggest resolves spelling).")] = None,
    genre: Annotated[str | None, Field(description="Exact Steam genre — matches the game's PRIMARY genre only.")] = None,
    min_reviews: Annotated[int, Field(ge=0, description="Floor on total_reviews.")] = 0,
    min_lifetime_months: Annotated[int | None, Field(ge=0, description="Floor on lifetime_months (steamcharts top-8k coverage); drops games with unknown lifetime.")] = None,
    lifetime_alive: Annotated[bool | None, Field(description="true = still averaging 10+ concurrent players, false = audience died; either value drops unknown-lifetime games.")] = None,
    min_metacritic: Annotated[int | None, Field(ge=0, le=100, description="Floor on the Metacritic critic score — only ~2.6% of games have one, so this drops ~97%.")] = None,
    has_demo: Annotated[bool | None, Field(description="true = has a playable Steam demo, false = checked and has none; either drops not-yet-checked games.")] = None,
    released_within_days: Annotated[int | None, Field(ge=1, le=3650, description="Released within N days of the mart's data_as_of date.")] = None,
    released_after: Annotated[int | None, Field(ge=1970, le=2100, description="release_year >= this.")] = None,
    released_before: Annotated[int | None, Field(ge=1970, le=2100, description="release_year <= this.")] = None,
    price_min: Annotated[float | None, Field(ge=0, description="List-price floor, USD (drops NULL-priced games).")] = None,
    price_max: Annotated[float | None, Field(ge=0, description="List-price ceiling, USD.")] = None,
    min_positive: PositiveFraction = None,
    min_revenue: Annotated[float | None, Field(ge=0, description="Floor on est_rev_reviews, USD.")] = None,
    self_published: Annotated[bool | None, Field(description="true = self-published only, false = publisher-backed only.")] = None,
    indie: Annotated[bool | None, Field(description="true = indie only, false = non-indie only.")] = None,
    sort: Annotated[GameSort, Field(description="Field to sort by (*_pct_in_genre = 0-100 percentile within the primary genre).")] = "total_reviews",
    order: Order = "desc",
    fields: Annotated[Literal["core", "all"], Field(description="core = lean rows; all = every column (incl. header_image, release_date, metacritic).")] = "core",
    limit: Annotated[int, _limit(50, "games")] = 15,
) -> dict:
    """Search/filter the game catalog (games clearing the >= 10-review analysis floor) — to find an appid for game_profile / find_comparables / game_teardown, or to spot-check who leads a tag or genre.

    Filters combine with AND. NULL-DROP semantics (bearish: an unmeasured game can't be shown to pass): any lifetime, demo, metacritic or price filter drops games whose value is unknown. has_demo is tri-state (NULL = not yet checked, never "no demo"). metacritic exists for ~2.6% of games (publisher-skewed) — use positive_ratio as the broad quality signal. dev_x_handle is an official X link from the game's own pages (may be the studio's or a dev's personal account). released_within_days counts back from the mart's data_as_of date, not today. Rows are lean by default (fields='all' adds the rest).
    """
    if sort not in _GAME_SORTABLE:
        return {"error": f"sort must be one of {sorted(_GAME_SORTABLE)}"}
    if order not in ("asc", "desc"):
        return {"error": "order must be 'asc' or 'desc'"}
    # The schema validator gives the wire this same message; direct calls get it here.
    try:
        _fraction_0_1(min_positive)
    except ValueError as exc:
        return {"error": str(exc)}
    gcols = _cols("mart_game")
    if sort not in gcols:
        if sort == "lifetime_months":
            return {"error": _LIFETIME_MISSING}
        return {"error": _column_missing("mart_game", sort)}
    if (min_lifetime_months is not None or lifetime_alive is not None) and not _has_lifetime_game():
        return {"error": _LIFETIME_MISSING}
    if has_demo is not None and not _has_demo():
        return {"error": _DEMO_MISSING}

    tag, tag_note = _resolve_tag(tag)
    where = ["total_reviews >= ?"]
    params: list = [min_reviews]
    if q:
        if _has_name_lower():
            where.append("contains(name_lower, ?)")
            params.append(q.lower())
        else:
            where.append("name ILIKE ?")
            params.append(f"%{q}%")
    if genre:
        where.append("primary_genre = ?")
        params.append(genre)
    if tag:
        where.append("list_contains(top_tags, ?)")
        params.append(tag)
    # Lifetime filters compare against NULL-able columns, so unknown-lifetime games drop
    # out naturally — a game we can't measure can't be shown to satisfy the constraint.
    if min_lifetime_months is not None:
        where.append("lifetime_months >= ?")
        params.append(min_lifetime_months)
    if lifetime_alive is not None:
        where.append("lifetime_alive = ?")
        params.append(lifetime_alive)
    if min_metacritic is not None:
        where.append("metacritic_score >= ?")
        params.append(min_metacritic)
    if released_within_days is not None:
        # "New releases": released in the recent PAST relative to the MART's as-of date
        # (not the wall clock — an older mart would otherwise return nothing). Upper-bounded
        # to that date so upcoming titles and far-future placeholder dates (9998-12-31) are
        # excluded; NULL/unparseable release dates drop out via TRY_CAST.
        anchor = _as_of_date().isoformat()
        where.append(
            "TRY_CAST(release_date AS DATE) >= CAST(? AS DATE) - CAST(? AS INTEGER) "
            "AND TRY_CAST(release_date AS DATE) <= CAST(? AS DATE)"
        )
        params.extend([anchor, released_within_days, anchor])
    if released_after is not None:
        where.append("release_year >= ?")
        params.append(released_after)
    if released_before is not None:
        where.append("release_year <= ?")
        params.append(released_before)
    # Price band in USD. Comparisons drop NULL-priced rows naturally. Free games
    # (price_initial = 0) stay in whenever the floor allows 0. Filters on the LIST PRICE,
    # not is_free, because some F2P-flagged titles sell paid editions with a real price.
    if price_min is not None:
        where.append("price_initial >= ?")
        params.append(price_min)
    if price_max is not None:
        where.append("price_initial <= ?")
        params.append(price_max)
    if min_positive is not None:
        where.append("positive_ratio >= ?")
        params.append(min_positive)
    if min_revenue is not None:
        where.append("est_rev_reviews >= ?")
        params.append(min_revenue)
    if self_published is not None:
        where.append("self_published = ?")
        params.append(1 if self_published else 0)
    if indie is not None:
        where.append("is_indie = ?")
        params.append(1 if indie else 0)
    if has_demo is not None:
        # Tri-state: NULL (not yet checked) satisfies neither = comparison, so unknowns drop
        # out rather than being counted as "no demo".
        where.append("has_demo = ?")
        params.append(has_demo)
    limit = max(1, min(limit, 50))

    wanted = list(_GAME_ALL if fields == "all" else _GAME_CORE)
    if min_metacritic is not None or sort == "metacritic_score":
        wanted.append("metacritic_score")
    wanted.append(sort)
    select = ", ".join(c for c in _dedupe(wanted) if c in gcols)
    rows = query(
        f"""
        SELECT {select}
        FROM mart_game
        WHERE {" AND ".join(where)}
        ORDER BY {sort} {order.upper()} NULLS LAST, total_reviews DESC
        LIMIT ?
        """,
        params + [limit],
    )
    filters = {
        k: v
        for k, v in {
            "q": q, "tag": tag, "genre": genre, "min_reviews": min_reviews or None,
            "min_lifetime_months": min_lifetime_months, "lifetime_alive": lifetime_alive,
            "min_metacritic": min_metacritic, "has_demo": has_demo,
            "released_within_days": released_within_days, "released_after": released_after,
            "released_before": released_before, "price_min": price_min, "price_max": price_max,
            "min_positive": min_positive, "min_revenue": min_revenue,
            "self_published": self_published, "indie": indie,
        }.items()
        if v is not None
    }
    out: dict[str, Any] = {"filters": filters}
    if tag_note:
        out["key_note"] = tag_note
    out.update({"sort": sort, "order": order, "n_returned": len(rows), "games": rows})
    return out


# game_profile's gated columns, in output order: (column, the table that must carry it).
_PROFILE_OPTIONAL = (
    "first_seen", "first_public_date", "release_date_1_0", "is_ea_graduate",
    "live_players", "players_7d_avg", "players_trend_7d_pct", "players_trend_7d_market_pct",
    "players_trend_7d_rel_pct",
    "lifetime_first_100_month", "lifetime_died_month", "lifetime_months", "lifetime_alive",
    "dev_x_handle", "dev_x_url", "dev_discord_url", "dev_youtube_url", "dev_bluesky_handle",
    "dev_bluesky_url", "has_demo", "demo_appid", "metacritic_url",
)


@_tool
def game_profile(appid: Annotated[int, Field(ge=1, description="Steam appid (find it with game_search).")]) -> dict:
    """Full profile for one game by Steam appid: metadata (primary genre, developers, publishers, self-published?, indie?), price, owners / reviews / est. revenue (Boxleiter-style ESTIMATES), percentile rank vs games in the same primary genre (rev/reviews/owners_pct_in_genre, 0-100), top community tags, review velocity (first 30/90/365 days + trailing 30 days — "is it still getting attention"), and lifetime playtime percentiles (playtime_p25/p50/p75, in MINUTES).

    When the mart carries them: live_players / players_7d_avg / players_trend_7d_pct (nightly point samples, NOT daily peaks — game_player_history has the series); lifetime_first_100_month / lifetime_died_month / lifetime_months / lifetime_alive (steamcharts monthly, top-8k coverage; all null = UNKNOWN, never zero); official socials harvested from the game's own pages (dev_x_handle may be the studio's or a dev's personal account); has_demo (null = not yet checked); Early Access dates (first_public_date, release_date_1_0, is_ea_graduate) on newer marts. Returns an error for an appid below the >= 10-review floor or not in the catalog.
    """
    gcols = _cols("mart_game")
    optional = "".join(f", {c}" for c in _PROFILE_OPTIONAL if c in gcols)
    row = query_one(
        f"""
        SELECT appid, name, release_year, release_date, price_initial, is_free,
               primary_genre, developers, publishers, self_published, is_indie,
               owners_mid, total_reviews, positive_ratio, est_rev_reviews, est_rev_owners,
               metacritic_score, achievements_count, avg_playtime_forever,
               short_description, header_image, rev_pct_in_genre,
               reviews_pct_in_genre, owners_pct_in_genre, top_tags, n_reviews_sampled,
               n_reviews_first_30d, n_reviews_first_90d,
               n_reviews_first_365d, n_reviews_trailing_30d, playtime_p25, playtime_p50,
               playtime_p75{optional}
        FROM mart_game WHERE appid = ?
        """,
        [appid],
    )
    if row is None:
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, "
            "or has fewer than 10 sampled reviews and didn't clear the analysis floor."
        }
    if "players_7d_avg" in gcols:
        row["caveats"] = [_PLAYERS_POINT_SAMPLE_CAVEAT]
    return row


@_tool
def find_comparables(
    appid: Annotated[int, Field(ge=1, description="Target game's Steam appid.")],
    limit: Annotated[int, _limit(50, "comparables")] = 15,
    min_reviews: Annotated[int, Field(ge=0, description="Candidates need total_reviews >= this (raise it to keep only proven competitors).")] = 10,
) -> dict:
    """Closest competitors for one game — "who else is fighting for this audience?" — computed on demand (no precomputed pairwise mart).

    Matching: same PRIMARY Steam genre only; price band [max(0, 0.5*price - $2), 2*price + $2] (free games match only free games); candidates need total_reviews >= min_reviews; ranked by Jaccard similarity of the two games' top-10 community tags (|shared| / |union|), ties by total_reviews. shared_tags shows what matched.

    Caveats first: tag-Jaccard is MECHANICAL similarity — overlapping tag sets, not overlapping audiences; est_rev_reviews is a Boxleiter ESTIMATE; mistagged or thinly-tagged games mismatch. Follow up with game_profile on the closest matches and game_teardown on the strongest.
    """
    target = query_one(
        "SELECT appid, name, primary_genre, price_initial, top_tags FROM mart_game WHERE appid = ?",
        [appid],
    )
    if target is None:
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, "
            "or below the >=10-review analysis floor. Use game_search to find appids."
        }

    price = target["price_initial"] or 0.0
    if price <= 0:
        lo, hi = -0.01, 0.01  # free games are only comparable to other free games
    else:
        lo, hi = max(0.0, price * 0.5 - 2.0), price * 2.0 + 2.0
    limit = max(1, min(limit, 50))

    # Jaccard denominator via |A ∪ B| = len(a) + len(b) − |A ∩ B| — exact, because
    # top_tags is duplicate-free by construction (a top-10 ranking). The FastAPI twin
    # (api/app/routers/games.py::game_comparables) computes it as
    # len(list_distinct(list_concat(a, b))) per row, which made it the slowest handler in
    # production (808ms p95); this form skips the per-row concat+distinct and returns the
    # identical ordering.
    rows = query(
        """
        WITH target AS (SELECT appid, primary_genre, top_tags FROM mart_game WHERE appid = ?),
        scored AS (
            SELECT g.appid, g.name, g.release_year, g.price_initial, g.total_reviews,
                g.positive_ratio, g.est_rev_reviews,
                list_intersect(g.top_tags, t.top_tags) AS shared_tags,
                len(list_intersect(g.top_tags, t.top_tags)) AS n_shared,
                len(g.top_tags) + len(t.top_tags) AS len_sum
            FROM mart_game g, target t
            WHERE g.appid != t.appid
              AND g.primary_genre = t.primary_genre
              AND g.price_initial BETWEEN ? AND ?
              AND g.total_reviews >= ?
        )
        SELECT appid, name, release_year, price_initial, total_reviews, positive_ratio,
            est_rev_reviews, shared_tags,
            n_shared * 1.0 / (len_sum - n_shared) AS jaccard
        FROM scored
        WHERE len_sum - n_shared > 0
        ORDER BY jaccard DESC, total_reviews DESC
        LIMIT ?
        """,
        [appid, lo, hi, min_reviews, limit],
    )
    result = {
        "appid": appid,
        "name": target["name"],
        "primary_genre": target["primary_genre"],
        "price_band": {"low": lo, "high": hi},
        "min_reviews": min_reviews,
        "n_returned": len(rows),
        "comparables": rows,
        "caveats": [
            "Tag-Jaccard is mechanical similarity: overlapping tag sets, not overlapping "
            "audiences — sanity-check the top matches with game_profile before leaning on them.",
            "est_rev_reviews is a Boxleiter estimate (gross lifetime), not reported revenue.",
            "Only games sharing the target's PRIMARY genre are candidates; free games only "
            "match other free games.",
        ],
    }
    if not rows:
        result["note"] = (
            "No comparables matched — the target may have a rare primary genre, few/no "
            "community tags, or no same-genre games in its price band clearing min_reviews."
        )
    return result


@_tool
def game_teardown(appid: Annotated[int, Field(ge=1, description="Steam appid (find it with game_search).")]) -> dict:
    """"Why it works" teardown for one game — (A) review-text aspect mining fused with (B) its press/PR footprint.

    Both signals are CORRELATIONAL — evidence toward why a game got popular, never proof. Check eligible_reviews and press.total_mentions before leaning on the numbers, and read `caveats` for this game's data-quality flags.
    (A) review_aspects: 10 fixed aspects (Combat & Bosses, World & Exploration, Art & Visuals, Music & Audio, Story & Writing, Difficulty, Controls & Performance, Map & Navigation / Backtracking, Content & Length, Price & Value), each with pos_share (share of keyword-matched mentions from positive reviews) and delta_vs_genre (this game minus its genre's baseline — what makes it stand out from peers, not just "players like it"), plus the VADER text-sentiment pair where the mart has it.
    (B) press: total mentions, distinct outlets, first/last seen, top sources, a timeline and up to 5 notable articles (incl. the earliest), plus article tone where the mart has it.
    Quote the reviewers behind an aspect with aspect_reviews(appid, aspect, sentiment).
    """
    game = query_one("SELECT appid, name, primary_genre FROM mart_game WHERE appid = ?", [appid])
    if game is None:
        return {"error": f"appid {appid} not found in mart_game."}

    # The text-sentiment / press-tone / article-link columns landed in later ETL builds —
    # gated so an older mart still gets the vote-based teardown instead of a Binder error.
    text_cols = ""
    if _has_column("mart_game_review_aspects", "text_pos_share") and _has_column(
        "mart_genre_aspect_baseline", "text_pos_share"
    ):
        text_cols = """,
            -- Aspect TEXT sentiment (VADER) + its own genre-baseline differential. pos_share
            -- is thumbs-based; these are what reviewers actually WROTE about the aspect.
            a.n_text_pos, a.n_text_neg, a.n_text_neutral, a.text_pos_share, a.mean_compound,
            COALESCE(gb.text_pos_share, ab.text_pos_share) AS genre_text_pos_share,
            a.text_pos_share - COALESCE(gb.text_pos_share, ab.text_pos_share) AS text_delta_vs_genre"""
    aspect_rows = query(
        f"""
        SELECT a.aspect, a.n_pos_mentions, a.n_neg_mentions, a.total_mentions, a.pos_share,
            a.n_reviews_sampled,
            COALESCE(gb.pos_share, ab.pos_share) AS genre_pos_share,
            a.pos_share - COALESCE(gb.pos_share, ab.pos_share) AS delta_vs_genre,
            -- Which baseline the differential was measured against: the game's own primary
            -- genre where it cleared the minimum game count, else the '__all__' catalog-wide
            -- one. Without this an agent cannot tell a genre-relative claim from a global one.
            COALESCE(gb.genre, ab.genre) AS baseline_genre,
            COALESCE(gb.n_games, ab.n_games) AS n_games_in_baseline{text_cols}
        FROM mart_game_review_aspects a
        LEFT JOIN mart_genre_aspect_baseline gb ON gb.genre = ? AND gb.aspect = a.aspect
        LEFT JOIN mart_genre_aspect_baseline ab ON ab.genre = '__all__' AND ab.aspect = a.aspect
        WHERE a.appid = ?
        ORDER BY a.total_mentions DESC
        """,
        [game["primary_genre"], appid],
    )
    n_reviews_sampled = int(aspect_rows[0]["n_reviews_sampled"]) if aspect_rows else 0

    tone = _has_column("mart_game_press_summary", "press_pos_share")
    tone_cols = (
        ", n_pos_articles, n_neg_articles, n_neutral_articles, n_scored_articles, "
        "press_pos_share, mean_compound" if tone else ""
    )
    press_summary = query_one(
        f"SELECT total_mentions, n_sources, first_seen, last_seen{tone_cols} "
        "FROM mart_game_press_summary WHERE appid = ?",
        [appid],
    )
    by_source = query(
        "SELECT source, n_mentions FROM mart_game_press_by_source WHERE appid = ? ORDER BY n_mentions DESC LIMIT 8",
        [appid],
    )
    ncols = _cols("mart_game_press_notable")
    notable_cols = ", ".join(
        c for c in ("source", "title", "author", "published_at", "match_confidence",
                    "is_earliest", "url", "sentiment_compound", "sentiment")
        if c in ncols
    )
    notable = query(
        f"SELECT {notable_cols} FROM mart_game_press_notable "
        "WHERE appid = ? ORDER BY published_at LIMIT 5",
        [appid],
    )
    timeline = query(
        "SELECT period, n_mentions FROM mart_game_press_timeline WHERE appid = ? ORDER BY period",
        [appid],
    )

    caveats = [
        "Review aspects are mined from a SAMPLE of English-language reviews, recency-biased "
        "toward older/popular titles — not the game's full review history.",
        "Press coverage is fuzzy-matched and confidence-filtered, skews recent (~365-day scrape "
        "backfill) and English-outlet; Steam News (dev-authored posts) is excluded.",
        "Correlational, not causal: evidence toward \"why it got popular,\" not proof.",
    ]
    if 0 < n_reviews_sampled < 50:
        caveats.append(f"Only {n_reviews_sampled} sampled English reviews — aspect shares are thin/noisy.")
    if not aspect_rows:
        caveats.append("Fewer than the review floor of sampled English reviews — review-aspect mining unavailable.")
    if press_summary is None:
        caveats.append("No press coverage found above the match-confidence floor.")
    elif press_summary.get("n_scored_articles"):
        caveats.append(
            "Press tone is VADER sentiment of each matched article's headline + short summary "
            "(not the body), so it captures an outlet's framing rather than a considered "
            "verdict — and an article's overall tone only proxies its stance on this game."
        )

    press: dict[str, Any] = {
        "total_mentions": int(press_summary["total_mentions"]) if press_summary else 0,
        "n_sources": int(press_summary["n_sources"]) if press_summary else 0,
        "first_seen": press_summary["first_seen"] if press_summary else None,
        "last_seen": press_summary["last_seen"] if press_summary else None,
        "by_source": by_source,
        "timeline": timeline,
        "notable_articles": notable,
    }
    if tone:
        # Article-tone counts + share, matching the REST teardown. n_scored_articles is the
        # denominator that makes press_pos_share readable — a share over three scored
        # articles is not the same claim as one over thirty.
        for k in ("n_pos_articles", "n_neg_articles", "n_neutral_articles", "n_scored_articles"):
            press[k] = int(press_summary[k] or 0) if press_summary else 0
        press["press_pos_share"] = press_summary["press_pos_share"] if press_summary else None
        press["mean_compound"] = press_summary["mean_compound"] if press_summary else None

    return {
        "appid": appid,
        "name": game["name"],
        "primary_genre": game["primary_genre"],
        "eligible_reviews": len(aspect_rows) > 0,
        "n_reviews_sampled": n_reviews_sampled,
        "review_aspects": aspect_rows,
        "press": press,
        "caveats": caveats,
    }


@_tool
def game_reviews_summary(
    appid: Annotated[int, Field(ge=1, description="Steam appid.")],
    months: Annotated[int, Field(ge=1, le=600, description="Monthly timeline rows returned, most recent last (default 24 = the 24-month window). The lifetime totals always ride in timeline_summary.")] = 24,
    include_launch_curve: Annotated[bool, Field(description="Also return the raw per-day first-year curve (launch_shape_windows always summarises it).")] = False,
) -> dict:
    """How ONE game's reception moved over time, who its audience is, and how front-loaded its reviews were — the per-game counterpart to launch_shape.

    - timeline: the last `months` MONTHLY rows (n_reviews, n_positive, cumulative totals, cum_positive_share, and trailing_reviews / trailing_positive_share — a bounded recent window that can fall, unlike the launch-anchored cumulative share: read the trailing one first). From Steam's own uncapped review histogram. timeline_summary keeps the lifetime totals.
    - language_split: share of reviews by language (from our SAMPLE — who actually plays it).
    - playtime_at_review: MINUTES played when the review was written (not game_profile's lifetime playtime).
    - launch_shape_windows: share of first-year reviews per launch window (1w ... 7-12m).
    Empty lists (eligible=false) mean too few sampled reviews, not a bad reception.
    """
    if not _has_game_reviews():
        return {
            "error": "mart_game_reviews_* are not present in this analytics DB — it was "
            "built by an older ETL. Re-run the ETL (`task etl`) and retry."
        }
    if not query_one("SELECT appid FROM mart_game WHERE appid = ?", [appid]):
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, or "
            "below the analysis floor."
        }
    months = max(1, min(months, 600))
    timeline = query(
        "SELECT period, n_reviews, n_positive, cum_reviews, cum_positive, cum_positive_share, "
        "trailing_reviews, trailing_positive_share "
        "FROM mart_game_reviews_timeline WHERE appid = ? ORDER BY period DESC LIMIT ?",
        [appid, months],
    )
    timeline.reverse()
    span = query_one(
        "SELECT MIN(period) AS first_period, MAX(period) AS last_period, COUNT(*) AS n_months "
        "FROM mart_game_reviews_timeline WHERE appid = ?",
        [appid],
    ) or {}
    lang = query(
        "SELECT language, n, share FROM mart_game_reviews_lang WHERE appid = ? ORDER BY n DESC",
        [appid],
    )
    playtime = query(
        "SELECT pctile, value FROM mart_game_reviews_playtime WHERE appid = ? ORDER BY pctile",
        [appid],
    )
    curve = query(
        "SELECT day, cum_fraction, sample_first_year_reviews FROM mart_game_launch_curve "
        "WHERE appid = ? ORDER BY day",
        [appid],
    )
    last = timeline[-1] if timeline else None
    out: dict[str, Any] = {
        "appid": appid,
        "eligible": bool(timeline or lang or playtime),
        "timeline_summary": {
            **span,
            "cum_reviews": last["cum_reviews"] if last else None,
            "cum_positive_share": last["cum_positive_share"] if last else None,
            "months_returned": len(timeline),
        },
        "timeline": timeline,
        "language_split": lang,
        "playtime_at_review": playtime,
        "launch_shape_windows": (
            _windowed_shape({int(r["day"]): r["cum_fraction"] for r in curve}) if curve else []
        ),
        "caveats": [
            "timeline uses Steam's uncapped monthly review histogram; language_split and "
            "playtime_at_review are composed from our SAMPLE of reviews, so they describe "
            "the sample's mix rather than every review ever written.",
            "playtime_at_review is MINUTES played WHEN THE REVIEW WAS WRITTEN — distinct "
            "from game_profile's playtime_p25/p50/p75 (lifetime playtime_forever, also minutes).",
        ],
    }
    if include_launch_curve:
        out["launch_curve"] = curve
    return out


_VALID_ASPECTS = (
    "Combat & Bosses",
    "World & Exploration",
    "Art & Visuals",
    "Music & Audio",
    "Story & Writing",
    "Difficulty",
    "Controls & Performance",
    "Map & Navigation / Backtracking",
    "Content & Length",
    "Price & Value",
)


@_tool
def aspect_reviews(
    appid: Annotated[int, Field(ge=1, description="Steam appid.")],
    aspect: Annotated[
        Literal[
            "Combat & Bosses", "World & Exploration", "Art & Visuals", "Music & Audio",
            "Story & Writing", "Difficulty", "Controls & Performance",
            "Map & Navigation / Backtracking", "Content & Length", "Price & Value",
        ],
        Field(description="One of game_teardown's 10 aspect labels."),
    ],
    sentiment: Annotated[Literal["praise", "complaint"], Field(description="Which side of the aspect to quote.")],
    limit: Annotated[int, _limit(10, "excerpts")] = 4,
) -> dict:
    """The verbatim review excerpts behind ONE game_teardown aspect's praise or complaint share — the evidence layer under the numbers. Run game_teardown first to see which aspects stand out, then quote the reviewers here.

    Excerpts are keyword-window snippets from the same sampled English reviews and floor as game_teardown, highest-voted first. An eligible game with nothing said about the aspect returns an empty list — absence of evidence, not a negative finding.
    """
    if not _has_aspect_reviews():
        return {
            "error": "mart_game_aspect_reviews is not present in this analytics DB — it was "
            "built by an older ETL. Re-run the ETL (`task etl`) and retry."
        }
    if aspect not in _VALID_ASPECTS:
        return {"error": f"aspect must be one of {sorted(_VALID_ASPECTS)}"}
    limit = max(1, min(limit, 10))
    rows = query(
        """
        SELECT excerpt, matched_keywords, votes_up, playtime_minutes, date, language
        FROM mart_game_aspect_reviews
        WHERE appid = ? AND aspect = ? AND sentiment = ?
        ORDER BY votes_up DESC NULLS LAST
        LIMIT ?
        """,
        [appid, aspect, sentiment, limit],
    )
    return {
        "appid": appid,
        "aspect": aspect,
        "sentiment": sentiment,
        "n_returned": len(rows),
        "items": rows,
    }


# In-process cache of the distinct (tag, n_games) list behind tag_suggest. Same tradeoff
# the REST twin measured (api/app/routers/games.py::_tag_frequencies, duplicated here per
# this file's no-api-imports rule): re-running the UNNEST(top_tags) aggregate over
# mart_game costs ~90ms per call, while the FULL distinct list is only ~460 rows — build
# it once per mart generation (~25ms), then every suggest call is a sub-millisecond
# in-memory substring filter. Keyed on _generation, so a hot-reloaded mart rebuilds it.
@lru_cache(maxsize=4)
def _tag_freqs(gen: int) -> tuple[tuple[str, int], ...]:
    rows = query(
        "SELECT tag, COUNT(*) AS n_games "
        "FROM (SELECT UNNEST(top_tags) AS tag FROM mart_game) "
        "WHERE tag IS NOT NULL "
        "GROUP BY tag ORDER BY n_games DESC, tag"
    )
    return tuple((r["tag"], int(r["n_games"])) for r in rows)


def _tag_frequencies() -> tuple[tuple[str, int], ...]:
    return _tag_freqs(_generation)


@_tool
def tag_suggest(
    q: Annotated[str, Field(description="Partial tag, case-insensitive (e.g. 'rogue'). Empty = the most common tags.")] = "",
    limit: Annotated[int, _limit(50, "tags")] = 10,
) -> dict:
    """Resolve a partial tag to the EXACT tag strings the catalog uses, with how many games carry each. Call this before passing a tag to game_search, tag_combos or the niche tools rather than guessing the spelling (spelling twins such as 'Rogue-like'/'Roguelike' are merged into one canonical tag on marts that carry mart_tag_alias)."""
    needle = (q or "").strip().lower()
    limit = max(1, min(limit, 50))
    freqs = _tag_frequencies()
    matched = [(t, n) for t, n in freqs if needle in t.lower()] if needle else list(freqs)
    rows = [{"tag": t, "n_games": n} for t, n in matched[:limit]]
    return {"q": q, "n_returned": len(rows), "tags": rows}


# ==========================================================================================
# Developer / publisher entity tools
# ==========================================================================================
_ENTITY_MARTS_MISSING = {
    "error": "mart_entity / mart_entity_games are not present in this analytics DB — they "
    "are built by a newer ETL than the one that produced this current.duckdb. Rebuild the "
    "marts (`task etl` in the main prospect checkout) and retry."
}

# entity_profile games-list / trajectory compaction: entities up to this many games get the
# full per-game list and per-seq trajectory; bigger ones (top publishers run to ~550 games)
# get head+tail games and a bucketed trajectory so the response stays token-lean.
_ENTITY_FULL_LIST_MAX = 40
_ENTITY_HEAD_TAIL = 20        # games kept from each end when truncating
_ENTITY_TRAJ_BUCKETS = 20     # per-seq trajectory buckets when n_games > _ENTITY_FULL_LIST_MAX


def _median_of(vals: list) -> float | None:
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    return float(statistics.median(vals))


def _entity_trajectory(games: list[dict]) -> dict:
    """Release-trajectory summary from the seq-ordered games list: debut vs latest, early-
    vs-recent median revenue, and a per-seq revenue series (bucketed for large entities) so
    an agent can see the debut -> latest arc without re-fetching anything."""
    n = len(games)

    def _pt(g: dict) -> dict:
        return {"seq": g["seq"], "name": g["name"], "release_year": g["release_year"],
                "est_rev_reviews": g["est_rev_reviews"]}

    out: dict = {
        "debut": _pt(games[0]),
        "latest": _pt(games[-1]),
        "first5_median_rev": _median_of([g["est_rev_reviews"] for g in games[:5]]),
        "last5_median_rev": _median_of([g["est_rev_reviews"] for g in games[-5:]]),
    }
    if n <= _ENTITY_FULL_LIST_MAX:
        out["per_seq"] = [
            {"seq": g["seq"], "release_year": g["release_year"], "est_rev_reviews": g["est_rev_reviews"]}
            for g in games
        ]
    else:
        buckets = []
        per = max(1, -(-n // _ENTITY_TRAJ_BUCKETS))  # ceil division
        for i in range(0, n, per):
            chunk = games[i:i + per]
            years = [g["release_year"] for g in chunk if g["release_year"] is not None]
            buckets.append({
                "seq_from": chunk[0]["seq"], "seq_to": chunk[-1]["seq"], "n": len(chunk),
                "year_from": min(years) if years else None,
                "year_to": max(years) if years else None,
                "median_rev": _median_of([g["est_rev_reviews"] for g in chunk]),
            })
        out["per_seq_bucketed"] = buckets
    return out


@_tool
def entity_profile(
    name: Annotated[str, Field(description="Exact developer/publisher name (trimmed, case-sensitive); a miss returns close-match suggestions.")],
    role: Annotated[Literal["developer", "publisher"], Field(description="Which side of the credit to profile.")] = "developer",
) -> dict:
    """Profile one developer or publisher ENTITY: track record (n_games, first/last release year, n_recent_24m — the active/dormant signal — total/median est. revenue, hit_rate_200k, median reviews/rating, self_published_share, top genres, and for publishers n_partners = distinct developers published), its games (oldest first by seq) and a release trajectory (debut -> latest, first-5 vs last-5 median revenue). Entities with > 40 games return the earliest + latest 20 and a BUCKETED trajectory (games_omitted says how many); the aggregates always cover ALL games.

    Caveats: entities come from self-reported developer/publisher strings with NO fuzzy identity resolution — "Ubisoft" and "UBISOFT" are separate entities, so a studio's numbers may be split across variants (check the suggestions; sum variants yourself when it matters). Revenue is a Boxleiter-style ESTIMATE. x_handle = the majority official X link across its games (may be a personal account). A miss says when the exact name exists under the OTHER role.
    """
    socials_cols = ",\n                   x_handle" if _has_dev_socials() else ""
    try:
        ent = query_one(
            f"""
            SELECT role, name, n_games, first_release_year, last_release_year, n_recent_24m,
                   total_rev, median_rev, hit_rate_200k, median_reviews, median_positive_ratio,
                   self_published_share, top_genres, n_partners{socials_cols}
            FROM mart_entity WHERE role = ? AND name = ?
            """,
            [role, name],
        )
    except duckdb.CatalogException:
        return dict(_ENTITY_MARTS_MISSING)

    if ent is None:
        other_role = "publisher" if role == "developer" else "developer"
        hints = []
        if query_one("SELECT 1 AS one FROM mart_entity WHERE role = ? AND name = ?", [other_role, name]):
            hints.append(f"{name!r} exists as a {other_role} — call entity_profile(name, role={other_role!r}).")
        suggestions = query(
            "SELECT name, n_games FROM mart_entity WHERE role = ? AND name ILIKE ? "
            "ORDER BY n_games DESC, name LIMIT 5",
            [role, f"%{name}%"],
        )
        return {
            "error": f"no {role} named {name!r} (exact match, case-sensitive). "
            + (hints[0] + " " if hints else "")
            + ("Close matches in `suggestions` — retry with one of those exact names."
               if suggestions else "No close matches either — try a shorter substring."),
            "suggestions": suggestions,
        }

    games = query(
        """
        SELECT meg.seq, g.appid, g.name, g.release_year, g.price_initial AS price,
               g.total_reviews, g.positive_ratio, g.est_rev_reviews, g.primary_genre
        FROM mart_entity_games meg
        JOIN mart_game g ON g.appid = meg.appid
        WHERE meg.role = ? AND meg.name = ?
        ORDER BY meg.seq
        """,
        [role, name],
    )

    trajectory = _entity_trajectory(games) if games else {}
    games_omitted = 0
    if len(games) > _ENTITY_FULL_LIST_MAX:
        games_omitted = len(games) - 2 * _ENTITY_HEAD_TAIL
        games = games[:_ENTITY_HEAD_TAIL] + games[-_ENTITY_HEAD_TAIL:]

    return {
        "entity": ent,
        "games": games,
        "games_omitted": games_omitted,
        "trajectory": trajectory,
        "caveats": [
            "Revenue is est_rev_reviews — a Boxleiter-style gross lifetime ESTIMATE.",
            "Entity names are self-reported strings; variant spellings of the same "
            "studio are separate entities (no fuzzy identity resolution).",
            "Population is the full live catalog including 0-review games — medians "
            "and hit_rate_200k are computed over games with revenue estimates only.",
        ],
    }


@_tool
def publisher_pitch_list(
    genre: Annotated[str, Field(description="Exact Steam PRIMARY-genre label (e.g. 'RPG', 'Strategy') — not a community tag.")],
    min_games: Annotated[int, Field(ge=1, description="Minimum total releases for a publisher to be listed.")] = 3,
    limit: Annotated[int, _limit(50, "publishers")] = 15,
) -> dict:
    """Which publishers to pitch for one Steam genre: publishers with >= min_games releases and >= 1 in this genre, ACTIVE first (a release in the last 24 months; dormant ones rank below every active one), then by games in the genre. Per row: n_games, n_in_genre, n_recent_24m, active, median_rev_in_genre, example_game (their top earner in the genre — fit-check it), n_partners (distinct developers published — how many outside studios they really work with) and self_published_share.

    Falsification rules first: a publisher's median outcome is SELECTION, not value-add (good publishers pick good games); self_published_share ~1.0 means a self-publishing dev, not a partner — filter those out; names are self-reported (variant spellings split); revenue is a Boxleiter ESTIMATE. An empty list is a real answer — but check the genre is an exact PRIMARY genre ("Roguelike" is a tag). Deep-dive a row with entity_profile(name, role='publisher').
    """
    min_games = max(1, min_games)
    limit = max(1, min(limit, 50))
    try:
        rows = query(
            """
            WITH in_genre AS (
                SELECT meg.name,
                    COUNT(*) AS n_in_genre,
                    median(g.est_rev_reviews) AS median_rev_in_genre,
                    arg_max(g.name, COALESCE(g.est_rev_reviews, -1)) AS example_game
                FROM mart_entity_games meg
                JOIN mart_game g ON g.appid = meg.appid
                WHERE meg.role = 'publisher' AND g.primary_genre = ?
                GROUP BY meg.name
            )
            SELECT e.name, e.n_games, ig.n_in_genre, e.n_recent_24m,
                   (e.n_recent_24m > 0) AS active,
                   ig.median_rev_in_genre, ig.example_game,
                   e.n_partners, e.self_published_share
            FROM mart_entity e
            JOIN in_genre ig ON ig.name = e.name
            WHERE e.role = 'publisher' AND e.n_games >= ?
            ORDER BY active DESC, ig.n_in_genre DESC, e.n_recent_24m DESC, e.n_games DESC, e.name
            LIMIT ?
            """,
            [genre, min_games, limit],
        )
    except duckdb.CatalogException:
        return dict(_ENTITY_MARTS_MISSING)

    caveats = [
        "Revenue is est_rev_reviews — a Boxleiter-style gross lifetime ESTIMATE.",
        "Selection bias: a publisher's median outcome reflects the games they pick, not "
        "the value they add — descriptive, not a promise for YOUR game.",
        "Entity names are self-reported; the same publisher under variant spellings "
        "counts as separate rows.",
        "Self-published rows are kept: self_published_share ~1.0 means a self-publishing "
        "dev, not a publishing partner — filter on it when scouting.",
        "active = any release in the last 24 months; dormant (active=false) rows may no "
        "longer sign games.",
    ]
    if not rows:
        caveats.insert(
            0,
            f"No publisher meets the floors for genre '{genre}'. genre must be an exact "
            "Steam PRIMARY-genre label (not a community tag) — check spelling/case via "
            "game_profile or market_benchmarks' boxleiter_by_genre.",
        )
    return {
        "genre": genre,
        "min_games": min_games,
        "n_returned": len(rows),
        "publishers": rows,
        "caveats": caveats,
    }


# ==========================================================================================
# Press / buzz tools
# ==========================================================================================
@_tool
def press_pitch_list(
    genre: Annotated[str, Field(description="Exact Steam genre label (e.g. 'RPG', 'Action') — not a community tag.")],
    limit: Annotated[int, _limit(50, "outlets and journalists (each)")] = 15,
) -> dict:
    """Who to pitch for press coverage in one Steam genre: outlets (article count, games covered, the median outcome of games they covered, one example headline + date + url) and journalists (article count, distinct games, outlets written for, an example), each ranked by ALL-TIME volume and capped at `limit`.

    Bearish reading first: all-time volume flatters past contributors — check n_articles_recent_24m and the example date before pitching; these outlets already chose this genre (selection bias, not a coverage promise); coverage is fuzzy-matched to games, and a lower-volume specialist can be a sharper target than the top row. Steam News (dev-authored posts) is excluded. Zero rows is an honest answer — double-check the exact genre spelling first.
    """
    limit = max(1, min(limit, 50))
    outlets = query(
        "SELECT source, n_articles, n_articles_recent_24m, n_games_covered, median_est_rev, "
        "median_owners, median_positive_ratio, example_author, example_title, example_url, "
        "example_published_at FROM mart_press_outlet_genre WHERE genre = ? "
        "ORDER BY n_articles DESC LIMIT ?",
        [genre, limit],
    )
    authors = query(
        "SELECT author, n_articles, n_articles_recent_24m, n_distinct_games, outlets, "
        "example_source, example_title, example_url, example_published_at "
        "FROM mart_press_author WHERE genre = ? ORDER BY n_articles DESC LIMIT ?",
        [genre, limit],
    )
    caveats = [
        "Selection bias: these outlets/journalists already chose to cover this genre — "
        "descriptive of the current press landscape, not a guarantee of future coverage.",
        "Ranked by ALL-TIME article volume (archives run back to 1997-2005 depending on "
        "source) — check n_articles_recent_24m and the example date; a past contributor may "
        "no longer cover the beat.",
        "Coverage is fuzzy-matched to games (match_confidence-filtered) — a lower-volume "
        "specialist can still be a sharper pitch target than the top row.",
        "Steam News excluded — journalist/trade-press coverage only.",
        "Genre is Steam's own exact genre field (not a community tag); a game usually has "
        "several genres, so the same article can count toward multiple genre pitch lists.",
    ]
    if not outlets and not authors:
        caveats.insert(
            0,
            f"No confidence-filtered journalist coverage found for genre '{genre}'. genre "
            "must be an exact Steam genre label (not a community tag like \"Roguelike\").",
        )
    return {
        "genre": genre,
        "outlets": outlets,
        "journalists": authors,
        "caveats": caveats,
    }


@_tool
def buzz_trends(
    direction: Annotated[Literal["rising", "cooling"], Field(description="rising = steepest recent-vs-prior increase first; cooling = steepest decrease first.")] = "rising",
    limit: Annotated[int, _limit(50, "terms")] = 15,
    include_series: Annotated[bool, Field(description="Add each term's 12-point monthly mention series.")] = False,
) -> dict:
    """Rising or cooling game-concept buzz: bigrams (mechanics/genres/tags, e.g. "roguelike deckbuilder") mined from journalist article TITLES over the last 12 complete months, restricted to Steam's own tag/genre vocabulary so it reads as game concepts, not news noise. A LEADING indicator (press attention before releases/sales) — distinct from niche_detail's lagging saturation_trend.

    Bearish reading first: title bigrams are a coarse, cheap signal from an English-outlet sample; the last 3 complete months are compared with the 3 before, so a single news cycle can move a small term — weigh total_mentions. Returns total_mentions, recent_avg, prior_avg and slope per term.
    """
    order = "DESC" if direction == "rising" else "ASC"
    limit = max(1, min(limit, 50))
    items = query(
        f"SELECT term, total_mentions, recent_avg, prior_avg, slope FROM mart_buzz_trends_summary "
        f"WHERE direction = ? ORDER BY slope {order} LIMIT ?",
        [direction, limit],
    )

    if include_series and items:
        terms = [item["term"] for item in items]
        placeholders = ",".join("?" for _ in terms)
        series_rows = query(
            f"SELECT term, period, n_mentions FROM mart_buzz_trends WHERE term IN ({placeholders}) "
            f"ORDER BY term, period",
            terms,
        )
        by_term: dict[str, list[dict]] = {t: [] for t in terms}
        for sr in series_rows:
            by_term[sr["term"]].append({"period": sr["period"], "n_mentions": sr["n_mentions"]})
        for item in items:
            item["series"] = by_term.get(item["term"], [])

    return {
        "direction": direction,
        "n_returned": len(items),
        "terms": items,
        "caveats": [
            "Compares the last 3 complete months to the 3 months before that; the current "
            "in-progress month is excluded.",
            "Mined from journalist article TITLES only, as English stopword-filtered bigrams — "
            "a coarse, cheap leading indicator, not full topic modeling or sentiment analysis.",
            "Restricted to Steam's tag/genre vocabulary (word-level match) so this reads as "
            "game concepts, not franchise names or sale events; an occasional edge case can "
            "still slip through.",
        ],
    }


# ==========================================================================================
# Marketing tools (Track M — Press; creator platforms removed 2026-08-25)
# ==========================================================================================
_PRESS_ONLY_NOTE = (
    "Press is the ONLY channel since the creator platforms were decommissioned (2026-08-25): "
    "shares are 1.0 by construction and weights are 1 per mention — this is a press-volume "
    "read, not a multi-channel comparison."
)


@_tool
def channel_mix(
    genre: Annotated[str | None, Field(description="Exact Steam genre label; omit for every genre.")] = None,
) -> dict:
    """PRESS attention volume per genre — honestly a single-channel read: the creator platforms (YouTube/Reddit/Twitch/X) were decommissioned 2026-08-25, so every genre's "mix" is 100% press (share_mentions = share_reach_weighted = 1.0 by construction) and the only informative number is n_mentions — how much press coverage the genre gets. reach_weighted = n_mentions (outlets carry no audience figure). The share columns are kept only so the shape is stable if a channel returns. An empty result = unknown genre label or no press data yet.
    """
    where = ""
    params: list = []
    if genre:
        where = "WHERE genre = ?"
        params.append(genre)
    try:
        rows = query(
            f"SELECT genre, channel, n_mentions, reach_weighted, share_mentions, share_reach_weighted "
            f"FROM mart_channel_mix {where} ORDER BY genre, share_reach_weighted DESC",
            params,
        )
    except duckdb.CatalogException:
        return {
            "error": "mart_channel_mix is not present in this analytics DB — it is built "
            "by a newer ETL than the one that produced this current.duckdb. Re-run the "
            "ETL (`task etl` in the main prospect checkout) and retry."
        }
    if not rows:
        return {
            "genre": genre,
            "items": [],
            "note": "No channel-mix data yet for this genre — either the genre label is "
            "wrong/unrecognized, or no press data has been collected yet.",
        }
    channels = {r["channel"] for r in rows}
    out: dict[str, Any] = {"genre": genre, "n_returned": len(rows), "items": rows}
    if channels == {"press"}:
        out["note"] = _PRESS_ONLY_NOTE
    return out


@_tool
def channel_buzz(
    direction: Annotated[Literal["rising", "cooling"], Field(description="rising = steepest weighted increase first; cooling = steepest decrease.")] = "rising",
    limit: Annotated[int, _limit(50, "terms")] = 15,
    include_series: Annotated[bool, Field(description="Add each term's per-period (n_mentions, reach_weighted_score).")] = False,
) -> dict:
    """Reach-weighted trending game concepts by marketing channel — today a DUPLICATE of buzz_trends: press is the only channel left (creator platforms decommissioned 2026-08-25) and press weighs 1 per mention, so total_weighted == total_mentions and by_channel is always press alone. Prefer buzz_trends; this stays for shape stability if a weighted channel returns. Same bigram/concept mining as buzz_trends (article titles, Steam tag/genre vocabulary, last 3 complete months vs the 3 before).
    """
    order = "DESC" if direction == "rising" else "ASC"
    limit = max(1, min(limit, 50))
    try:
        items = query(
            f"SELECT term, total_mentions, total_weighted, recent_avg_weighted, prior_avg_weighted, "
            f"slope_weighted FROM mart_channel_buzz_summary WHERE direction = ? "
            f"ORDER BY slope_weighted {order} LIMIT ?",
            [direction, limit],
        )

        channels: set[str] = set()
        if items:
            terms = [item["term"] for item in items]
            placeholders = ",".join("?" for _ in terms)
            breakdown: dict[str, dict[str, dict]] = {t: {} for t in terms}
            series: dict[str, dict[str, dict]] = {t: {} for t in terms}
            if include_series:
                # Per-period detail: one scan feeds BOTH the per-channel totals and each
                # term's period series. Values arrive as floats (DECIMAL is coerced in
                # query()), so the roll-up is plain float arithmetic.
                detail_rows = query(
                    f"SELECT term, channel, period, n_mentions, reach_weighted_score FROM mart_channel_buzz "
                    f"WHERE term IN ({placeholders}) ORDER BY term, period",
                    terms,
                )
                for r in detail_rows:
                    t, ch, per = r["term"], r["channel"], r["period"]
                    weight = float(r["reach_weighted_score"] or 0.0)
                    cb = breakdown[t].setdefault(ch, {"n_mentions": 0, "reach_weighted_score": 0.0})
                    cb["n_mentions"] += int(r["n_mentions"] or 0)
                    cb["reach_weighted_score"] += weight
                    sp = series[t].setdefault(per, {"n_mentions": 0, "reach_weighted_score": 0.0})
                    sp["n_mentions"] += int(r["n_mentions"] or 0)
                    sp["reach_weighted_score"] += weight
            else:
                # Summary-only: by_channel needs per-(term, channel) TOTALS, not the
                # per-period rows — aggregate in the DB and skip shipping/looping the full
                # period detail the caller didn't ask for.
                for r in query(
                    f"SELECT term, channel, SUM(n_mentions) AS n_mentions, "
                    f"SUM(reach_weighted_score) AS reach_weighted_score "
                    f"FROM mart_channel_buzz WHERE term IN ({placeholders}) "
                    f"GROUP BY term, channel",
                    terms,
                ):
                    breakdown[r["term"]][r["channel"]] = {
                        "n_mentions": int(r["n_mentions"] or 0),
                        "reach_weighted_score": float(r["reach_weighted_score"] or 0.0),
                    }
            for item in items:
                channels.update(breakdown[item["term"]])
                item["by_channel"] = [
                    {"channel": ch, **v}
                    for ch, v in sorted(breakdown[item["term"]].items(), key=lambda kv: -kv[1]["reach_weighted_score"])
                ]
                if include_series:
                    item["series"] = [{"period": per, **v} for per, v in sorted(series[item["term"]].items())]
    except duckdb.CatalogException:
        return {
            "error": "mart_channel_buzz/mart_channel_buzz_summary are not present in this "
            "analytics DB — they are built by a newer ETL than the one that produced this "
            "current.duckdb. Re-run the ETL (`task etl` in the main prospect checkout) "
            "and retry."
        }

    caveats = [
        "Compares the last 3 complete months to the 3 before that; the current in-progress "
        "month is excluded.",
        "Restricted to Steam's tag/genre vocabulary (word-level match), same as buzz_trends.",
    ]
    if channels <= {"press"}:
        caveats.insert(0, _PRESS_ONLY_NOTE + " Use buzz_trends — it carries the same terms.")
    return {
        "direction": direction,
        "n_returned": len(items),
        "terms": items,
        "caveats": caveats,
    }


# ==========================================================================================
# Live-player (CCU) history tools — daily point-sample series from mart_players.sql
# ==========================================================================================
PlayerDays = Annotated[
    int,
    Field(ge=7, le=3650, description="Window length in days, counted back from the mart's last capture date; bounds BOTH the daily series and the monthly (steamcharts) block. Up to 3650 for deep monthly history."),
]


@_tool
def game_player_history(
    appid: Annotated[int, Field(ge=1, description="Steam appid (find it with game_search).")],
    days: PlayerDays = 30,
) -> dict:
    """Daily concurrent-player (CCU) history for one game — direct "are people actually playing this" traction (owners/revenue are lifetime estimates; this is measured).

    Caveats first: one value per day = the LAST capture of the UTC date from the nightly ~21-22:00 UTC sweep — a point sample, NOT the daily peak (SteamDB peaks run higher); a gap = unmeasured, never zero (collection began 2026-07-18; games outside the top-8k-by-reviews head rotate every ~3-8 nights).

    The window ends at the mart's LAST capture date (summary.as_of), not today, so an older mart still shows its own last `days`. summary always covers the FULL measured history: latest sample, trailing-7d average vs prior 7d, the window's peak, measured-day count and first/last dates. monthly = steamcharts monthly averages/peaks inside the same window — a DIFFERENT measure; never blend it with the daily series. No history at all is a real answer (below the 50-review CCU floor, or not yet rotated in).
    """
    if not _has_players():
        return {"error": _PLAYERS_MISSING}
    days = max(7, min(days, 3650))
    gcols = _cols("mart_game")
    trend_cols = "".join(
        f", {c}" for c in ("players_trend_7d_market_pct", "players_trend_7d_rel_pct") if c in gcols
    )
    game = query_one(
        f"SELECT appid, name, live_players, players_7d_avg, players_trend_7d_pct{trend_cols} "
        "FROM mart_game WHERE appid = ?",
        [appid],
    )
    if game is None:
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, "
            "or below the >=10-review analysis floor. Use game_search to find valid appids."
        }

    anchor = _max_date(_generation, "mart_game_players_daily")
    notes: list[str] = []
    series: list[dict] = []
    stats: dict | None = None
    if anchor is not None:
        start = anchor - timedelta(days=days - 1)  # `days` dates, ending at the anchor
        series = query(
            "SELECT date, players, n_captures FROM mart_game_players_daily "
            "WHERE appid = ? AND date >= CAST(? AS DATE) ORDER BY date",
            [appid, start.isoformat()],
        )
        a, s = anchor.isoformat(), start.isoformat()
        stats = query_one(
            """
            SELECT COUNT(*) AS n_days_measured,
                   MIN(date) AS first_date, MAX(date) AS last_date,
                   max_by(players, date) AS latest_players,
                   MAX(players) FILTER (WHERE date >= CAST(? AS DATE)) AS window_peak,
                   max_by(date, players) FILTER (WHERE date >= CAST(? AS DATE)) AS peak_date,
                   AVG(players) FILTER (WHERE date > CAST(? AS DATE) - 7) AS avg_recent_7d,
                   AVG(players) FILTER (WHERE date <= CAST(? AS DATE) - 7
                                          AND date > CAST(? AS DATE) - 14) AS avg_prior_7d
            FROM mart_game_players_daily WHERE appid = ?
            """,
            [s, s, a, a, a, appid],
        )
    if not stats or not stats["n_days_measured"]:
        notes.append(
            "never captured — the game is below the 50-review CCU collection floor, or the "
            "capture rotation hasn't reached it yet."
        )
        summary: dict[str, Any] = {"as_of": anchor.isoformat() if anchor else None, "n_days_measured": 0}
    else:
        summary = {
            "as_of": anchor.isoformat(),
            "latest": {"date": stats["last_date"], "players": stats["latest_players"]},
            # Prefer the mart's precomputed values (tool and mart must never disagree);
            # the live-computed fallback only covers a NULL mart value.
            "players_7d_avg": game["players_7d_avg"] if game["players_7d_avg"] is not None else stats["avg_recent_7d"],
            "players_prior_7d_avg": stats["avg_prior_7d"],
            "players_trend_7d_pct": game["players_trend_7d_pct"],
            **{c: game[c] for c in ("players_trend_7d_market_pct", "players_trend_7d_rel_pct") if c in game},
            "window_peak": {"date": stats["peak_date"], "players": stats["window_peak"]},
            "n_days_measured": stats["n_days_measured"],
            "history": {"first_date": stats["first_date"], "last_date": stats["last_date"]},
        }
        if not series:
            notes.append(
                f"measured history exists but none in the {days} days up to the mart's last "
                f"capture ({anchor.isoformat()}); last measured {stats['last_date']} — "
                "rotated out of collection, or delisted."
            )

    monthly: list[dict] = []
    if _has_players_history() and anchor is not None:
        month_start = (anchor - timedelta(days=days - 1)).replace(day=1)
        monthly = query(
            "SELECT CAST(date AS VARCHAR) AS month, avg_players, peak_players "
            "FROM mart_game_players_history WHERE appid = ? AND grain = 'monthly' "
            "AND date >= CAST(? AS DATE) ORDER BY date",
            [appid, month_start.isoformat()],
        )
        if monthly:
            notes.append(
                "monthly = EXTERNAL history via steamcharts.com (period averages + true monthly "
                "peaks) within the same window — a different measure from the nightly point "
                "samples in `series`; never blend them."
            )

    return {
        "appid": appid,
        "name": game["name"],
        "days": days,
        "summary": summary,
        "series": series,
        "monthly": monthly,
        "caveats": [_PLAYERS_POINT_SAMPLE_CAVEAT, _PLAYERS_HISTORY_CAVEAT] + notes,
    }


@_tool
def niche_player_history(dimension: Dimension, key: NicheKey, days: PlayerDays = 30) -> dict:
    """Daily total-live-players series for one niche — "is this niche hot, and which way is it moving".

    Caveats first: totals are dominated by the niche's biggest games (the top ~12k games hold ~99% of Steam CCU) — a big total says people play the niche's HITS, not that a new entrant gets players; check players_top5_share and median_players_now. Values are nightly point samples (not peaks); each game's last capture is carried forward up to 7 days (LOCF) so rotation gaps don't read as dips — measured_players / n_games_measured show the raw same-day coverage.

    summary = the niche's mart_niche players columns: total_players_now, players_trend_7d_pct (SAME-PANEL: only games measured in both 7-day windows), players_coverage (fresh-measured share), median_players_now, players_top5_share (+ market-relative trends on newer marts), n_games_panel and history bounds. The window ends at the mart's last capture date (summary.as_of). monthly = summed steamcharts monthly averages (top-8k games only) inside the same window — a different measure; never blend. An empty series for a real niche = fewer than 10 of its games ever measured.
    """
    if not _has_players():
        return {"error": _PLAYERS_MISSING}
    days = max(7, min(days, 3650))
    resolved, note = _resolve_niche_key(dimension, key)
    if resolved is None:
        return {"error": note}
    ncols = _cols("mart_niche")
    summary_cols = [
        c for c in (
            "total_players_now", "players_trend_7d_pct", "players_trend_7d_market_pct",
            "players_trend_7d_rel_pct", "players_coverage", "median_players_now",
            "players_top5_share",
        )
        if c in ncols
    ]
    niche = query_one(
        f"SELECT {', '.join(summary_cols)} FROM mart_niche WHERE dimension = ? AND key = ? LIMIT 1",
        [dimension, resolved],
    ) or {}

    anchor = _max_date(_generation, "mart_niche_players")
    series: list[dict] = []
    if anchor is not None:
        start = anchor - timedelta(days=days - 1)
        series = query(
            "SELECT date, total_players, measured_players, n_games_measured "
            "FROM mart_niche_players WHERE dimension = ? AND key = ? "
            "AND date >= CAST(? AS DATE) ORDER BY date",
            [dimension, resolved, start.isoformat()],
        )
    panel = query_one(
        "SELECT MAX(n_games_panel) AS n_games_panel, MIN(date) AS first_date, "
        "MAX(date) AS last_date, COUNT(*) AS n_days FROM mart_niche_players "
        "WHERE dimension = ? AND key = ?",
        [dimension, resolved],
    )

    notes: list[str] = []
    if not panel or not panel["n_days"]:
        notes.append(
            "no players series for this niche — fewer than 10 of its games have ever been "
            "measured (below the CCU floor / not yet rotated in), or the niche is under the "
            "30-scored-games floor."
        )
        history = None
    else:
        history = {
            "first_date": panel["first_date"],
            "last_date": panel["last_date"],
            "n_days": panel["n_days"],
        }

    monthly: list[dict] = []
    if _has_players_history() and _has_table("mart_niche_players_monthly") and anchor is not None:
        month_start = (anchor - timedelta(days=days - 1)).replace(day=1)
        monthly = query(
            "SELECT CAST(month AS VARCHAR) AS month, avg_players_sum, n_games_measured "
            "FROM mart_niche_players_monthly WHERE dimension = ? AND key = ? "
            "AND month >= CAST(? AS DATE) ORDER BY month",
            [dimension, resolved, month_start.isoformat()],
        )
        if monthly:
            notes.append(
                "monthly = the niche's summed steamcharts monthly AVERAGES (top-8k games only — "
                "the measured HEAD, not the tail; rising early-years values are partly new games "
                "entering measurement). Different measure from the daily series; never blend."
            )

    top_games: list[dict] = []
    if _has_players_dist() and _has_table("mart_niche_players_top"):
        top_games = query(
            "SELECT rank, appid, name, players, share FROM mart_niche_players_top "
            "WHERE dimension = ? AND key = ? ORDER BY rank LIMIT 5",
            [dimension, resolved],
        )

    out: dict[str, Any] = {"dimension": dimension, "key": resolved}
    if note:
        out["key_note"] = note
    out.update(
        {
            "days": days,
            "summary": {
                "as_of": anchor.isoformat() if anchor else None,
                "total_players_now": niche.get("total_players_now"),
                "players_trend_7d_pct": niche.get("players_trend_7d_pct"),
                **{c: niche.get(c) for c in ("players_trend_7d_market_pct", "players_trend_7d_rel_pct") if c in niche},
                "players_coverage": niche.get("players_coverage"),
                "median_players_now": niche.get("median_players_now"),
                "players_top5_share": niche.get("players_top5_share"),
                "n_games_panel": panel["n_games_panel"] if panel else None,
                "history": history,
            },
            "top_games_now": top_games,
            "series": series,
            "monthly": monthly,
            "caveats": [
                _PLAYERS_POINT_SAMPLE_CAVEAT,
                _PLAYERS_HISTORY_CAVEAT,
                "total_players carries each game's last capture forward up to 7 days (LOCF); "
                "players_trend_7d_pct is same-panel (games measured in BOTH windows), so "
                "coverage growth can't masquerade as audience growth.",
            ] + notes,
        }
    )
    return out


# ==========================================================================================
# Methodology — the long-form docs, by topic
# ==========================================================================================
@_tool
def methodology(
    topic: Annotated[
        Literal["rules", "scores", "fields", "falsification", "players", "lifetime", "demand",
                "cuts", "revenue", "marts", "caveats", "all"],
        Field(description="rules = the analysis rules + every flag code; scores = opportunity_v2/v1 formulas and the Radar rings; fields = niche columns (entrant_ratio, solo_viability, tier, size); falsification = how each metric lies; players / lifetime / demand = those column families; cuts = window x min_reviews; revenue = how estimates are made; marts = what each mart covers; caveats = data biases; all = everything."),
    ] = "rules",
) -> dict:
    """The long-form methodology behind every tool — formulas, thresholds, flag definitions, falsification rules and caveats — served by topic (it used to live in the tool descriptions, which clients truncate at ~2K chars). Start with topic='rules' (the owner's analysis rules and every flag code find_niches/niche_detail emit), then 'scores' before explaining an opportunity_v2 value. The same text is the prospect-data-dictionary resource.
    """
    text = _data_dictionary_text() if topic == "all" else _DOCS.get(topic)
    if text is None:
        return {"error": f"topic must be one of {[*_DOC_TOPICS, 'all']}"}
    return {"topic": topic, "text": text}


if __name__ == "__main__":
    mcp.run()
