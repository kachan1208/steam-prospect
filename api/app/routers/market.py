from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import analytics_db, benchmarks
from ..auth import get_current_org
from ..models import Org
from ..schemas import (
    BenchmarkMark,
    BoxleiterRow,
    HistBucket,
    MarketDistribution,
    PercentilePoint,
    TierRow,
)

router = APIRouter(prefix="/api/market", tags=["market"])

_METRICS = {"revenue", "reviews", "owners", "price"}


def _marks_for(metric: str) -> list[BenchmarkMark]:
    if metric == "revenue":
        return [BenchmarkMark(**m) for m in benchmarks.REVENUE_BENCHMARK_MARKS]
    if metric == "owners":
        return [
            BenchmarkMark(label="Hobby (2K)", value=2_000, cite="dev tier floor"),
            BenchmarkMark(label="Small (20K)", value=20_000, cite="dev tier floor"),
            BenchmarkMark(label="Middle (200K)", value=200_000, cite="dev tier floor"),
            BenchmarkMark(label="Triple-I (1M)", value=1_000_000, cite="dev tier floor"),
        ]
    if metric == "price":
        return [
            BenchmarkMark(label="$9.99", value=9.99, cite="common indie price point"),
            BenchmarkMark(label="$19.99", value=19.99, cite="premium indie price point"),
        ]
    return [
        BenchmarkMark(label="1,000 reviews", value=1_000,
                      cite="≈ $150K+ / genre-dependent"),
    ]


@router.get("/distribution", response_model=MarketDistribution)
def distribution(
    metric: str = Query("revenue"),
    genre: str = Query("__all__"),
    window: str = Query("all", pattern="^(all|24m)$"),
    org: Org = Depends(get_current_org),
) -> MarketDistribution:
    if metric not in _METRICS:
        metric = "revenue"
    buckets = analytics_db.query(
        "SELECT bucket_index, x_min, x_max, count FROM mart_market_hist "
        "WHERE metric = ? AND genre = ? AND win = ? ORDER BY bucket_index",
        [metric, genre, window],
    )
    pcts = analytics_db.query(
        "SELECT pctile, value, n FROM mart_market_pct "
        "WHERE metric = ? AND genre = ? AND win = ? ORDER BY value",
        [metric, genre, window],
    )
    n = int(pcts[0]["n"]) if pcts else 0
    return MarketDistribution(
        metric=metric,
        genre=genre,
        window=window,
        n=n,
        buckets=[HistBucket(**b) for b in buckets],
        percentiles=[PercentilePoint(pctile=p["pctile"], value=p["value"]) for p in pcts],
        benchmark_marks=_marks_for(metric),
    )


@router.get("/benchmarks")
def market_benchmarks(org: Org = Depends(get_current_org)) -> dict:
    meta = {r["key"]: r["value"] for r in analytics_db.query("SELECT key, value FROM mart_meta")}
    boxleiter = analytics_db.query(
        "SELECT genre, n, owners_per_review_median, owners_per_review_p25, "
        "owners_per_review_p75, slope, intercept FROM mart_market_boxleiter ORDER BY n DESC"
    )
    tiers = analytics_db.query(
        "SELECT tier, tier_order, count, pct FROM mart_market_tiers ORDER BY tier_order"
    )

    def _f(key: str) -> float | None:
        v = meta.get(key)
        return float(v) if v not in (None, "") else None

    return {
        "cited": benchmarks.as_dict(),
        "computed": {
            # our catalog figures, with the population made explicit
            "median_revenue_scored": _f("global_median_revenue"),
            "median_revenue_paid": _f("global_median_revenue_paid"),
            "boxleiter_owners_per_review_slope": _f("boxleiter_owners_per_review"),
            "pct_over_100k_scored": _f("pct_over_100k"),
            "n_games_total": _f("n_games_total"),
            "n_games_scored": _f("n_games_scored"),
            "population_note": (
                "computed medians/pct are Boxleiter gross over games with >=10 reviews "
                "(paid = price>0, >=1 review); cited $249/8.5% are first-year/net over ALL releases"
            ),
        },
        "boxleiter_by_genre": [BoxleiterRow(**b).model_dump() for b in boxleiter],
        "tiers": [TierRow(**t).model_dump() for t in tiers],
    }
