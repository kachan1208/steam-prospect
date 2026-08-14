"""Per-game momentum trends over time.

GET /api/games/{appid}/trends returns a game's monthly time series from
mart_game_trends (see etl/marts/mart_game_trends.sql): review velocity, average live
concurrent players, Twitch viewer reach, and creator-mention volume, one row per
'YYYY-MM'. Separate router from games.py (distinct path), included alongside it in
api/app/main.py.

Optional competitor overlay: pass ?comps=1,2,3 (comma-separated appids) and the response
also carries a `comps` block — each comp's own monthly series PLUS a `cohort` series
(per-period MEDIAN, with p25/p75, across the comps) so the UI can draw one cohort
band/line ("am I above/below comparable games?") instead of unreadable spaghetti. The
base shape ({appid, eligible, points}) is unchanged; `comps` is null unless requested.

Data caveats (surfaced so the UI can caption the chart honestly):
- n_reviews is from the per-game review SAMPLE (recency-biased for older/popular titles),
  so it tracks sampled review velocity, not the true full-history review count.
- ccu_avg / twitch_viewers / n_mentions are only as deep as the collectors have run:
  player-count and creator-mention snapshots are recent, so those series are typically a
  single current month today and thicken as history accumulates. ccu_avg is NULL (a gap,
  not zero) for any month without a snapshot.
- The cohort median is taken over the comps that HAVE a row that month (a missing month
  for a comp is "not yet released / no signal", not a zero), so its `n_comps` count tells
  the UI how many comps actually back each period — early/late months lean on few games.
"""
from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query

from pydantic import BaseModel

from .. import analytics_db

router = APIRouter(prefix="/api/games", tags=["games"])

# Cap the number of comps we fan out over: bounds the response (per-comp series) and keeps
# the cohort band legible. Extra ids beyond this are ignored (matched list reflects what
# actually contributed).
MAX_COMPS = 12

_POINT_COLS = "period, n_reviews, ccu_avg, twitch_viewers, n_mentions"


class GameTrendPoint(BaseModel):
    period: str  # 'YYYY-MM'
    n_reviews: int
    ccu_avg: float | None  # NULL when no live-player snapshot landed that month
    twitch_viewers: int
    n_mentions: int


class CompSeries(BaseModel):
    """One comparable game's own monthly series (same shape as the subject game's points)."""

    appid: int
    points: list[GameTrendPoint]


class CohortTrendPoint(BaseModel):
    """Per-period summary ACROSS the comps: the median comp's trend plus the p25-p75 review
    band, so the chart shows a single cohort context line/band instead of spaghetti."""

    period: str
    n_comps: int  # how many comps had a row this period (band/median reliability)
    n_reviews: int  # MEDIAN sampled reviews/mo across comps
    n_reviews_p25: int  # 25th pct — lower edge of the review-velocity band
    n_reviews_p75: int  # 75th pct — upper edge of the review-velocity band
    ccu_avg: float | None  # MEDIAN live players (NULL when no comp had a snapshot that month)
    twitch_viewers: int  # MEDIAN Twitch viewers/mo
    n_mentions: int  # MEDIAN creator mentions/mo


class GameTrendsComps(BaseModel):
    requested: list[int]  # parsed comp appids the caller asked for (deduped, self dropped)
    matched: list[int]  # subset actually present in mart_game_trends (unknown ids ignored)
    series: list[CompSeries]  # each matched comp's own monthly points
    cohort: list[CohortTrendPoint]  # per-period median/band across the matched comps


class GameTrendsResponse(BaseModel):
    appid: int
    eligible: bool  # False when the game has no monthly rows (not in the catalog sample)
    points: list[GameTrendPoint]
    comps: GameTrendsComps | None = None  # only populated when ?comps= is requested


def _parse_comps(raw: str | None, self_appid: int) -> list[int]:
    """Parse a `1,2,3` comps param into a bounded, deduped appid list. Non-integer tokens
    and the subject game itself are dropped; order is preserved; capped at MAX_COMPS."""
    if not raw:
        return []
    out: list[int] = []
    seen: set[int] = set()
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            appid = int(tok)
        except ValueError:
            continue
        if appid == self_appid or appid in seen:
            continue
        seen.add(appid)
        out.append(appid)
        if len(out) >= MAX_COMPS:
            break
    return out


def _build_comps(requested: list[int]) -> GameTrendsComps:
    """Validate requested comps against mart_game_trends, then assemble each comp's series
    and the per-period cohort median/band across the ones that exist."""
    placeholders = ",".join("?" * len(requested))
    present = {
        r["appid"]
        for r in analytics_db.query(
            f"SELECT DISTINCT appid FROM mart_game_trends WHERE appid IN ({placeholders})",
            requested,
        )
    }
    matched = [a for a in requested if a in present]

    series: list[CompSeries] = []
    cohort: list[CohortTrendPoint] = []
    if matched:
        for appid in matched:
            rows = analytics_db.query(
                f"SELECT {_POINT_COLS} FROM mart_game_trends WHERE appid = ? ORDER BY period ASC",
                [appid],
            )
            series.append(CompSeries(appid=appid, points=[GameTrendPoint(**r) for r in rows]))

        cohort_ph = ",".join("?" * len(matched))
        cohort_rows = analytics_db.query(
            "SELECT period, "
            "COUNT(DISTINCT appid) AS n_comps, "
            "CAST(ROUND(MEDIAN(n_reviews)) AS BIGINT) AS n_reviews, "
            "CAST(ROUND(QUANTILE_CONT(n_reviews, 0.25)) AS BIGINT) AS n_reviews_p25, "
            "CAST(ROUND(QUANTILE_CONT(n_reviews, 0.75)) AS BIGINT) AS n_reviews_p75, "
            "MEDIAN(ccu_avg) AS ccu_avg, "
            "CAST(ROUND(MEDIAN(twitch_viewers)) AS BIGINT) AS twitch_viewers, "
            "CAST(ROUND(MEDIAN(n_mentions)) AS BIGINT) AS n_mentions "
            f"FROM mart_game_trends WHERE appid IN ({cohort_ph}) "
            "GROUP BY period ORDER BY period ASC",
            matched,
        )
        cohort = [CohortTrendPoint(**r) for r in cohort_rows]

    return GameTrendsComps(requested=requested, matched=matched, series=series, cohort=cohort)


# ------------------------------------------------------------------------------------------
# Daily live-player (CCU) series — GET /api/games/{appid}/players
# ------------------------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _has_players_daily() -> bool:
    """Whether the current mart carries the daily CCU marts (mart_players.sql). Gated so
    the endpoint degrades to available=False (not a 500) when the app boots against an
    older mart — same capability idiom as games.py::_has_name_lower. Cached: the DB is
    swapped + app restarted on each ETL build."""
    rows = analytics_db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'mart_game_players_daily'"
    )
    return bool(rows)


class GamePlayersPoint(BaseModel):
    date: str  # 'YYYY-MM-DD' (UTC capture date)
    players: int  # LAST capture of that date — a ~21-22:00 UTC point sample, NOT a daily peak


class GamePlayersSummary(BaseModel):
    live_players: int | None = None  # latest capture (mart_game.live_players)
    players_7d_avg: float | None = None  # trailing-7d average of the point samples
    players_trend_7d_pct: float | None = None  # vs the prior 7d (measured days only)
    n_days_measured: int = 0  # measured days in the FULL retained history
    first_date: str | None = None  # bounds of that history
    last_date: str | None = None


class GamePlayersResponse(BaseModel):
    appid: int
    days: int
    available: bool  # False when the mart predates the CCU marts (UI: hide the panel)
    summary: GamePlayersSummary | None = None
    points: list[GamePlayersPoint]  # measured days only — a gap is "unmeasured", never zero


@router.get("/{appid}/players", response_model=GamePlayersResponse)
def game_players(
    appid: int,
    days: int = Query(90, ge=7, le=365, description="Series window in days (summary always covers full history)."),
) -> GamePlayersResponse:
    exists = analytics_db.scalar("SELECT COUNT(*) FROM mart_game WHERE appid = ?", [appid])
    if not exists:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")
    if not _has_players_daily():
        return GamePlayersResponse(appid=appid, days=days, available=False, summary=None, points=[])

    # days is Query-validated (7-365), safe to interpolate into the INTERVAL literal.
    rows = analytics_db.query(
        f"SELECT CAST(date AS VARCHAR) AS date, players FROM mart_game_players_daily "
        f"WHERE appid = ? AND date >= CURRENT_DATE - INTERVAL {days} DAY ORDER BY date ASC",
        [appid],
    )
    game = analytics_db.query_one(
        "SELECT live_players, players_7d_avg, players_trend_7d_pct FROM mart_game WHERE appid = ?",
        [appid],
    )
    bounds = analytics_db.query_one(
        "SELECT COUNT(*) AS n_days_measured, CAST(MIN(date) AS VARCHAR) AS first_date, "
        "CAST(MAX(date) AS VARCHAR) AS last_date FROM mart_game_players_daily WHERE appid = ?",
        [appid],
    )
    return GamePlayersResponse(
        appid=appid,
        days=days,
        available=True,
        summary=GamePlayersSummary(**(game or {}), **(bounds or {})),
        points=[GamePlayersPoint(**r) for r in rows],
    )


@router.get("/{appid}/trends", response_model=GameTrendsResponse)
def game_trends(
    appid: int,
    comps: str | None = Query(
        None,
        description="Optional comma-separated comparable appids, e.g. `1,2,3`. When present, "
        "the response adds a `comps` block with each comp's series and a cohort median/band.",
    ),
) -> GameTrendsResponse:
    exists = analytics_db.scalar("SELECT COUNT(*) FROM mart_game WHERE appid = ?", [appid])
    if not exists:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")

    rows = analytics_db.query(
        f"SELECT {_POINT_COLS} FROM mart_game_trends WHERE appid = ? ORDER BY period ASC",
        [appid],
    )

    requested = _parse_comps(comps, appid)
    comps_block = _build_comps(requested) if requested else None

    return GameTrendsResponse(
        appid=appid,
        eligible=len(rows) > 0,
        points=[GameTrendPoint(**r) for r in rows],
        comps=comps_block,
    )
