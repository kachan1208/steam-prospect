"""Niche Finder endpoints over mart_niche and its satellite marts.

Resurrected 2026-08 (the original was removed in the "trim to four surfaces" cut,
e777cb2) and upgraded for everything the marts have grown since:

- v2 scoring: opportunity_v2 (growth-gated), decline_gate, entrant_ratio,
  solo_viability, tier — with the same interpretation rules the MCP find_niches tool
  documents (low competition + shrinking pipeline = decline, not opportunity).
- Absolute size: total_owners / total_rev / total_reviews / market_size.
- Live players: total_players_now / players_trend_7d_pct / players_coverage on every
  row, plus the per-niche daily series (mart_niche_players) in the detail response.
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
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from .. import analytics_db
from ..schemas import (
    HistBucket,
    NicheDetail,
    NicheGame,
    NicheList,
    NichePlayers,
    NichePlayersPoint,
    NicheRow,
    NicheTheme,
    TrendPoint,
)

router = APIRouter(prefix="/api/niches", tags=["niches"])

_TIERS = {"micro", "theme", "umbrella", "meta"}

# Columns a client is allowed to sort on (prevents SQL injection via `sort`).
SORTABLE = {
    "key",
    "opportunity", "opportunity_v2", "decline_gate", "entrant_ratio", "solo_viability",
    "demand", "competition", "quality_gap",
    "market_size", "total_owners", "total_rev", "total_reviews",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity",
    "n_games", "n_recent", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "self_pub_share", "winner_concentration",
    "total_players_now", "players_trend_7d_pct", "players_coverage",
}
_PLAYERS_COLS = ["total_players_now", "players_trend_7d_pct", "players_coverage"]

# Ordered base column list (single source of truth for SELECT + CSV header); the players
# columns are appended when the mart carries them.
_BASE_COLS = [
    "dimension", "key", "win", "min_reviews", "n_games", "n_recent",
    "median_rev", "p25_rev", "p75_rev", "median_reviews", "median_price",
    "median_positive_ratio", "median_owners",
    "total_owners", "total_rev", "total_reviews", "market_size",
    "recent_velocity",
    "self_pub_share", "winner_concentration", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "demand", "competition", "quality_gap",
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


def _cols() -> list[str]:
    return _BASE_COLS + (_PLAYERS_COLS if _has_players() else [])


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
        where += " AND key ILIKE ?"
        params.append(f"%{q}%")
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
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> NicheList:
    if sort not in SORTABLE:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTABLE)}")
    if sort in _PLAYERS_COLS and not _has_players():
        raise HTTPException(
            status_code=503,
            detail="mart_niche predates the live-player columns — rebuild the marts (task etl).",
        )
    tiers_arg = tiers if tiers else None  # "" (explicit empty) = no tier filter
    where, params = _build_filters(
        dimension, window, min_reviews, q, tiers_arg, min_total_players, min_total_owners
    )
    total = analytics_db.scalar(f"SELECT COUNT(*) FROM mart_niche {where}", params)
    rows = _niche_query(where, params, sort, order, limit, offset)
    return NicheList(
        items=[_row_to_niche(r) for r in rows],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


@router.get("/{dimension}/{key:path}", response_model=NicheDetail)
def niche_detail(dimension: str, key: str) -> NicheDetail:
    if dimension not in ("tag", "genre"):
        raise HTTPException(status_code=400, detail="dimension must be tag or genre")

    variants = _niche_query(
        "WHERE dimension = ? AND key = ?", [dimension, key], "min_reviews", "asc", 8, None
    )
    if not variants:
        raise HTTPException(status_code=404, detail=f"niche not found: {dimension}/{key}")
    variants.sort(key=lambda v: (v["win"], v["min_reviews"]))

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
        head = variants[0]
        players = NichePlayers(
            total_players_now=head.get("total_players_now"),
            players_trend_7d_pct=head.get("players_trend_7d_pct"),
            players_coverage=head.get("players_coverage"),
            n_games_panel=panel,
            series=[NichePlayersPoint(**s) for s in series],
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
):
    if sort not in SORTABLE:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTABLE)}")
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
    buf.seek(0)
    filename = f"niches_{dimension}_{window}_mr{min_reviews}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
