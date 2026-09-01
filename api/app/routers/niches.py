"""Niche Finder endpoints over mart_niche and its satellite marts.

Resurrected 2026-08 (the original was removed in the "trim to four surfaces" cut,
e777cb2) and upgraded for everything the marts have grown since:

- v2 scoring: opportunity_v2, its sub-scores (momentum / supply_room / revenue_spread /
  market_pull / supply_brake), decline_gate, entrant_ratio, solo_viability, solo_tier,
  tier — with the same interpretation rules the MCP find_niches tool documents (low
  competition + shrinking pipeline = decline, not opportunity). REBUILT 2026-08-31: the
  score is now built from the SAME axes and the SAME thresholds as the Radar board's ring
  verdicts (it used to rank the opposite way — median score by ring ran enter 17.6 <
  crowded 20.9 < declining 23.4), so a high opportunity_v2 means "the radar would tell you
  to enter". decline_gate survives as a falsification TELL; it no longer multiplies
  anything. See etl/marts/mart_niche.sql's "opportunity_v2 REBUILT" header.
- Absolute size: total_owners / total_rev / total_reviews / market_size.
- Live players: total_players_now / players_trend_7d_pct / players_coverage on every
  row, plus the per-niche daily series (mart_niche_players) in the detail response.
- 24-month demand: reviews_24m / reviews_prev_24m / demand_trend_24m_pct on every LIST
  row (capability-gated like p90_rev; cut-independent in the mart — one value per
  (dimension, key), stamped on every window/floor cut), so the Radar board can ring every
  blip on its own trend client-side.
- Review themes: mart_niche_themes' pooled praise/complaint aspects in the detail.

Defaults mirror the MCP tool: window=24m (the market a new entrant faces),
min_reviews=50, sort=opportunity_v2, tiers micro+theme (umbrella/meta containers are
excluded unless asked for — "build an Open World game" is not a plan).

The players columns are capability-gated (information_schema, cached) like
games.py::_has_name_lower so the app still boots against a mart that predates the CCU
marts; v2 columns are treated as required (503 with a rebuild hint if absent, same
convention as the timing router's "marts not built yet").
"""
from __future__ import annotations

import csv
import io
from functools import lru_cache

import duckdb
from fastapi import APIRouter, HTTPException, Query, Response

from .. import analytics_db
from ..schemas import (
    HistBucket,
    NicheCombined,
    NicheCombinedInput,
    NicheDetail,
    NicheDistribution,
    NicheGame,
    NicheGameList,
    NicheGameRow,
    NicheList,
    NichePlayers,
    NichePlayersDistribution,
    NichePlayersMonthlyPoint,
    NichePlayersPoint,
    NichePlayersTopGame,
    NichePress,
    NichePressOutlet,
    NichePressPoint,
    NicheRow,
    NicheTheme,
    TrendPoint,
)

router = APIRouter(prefix="/api/niches", tags=["niches"])

_TIERS = {"micro", "theme", "umbrella", "meta"}

# The Radar page's solo-friendliness bar: mart_niche.solo_viability (share of the cut's
# scored games playable single-player; catalog norm ~0.9, below ~0.8 leans multiplayer) at
# or above which a niche counts as solo-buildable. Applied server-side via the `solo_only`
# param on GET /api/niches — opt-in, default OFF: the list is a shared surface (NicheFinder,
# the CSV export) and non-radar consumers must see the unfiltered population. The Radar
# board is the consumer that passes solo_only=1 (it is solo-first by user directive,
# 2026-08-26; its own toggle turns the filter off).
#
# MUST stay in lockstep with SOLO_FRIENDLY_MIN in web/src/lib/radarVerdict.ts — the web
# renders the same 0.8 bar in the board legend, the solo lens and the verdict dossier, so
# a drift here would make the legend lie about what the server filtered.
#
# NULL policy: NULL solo_viability is "unknown", and unknown is NOT solo-friendly — the
# radar population is an explicit positive claim ("you could build this solo"), so
# unmeasured niches are excluded rather than given the benefit of the doubt. The plain
# `solo_viability >= ?` predicate already does this (a NULL comparison is never TRUE in
# SQL) — deliberate, not an accident.
RADAR_SOLO_FRIENDLY_MIN = 0.8

_SOLO_ONLY_DESC = (
    "Solo population rule: keep only solo-friendly niches "
    f"(solo_viability >= {RADAR_SOLO_FRIENDLY_MIN}; NULL = unknown = excluded)."
)


def _apply_solo_only(where: str, params: list) -> tuple[str, list]:
    """Append the solo-friendliness filter. NULL solo_viability fails the >=
    (SQL three-valued logic) — exactly the intended 'unknown is not solo-friendly'
    reading; see RADAR_SOLO_FRIENDLY_MIN."""
    return where + " AND solo_viability >= ?", params + [RADAR_SOLO_FRIENDLY_MIN]

# Columns a client is allowed to sort on (prevents SQL injection via `sort`).
SORTABLE = {
    "key",
    "opportunity", "opportunity_v2", "decline_gate", "entrant_ratio", "solo_viability",
    # opportunity_v2's sub-scores — sortable so "show me the niches with the most demand
    # momentum" / "the most supply room" is a first-class query, not a client-side filter.
    "momentum", "supply_room", "revenue_spread", "market_pull", "supply_brake",
    "demand", "competition", "quality_gap",
    "market_size", "total_owners", "total_rev", "total_reviews",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity",
    "n_games", "n_recent", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "self_pub_share", "winner_concentration",
    "total_players_now", "players_trend_7d_pct", "players_coverage",
    "median_players_now", "players_top5_share",
    "lifetime_survival_12m", "lifetime_median_dead_months",
    "p90_rev",
    "reviews_24m", "reviews_prev_24m", "demand_trend_24m_pct",
}
_PLAYERS_COLS = ["total_players_now", "players_trend_7d_pct", "players_coverage"]
_LIFETIME_COLS = ["lifetime_n_games", "lifetime_survival_12m", "lifetime_median_dead_months"]
# 24-month demand (cut-independent: identical on every window/floor cut of a niche — see
# etl/marts/mart_niche.sql's _niche_demand24m). On LIST rows so the Radar board can ring
# every blip on its own trend instead of joining the feed's top movers. The emerging pair
# (reviews_24m_new_share / demand_emerging — young tags whose prior window is near zero BY
# CONSTRUCTION, so their raw trend % is not representative) ships in the same ETL build as
# the 24m windows: one column family, one probe (_has_demand24m).
_DEMAND24M_COLS = [
    "reviews_24m", "reviews_prev_24m", "demand_trend_24m_pct",
    "reviews_24m_new_share", "demand_emerging",
]
# Solo-lens EVIDENCE trio (2026-08-27): solo_viability is the niche's SINGLEPLAYER SHARE —
# a no-netcode proxy, not a production-scope measure — so the radar renders the member
# profile behind it instead of asserting a bare 0.98: self_published_share (AVG
# self_published), indie_share (AVG is_indie), med_playtime_h (median of member games'
# playtime_p50, hours, 1 decimal). Same per-cut population as solo_viability by
# construction (etl/marts/mart_niche.sql's agg CTE). One column family, one probe
# (_has_solo_evidence) — the three always ship in the same ETL build.
_SOLO_EVIDENCE_COLS = ["self_published_share", "indie_share", "med_playtime_h"]
# opportunity_v2's SUB-SCORES (2026-08-31 rebuild — see etl/marts/mart_niche.sql's
# "opportunity_v2 REBUILT" header). The score is now a blend of four inspectable 0..100
# terms times a supply brake, and these are those terms, so any consumer can take a score
# apart into the four claims it makes instead of trusting one opaque number. solo_tier
# ships in the same ETL build (the same commit added both), so one probe covers the family.
_V2_PARTS_COLS = [
    "momentum", "supply_room", "revenue_spread", "market_pull", "supply_brake", "solo_tier",
]

# Ordered base column list (single source of truth for SELECT + CSV header); the players
# columns are appended when the mart carries them.
_BASE_COLS = [
    "dimension", "key", "win", "min_reviews", "n_games", "n_recent",
    "median_rev", "p25_rev", "p75_rev", "median_reviews", "median_price",
    "median_positive_ratio", "median_owners",
    "total_owners", "total_rev", "total_reviews", "market_size",
    "recent_velocity",
    "self_pub_share", "winner_concentration", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "n_recent_year", "n_prior_year", "demand", "competition", "quality_gap",
    "opportunity", "opportunity_v2", "decline_gate", "entrant_ratio",
    "solo_viability", "tier",
]


@lru_cache(maxsize=1)
def _has_players() -> bool:
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'total_players_now'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_players_dist() -> bool:
    """median_players_now / players_top5_share (the who-holds-the-players columns) —
    landed after the first players columns, so they get their own gate."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'players_top5_share'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_lifetime() -> bool:
    """lifetime_n_games / lifetime_survival_12m / lifetime_median_dead_months (how long a
    game keeps an audience) — landed after the players-distribution columns, so they get
    their own gate."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'lifetime_survival_12m'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_no_floor_cut() -> bool:
    """Whether the mart materialises the min_reviews=0 cut (the whole tag, no review floor
    — MIN_REVIEWS_LEVELS gained 0 after the lifetime columns landed). A ROW probe, not a
    column probe: the cut adds rows, not schema. Cached for the usual swap-then-restart
    reason."""
    rows = analytics_db.query("SELECT 1 FROM mart_niche WHERE min_reviews = 0 LIMIT 1")
    return bool(rows)


@lru_cache(maxsize=1)
def _has_p90() -> bool:
    """p90_rev landed 2026-08-14; gate it like the players columns so the app still
    serves a mart built before that ETL."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'p90_rev'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_p90_trend() -> bool:
    """mart_niche_trend.p90_rev (yearly p90 for the saturation-trend chart) — gated
    separately from mart_niche.p90_rev because they can land in different ETL builds."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche_trend' AND column_name = 'p90_rev'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_demand24m() -> bool:
    """reviews_24m / reviews_prev_24m / demand_trend_24m_pct — the ranking metric behind
    the Radar board's verdict rings. 24-month windows REPLACED the 12-month ones outright
    (2026-08-26, user-directed: the radar's pinned membership cut is 24m x min50, so the
    whole radar now speaks 24 months), which had themselves
    replaced the 90-day windows (quarter-over-quarter caught release spikes; a year-plus
    window reads structural growth, which is what "what should I build" needs) — so a
    mart carrying only the older 90d/12m columns still answers False here and degrades
    the same way a pre-demand mart does. One probe covers the whole family: the emerging
    columns (reviews_24m_new_share / demand_emerging) ship in the same ETL build as the
    24m windows, never separately. Gated exactly like _has_p90/_has_players: an
    information_schema probe, cached per process (the DB is swapped and the app restarted
    on each nightly rebuild, so a per-process answer can't go stale)."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'demand_trend_24m_pct'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_solo_evidence() -> bool:
    """The solo-evidence trio (see _SOLO_EVIDENCE_COLS) — landed after the 24m demand
    columns, so it gets its own gate. The mart on the server predates these columns for
    hours after every deploy that adds them: rows then carry null and the UI omits the
    evidence line — degrade, never a BinderException 500."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'med_playtime_h'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_v2_parts() -> bool:
    """The opportunity_v2 sub-scores + solo_tier (see _V2_PARTS_COLS) — landed with the
    2026-08-31 score rebuild, so they get their own gate. IMPORTANT: opportunity_v2 itself
    is served by every mart, old or new; what an older mart cannot serve is the BREAKDOWN.
    Rows then carry null for the parts and the UI omits the breakdown — degrade, never a
    BinderException 500 — but the score column stays populated (with the OLD formula's
    values until the nightly rebuild lands, which is the honest state of that DB)."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'supply_brake'"
    )
    return bool(rows)


@lru_cache(maxsize=1)
def _has_niche_games() -> bool:
    """mart_niche_game — the (dimension, key, win, min_reviews) -> appid membership map that
    backs the drill-down surface (/games, /distribution, /combined).

    A TABLE probe, not a column probe, because the whole table is new. It only appears when
    the nightly mart rebuild runs, and the API is always deployed BEFORE that rebuild lands
    — so "absent" is the state production is genuinely in first, for hours, not an error.
    Every endpoint below therefore degrades to an explicit 503 + rebuild hint (the same
    convention as _niche_query's v2-columns 503), never a BinderException 500.

    lru_cached for the usual reason: the whole DB is swapped atomically and the app
    restarted on each ETL, so a per-process answer can't go stale in practice."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'mart_niche_game'"
    )
    return bool(rows)


_NO_NICHE_GAMES = (
    "mart_niche_game (per-niche game membership) has not been built yet — rebuild the "
    "marts (task etl). The niche list/detail endpoints are unaffected."
)


def _require_niche_games() -> None:
    if not _has_niche_games():
        raise HTTPException(status_code=503, detail=_NO_NICHE_GAMES)


def _mq(sql: str, params: list) -> list[dict]:
    """query() for the mart_niche_game-backed SQL below. _has_niche_games() is cached for
    the process lifetime, so a DB swapped in under a running process could otherwise turn a
    vanished table into a 500 — map it onto the same 503 the probe raises."""
    try:
        return analytics_db.query(sql, params)
    except duckdb.CatalogException as exc:
        raise HTTPException(status_code=503, detail=_NO_NICHE_GAMES) from exc


def _mscalar(sql: str, params: list):
    rows = _mq(sql, params)
    if not rows:
        return None
    return next(iter(rows[0].values()))


@lru_cache(maxsize=1)
def _niche_game_cuts() -> tuple[tuple[str, int], ...]:
    """The (win, min_reviews) cuts mart_niche_game actually materialises — MIN_REVIEWS_LEVELS
    x {all, 24m} in etl/build_marts.py, but read off the data rather than hardcoded so a
    mart built before a level was added still reports the truth. Asking for a cut that was
    never built must be a loud 422 listing what exists, not a silent `total: 0` that the UI
    would render as "this niche has no games".

    One cached DISTINCT over two low-cardinality columns, once per process — the only full
    scan in this module, and it buys every endpoint its input validation."""
    rows = _mq("SELECT DISTINCT win, min_reviews FROM mart_niche_game", [])
    return tuple(sorted((str(r["win"]), int(r["min_reviews"])) for r in rows))


def _require_cut(win: str, min_reviews: int) -> None:
    cuts = _niche_game_cuts()
    if (win, min_reviews) not in cuts:
        raise HTTPException(
            status_code=422,
            detail=(
                f"cut (win={win}, min_reviews={min_reviews}) is not materialised in "
                f"mart_niche_game; available: "
                + ", ".join(f"({w}, {m})" for w, m in cuts)
            ),
        )


def _require_dimension(dimension: str) -> None:
    """422 everywhere a path dimension is validated by hand (drill-down surface AND
    niche_detail): FastAPI's own validation status for bad input, so all these endpoints
    answer malformed input identically. (niche_detail used to answer 400 here; unified
    2026-08-28 after confirming no web/src code branches on that 400.)"""
    if dimension not in ("tag", "genre"):
        raise HTTPException(status_code=422, detail="dimension must be tag or genre")


# Games the client may sort on -> the mart_game column, whitelisted (never interpolate a
# user string into SQL). `revenue`/`reviews` are the request-side names the web contract
# froze; the marts call them est_rev_reviews / total_reviews.
_GAME_SORT = {
    "revenue": "g.est_rev_reviews",
    "price": "g.price_initial",
    "reviews": "g.total_reviews",
    "release_year": "g.release_year",
    "name": "g.name",
}

# The NicheGameRow projection. mart_niche_game carries keys only, so every attribute comes
# from the mart_game join.
_GAME_SELECT = (
    "g.appid AS appid, g.name AS name, g.release_year AS release_year, "
    "g.price_initial AS price_initial, g.est_rev_reviews AS est_revenue, "
    "g.total_reviews AS total_reviews, g.owners_mid AS owners_est"
)

# mart_niche_hist is materialised for exactly ONE cut — win='all' and
# min_reviews=MIN_REVIEWS_DEFAULT (etl/marts/mart_niche.sql builds it with a bare
# `total_reviews >= @MIN_REVIEWS_DEFAULT@` and carries no win/min_reviews columns).
_HIST_CUT = ("all", 50)

# The cut grid mart_niche materialises per (dimension, key) — mirrors etl/build_marts.py's
# MIN_REVIEWS_LEVELS x its two windows. niche_detail's variants query is bounded by the
# grid size (every cut of one niche, no more) instead of a magic row count.
_MIN_REVIEWS_LEVELS = (0, 50, 100)
_CUT_WINDOWS = ("all", "24m")
_MAX_VARIANTS = len(_MIN_REVIEWS_LEVELS) * len(_CUT_WINDOWS)

_MAX_COMBINED_NICHES = 8

# Param-name consistency: the list surface (/api/niches, /api/market/distribution) calls
# the cut window `window`, while the drill-down surface froze `win` into the web contract.
# The drill-down endpoints accept `window` as an alias (it wins when both are sent — the
# caller who spells it out gets what they asked for); `win` keeps working unchanged.
_WINDOW_ALIAS_DESC = (
    "Alias for `win` (the list endpoints call this `window`); takes precedence when both "
    "are sent."
)


def _bucket_filters(
    rev_min: float | None,
    rev_max: float | None,
    price_min: float | None,
    price_max: float | None,
) -> tuple[str, list]:
    """The chart cross-filter. HALF-OPEN [min, max) on both axes — deliberately the exact
    semantics of /distribution's buckets, so handing a bucket's (x_min, x_max) straight back
    returns precisely that bucket's `count` rows (including the free-to-play bucket, whose
    [0.0, 0.01) window isolates $0 games and nothing else)."""
    sql, params = "", []
    for col, lo, hi in (
        ("g.est_rev_reviews", rev_min, rev_max),
        ("g.price_initial", price_min, price_max),
    ):
        if lo is not None:
            sql += f" AND {col} >= ?"
            params.append(lo)
        if hi is not None:
            sql += f" AND {col} < ?"
            params.append(hi)
    return sql, params


def _order_by(sort: str, order: str) -> str:
    # appid tiebreak keeps paging stable across requests when the sort key ties (it does a
    # lot: whole niches share one price point, and release_year is coarse).
    return f"ORDER BY {_GAME_SORT[sort]} {order.upper()} NULLS LAST, g.appid ASC"


def _cols() -> list[str]:
    cols = list(_BASE_COLS)
    if _has_p90():
        cols.append("p90_rev")
    if _has_players():
        cols.extend(_PLAYERS_COLS)
    if _has_players_dist():
        cols.extend(["median_players_now", "players_top5_share"])
    if _has_lifetime():
        cols.extend(_LIFETIME_COLS)
    if _has_demand24m():
        cols.extend(_DEMAND24M_COLS)
    if _has_solo_evidence():
        cols.extend(_SOLO_EVIDENCE_COLS)
    if _has_v2_parts():
        cols.extend(_V2_PARTS_COLS)
    return cols


def _row_to_niche(r: dict) -> NicheRow:
    r = dict(r)
    r["window"] = r.pop("win")
    return NicheRow(**r)


def _niche_query(
    where: str, params: list, sort: str, order: str, limit: int, offset: int | None
) -> list[dict]:
    sql = (
        f"SELECT {', '.join(_cols())} FROM mart_niche {where} "
        f"ORDER BY {sort} {order.upper()} NULLS LAST, n_games DESC LIMIT ?"
    )
    params = params + [limit]
    if offset is not None:
        sql += " OFFSET ?"
        params = params + [offset]
    try:
        return analytics_db.query(sql, params)
    except duckdb.BinderException as exc:  # v2 columns missing — mart predates them
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the niche-score v2 columns — rebuild the marts (task etl).",
        ) from exc


def _require_list_capabilities(sort: str, min_reviews: int) -> None:
    """The list surface's shared input gates (list_niches AND export_csv — the CSV export
    used to skip these, so e.g. sort=total_players_now on an older mart fell through to
    _niche_query's misleading v2-columns 503 instead of the specific one below).

    400 on an unknown sort (whitelist, prevents SQL injection); 503 with a rebuild hint
    when the sort column / requested cut is real but the loaded mart predates it."""
    if sort not in SORTABLE:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTABLE)}")
    if sort in _PLAYERS_COLS and not _has_players():
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the live-player columns — rebuild the marts (task etl).",
        )
    if sort in ("median_players_now", "players_top5_share") and not _has_players_dist():
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the players-distribution columns — rebuild the marts (task etl).",
        )
    if sort in _LIFETIME_COLS and not _has_lifetime():
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the lifetime columns — rebuild the marts (task etl).",
        )
    if sort == "p90_rev" and not _has_p90():
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the p90_rev column — rebuild the marts (task etl).",
        )
    if sort in _DEMAND24M_COLS and not _has_demand24m():
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the 24-month demand columns — rebuild the marts (task etl).",
        )
    if sort in _V2_PARTS_COLS and not _has_v2_parts():
        raise HTTPException(
            status_code=503,
            detail=(
                "mart_niche predates the opportunity_v2 sub-scores — rebuild the marts "
                "(task etl). opportunity_v2 itself is still sortable."
            ),
        )
    if min_reviews == 0 and not _has_no_floor_cut():
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the no-floor (min_reviews=0) cut — rebuild the marts (task etl).",
        )


def _like_escape(q: str) -> str:
    """Escape the ILIKE wildcards so a user-typed '%' or '_' matches literally instead of
    acting as a pattern (the games.py contains(name_lower, ?) path gets this for free;
    this ILIKE needs it explicitly). Mirrors entities.py's copy."""
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _build_filters(
    dimension: str,
    window: str,
    min_reviews: int,
    q: str | None,
    tiers: str | None,
    min_total_players: float | None,
    min_total_owners: float | None,
) -> tuple[str, list]:
    where = "WHERE dimension = ? AND win = ? AND min_reviews = ?"
    params: list = [dimension, window, min_reviews]
    if q:
        where += " AND key ILIKE ? ESCAPE '\\'"
        params.append(f"%{_like_escape(q)}%")
    if tiers is not None and dimension == "tag":
        wanted = [t.strip() for t in tiers.split(",") if t.strip()]
        bad = [t for t in wanted if t not in _TIERS]
        if bad:
            raise HTTPException(status_code=400, detail=f"tiers must be from {sorted(_TIERS)}, got {bad}")
        if wanted:
            where += f" AND tier IN ({','.join('?' for _ in wanted)})"
            params.extend(wanted)
    if min_total_players is not None:
        if not _has_players():
            raise HTTPException(
                status_code=503,
                detail="mart_niche predates the live-player columns — rebuild the marts (task etl).",
            )
        where += " AND total_players_now >= ?"
        params.append(min_total_players)
    if min_total_owners is not None:
        where += " AND total_owners >= ?"
        params.append(min_total_owners)
    return where, params


@router.get("", response_model=NicheList)
def list_niches(
    dimension: str = Query("tag", pattern="^(tag|genre)$"),
    window: str = Query("24m", pattern="^(all|24m)$"),
    min_reviews: int = Query(50),
    sort: str = Query("opportunity_v2"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    q: str | None = Query(None),
    tiers: str | None = Query(
        "micro,theme",
        description="Comma-separated tag tiers to include (tags only). Empty/absent value = all tiers.",
    ),
    min_total_players: float | None = Query(None, ge=0),
    min_total_owners: float | None = Query(None, ge=0),
    # Explicit OPT-IN (default off): this list backs NicheFinder / CSV-adjacent flows too,
    # so the radar's population rule must never filter it globally — the Radar board is
    # the consumer that passes solo_only=1.
    solo_only: bool = Query(False, description=_SOLO_ONLY_DESC + " Default off."),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> NicheList:
    _require_list_capabilities(sort, min_reviews)
    tiers_arg = tiers if tiers else None  # "" (explicit empty) = no tier filter
    where, params = _build_filters(
        dimension, window, min_reviews, q, tiers_arg, min_total_players, min_total_owners
    )
    if solo_only:
        where, params = _apply_solo_only(where, params)
    total = analytics_db.scalar(f"SELECT COUNT(*) FROM mart_niche {where}", params)
    rows = _niche_query(where, params, sort, order, limit, offset)
    return NicheList(
        items=[_row_to_niche(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


# =========================================================================================
# Niche drill-down (mart_niche_game). ROUTE ORDER IS LOAD-BEARING: these three MUST be
# registered before `/{dimension}/{key:path}` below, because that route's greedy path
# converter would otherwise swallow /api/niches/tag/Roguelike/games as key="Roguelike/games"
# and 404. Do not move them.
# =========================================================================================


@router.get("/combined", response_model=NicheCombined)
def niches_combined(
    niches: list[str] = Query(
        ...,
        description=(
            "Repeated `dimension:key` specs, 2.."
            f"{_MAX_COMBINED_NICHES} of them — e.g. niches=tag:Roguelike&niches=tag:Deckbuilding. "
            "Split on the FIRST colon, so keys may themselves contain ':', '/' and spaces."
        ),
    ),
    mode: str = Query("intersect", pattern="^(intersect|union)$"),
    win: str = Query("all", pattern="^(all|24m)$"),
    window: str | None = Query(None, pattern="^(all|24m)$", description=_WINDOW_ALIAS_DESC),
    min_reviews: int = Query(50, ge=0, le=100000),
    sort: str = Query("revenue", pattern="^(revenue|price|reviews|release_year|name)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=50000),
) -> NicheCombined:
    """Headline stats + a page of games over 2..N niches combined.

    intersect (the default) = a game must be in EVERY listed niche; union = in any. Intersect
    is the read that makes combined analysis mean anything: a game legitimately belongs to
    many niches, so "Roguelike AND Deckbuilding" is a real sub-market while "Roguelike OR
    Deckbuilding" is just a bigger bag.

    The percentiles are recomputed over the combined set with mart_niche's own definitions
    (quantile_cont over est_rev_reviews; median over price_initial with free games included)
    — averaging the per-niche marts would be flatly wrong for an intersection.
    """
    win = window or win  # `window` is an accepted alias — see _WINDOW_ALIAS_DESC
    pairs = _parse_niche_specs(niches)  # 422s before any capability/DB work
    _require_niche_games()
    _require_cut(win, min_reviews)

    pair_sql = " OR ".join("(dimension = ? AND key = ?)" for _ in pairs)
    pair_params = [v for p in pairs for v in p]
    cut_params: list = [win, min_reviews]

    # Per-input contribution. Counted straight off mart_niche_game, whose per-cut row count
    # is guaranteed equal to mart_niche.n_games — so this is the same number the list page
    # shows, not a re-derivation that could disagree with it.
    per_niche = {
        (r["dimension"], r["key"]): int(r["n"])
        for r in _mq(
            "SELECT dimension, key, COUNT(*) AS n FROM mart_niche_game "
            f"WHERE win = ? AND min_reviews = ? AND ({pair_sql}) GROUP BY dimension, key",
            cut_params + pair_params,
        )
    }
    inputs = [
        NicheCombinedInput(dimension=d, key=k, n_games=per_niche.get((d, k), 0))
        for d, k in pairs
    ]

    # One membership pass: count how many of the requested niches each appid hits, then keep
    # the ones that clear the threshold (N for intersect, 1 for union). Specs are de-duped in
    # _parse_niche_specs, and 'tag'/'genre' can't collide across the ':' join, so
    # COUNT(DISTINCT dimension || ':' || key) is injective here.
    threshold = len(pairs) if mode == "intersect" else 1
    sel_cte = (
        "WITH hits AS ("
        " SELECT appid, COUNT(DISTINCT dimension || ':' || key) AS n_hit"
        " FROM mart_niche_game"
        f" WHERE win = ? AND min_reviews = ? AND ({pair_sql})"
        " GROUP BY appid"
        "), sel AS (SELECT appid FROM hits WHERE n_hit >= ?) "
    )
    sel_params = cut_params + pair_params + [threshold]

    stats = _mq(
        sel_cte
        + "SELECT COUNT(*) AS n_games, "
        "median(g.est_rev_reviews) AS median_rev, "
        "quantile_cont(g.est_rev_reviews, 0.25) AS p25_rev, "
        "quantile_cont(g.est_rev_reviews, 0.75) AS p75_rev, "
        "quantile_cont(g.est_rev_reviews, 0.90) AS p90_rev, "
        "median(g.price_initial) AS median_price "
        "FROM sel s JOIN mart_game g ON g.appid = s.appid",
        sel_params,
    )
    head = stats[0] if stats else {}
    n_games = int(head.get("n_games") or 0)

    rows = _mq(
        sel_cte
        + f"SELECT {_GAME_SELECT} FROM sel s JOIN mart_game g ON g.appid = s.appid "
        f"{_order_by(sort, order)} LIMIT ? OFFSET ?",
        sel_params + [limit, offset],
    )
    return NicheCombined(
        mode=mode,
        win=win,
        min_reviews=min_reviews,
        inputs=inputs,
        n_games=n_games,
        median_rev=head.get("median_rev"),
        p25_rev=head.get("p25_rev"),
        p75_rev=head.get("p75_rev"),
        p90_rev=head.get("p90_rev"),
        median_price=head.get("median_price"),
        # No bucket cross-filter on this surface, so the paging total IS the set size.
        total=n_games,
        items=[NicheGameRow(**r) for r in rows],
        limit=limit,
        offset=offset,
    )


def _parse_niche_specs(raw: list[str]) -> list[tuple[str, str]]:
    """`dim:key` -> (dim, key), strictly. Split on the FIRST colon only: keys are Steam tag /
    genre strings that can contain ':', '/' and spaces ("Sci-fi", "Rogue-lite", ...)."""
    if len(raw) < 2:
        raise HTTPException(
            status_code=422, detail="niches: pass at least 2 `dimension:key` specs to combine"
        )
    if len(raw) > _MAX_COMBINED_NICHES:
        raise HTTPException(
            status_code=422,
            detail=f"niches: at most {_MAX_COMBINED_NICHES} niches may be combined, got {len(raw)}",
        )
    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for spec in raw:
        dim, sep, key = spec.partition(":")
        dim, key = dim.strip(), key.strip()
        if not sep or not dim or not key:
            raise HTTPException(
                status_code=422,
                detail=f"niches: expected 'dimension:key' (e.g. tag:Roguelike), got {spec!r}",
            )
        if dim not in ("tag", "genre"):
            raise HTTPException(
                status_code=422,
                detail=f"niches: dimension must be tag or genre, got {dim!r} in {spec!r}",
            )
        if (dim, key) in seen:
            # An intersect threshold of N assumes N distinct niches; a repeat would make the
            # threshold unreachable and silently return nothing.
            raise HTTPException(status_code=422, detail=f"niches: duplicate spec {spec!r}")
        seen.add((dim, key))
        pairs.append((dim, key))
    return pairs


@router.get("/{dimension}/{key:path}/games", response_model=NicheGameList)
def niche_games(
    dimension: str,
    key: str,
    win: str = Query("all", pattern="^(all|24m)$"),
    window: str | None = Query(None, pattern="^(all|24m)$", description=_WINDOW_ALIAS_DESC),
    min_reviews: int = Query(50, ge=0, le=100000),
    sort: str = Query("revenue", pattern="^(revenue|price|reviews|release_year|name)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    rev_min: float | None = Query(None, description="Cross-filter: est_revenue >= this"),
    rev_max: float | None = Query(None, description="Cross-filter: est_revenue < this"),
    price_min: float | None = Query(None, description="Cross-filter: price_initial >= this"),
    price_max: float | None = Query(None, description="Cross-filter: price_initial < this"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=50000),
) -> NicheGameList:
    """Every member game of one niche cut, paged.

    Defaults mirror the DETAIL endpoint's headline cut (win='all', min_reviews=50 — the
    broadest population, and the one mart_niche_hist is built for), NOT the list endpoint's
    24m default: this table sits under the detail page's charts and must agree with them.

    `total` is the match count before limit/offset (and after any cross-filter), so the UI
    can page honestly. A niche/cut with no rows returns total=0 rather than 404 — a real
    niche can legitimately miss a cut that fell under the mart's MIN_NICHE_GAMES floor, and
    distinguishing that from a typo would cost another full scan.
    """
    win = window or win  # `window` is an accepted alias — see _WINDOW_ALIAS_DESC
    _require_dimension(dimension)
    _require_niche_games()
    _require_cut(win, min_reviews)

    base = (
        "FROM mart_niche_game m JOIN mart_game g ON g.appid = m.appid "
        "WHERE m.dimension = ? AND m.key = ? AND m.win = ? AND m.min_reviews = ?"
    )
    params: list = [dimension, key, win, min_reviews]
    bsql, bparams = _bucket_filters(rev_min, rev_max, price_min, price_max)

    total = _mscalar(f"SELECT COUNT(*) AS n {base}{bsql}", params + bparams)
    rows = _mq(
        f"SELECT {_GAME_SELECT} {base}{bsql} {_order_by(sort, order)} LIMIT ? OFFSET ?",
        params + bparams + [limit, offset],
    )
    return NicheGameList(
        total=int(total or 0),
        items=[NicheGameRow(**r) for r in rows],
        limit=limit,
        offset=offset,
    )


@router.get("/{dimension}/{key:path}/distribution", response_model=NicheDistribution)
def niche_distribution(
    dimension: str,
    key: str,
    metric: str = Query(..., pattern="^(revenue|price)$"),
    win: str = Query("all", pattern="^(all|24m)$"),
    window: str | None = Query(None, pattern="^(all|24m)$", description=_WINDOW_ALIAS_DESC),
    min_reviews: int = Query(50, ge=0, le=100000),
) -> NicheDistribution:
    """Revenue or price histogram for one niche cut. See schemas.NicheDistribution for the
    bucket contract; the short version is that buckets are half-open [x_min, x_max) and
    round-trip exactly into /games' rev_min/rev_max/price_min/price_max cross-filter.

    revenue on the default cut is the one thing on this surface that works WITHOUT
    mart_niche_game — mart_niche_hist already ships it — so the charts light up the moment
    the API deploys, hours before the rebuild.
    """
    win = window or win  # `window` is an accepted alias — see _WINDOW_ALIAS_DESC
    _require_dimension(dimension)

    if metric == "revenue":
        # Prefer the precomputed mart when the request matches the ONE cut it materialises
        # (win='all', min_reviews=MIN_REVIEWS_DEFAULT — see _HIST_CUT): it is a small keyed
        # lookup instead of a millions-row join, and it is the exact same binning, so the
        # two paths are interchangeable. Empty means the niche fell under the mart's
        # MIN_NICHE_GAMES floor — fall through and compute it.
        if (win, min_reviews) == _HIST_CUT:
            try:
                hist = analytics_db.query(
                    "SELECT bucket_index, x_min, x_max, count FROM mart_niche_hist "
                    "WHERE dimension = ? AND key = ? ORDER BY bucket_index",
                    [dimension, key],
                )
            except duckdb.CatalogException:  # mart older than mart_niche_hist itself
                hist = []
            if hist:
                buckets = []
                for h in hist:
                    h = dict(h)
                    # The mart's GREATEST(v, 1) floor lands $0 games in bucket 0 but labels
                    # its lower edge 1.0. Report 0.0 so the cross-filter that the UI builds
                    # from (x_min, x_max) doesn't silently drop free games.
                    if int(h["bucket_index"]) == 0:
                        h["x_min"] = 0.0
                    buckets.append(HistBucket(**h))
                return NicheDistribution(
                    metric="revenue",
                    buckets=buckets,
                    n_games=sum(b.count for b in buckets),
                    source="mart",
                )

    _require_niche_games()
    _require_cut(win, min_reviews)

    member_cte = (
        "WITH m AS (SELECT appid FROM mart_niche_game "
        "WHERE dimension = ? AND key = ? AND win = ? AND min_reviews = ?) "
    )
    params: list = [dimension, key, win, min_reviews]

    if metric == "revenue":
        sql = (
            member_cte
            + "SELECT CAST(floor(log10(GREATEST(g.est_rev_reviews, 1)) * 2) AS INTEGER) AS bucket_index, "
            # bucket 0's lower edge is reported as 0.0, not 10^0 — same reason as the mart
            # path above: it is the bucket that holds the $0 games.
            "CASE WHEN CAST(floor(log10(GREATEST(g.est_rev_reviews, 1)) * 2) AS INTEGER) = 0 "
            "THEN 0.0 ELSE pow(10, CAST(floor(log10(GREATEST(g.est_rev_reviews, 1)) * 2) AS INTEGER) / 2.0) END AS x_min, "
            "pow(10, (CAST(floor(log10(GREATEST(g.est_rev_reviews, 1)) * 2) AS INTEGER) + 1) / 2.0) AS x_max, "
            "COUNT(*) AS count "
            "FROM m JOIN mart_game g ON g.appid = m.appid "
            "WHERE g.est_rev_reviews IS NOT NULL "
            "GROUP BY 1, 2, 3 ORDER BY 1"
        )
    else:
        # Price: linear $2.50 bins (mart_market_hist's convention — price is bounded and
        # clusters at price points, so log bins would be unreadable), with free-to-play
        # pulled OUT into its own bucket_index = -1 spanning [0.0, 0.01). F2P is a large,
        # genuinely different product category; folding $0 into a "$0-$2.50" bar would
        # read as a pricing floor that nobody chose. Paid bucket 0 therefore starts at
        # 0.01 (the first paid cent) so every bucket still round-trips exactly.
        bkt = "CASE WHEN g.price_initial <= 0 THEN -1 ELSE CAST(floor(g.price_initial / 2.5) AS INTEGER) END"
        # The edges are CAST to DOUBLE explicitly: mart_game.price_initial is DECIMAL in the
        # real marts (DOUBLE only in the test fixture), and DuckDB would otherwise hand back
        # Decimal edges here but plain floats on the revenue axis.
        sql = (
            member_cte
            + f"SELECT {bkt} AS bucket_index, "
            f"CAST(CASE WHEN {bkt} = -1 THEN 0.0 WHEN {bkt} = 0 THEN 0.01 ELSE {bkt} * 2.5 END AS DOUBLE) AS x_min, "
            f"CAST(CASE WHEN {bkt} = -1 THEN 0.01 ELSE ({bkt} + 1) * 2.5 END AS DOUBLE) AS x_max, "
            "COUNT(*) AS count "
            "FROM m JOIN mart_game g ON g.appid = m.appid "
            "WHERE g.price_initial IS NOT NULL "
            "GROUP BY 1, 2, 3 ORDER BY 1"
        )

    buckets = [HistBucket(**b) for b in _mq(sql, params)]
    return NicheDistribution(
        metric=metric,  # type: ignore[arg-type]
        buckets=buckets,
        n_games=sum(b.count for b in buckets),
        source="computed",
    )


@router.get("/{dimension}/{key:path}", response_model=NicheDetail)
def niche_detail(dimension: str, key: str) -> NicheDetail:
    _require_dimension(dimension)

    variants = _niche_query(
        "WHERE dimension = ? AND key = ?",
        [dimension, key],
        "min_reviews",
        "asc",
        _MAX_VARIANTS,  # every cut of one niche (the levels x windows grid), no more
        None,
    )
    if not variants:
        raise HTTPException(status_code=404, detail=f"niche not found: {dimension}/{key}")
    variants.sort(key=lambda v: (v["win"], v["min_reviews"]))

    trend_cols = "year, n_releases, n_scored, median_rev" + (", p90_rev" if _has_p90_trend() else "")
    trend = analytics_db.query(
        f"SELECT {trend_cols} FROM mart_niche_trend "
        "WHERE dimension = ? AND key = ? ORDER BY year",
        [dimension, key],
    )
    hist = analytics_db.query(
        "SELECT bucket_index, x_min, x_max, count FROM mart_niche_hist "
        "WHERE dimension = ? AND key = ? ORDER BY bucket_index",
        [dimension, key],
    )
    games = analytics_db.query(
        "SELECT rank_in_niche, appid, name, release_year, price_initial, owners_mid, "
        "total_reviews, positive_ratio, est_rev_reviews, self_published, header_image "
        "FROM mart_niche_top WHERE dimension = ? AND key = ? ORDER BY rank_in_niche",
        [dimension, key],
    )

    # Live players: mart_niche summary columns (identical on every cut row) + the daily
    # series. None when the mart predates the CCU marts.
    players: NichePlayers | None = None
    if _has_players():
        series = analytics_db.query(
            "SELECT CAST(date AS VARCHAR) AS date, total_players, measured_players, "
            "n_games_measured FROM mart_niche_players "
            "WHERE dimension = ? AND key = ? ORDER BY date",
            [dimension, key],
        )
        panel = analytics_db.scalar(
            "SELECT MAX(n_games_panel) FROM mart_niche_players WHERE dimension = ? AND key = ?",
            [dimension, key],
        )
        # Deep monthly history (steamcharts, top-8k games) — its mart landed after the
        # daily one, so it degrades independently.
        monthly: list[NichePlayersMonthlyPoint] = []
        try:
            monthly = [
                NichePlayersMonthlyPoint(**r)
                for r in analytics_db.query(
                    "SELECT CAST(month AS VARCHAR) AS month, avg_players_sum, n_games_measured "
                    "FROM mart_niche_players_monthly WHERE dimension = ? AND key = ? ORDER BY month",
                    [dimension, key],
                )
            ]
        except duckdb.CatalogException:
            monthly = []
        # "Who holds the players" — the distribution marts landed after the daily ones,
        # so they degrade independently.
        distribution: NichePlayersDistribution | None = None
        try:
            # NB: a distinct local name — this must NOT rebind the revenue `hist` above,
            # which previously leaked the players histogram into revenue_histogram.
            players_hist = analytics_db.query(
                "SELECT bucket_index, x_min, x_max, count FROM mart_niche_players_hist "
                "WHERE dimension = ? AND key = ? ORDER BY bucket_index",
                [dimension, key],
            )
            top_games = analytics_db.query(
                "SELECT rank, appid, name, players, share FROM mart_niche_players_top "
                "WHERE dimension = ? AND key = ? ORDER BY rank",
                [dimension, key],
            )
            head0 = variants[0]
            if players_hist or top_games:
                distribution = NichePlayersDistribution(
                    median_players_now=head0.get("median_players_now"),
                    players_top5_share=head0.get("players_top5_share"),
                    n_games_now=sum(int(h["count"]) for h in players_hist),
                    histogram=[HistBucket(**h) for h in players_hist],
                    top_games=[NichePlayersTopGame(**t) for t in top_games],
                )
        except duckdb.CatalogException:
            distribution = None

        head = variants[0]
        players = NichePlayers(
            total_players_now=head.get("total_players_now"),
            players_trend_7d_pct=head.get("players_trend_7d_pct"),
            players_coverage=head.get("players_coverage"),
            n_games_panel=panel,
            series=[NichePlayersPoint(**s) for s in series],
            monthly=monthly,
            distribution=distribution,
        )

    # Pooled review themes (vote-based family), biggest signal first. Membership is
    # narrower than mart_niche's (top-10 tags / primary genre only — see
    # mart_niche_themes.sql), so a niche can legitimately have none.
    themes = analytics_db.query(
        "SELECT aspect, n_games, total_mentions, praise_share, complaint_share, "
        "praise_delta_vs_catalog FROM mart_niche_themes "
        "WHERE dimension = ? AND key = ? ORDER BY total_mentions DESC LIMIT 10",
        [dimension, key],
    )

    # Press coverage pooled to niche level (mart_niche_press / mart_niche_press_outlets).
    # None when the mart predates this feature (CatalogException on the missing tables —
    # same degrade convention as the players block, but the whole TABLE can be absent here,
    # not just columns) or when the niche has no published rows (below the covered-games
    # floor / genuinely uncovered). total_articles sums the dated timeline; outlets are
    # already capped + ordered by volume in the mart.
    press: NichePress | None = None
    try:
        press_timeline = analytics_db.query(
            "SELECT month, n_articles FROM mart_niche_press "
            "WHERE dimension = ? AND key = ? ORDER BY month",
            [dimension, key],
        )
        press_outlets = analytics_db.query(
            "SELECT source, n_articles, n_games_covered FROM mart_niche_press_outlets "
            "WHERE dimension = ? AND key = ? ORDER BY n_articles DESC, source",
            [dimension, key],
        )
        if press_timeline or press_outlets:
            press = NichePress(
                total_articles=sum(int(p["n_articles"]) for p in press_timeline),
                timeline=[NichePressPoint(**p) for p in press_timeline],
                top_outlets=[NichePressOutlet(**o) for o in press_outlets],
            )
    except duckdb.CatalogException:
        press = None

    # Headline numbers from the all/50 cut (the broadest population that always exists).
    headline = next(
        (v for v in variants if v["win"] == "all" and v["min_reviews"] == 50), variants[0]
    )
    return NicheDetail(
        dimension=dimension,
        key=key,
        tier=headline.get("tier"),
        variants=[_row_to_niche(v) for v in variants],
        saturation_trend=[TrendPoint(**t) for t in trend],
        revenue_histogram=[HistBucket(**h) for h in hist],
        representative_games=[NicheGame(**g) for g in games],
        players=players,
        themes=[NicheTheme(**t) for t in themes],
        press=press,
        hit_rates={
            "hit_rate_200k": headline["hit_rate_200k"],
            "hit_rate_500k": headline["hit_rate_500k"],
            "median_rev": headline["median_rev"],
            "n_games": headline["n_games"],
            "winner_concentration": headline["winner_concentration"],
        },
    )


@router.get("/export.csv")
def export_csv(
    dimension: str = Query("tag", pattern="^(tag|genre)$"),
    window: str = Query("24m", pattern="^(all|24m)$"),
    min_reviews: int = Query(50),
    sort: str = Query("opportunity_v2"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    q: str | None = Query(None),
    tiers: str | None = Query("micro,theme"),
    limit: int = Query(1000, ge=1, le=5000),
) -> Response:
    # The SAME capability gates as list_niches — the export is the list in CSV clothes,
    # so a request the list would answer with a specific 503 must not fall through to
    # _niche_query's generic (and here misleading) v2-columns 503.
    _require_list_capabilities(sort, min_reviews)
    tiers_arg = tiers if tiers else None
    where, params = _build_filters(dimension, window, min_reviews, q, tiers_arg, None, None)
    rows = _niche_query(where, params, sort, order, limit, None)

    fields = ["window" if c == "win" else c for c in _cols()]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields)
    writer.writeheader()
    for r in rows:
        r = dict(r)
        r["window"] = r.pop("win")
        writer.writerow(r)
    filename = f"niches_{dimension}_{window}_mr{min_reviews}.csv"
    # A plain Response, not StreamingResponse: the payload is already fully buffered in
    # `buf` (max 5000 small rows), so streaming a one-element iterator bought nothing and
    # cost a correct Content-Length.
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
