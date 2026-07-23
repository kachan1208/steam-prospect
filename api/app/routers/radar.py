"""Opportunity Radar — a curated calendar of indie-relevant Steam/marketing opportunities.

This surface is intentionally simple: no database, no analytics marts. It loads a
hand-curated seed of recurring events (Steam Next Fest, seasonal sales, festivals,
awards) from ``app/data/events_seed.json`` and, at request time, computes a
"days until" for each event's start date and submission deadline relative to *today*.

The GET / endpoint returns the events split into ``upcoming`` (starting today or
later, nearest first) and ``recent_past`` (started within the last 30 days), so a dev
can see what's coming and what just opened without ever missing a demo/submission
window. All future dates in the seed are best-guess approximations of recurring
events — see each event's ``note`` and the seed's ``_meta`` block.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import get_current_org
from ..models import Org

router = APIRouter(prefix="/api/radar", tags=["radar"])

# How far back a started event still counts as "recent" (days).
_RECENT_PAST_WINDOW_DAYS = 30

# Static, sensible prep checklists per event type — what a solo dev should have ready ahead of
# each kind of opportunity. Deliberately short and non-database (advice, not analytics).
_PREP_BY_TYPE: dict[str, list[str]] = {
    "next_fest": [
        "Playable demo built, bug-tested & performance-checked",
        "Capsule art + short trailer final",
        "Wishlist call-to-action / push scheduled",
        "Steam page live as 'Coming Soon', fest opted into (Steamworks)",
    ],
    "steam_sale": [
        "Decide your discount % (a first-ever discount can't be changed mid-sale)",
        "Refresh capsule art & short description",
        "Announce the sale to followers / wishlists / Discord",
    ],
    "festival": [
        "Submission assets ready (trailer, screenshots, build/press key)",
        "Check the submission deadline & opt-in form",
        "Prepare a press / streamer contact list for the day",
    ],
    "awards": [
        "Confirm eligibility & the right category",
        "Prepare submission build, materials & a short pitch",
        "Note the submission deadline — miss it and you wait a year",
        "Line up an announcement if you're selected/nominated",
    ],
}

# The type vocabulary the ?type= filter accepts (mirrors _PREP_BY_TYPE and the seed's types).
_EVENT_TYPES: tuple[str, ...] = tuple(_PREP_BY_TYPE.keys())

# Load the curated seed once at import. Located relative to THIS module so it works
# regardless of the process's working directory:
#   api/app/routers/radar.py -> parents[1] == api/app -> data/events_seed.json
_SEED_PATH = Path(__file__).resolve().parents[1] / "data" / "events_seed.json"


def _load_events() -> list[dict]:
    with _SEED_PATH.open(encoding="utf-8") as fh:
        payload = json.load(fh)
    return list(payload.get("events", []))


_EVENTS: list[dict] = _load_events()


class RadarEvent(BaseModel):
    id: str
    name: str
    type: str
    start_date: str
    end_date: str
    submission_deadline: Optional[str] = None
    url: Optional[str] = None
    note: str
    # Static per-type prep checklist (see _PREP_BY_TYPE) — what to have ready for this kind of event.
    prep: list[str] = []
    # Computed relative to today (negative = in the past).
    days_until_start: int
    days_until_end: int
    days_until_deadline: Optional[int] = None


class RadarTypeCount(BaseModel):
    type: str
    count: int


class RadarResponse(BaseModel):
    today: str
    # Echoes the ?type= filter that was applied (null = all types).
    applied_type: Optional[str] = None
    # Per-type counts over the visible (upcoming + recent) set BEFORE the type filter — drives the
    # UI's filter chips, so they stay stable regardless of which type is currently selected.
    available_types: list[RadarTypeCount] = []
    upcoming: list[RadarEvent]
    recent_past: list[RadarEvent]


def _parse(d: Optional[str]) -> Optional[date]:
    return date.fromisoformat(d) if d else None


def _to_event(raw: dict, today: date) -> RadarEvent:
    start = _parse(raw["start_date"])
    end = _parse(raw.get("end_date")) or start
    deadline = _parse(raw.get("submission_deadline"))
    return RadarEvent(
        id=raw["id"],
        name=raw["name"],
        type=raw["type"],
        start_date=raw["start_date"],
        end_date=raw.get("end_date") or raw["start_date"],
        submission_deadline=raw.get("submission_deadline"),
        url=raw.get("url"),
        note=raw["note"],
        prep=list(_PREP_BY_TYPE.get(raw["type"], [])),
        days_until_start=(start - today).days,
        days_until_end=(end - today).days,
        days_until_deadline=(deadline - today).days if deadline is not None else None,
    )


@router.get("", response_model=RadarResponse)
def list_radar(
    type: Optional[str] = Query(
        None,
        description=f"Optional filter by event type — one of {list(_EVENT_TYPES)}; omit for all.",
    ),
    org: Org = Depends(get_current_org),
) -> RadarResponse:
    """Curated opportunities split into upcoming (nearest first) and recently-started.

    Pass ``?type=`` (next_fest / steam_sale / festival / awards) to narrow to one kind. Each event
    also carries a static ``prep`` checklist for its type, and ``available_types`` lists the per-type
    counts over the whole visible window (before filtering) so the UI's chips stay stable.
    """
    if type is not None and type not in _EVENT_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {list(_EVENT_TYPES)}")

    today = date.today()
    events = [_to_event(raw, today) for raw in _EVENTS]

    def _visible(e: RadarEvent) -> bool:
        return e.days_until_start >= 0 or -_RECENT_PAST_WINDOW_DAYS <= e.days_until_start < 0

    # Per-type counts over the visible set BEFORE the type filter — stable chips regardless of
    # the current selection. Canonical order (_EVENT_TYPES), only types that actually have events.
    counts: dict[str, int] = {}
    for e in events:
        if _visible(e):
            counts[e.type] = counts.get(e.type, 0) + 1
    available_types = [RadarTypeCount(type=t, count=counts[t]) for t in _EVENT_TYPES if t in counts]

    if type is not None:
        events = [e for e in events if e.type == type]

    # Upcoming: starts today or later — nearest first.
    upcoming = sorted(
        (e for e in events if e.days_until_start >= 0),
        key=lambda e: e.days_until_start,
    )
    # Recent past: started within the last window — most recent first.
    recent_past = sorted(
        (e for e in events if -_RECENT_PAST_WINDOW_DAYS <= e.days_until_start < 0),
        key=lambda e: e.days_until_start,
        reverse=True,
    )

    return RadarResponse(
        today=today.isoformat(),
        applied_type=type,
        available_types=available_types,
        upcoming=upcoming,
        recent_past=recent_past,
    )
