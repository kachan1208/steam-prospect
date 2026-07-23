"""Dev-log inputs API — the org's own marketing log + manual wishlist/follower milestones.

Mirrors watchlist.py: analytics reads (mart_game) come from the read-only DuckDB via
`analytics_db`; the dev-authored rows are control-plane SQLAlchemy writes scoped to the
caller's org. Every appid a client sends is validated against mart_game so the log can
only attach to a real, known game.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import analytics_db
from ..auth import get_current_org
from ..control_db import get_db
from ..input_models import MarketingEvent, WishlistGoal, WishlistMilestone
from ..models import Org, Watchlist
from typing import Literal, Optional

router = APIRouter(prefix="/api/inputs", tags=["inputs"])

_WATCH_KIND = "game"
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
class GamePickItem(BaseModel):
    """One watched game, enriched with display fields, for the Dev Log's game picker."""

    appid: int
    name: Optional[str] = None
    header_image: Optional[str] = None
    primary_genre: Optional[str] = None


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


class WishlistMilestoneIn(BaseModel):
    appid: int
    on_date: date
    wishlists: Optional[int] = Field(default=None, ge=0)
    followers: Optional[int] = Field(default=None, ge=0)


class WishlistMilestoneOut(BaseModel):
    id: int
    appid: int
    on_date: str
    wishlists: Optional[int] = None
    followers: Optional[int] = None
    source: str
    created_at: str


class WishlistBenchmarkOut(BaseModel):
    """A suggested wishlist target for a game plus the (heuristic) reasoning behind it."""

    appid: int
    primary_genre: Optional[str] = None
    suggested_target: int
    basis: list[str]  # human-readable, honest explanation of how the number was derived
    latest_wishlists: Optional[int] = None
    pct_to_target: Optional[float] = None  # latest / suggested_target, as a percentage


class WishlistGoalIn(BaseModel):
    appid: int
    target: int = Field(..., gt=0, le=100_000_000)
    note: Optional[str] = None


class WishlistGoalOut(BaseModel):
    appid: int
    target: int
    note: Optional[str] = None
    updated_at: str


class WishlistImportIn(BaseModel):
    appid: int
    csv: str = Field(..., description="Lines of 'YYYY-MM-DD,wishlists[,followers]'.")


class WishlistImportOut(BaseModel):
    imported: int
    skipped: int
    errors: list[str] = []  # first handful of reasons rows were skipped, for the UI


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


def _milestone_out(r: WishlistMilestone) -> WishlistMilestoneOut:
    return WishlistMilestoneOut(
        id=r.id,
        appid=r.appid,
        on_date=str(r.on_date),
        wishlists=r.wishlists,
        followers=r.followers,
        source=r.source,
        created_at=r.created_at.isoformat() if r.created_at else "",
    )


def _goal_out(r: WishlistGoal) -> WishlistGoalOut:
    return WishlistGoalOut(
        appid=r.appid,
        target=r.target,
        note=r.note,
        updated_at=r.updated_at.isoformat() if r.updated_at else "",
    )


def _latest_wishlist_count(db: Session, org_id: int, appid: int) -> Optional[int]:
    """Most recently dated wishlist count the org has recorded for a game (None if none)."""
    row = db.scalars(
        select(WishlistMilestone)
        .where(
            WishlistMilestone.org_id == org_id,
            WishlistMilestone.appid == appid,
            WishlistMilestone.wishlists.is_not(None),
        )
        .order_by(WishlistMilestone.on_date.desc(), WishlistMilestone.id.desc())
    ).first()
    return row.wishlists if row else None


def _parse_iso_date(s: str) -> Optional[str]:
    """Return a normalised 'YYYY-MM-DD' string, or None if the token isn't a valid date."""
    try:
        return date.fromisoformat(s.strip()).isoformat()
    except ValueError:
        return None


def _parse_count(s: str) -> Optional[int]:
    """Parse a non-negative integer count, tolerating '1,200' and '1200.0'; None if invalid."""
    t = s.strip().replace(",", "").replace("_", "")
    if t == "":
        return None
    try:
        n = int(float(t))
    except ValueError:
        return None
    return n if n >= 0 else None


# ---- game picker ------------------------------------------------------------------------
@router.get("/games", response_model=list[GamePickItem])
def list_games(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    """The org's watched games (Watchlist kind='game'), enriched from mart_game so the Dev
    Log UI has a picker. Rows whose game has since dropped out of the catalog are skipped."""
    rows = db.scalars(
        select(Watchlist)
        .where(Watchlist.org_id == org.id, Watchlist.kind == _WATCH_KIND)
        .order_by(Watchlist.created_at.desc())
    ).all()
    out: list[GamePickItem] = []
    for w in rows:
        try:
            appid = int(w.key)
        except (TypeError, ValueError):
            continue
        game = (
            analytics_db.query_one(
                "SELECT name, header_image, primary_genre FROM mart_game WHERE appid = ?",
                [appid],
            )
            or {}
        )
        if not game:
            continue
        out.append(
            GamePickItem(
                appid=appid,
                name=game.get("name"),
                header_image=game.get("header_image"),
                primary_genre=game.get("primary_genre"),
            )
        )
    return out


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


# ---- wishlist / follower milestones -----------------------------------------------------
@router.get("/wishlist", response_model=list[WishlistMilestoneOut])
def list_wishlist(
    appid: int = Query(..., description="Game to list wishlist milestones for."),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _require_game(appid)
    rows = db.scalars(
        select(WishlistMilestone)
        .where(WishlistMilestone.org_id == org.id, WishlistMilestone.appid == appid)
        .order_by(WishlistMilestone.on_date.asc(), WishlistMilestone.id.asc())
    ).all()
    return [_milestone_out(r) for r in rows]


@router.post("/wishlist", response_model=WishlistMilestoneOut, status_code=201)
def add_wishlist(
    payload: WishlistMilestoneIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _require_game(payload.appid)
    if payload.wishlists is None and payload.followers is None:
        raise HTTPException(
            status_code=422, detail="Provide at least a wishlist or follower count."
        )
    row = WishlistMilestone(
        org_id=org.id,
        appid=payload.appid,
        on_date=payload.on_date.isoformat(),
        wishlists=payload.wishlists,
        followers=payload.followers,
        source="manual",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _milestone_out(row)


@router.delete("/wishlist/{milestone_id:int}", status_code=204)
def delete_wishlist(
    milestone_id: int,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    row = db.scalar(
        select(WishlistMilestone).where(
            WishlistMilestone.id == milestone_id, WishlistMilestone.org_id == org.id
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Wishlist milestone not found.")
    db.delete(row)
    db.commit()


# ---- wishlist benchmark / goal ----------------------------------------------------------
@router.get("/wishlist/benchmark", response_model=WishlistBenchmarkOut)
def wishlist_benchmark(
    appid: int = Query(..., description="Game to suggest a wishlist target for."),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    """A *heuristic* suggested wishlist target for a game, with its reasoning laid bare.

    Two honest reference points are combined and the more demanding one is taken:
      * a fixed ~7,000-wishlist "gets noticed at launch" floor (rule of thumb), and
      * a genre-informed figure — the median lifetime owners of established titles in the
        game's primary genre, scaled by a rough ~0.2 wishlist-per-owner ratio.
    Both are ballparks off noisy owner estimates, not guarantees; the `basis` strings say so.
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

    latest = _latest_wishlist_count(db, org.id, appid)
    if latest is not None:
        basis.append(f"Your latest recorded count: {latest:,} wishlists.")
        pct = round(100.0 * latest / suggested, 1) if suggested else None
    else:
        basis.append("No wishlist count recorded yet — add a milestone to track progress.")
        pct = None

    return WishlistBenchmarkOut(
        appid=appid,
        primary_genre=genre,
        suggested_target=suggested,
        basis=basis,
        latest_wishlists=latest,
        pct_to_target=pct,
    )


@router.get("/wishlist/goal", response_model=Optional[WishlistGoalOut])
def get_wishlist_goal(
    appid: int = Query(..., description="Game to fetch the saved wishlist goal for."),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    """The org's saved wishlist target for a game, or null if none has been set."""
    _require_game(appid)
    row = db.scalar(
        select(WishlistGoal).where(
            WishlistGoal.org_id == org.id, WishlistGoal.appid == appid
        )
    )
    return _goal_out(row) if row else None


@router.post("/wishlist/goal", response_model=WishlistGoalOut)
def set_wishlist_goal(
    payload: WishlistGoalIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    """Set (or replace) the org's wishlist target for a game. One goal per (org, appid)."""
    _require_game(payload.appid)
    note = payload.note.strip() if payload.note else None
    row = db.scalar(
        select(WishlistGoal).where(
            WishlistGoal.org_id == org.id, WishlistGoal.appid == payload.appid
        )
    )
    if row is None:
        row = WishlistGoal(
            org_id=org.id, appid=payload.appid, target=payload.target, note=note or None
        )
        db.add(row)
    else:
        row.target = payload.target
        row.note = note or None
    db.commit()
    db.refresh(row)
    return _goal_out(row)


@router.delete("/wishlist/goal", status_code=204)
def delete_wishlist_goal(
    appid: int = Query(..., description="Game to clear the wishlist goal for."),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    """Clear the saved goal so the UI falls back to the heuristic suggested target."""
    row = db.scalar(
        select(WishlistGoal).where(
            WishlistGoal.org_id == org.id, WishlistGoal.appid == appid
        )
    )
    if row is not None:
        db.delete(row)
        db.commit()


# ---- wishlist CSV import ----------------------------------------------------------------
@router.post("/wishlist/import", response_model=WishlistImportOut)
def import_wishlist(
    payload: WishlistImportIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    """Bulk-append wishlist milestones from pasted CSV: 'YYYY-MM-DD,wishlists[,followers]'.

    Blank lines and an optional header row (a first line whose first field isn't a date) are
    ignored; malformed rows are skipped and counted (with a reason) rather than failing the
    whole import. Imported rows are tagged source='csv'.
    """
    _require_game(payload.appid)

    imported = 0
    skipped = 0
    errors: list[str] = []
    to_add: list[WishlistMilestone] = []
    first_content = True

    for lineno, raw in enumerate(payload.csv.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue  # blank line — ignore, don't count
        parts = [p.strip() for p in line.split(",")]

        if first_content:
            first_content = False
            if _parse_iso_date(parts[0]) is None:
                continue  # treat a non-date first line as a header — ignore, don't count

        if len(parts) < 2:
            skipped += 1
            errors.append(f"line {lineno}: expected at least date,wishlists")
            continue

        on_date = _parse_iso_date(parts[0])
        if on_date is None:
            skipped += 1
            errors.append(f"line {lineno}: invalid date '{parts[0]}'")
            continue

        wishlists = _parse_count(parts[1])
        if wishlists is None:
            skipped += 1
            errors.append(f"line {lineno}: invalid wishlists '{parts[1]}'")
            continue

        followers = _parse_count(parts[2]) if len(parts) >= 3 else None

        to_add.append(
            WishlistMilestone(
                org_id=org.id,
                appid=payload.appid,
                on_date=on_date,
                wishlists=wishlists,
                followers=followers,
                source="csv",
            )
        )
        imported += 1

    if to_add:
        db.add_all(to_add)
        db.commit()

    return WishlistImportOut(imported=imported, skipped=skipped, errors=errors[:20])
