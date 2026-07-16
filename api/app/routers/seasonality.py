from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import analytics_db
from ..auth import get_current_org
from ..models import Org
from ..schemas import LaunchCurve, LaunchCurvePoint, Seasonality, SeasonalityCell

router = APIRouter(tags=["timing"])

_SEASON_COLS = (
    "genre, month, weekday, year, n_releases, n_scored, "
    "median_rev, median_reviews, median_positive_ratio"
)


@router.get("/api/seasonality", response_model=Seasonality)
def seasonality(
    genre: str = Query("__all__"),
    org: Org = Depends(get_current_org),
) -> Seasonality:
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
    genre: str = Query("__all__"),
    org: Org = Depends(get_current_org),
) -> LaunchCurve:
    rows = analytics_db.query(
        "SELECT day, mean_cum_fraction, median_cum_fraction, n_games "
        "FROM mart_launch_curve WHERE genre = ? ORDER BY day",
        [genre],
    )
    return LaunchCurve(genre=genre, points=[LaunchCurvePoint(**r) for r in rows])
