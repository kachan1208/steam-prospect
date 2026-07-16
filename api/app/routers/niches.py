from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from .. import analytics_db
from ..auth import get_current_org, get_entitlements
from ..entitlements import Entitlements
from ..models import Org
from ..schemas import (
    HistBucket,
    NicheDetail,
    NicheGame,
    NicheList,
    NicheRow,
    TrendPoint,
)

router = APIRouter(prefix="/api/niches", tags=["niches"])

# Columns a client is allowed to sort on (prevents SQL injection via `sort`).
SORTABLE = {
    "key",
    "opportunity", "demand", "competition", "quality_gap",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity",
    "n_games", "n_recent", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "self_pub_share", "winner_concentration",
}

# Ordered column list (single source of truth for SELECT + CSV header).
_COLS = [
    "dimension", "key", "win", "min_reviews", "n_games", "n_recent",
    "median_rev", "p25_rev", "p75_rev", "median_reviews", "median_price",
    "median_positive_ratio", "median_owners", "recent_velocity",
    "self_pub_share", "winner_concentration", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "demand", "competition", "quality_gap", "opportunity",
]
_SELECT_COLS = ", ".join(_COLS)
# CSV field order with the reserved column renamed for JSON/CSV friendliness.
_CSV_FIELDS = ["window" if c == "win" else c for c in _COLS]


def _row_to_niche(r: dict) -> NicheRow:
    r = dict(r)
    r["window"] = r.pop("win")
    return NicheRow(**r)


@router.get("", response_model=NicheList)
def list_niches(
    dimension: str = Query("tag", pattern="^(tag|genre)$"),
    window: str = Query("all", pattern="^(all|24m)$"),
    min_reviews: int = Query(10),
    sort: str = Query("opportunity"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    q: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    org: Org = Depends(get_current_org),
) -> NicheList:
    if sort not in SORTABLE:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTABLE)}")

    where = "WHERE dimension = ? AND win = ? AND min_reviews = ?"
    params: list = [dimension, window, min_reviews]
    if q:
        where += " AND key ILIKE ?"
        params.append(f"%{q}%")

    total = analytics_db.scalar(f"SELECT COUNT(*) FROM mart_niche {where}", params)
    rows = analytics_db.query(
        f"SELECT {_SELECT_COLS} FROM mart_niche {where} "
        f"ORDER BY {sort} {order.upper()} NULLS LAST, n_games DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    )
    return NicheList(
        items=[_row_to_niche(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/{dimension}/{key:path}", response_model=NicheDetail)
def niche_detail(
    dimension: str,
    key: str,
    org: Org = Depends(get_current_org),
) -> NicheDetail:
    if dimension not in ("tag", "genre"):
        raise HTTPException(status_code=400, detail="dimension must be tag or genre")

    variants = analytics_db.query(
        f"SELECT {_SELECT_COLS} FROM mart_niche WHERE dimension = ? AND key = ? "
        "ORDER BY win, min_reviews",
        [dimension, key],
    )
    if not variants:
        raise HTTPException(status_code=404, detail=f"niche not found: {dimension}/{key}")

    trend = analytics_db.query(
        "SELECT year, n_releases, n_scored, median_rev FROM mart_niche_trend "
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

    # Prefer the all/10 variant for the headline hit-rate numbers.
    headline = next((v for v in variants if v["win"] == "all" and v["min_reviews"] == 10), variants[0])
    return NicheDetail(
        dimension=dimension,
        key=key,
        variants=[_row_to_niche(v) for v in variants],
        saturation_trend=[TrendPoint(**t) for t in trend],
        revenue_histogram=[HistBucket(**h) for h in hist],
        representative_games=[NicheGame(**g) for g in games],
        hit_rates={
            "hit_rate_200k": headline["hit_rate_200k"],
            "hit_rate_500k": headline["hit_rate_500k"],
            "median_rev": headline["median_rev"],
            "n_games": headline["n_games"],
            "winner_concentration": headline["winner_concentration"],
        },
    )


@router.get("/export.csv")  # note: also mounted at /api/export/niches.csv in main
def export_csv(
    dimension: str = Query("tag", pattern="^(tag|genre)$"),
    window: str = Query("all", pattern="^(all|24m)$"),
    min_reviews: int = Query(10),
    sort: str = Query("opportunity"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    q: str | None = Query(None),
    limit: int = Query(1000, ge=1, le=5000),
    org: Org = Depends(get_current_org),
    ent: Entitlements = Depends(get_entitlements),
):
    if not ent.can_export:
        raise HTTPException(status_code=402, detail="Export not included in your plan.")
    if sort not in SORTABLE:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTABLE)}")

    where = "WHERE dimension = ? AND win = ? AND min_reviews = ?"
    params: list = [dimension, window, min_reviews]
    if q:
        where += " AND key ILIKE ?"
        params.append(f"%{q}%")
    rows = analytics_db.query(
        f"SELECT {_SELECT_COLS} FROM mart_niche {where} "
        f"ORDER BY {sort} {order.upper()} NULLS LAST LIMIT ?",
        params + [limit],
    )

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=_CSV_FIELDS)
    writer.writeheader()
    for r in rows:
        r = dict(r)
        r["window"] = r.pop("win")
        writer.writerow(r)
    buf.seek(0)
    filename = f"niches_{dimension}_{window}_mr{min_reviews}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
