from __future__ import annotations

from fastapi import APIRouter, Query, Response

from .. import analytics_db, response_cache
from ..schemas import LaunchCurve, LaunchCurvePoint, Seasonality, SeasonalityCell

router = APIRouter(tags=["timing"])

_SEASON_COLS = (
    "genre, month, weekday, year, n_releases, n_scored, "
    "median_rev, median_reviews, median_positive_ratio"
)


@router.get("/api/seasonality", response_model=Seasonality)
def seasonality(
    response: Response,
    genre: str = Query("__all__"),
) -> Seasonality:
    """A pure function of the mart for a given genre — cached in-process keyed by the mart
    version, and sent with an hour of public cache (see response_cache)."""
    response.headers["Cache-Control"] = response_cache.CACHE_CONTROL
    return response_cache.get_or_compute("seasonality", (genre,), lambda: _seasonality(genre))


def _seasonality(genre: str) -> Seasonality:
    rows = analytics_db.query(
        f"SELECT grain, {_SEASON_COLS} FROM mart_seasonality WHERE genre = ?",
        [genre],
    )
    by_grain: dict[str, list[SeasonalityCell]] = {"month_weekday": [], "month": [], "weekday": [], "year": []}
    for r in rows:
        grain = r.pop("grain")
        if grain in by_grain:
            by_grain[grain].append(SeasonalityCell(**r))
    by_grain["month_weekday"].sort(key=lambda c: (c.month or 0, c.weekday or 0))
    by_grain["month"].sort(key=lambda c: c.month or 0)
    by_grain["weekday"].sort(key=lambda c: c.weekday or 0)
    by_grain["year"].sort(key=lambda c: c.year or 0)
    return Seasonality(genre=genre, **by_grain)


@router.get("/api/launch-curve", response_model=LaunchCurve)
def launch_curve(
    response: Response,
    genre: str = Query("__all__"),
) -> LaunchCurve:
    """Cached + Cache-Control'd for the same reason as /api/seasonality above."""
    response.headers["Cache-Control"] = response_cache.CACHE_CONTROL
    return response_cache.get_or_compute("launch_curve", (genre,), lambda: _launch_curve(genre))


def _launch_curve(genre: str) -> LaunchCurve:
    rows = analytics_db.query(
        "SELECT day, mean_cum_fraction, median_cum_fraction, n_games "
        "FROM mart_launch_curve WHERE genre = ? ORDER BY day",
        [genre],
    )
    return LaunchCurve(genre=genre, points=[LaunchCurvePoint(**r) for r in rows])
