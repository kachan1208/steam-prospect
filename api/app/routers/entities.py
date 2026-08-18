"""Developer/publisher entity profiles over mart_entity / mart_entity_games.

The ETL normalizes mart_game's comma-joined `developers` / `publishers` strings into one
row per (role, name) in `mart_entity` (career aggregates) plus a (role, name, appid, seq)
map in `mart_entity_games` (seq 1 = the entity's earliest release). This router only reads
those two marts and JOINs mart_game for per-game display fields — no string splitting
happens here (the web client mirrors the ETL's suffix-remerge rule for link building only;
see web/src/lib/entities.ts).

Entity names contain commas, slashes, and unicode ("CAPCOM Co., Ltd.", "方块游戏"), so both
endpoints take the name as a QUERY parameter, never a path segment.

Unlike the older marts, mart_entity may be missing in prod between a deploy and the next
nightly ETL run — every query is wrapped so that case surfaces as a clear 503 ("data
refreshing"), not a raw duckdb.CatalogException 500.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

import duckdb
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import analytics_db

router = APIRouter(prefix="/api/entities", tags=["entities"])

Role = Literal["developer", "publisher"]

_MARTS_MISSING_DETAIL = (
    "entity data is refreshing — the developer/publisher marts haven't been built yet "
    "(mart_entity/mart_entity_games missing; they appear after the next ETL run)"
)
_DB_MISSING_DETAIL = (
    "analytics database not available — the ETL hasn't produced current.duckdb yet"
)


def _q(sql: str, params: list | None = None) -> list[dict]:
    """analytics_db.query with the pre-ETL failure modes mapped to a clean 503.

    Two distinct cases: the whole analytics DB absent (analytics_db.init failed at startup —
    main.py deliberately keeps the app up, see its lifespan), and the DB present but built
    by an ETL that predates the entity marts (CatalogException on the missing table)."""
    if not analytics_db.is_ready():
        raise HTTPException(status_code=503, detail=_DB_MISSING_DETAIL)
    try:
        return analytics_db.query(sql, params)
    except duckdb.CatalogException:
        raise HTTPException(status_code=503, detail=_MARTS_MISSING_DETAIL)


# All of mart_entity, in contract order (see etl/marts — the mart agent's schema contract).
_ENTITY_COLS = (
    "role, name, n_games, first_release_year, last_release_year, n_recent_24m, "
    "total_rev, median_rev, hit_rate_200k, median_reviews, median_positive_ratio, "
    "self_published_share, top_genres, n_partners"
)

# Compact subset for search results (list rows, not the full career profile).
# n_recent_24m rides along so browse views (the Studios page) can show an honest
# "still shipping?" Active signal without a per-row profile fetch.
_SEARCH_COLS = (
    "role, name, n_games, first_release_year, last_release_year, n_recent_24m, "
    "total_rev, median_rev, hit_rate_200k, top_genres"
)


@lru_cache(maxsize=1)
def _has_p90() -> bool:
    """Whether the mart carries p90_rev (added 2026-08-14). Gated so the app still boots
    against an older mart — same capability idiom as games.py::_has_name_lower."""
    if not analytics_db.is_ready():
        return False
    return bool(
        analytics_db.query(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'mart_entity' AND column_name = 'p90_rev'"
        )
    )


@lru_cache(maxsize=1)
def _has_x_handle() -> bool:
    """Whether the mart carries x_handle — the entity's majority-vote X handle across its
    games' mart_game.dev_x_handle (official links harvested from the games' own store
    pages / dev websites, so it may be a game's, the studio's, or the dev's personal
    account). Gated so the app still boots against an older mart — same capability idiom
    as _has_p90."""
    if not analytics_db.is_ready():
        return False
    return bool(
        analytics_db.query(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'mart_entity' AND column_name = 'x_handle'"
        )
    )


def _entity_cols() -> str:
    return (
        _ENTITY_COLS
        + (", p90_rev" if _has_p90() else "")
        + (", x_handle" if _has_x_handle() else "")
    )


def _search_cols() -> str:
    return _SEARCH_COLS + (", p90_rev" if _has_p90() else "")


class EntitySearchRow(BaseModel):
    role: Role
    name: str
    n_games: int
    first_release_year: int | None
    last_release_year: int | None
    n_recent_24m: int | None
    total_rev: float | None
    median_rev: float | None
    p90_rev: float | None = None  # absent on marts that predate it
    hit_rate_200k: float | None
    top_genres: list[str]


class EntitySearchList(BaseModel):
    items: list[EntitySearchRow]
    total: int
    limit: int


class EntitySummary(BaseModel):
    role: Role
    name: str
    n_games: int
    first_release_year: int | None
    last_release_year: int | None
    n_recent_24m: int | None
    total_rev: float | None
    median_rev: float | None
    p90_rev: float | None = None  # absent on marts that predate it
    hit_rate_200k: float | None
    median_reviews: float | None
    median_positive_ratio: float | None
    self_published_share: float | None
    top_genres: list[str]
    # Distinct co-credited entities of the OTHER role. NULL for developers by contract.
    n_partners: int | None
    # Majority-vote X handle across the entity's games' dev_x_handle — an official link
    # from the games' own store pages / dev websites, which may be a game's, the studio's,
    # or the dev's personal account (no X-side verification). None = none found / socials
    # never fetched / mart predates the socials ETL.
    x_handle: str | None = None


class EntityGameRow(BaseModel):
    appid: int
    seq: int  # 1 = the entity's earliest release
    # LEFT JOIN mart_game — all display fields nullable in case the map carries an appid
    # the game mart dropped (delisted between ETL steps).
    name: str | None
    release_year: int | None
    release_date: str | None
    price_initial: float | None
    total_reviews: int | None
    positive_ratio: float | None
    est_rev_reviews: float | None
    primary_genre: str | None
    header_image: str | None


class EntityProfileResponse(BaseModel):
    entity: EntitySummary
    games: list[EntityGameRow]  # ordered by seq ASC (release order)


@router.get("/search", response_model=EntitySearchList)
def search_entities(
    q: str | None = Query(None, description="Case-insensitive substring of the entity name. "
                          "Omit to BROWSE: top entities by total est. revenue."),
    role: Role | None = Query(None, description="Restrict to developers or publishers."),
    min_games: int = Query(1, ge=1, description="Floor on n_games — browse views pass e.g. 3 "
                           "so single-release entities don't drown the ranking."),
    limit: int = Query(20, ge=1, le=100),
) -> EntitySearchList:
    where, params = ["n_games >= ?"], [min_games]
    if q:
        where.append("name ILIKE ?")
        params.append(f"%{q}%")
    if role:
        where.append("role = ?")
        params.append(role)
    where_sql = "WHERE " + " AND ".join(where)

    total_rows = _q(f"SELECT COUNT(*) AS n FROM mart_entity {where_sql}", params)
    rows = _q(
        f"SELECT {_search_cols()} FROM mart_entity {where_sql} "
        "ORDER BY total_rev DESC NULLS LAST, n_games DESC, name ASC LIMIT ?",
        params + [limit],
    )
    return EntitySearchList(
        items=[EntitySearchRow(**{**r, "top_genres": list(r["top_genres"] or [])}) for r in rows],
        total=int(total_rows[0]["n"] or 0),
        limit=limit,
    )


@router.get("/profile", response_model=EntityProfileResponse)
def entity_profile(
    role: Role = Query(...),
    name: str = Query(..., min_length=1, description="Exact entity name (query param — names contain slashes/unicode)."),
) -> EntityProfileResponse:
    rows = _q(f"SELECT {_entity_cols()} FROM mart_entity WHERE role = ? AND name = ?", [role, name])
    if not rows:
        # Structured 404: carry up to 5 near-miss names so the client can render
        # "did you mean" links instead of a dead end.
        suggestions = _q(
            "SELECT name FROM mart_entity WHERE role = ? AND name ILIKE ? "
            "ORDER BY total_rev DESC NULLS LAST, n_games DESC LIMIT 5",
            [role, f"%{name}%"],
        )
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"{role} not found: {name}",
                "suggestions": [s["name"] for s in suggestions],
            },
        )
    entity = rows[0]

    games = _q(
        """
        SELECT m.appid, m.seq, g.name, g.release_year, g.release_date, g.price_initial,
            g.total_reviews, g.positive_ratio, g.est_rev_reviews, g.primary_genre,
            g.header_image
        FROM mart_entity_games m
        LEFT JOIN mart_game g ON g.appid = m.appid
        WHERE m.role = ? AND m.name = ?
        ORDER BY m.seq ASC
        """,
        [role, name],
    )
    return EntityProfileResponse(
        entity=EntitySummary(**{**entity, "top_genres": list(entity["top_genres"] or [])}),
        games=[EntityGameRow(**g) for g in games],
    )
