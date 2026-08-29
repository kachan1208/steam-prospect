"""Launch & Timing overview over the mart_timing_* marts (see etl/marts/mart_timing.sql).

Built from the TRUE uncapped monthly review histograms (review_histogram in the source
catalog, ~40K games), these replace the old "median revenue by launch month" read, which
was composition-confounded: a high-median month reflects WHAT KIND of game launches then,
not the calendar. The three honest series:

  demand      — share of the genre's pooled monthly review velocity per calendar month,
                with each game's first 2 months excluded so launch spikes don't
                masquerade as seasonal demand. WHEN PLAYERS ACTUALLY BUY.
  congestion  — average releases (and big releases, est_rev >= $200K) per calendar month
                over the last 3 complete years. HOW CROWDED each window is.
  decay       — median share of a game's first-24-months review total landing in each
                month since release (per-game normalized first, so big games don't
                dominate). HOW LONG A LAUNCH PAYS OUT.

window_recommendation is deliberately transparent, not a model:
  demand_index[m]     = demand_share[m] / (1/12)            (1.0 = an average month)
  congestion_index[m] = avg_releases[m] / mean(avg_releases) (1.0 = an average month)
  score[m]            = demand_index[m] - congestion_index[m]
Positive score = player buying outruns release crowding. All components are returned so
the client (and the user) can audit the arithmetic.

Like entities.py, mart_timing_* may be missing in prod between a deploy and the next
nightly ETL — every query is wrapped so that surfaces as a clear 503, not a raw
duckdb.CatalogException 500.
"""
from __future__ import annotations

import calendar

import duckdb
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from .. import analytics_db, response_cache

router = APIRouter(prefix="/api/timing", tags=["timing"])

_MARTS_MISSING_DETAIL = (
    "timing data is refreshing — the launch-timing marts haven't been built yet "
    "(mart_timing_demand/mart_timing_congestion/mart_timing_decay missing; they appear "
    "after the next ETL run)"
)
_DB_MISSING_DETAIL = (
    "analytics database not available — the ETL hasn't produced current.duckdb yet"
)

_MONTH_NAMES = ["", *calendar.month_abbr[1:]]  # 1-indexed Jan..Dec


def _q(sql: str, params: list | None = None) -> list[dict]:
    """analytics_db.query with the pre-ETL failure modes mapped to a clean 503 (mirrors
    entities.py's _q — whole DB absent vs. DB present but built by an older ETL)."""
    if not analytics_db.is_ready():
        raise HTTPException(status_code=503, detail=_DB_MISSING_DETAIL)
    try:
        return analytics_db.query(sql, params)
    except duckdb.CatalogException:
        raise HTTPException(status_code=503, detail=_MARTS_MISSING_DETAIL)


class DemandPoint(BaseModel):
    month: int  # 1-12
    demand_share: float | None  # of the genre's pooled post-launch review velocity
    month_reviews: int | None  # raw pooled review count behind the share
    n_games: int  # distinct games contributing in this calendar month


class CongestionPoint(BaseModel):
    month: int
    avg_releases: float
    avg_big_releases: float  # est_rev_reviews >= $200K
    n_years: int


class DecayPoint(BaseModel):
    month_since_release: int  # 0-23
    median_share: float | None  # median per-game share of first-24-months reviews
    mean_share: float | None
    n_games: int


class DecaySummary(BaseModel):
    # Cumulative shares of the median decay curve, renormalized so the 24 medians sum to
    # 1 (per-game medians don't sum to exactly 1 across months).
    first_3_months_share: float | None
    first_6_months_share: float | None
    first_12_months_share: float | None
    n_games: int


class WindowScore(BaseModel):
    month: int
    month_name: str
    demand_share: float | None
    demand_index: float | None  # demand_share / (1/12); 1.0 = an average month
    avg_releases: float | None
    avg_big_releases: float | None
    congestion_index: float | None  # avg_releases / mean(avg_releases); 1.0 = average
    score: float | None  # demand_index - congestion_index


class WindowRecommendation(BaseModel):
    best_months: list[int]
    best_month_names: list[str]
    rationale: str  # one-sentence plain-language read of the best windows
    method: str  # the exact formula, so the score is auditable
    months: list[WindowScore]  # all 12, calendar order


class TimingOverview(BaseModel):
    genre: str
    demand: list[DemandPoint]
    congestion: list[CongestionPoint]
    decay: list[DecayPoint]
    decay_summary: DecaySummary | None
    window_recommendation: WindowRecommendation | None
    notes: list[str]


_NOTES = [
    "Reviews proxy sales (Boxleiter): all volumes here are review counts, not revenue.",
    "Demand excludes each game's first 2 calendar months since release, so launch spikes "
    "don't masquerade as seasonal demand — what remains is post-launch/catalog buying.",
    "Correlational, not causal: seasonal effects are real but second-order vs. game "
    "quality and wishlist momentum. Congestion is genre-wide, not niche-level.",
]


def _recommendation(
    demand: list[DemandPoint], congestion: list[CongestionPoint], genre: str
) -> WindowRecommendation | None:
    d_by_m = {p.month: p for p in demand if p.demand_share is not None}
    c_by_m = {p.month: p for p in congestion}
    if len(d_by_m) < 12 or len(c_by_m) < 12:
        return None  # only score when both series are complete

    mean_releases = sum(c.avg_releases for c in c_by_m.values()) / 12
    baseline = 1.0 / 12

    months: list[WindowScore] = []
    for m in range(1, 13):
        d, c = d_by_m[m], c_by_m[m]
        demand_index = (d.demand_share or 0) / baseline
        congestion_index = c.avg_releases / mean_releases if mean_releases > 0 else None
        score = demand_index - congestion_index if congestion_index is not None else None
        months.append(
            WindowScore(
                month=m,
                month_name=_MONTH_NAMES[m],
                demand_share=d.demand_share,
                demand_index=round(demand_index, 4),
                avg_releases=c.avg_releases,
                avg_big_releases=c.avg_big_releases,
                congestion_index=round(congestion_index, 4) if congestion_index is not None else None,
                score=round(score, 4) if score is not None else None,
            )
        )

    scored = [w for w in months if w.score is not None]
    if not scored:
        return None
    best = sorted(scored, key=lambda w: w.score, reverse=True)[:3]
    top = best[0]
    label = "the catalog" if genre == "__all__" else genre
    rationale = (
        f"{', '.join(w.month_name for w in best)} look like the best windows for {label}: "
        f"in {top.month_name}, players do {top.demand_index:.2f}x an average month's buying "
        f"({(top.demand_share or 0) * 100:.1f}% of the year's post-launch review activity) "
        f"while release traffic runs {top.congestion_index:.2f}x the monthly average "
        f"({top.avg_releases:.0f} releases/yr, {top.avg_big_releases:.0f} of them $200K+) — "
        "demand outruns crowding there. Timing is a second-order effect: it tilts odds, "
        "it doesn't rescue a weak game."
    )
    return WindowRecommendation(
        best_months=[w.month for w in best],
        best_month_names=[w.month_name for w in best],
        rationale=rationale,
        method=(
            "score = demand_share/(1/12) - avg_releases/mean(avg_releases); "
            "components returned per month so the arithmetic is auditable"
        ),
        months=months,
    )


def _decay_summary(decay: list[DecayPoint]) -> DecaySummary | None:
    shares = [(p.month_since_release, p.median_share) for p in decay if p.median_share is not None]
    if not shares:
        return None
    total = sum(s for _, s in shares)
    if total <= 0:
        return None

    def cum(upto: int) -> float:
        return round(sum(s for m, s in shares if m < upto) / total, 4)

    return DecaySummary(
        first_3_months_share=cum(3),
        first_6_months_share=cum(6),
        first_12_months_share=cum(12),
        n_games=decay[0].n_games if decay else 0,
    )


@router.get("/overview", response_model=TimingOverview)
def timing_overview(
    response: Response,
    genre: str = Query("__all__", description="Exact Steam genre label, or '__all__'."),
) -> TimingOverview:
    """Three mart reads plus the 12-month scoring pass — a pure function of the mart for a
    given genre, so it is cached in-process keyed by the mart version and sent with an hour
    of public cache (see response_cache). The 404 for an unknown genre is NOT cached: only
    successful answers are stored."""
    response.headers["Cache-Control"] = response_cache.CACHE_CONTROL
    return response_cache.get_or_compute("timing_overview", (genre,), lambda: _overview(genre))


def _overview(genre: str) -> TimingOverview:
    demand_rows = _q(
        "SELECT month, demand_share, month_reviews, n_games FROM mart_timing_demand "
        "WHERE genre = ? ORDER BY month",
        [genre],
    )
    congestion_rows = _q(
        "SELECT month, avg_releases, avg_big_releases, n_years FROM mart_timing_congestion "
        "WHERE genre = ? ORDER BY month",
        [genre],
    )
    decay_rows = _q(
        "SELECT month_since_release, median_share, mean_share, n_games FROM mart_timing_decay "
        "WHERE genre = ? ORDER BY month_since_release",
        [genre],
    )
    if not demand_rows and not congestion_rows and not decay_rows:
        raise HTTPException(
            status_code=404,
            detail=f"no timing data for genre {genre!r} — it may be below the per-genre "
            "size floors; try '__all__' or an exact Steam genre label",
        )

    demand = [DemandPoint(**r) for r in demand_rows]
    congestion = [CongestionPoint(**r) for r in congestion_rows]
    decay = [DecayPoint(**r) for r in decay_rows]

    return TimingOverview(
        genre=genre,
        demand=demand,
        congestion=congestion,
        decay=decay,
        decay_summary=_decay_summary(decay),
        window_recommendation=_recommendation(demand, congestion, genre),
        notes=_NOTES,
    )
