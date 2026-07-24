"""Dev-log inputs API — the org's own marketing log, plus a read-only wishlist benchmark.

Mirrors the analytics-read half of the old watchlist.py: reads (mart_game, mart_niche) come
from the read-only DuckDB via `analytics_db`; the dev-authored marketing events are control-
plane SQLAlchemy writes scoped to the caller's org. Every appid a client sends is validated
against mart_game so the log can only attach to a real, known game.

Wishlist goals and milestone history used to be control-plane writes here too
(WishlistGoal/WishlistMilestone) — the minimal-tool trim moved that side of the Dev Log to
browser localStorage only (see web/src/pages/DevLog.tsx), so the benchmark endpoint below is
now purely read-only: it takes an appid and returns a heuristic suggested target with its
reasoning, no control-plane read or write at all.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import analytics_db
from ..auth import get_current_org
from ..control_db import get_db
from ..input_models import MarketingEvent
from ..models import Org
from typing import Literal, Optional

router = APIRouter(prefix="/api/inputs", tags=["inputs"])

EventKind = Literal["trailer", "festival", "press", "update", "other"]

# --- wishlist benchmark heuristics (all rough rules of thumb, surfaced honestly) ----------
# ~7k wishlists is the widely-cited "enough to get noticed at launch" bar (Steam's
# 'Popular Upcoming' momentum). It is a rule of thumb, not a guarantee.
WISHLIST_VISIBILITY_FLOOR = 7_000
# A very rough wishlists-per-owner ratio used to turn a genre's median *owner* count into a
# ballpark wishlist figure. Owner estimates themselves are coarse Boxleiter buckets, so this
# is a soft signal, never a promise.
WL_PER_OWNER = 0.2


# ---- Pydantic models --------------------------------------------------------------------
class MarketingEventIn(BaseModel):
    appid: int
    event_date: date
    kind: EventKind
    note: Optional[str] = None


class MarketingEventOut(BaseModel):
    id: int
    appid: int
    event_date: str
    kind: str
    note: Optional[str] = None
    created_at: str


class WishlistBenchmarkOut(BaseModel):
    """A suggested wishlist target for a game plus the (heuristic) reasoning behind it."""

    appid: int
    primary_genre: Optional[str] = None
    suggested_target: int
    basis: list[str]  # human-readable, honest explanation of how the number was derived


# ---- helpers ----------------------------------------------------------------------------
def _require_game(appid: int) -> None:
    """404 unless the appid exists in the analytics catalog (mart_game)."""
    exists = analytics_db.scalar("SELECT COUNT(*) FROM mart_game WHERE appid = ?", [appid])
    if not exists:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")


def _event_out(r: MarketingEvent) -> MarketingEventOut:
    return MarketingEventOut(
        id=r.id,
        appid=r.appid,
        event_date=str(r.event_date),
        kind=r.kind,
        note=r.note,
        created_at=r.created_at.isoformat() if r.created_at else "",
    )


# ---- marketing events -------------------------------------------------------------------
@router.get("/events", response_model=list[MarketingEventOut])
def list_events(
    appid: int = Query(..., description="Game to list the marketing log for."),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _require_game(appid)
    rows = db.scalars(
        select(MarketingEvent)
        .where(MarketingEvent.org_id == org.id, MarketingEvent.appid == appid)
        .order_by(MarketingEvent.event_date.desc(), MarketingEvent.id.desc())
    ).all()
    return [_event_out(r) for r in rows]


@router.post("/events", response_model=MarketingEventOut, status_code=201)
def add_event(
    payload: MarketingEventIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _require_game(payload.appid)
    note = payload.note.strip() if payload.note else None
    row = MarketingEvent(
        org_id=org.id,
        appid=payload.appid,
        event_date=payload.event_date.isoformat(),
        kind=payload.kind,
        note=note or None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _event_out(row)


@router.delete("/events/{event_id}", status_code=204)
def delete_event(
    event_id: int,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    row = db.scalar(
        select(MarketingEvent).where(
            MarketingEvent.id == event_id, MarketingEvent.org_id == org.id
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Marketing event not found.")
    db.delete(row)
    db.commit()


# ---- wishlist benchmark (read-only) ------------------------------------------------------
@router.get("/wishlist/benchmark", response_model=WishlistBenchmarkOut)
def wishlist_benchmark(
    appid: int = Query(..., description="Game to suggest a wishlist target for."),
    org: Org = Depends(get_current_org),
):
    """A *heuristic* suggested wishlist target for a game, with its reasoning laid bare.

    Two honest reference points are combined and the more demanding one is taken:
      * a fixed ~7,000-wishlist "gets noticed at launch" floor (rule of thumb), and
      * a genre-informed figure — the median lifetime owners of established titles in the
        game's primary genre, scaled by a rough ~0.2 wishlist-per-owner ratio.
    Both are ballparks off noisy owner estimates, not guarantees; the `basis` strings say so.
    Purely read-only against the analytics marts — the caller's own wishlist goal/history now
    lives in browser localStorage, so this endpoint has nothing of the org's to read or write.
    """
    _require_game(appid)
    game = (
        analytics_db.query_one(
            "SELECT name, primary_genre FROM mart_game WHERE appid = ?", [appid]
        )
        or {}
    )
    genre = game.get("primary_genre")

    basis: list[str] = [
        f"Floor: ~{WISHLIST_VISIBILITY_FLOOR:,} wishlists is a commonly-cited bar for "
        "getting noticed at launch (enough momentum for Steam's 'Popular Upcoming'). "
        "A rule of thumb, not a guarantee."
    ]

    genre_estimate = 0
    if genre:
        niche = analytics_db.query_one(
            "SELECT median_owners, n_games FROM mart_niche "
            "WHERE dimension = 'genre' AND key = ? AND win = 'all' AND min_reviews = 50",
            [genre],
        )
        median_owners = (niche or {}).get("median_owners")
        if median_owners:
            mo = float(median_owners)
            n_games = int((niche or {}).get("n_games") or 0)
            genre_estimate = int(round(mo * WL_PER_OWNER))
            basis.append(
                f"Genre signal: median lifetime owners for {genre} is ~{mo:,.0f} across "
                f"{n_games:,} established titles (≥50 reviews); at a rough {WL_PER_OWNER:g} "
                f"wishlist-per-owner ratio that implies ~{genre_estimate:,} wishlists. "
                "Heuristic off coarse owner estimates."
            )
        else:
            basis.append(
                f"Genre signal: no reliable owner benchmark for {genre}; leaning on the "
                "visibility floor alone."
            )
    else:
        basis.append(
            "Genre signal: this game has no primary genre in the catalog; leaning on the "
            "visibility floor alone."
        )

    # Take the more demanding reference point, then round to a clean target.
    suggested = max(WISHLIST_VISIBILITY_FLOOR, genre_estimate)
    suggested = int(round(suggested / 500.0) * 500)

    return WishlistBenchmarkOut(
        appid=appid,
        primary_genre=genre,
        suggested_target=suggested,
        basis=basis,
    )
