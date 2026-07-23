"""Creator Outreach — a per-game / per-genre PITCH PIPELINE (a kanban workbench).

The old version of this router was a thin genre -> ranked-creators list with a 4-state status
column (a near-duplicate of the Marketing page). This rebuild turns it into an outreach
workbench:

* **Candidates** (read side, ``mart_creator_pitch``) — ranked creators for a genre (or for a
  specific game's primary genre), each carrying a ``fit`` breakdown that *explains* the ranking
  and its current pipeline ``stage`` if you've already pulled it onto your board.
* **Board** (write side, control plane) — the creators you're actually working, grouped into
  six pipeline stages: to_pitch -> queued -> pitched -> replied -> covered, plus declined.
* **Creator detail / template / notes** — everything the slide-over drawer needs to actually
  pitch: which genres/games a creator covers, a pre-filled pitch-email draft, and per-target
  notes.

Reads hit the analytics marts (DuckDB, read-only); writes hit the control plane (SQLAlchemy).
``mart_creator_pitch`` is large (~1.6M rows across 17 genres x {youtube, twitch}), so every
mart read is genre- or creator-filtered and LIMITed. See marketing.py's creator-pitch-list for
the sibling one-platform read; this router spans platforms and adds the pipeline on top.
"""
from __future__ import annotations

import json
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import analytics_db
from ..auth import get_current_org
from ..control_db import get_db
from ..models import Org
from ..outreach_models import (  # noqa: F401 — imports register the tables on Base.metadata
    OutreachNote,
    OutreachStatus,
    OutreachTarget,
)

router = APIRouter(prefix="/api/outreach", tags=["outreach"])

# Pipeline stages, in board order. One source of truth for the Pydantic Literal, the runtime
# default, and the board grouping so they can never drift.
Stage = Literal["to_pitch", "queued", "pitched", "replied", "covered", "declined"]
STAGES: tuple[str, ...] = ("to_pitch", "queued", "pitched", "replied", "covered", "declined")
STAGE_LABELS: dict[str, str] = {
    "to_pitch": "To pitch",
    "queued": "Queued",
    "pitched": "Pitched",
    "replied": "Replied",
    "covered": "Covered",
    "declined": "Declined",
}
_DEFAULT_STAGE = "to_pitch"

# Columns pulled from mart_creator_pitch for one creator row (mirrors marketing.py's set).
_CREATOR_COLS = (
    "genre, platform, creator_id, handle, display_name, creator_url, n_mentions, "
    "n_mentions_recent, n_games_covered, reach, reach_captured_at, pitch_score, "
    "example_title, example_url, example_published_at"
)


# --------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------
def _compact(n: Optional[float]) -> str:
    """Human number for a fit reason: 110000000 -> '110.0M', 34384 -> '34.4K'."""
    if n is None:
        return "an unknown"
    n = float(n)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(int(n))


def _dt_iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _article(word: str) -> str:
    """'a' / 'an' for a following word — keeps merged genre phrasing readable ('an Action game')."""
    return "an" if word[:1].lower() in "aeiou" else "a"


def _fit_reasons(row: dict, *, game_name: Optional[str], genre: str) -> list[str]:
    """Plain-English bullets explaining why a creator ranks where it does. The ranking itself
    is pitch_score (reach x recent activity) from the mart; this narrates the inputs so the
    dev can sanity-check a number instead of trusting it blind."""
    reasons: list[str] = []
    reach = row.get("reach")
    recent = row.get("n_mentions_recent") or 0
    games = row.get("n_games_covered") or 0
    platform = row.get("platform")

    if reach:
        reasons.append(f"{_compact(reach)} reach on {platform} (snapshot)")
    else:
        reasons.append(f"No reach snapshot yet on {platform} — audience size unknown, not zero")

    if recent >= 3:
        reasons.append(f"Active — {recent} mentions in the recent window")
    elif recent >= 1:
        reasons.append(f"Some recent activity — {recent} mention(s) in the recent window")
    else:
        reasons.append("Quiet lately — no mentions in the recent window; may have moved on")

    if games >= 5:
        reasons.append(f"Established in {genre} — has covered {games} games in it")
    elif games >= 1:
        reasons.append(f"Covers {genre} — {games} game(s) so far")

    example = row.get("example_title")
    if example:
        if game_name:
            reasons.append(f'Covered "{example}" — a comparable {genre} game to {game_name}')
        else:
            reasons.append(f'Example {genre} coverage: "{example}"')
    return reasons


def _apply_stage(target: OutreachTarget, stage: str) -> None:
    """Move a target to ``stage`` and stamp the timeline anchors. contacted_at is set the first
    time a target reaches any post-contact stage (pitched/replied/covered); replied_at the first
    time it reaches replied. Anchors are only ever *set*, never cleared, so moving a card
    backwards keeps its history."""
    now = datetime.now(timezone.utc)
    target.stage = stage
    if stage in ("pitched", "replied", "covered") and target.contacted_at is None:
        target.contacted_at = now
    if stage == "replied" and target.replied_at is None:
        target.replied_at = now


def _owned_target(db: Session, org: Org, target_id: int) -> OutreachTarget:
    t = db.scalar(
        select(OutreachTarget).where(
            OutreachTarget.id == target_id, OutreachTarget.org_id == org.id
        )
    )
    if t is None:
        raise HTTPException(status_code=404, detail=f"No outreach target #{target_id} for this org.")
    return t


# --------------------------------------------------------------------------------------------
# schemas
# --------------------------------------------------------------------------------------------
class Fit(BaseModel):
    """The ranking, unpacked — the numbers behind pitch_score plus prose reasons."""

    reach: Optional[int] = None
    recent_activity: int = 0          # n_mentions_recent
    games_covered: int = 0            # n_games_covered
    reasons: list[str] = Field(default_factory=list)


class CandidateRow(BaseModel):
    platform: str
    creator_id: int
    creator_handle: str
    display_name: Optional[str] = None
    creator_url: Optional[str] = None
    reach: Optional[int] = None
    reach_captured_at: Optional[str] = None
    n_mentions: int
    n_mentions_recent: int
    n_games_covered: int
    pitch_score: Optional[float] = None
    example_title: Optional[str] = None
    example_url: Optional[str] = None
    example_published_at: Optional[str] = None
    # Joined from the org's board (this appid-scope), if the creator is already tracked.
    stage: Optional[str] = None
    target_id: Optional[int] = None
    fit: Fit


class CandidatesResponse(BaseModel):
    genre: str
    appid: Optional[int] = None
    game_name: Optional[str] = None
    items: list[CandidateRow]


class TargetOut(BaseModel):
    id: int
    appid: Optional[int] = None
    platform: str
    creator_handle: str
    display_name: Optional[str] = None
    genre: Optional[str] = None
    stage: str
    reach: Optional[int] = None
    contacted_at: Optional[str] = None
    replied_at: Optional[str] = None
    updated_at: Optional[str] = None
    note_count: int = 0


class StageGroup(BaseModel):
    stage: str
    label: str
    targets: list[TargetOut]


class BoardResponse(BaseModel):
    appid: Optional[int] = None
    stages: list[StageGroup]


class TargetIn(BaseModel):
    platform: str
    creator_handle: str
    display_name: Optional[str] = None
    genre: Optional[str] = None
    appid: Optional[int] = None
    reach: Optional[int] = None
    stage: Stage = _DEFAULT_STAGE


class StageIn(BaseModel):
    target_id: int
    stage: Stage


class CreatorGenreRow(BaseModel):
    genre: str
    n_mentions: int
    n_mentions_recent: int
    n_games_covered: int
    pitch_score: Optional[float] = None
    example_title: Optional[str] = None
    example_url: Optional[str] = None
    example_published_at: Optional[str] = None


class CreatorDetail(BaseModel):
    platform: str
    handle: str
    display_name: Optional[str] = None
    creator_url: Optional[str] = None
    reach: Optional[int] = None
    reach_captured_at: Optional[str] = None
    coverage: list[CreatorGenreRow]


class PitchTemplate(BaseModel):
    subject: str
    body: str


class NoteIn(BaseModel):
    target_id: int
    body: str = Field(..., min_length=1)


class NoteOut(BaseModel):
    id: int
    target_id: int
    body: str
    created_at: Optional[str] = None


# --------------------------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------------------------
@router.get("/genres", response_model=list[str])
def list_genres(org: Org = Depends(get_current_org)) -> list[str]:
    """Distinct genres that have creator coverage — drives the genre picker."""
    return [
        r["genre"]
        for r in analytics_db.query("SELECT DISTINCT genre FROM mart_creator_pitch ORDER BY genre")
    ]


# --- Curated Reddit + X targets (api/app/data/outreach_seed.json) ------------------------
# Reddit and X have no free scrapeable creator data, so mart_creator_pitch only holds
# youtube+twitch. These hand-curated subreddits / X accounts+hashtags per genre slot into the
# SAME candidate shape + board pipeline, so Outreach spans all four channels. They carry no live
# reach/mentions — the note is the "why" — and are refined by hand (upgrade Reddit to the OAuth
# API later without touching the UI).
_SEED_PATH = Path(__file__).resolve().parent.parent / "data" / "outreach_seed.json"
try:
    _OUTREACH_SEED = {k: v for k, v in json.loads(_SEED_PATH.read_text()).items() if not k.startswith("_")}
except (OSError, ValueError):
    _OUTREACH_SEED = {}


def _synthetic_id(platform: str, handle: str) -> int:
    # Stable NEGATIVE id so curated targets never collide with real creator_ids.
    return -(zlib.crc32(f"{platform}:{handle}".encode()) & 0x7FFFFFFF)


def _curated_candidates(genre: str, tracked: dict) -> list[CandidateRow]:
    out: list[CandidateRow] = []
    seen: set[tuple[str, str]] = set()
    for scope in ("__all__", genre):
        block = _OUTREACH_SEED.get(scope) or {}
        for sub in block.get("reddit", []):
            handle = sub.get("name")
            if not handle or ("reddit", handle) in seen:
                continue
            seen.add(("reddit", handle))
            subs, note = sub.get("subscribers"), sub.get("note")
            t = tracked.get(("reddit", handle))
            reasons = [f"Curated {genre} community"]
            if subs:
                reasons.append(f"~{_compact(subs)} members")
            if note:
                reasons.append(note)
            url = f"https://www.reddit.com/r/{handle}/"
            out.append(CandidateRow(
                platform="reddit", creator_id=_synthetic_id("reddit", handle),
                creator_handle=handle, display_name=f"r/{handle}", creator_url=url,
                reach=subs, reach_captured_at=None, n_mentions=0, n_mentions_recent=0,
                n_games_covered=0, pitch_score=None, example_title=note, example_url=url,
                example_published_at=None, stage=t.stage if t else None, target_id=t.id if t else None,
                fit=Fit(reach=subs, recent_activity=0, games_covered=0, reasons=reasons),
            ))
        for acc in block.get("x", []):
            handle = acc.get("handle")
            if not handle or ("x", handle) in seen:
                continue
            seen.add(("x", handle))
            is_tag = acc.get("kind", "account") == "hashtag"
            foll, note = acc.get("followers"), acc.get("note")
            t = tracked.get(("x", handle))
            reasons = [f"Curated {genre} {'hashtag' if is_tag else 'account'}"]
            if note:
                reasons.append(note)
            if foll:
                reasons.append(f"~{_compact(foll)} followers")
            url = f"https://x.com/hashtag/{handle}" if is_tag else f"https://x.com/{handle}"
            out.append(CandidateRow(
                platform="x", creator_id=_synthetic_id("x", handle),
                creator_handle=handle, display_name=(f"#{handle}" if is_tag else f"@{handle}"),
                creator_url=url, reach=foll, reach_captured_at=None, n_mentions=0,
                n_mentions_recent=0, n_games_covered=0, pitch_score=None, example_title=note,
                example_url=url, example_published_at=None, stage=t.stage if t else None,
                target_id=t.id if t else None,
                fit=Fit(reach=foll, recent_activity=0, games_covered=0, reasons=reasons),
            ))
    return out


@router.get("/candidates", response_model=CandidatesResponse)
def list_candidates(
    genre: Optional[str] = Query(None, description="Exact genre label (see GET /api/outreach/genres)."),
    appid: Optional[int] = Query(None, description="Target creators for this game; its primary_genre wins over `genre`."),
    status: Optional[Stage] = Query(None, description="Optional filter: only candidates already at this stage."),
    limit: int = Query(50, ge=1, le=200, description="Max top-by-pitch_score creators returned."),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> CandidatesResponse:
    """Ranked creators (YouTube + Twitch) for a genre, each with a ``fit`` breakdown and its
    current board ``stage``. If ``appid`` is given, the game's own ``primary_genre`` drives the
    list (so you get creators who cover *comparable* — same-genre — games) and the fit reasons
    name the game. Candidates already on the board (for this appid-scope) carry their stage +
    target_id so the UI can show them as tracked. Empty items is an honest answer: no channel
    scraper has populated this genre yet.
    """
    game_name: Optional[str] = None
    resolved_genre = genre
    if appid is not None:
        game = analytics_db.query_one(
            "SELECT appid, name, primary_genre FROM mart_game WHERE appid = ?", [appid]
        )
        if game is None:
            raise HTTPException(status_code=404, detail=f"No game with appid {appid}.")
        game_name = game["name"]
        resolved_genre = game["primary_genre"] or genre
    if not resolved_genre:
        raise HTTPException(
            status_code=400,
            detail="Provide a genre, or an appid whose game has a primary_genre.",
        )

    rows = analytics_db.query(
        f"SELECT {_CREATOR_COLS} FROM mart_creator_pitch WHERE genre = ? "
        f"ORDER BY pitch_score DESC NULLS LAST, reach DESC NULLS LAST LIMIT ?",
        [resolved_genre, limit],
    )

    # The org's tracked creators in *this* scope: a specific game (appid set) or the genre-wide
    # board (appid IS NULL). Keyed by (platform, handle) to annotate each candidate.
    tq = select(OutreachTarget).where(OutreachTarget.org_id == org.id)
    tq = tq.where(OutreachTarget.appid == appid) if appid is not None else tq.where(OutreachTarget.appid.is_(None))
    tracked = {(t.platform, t.creator_handle): t for t in db.scalars(tq).all()}

    items: list[CandidateRow] = []
    for r in rows:
        t = tracked.get((r["platform"], r["handle"]))
        items.append(
            CandidateRow(
                platform=r["platform"],
                creator_id=r["creator_id"],
                creator_handle=r["handle"],
                display_name=r["display_name"],
                creator_url=r["creator_url"],
                reach=r["reach"],
                reach_captured_at=r["reach_captured_at"],
                n_mentions=r["n_mentions"],
                n_mentions_recent=r["n_mentions_recent"],
                n_games_covered=r["n_games_covered"],
                pitch_score=r["pitch_score"],
                example_title=r["example_title"],
                example_url=r["example_url"],
                example_published_at=r["example_published_at"],
                stage=t.stage if t else None,
                target_id=t.id if t else None,
                fit=Fit(
                    reach=r["reach"],
                    recent_activity=r["n_mentions_recent"],
                    games_covered=r["n_games_covered"],
                    reasons=_fit_reasons(r, game_name=game_name, genre=resolved_genre),
                ),
            )
        )

    # Curated Reddit + X targets for this genre, slotted into the same shape + board pipeline.
    items.extend(_curated_candidates(resolved_genre, tracked))

    if status is not None:
        items = [it for it in items if it.stage == status]

    return CandidatesResponse(genre=resolved_genre, appid=appid, game_name=game_name, items=items)


@router.get("/board", response_model=BoardResponse)
def get_board(
    appid: Optional[int] = Query(None, description="Only this game's targets; omit for every target."),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> BoardResponse:
    """The org's outreach targets grouped into the six pipeline stages. If ``appid`` is given,
    only that game's board; otherwise every target the org tracks."""
    q = select(OutreachTarget).where(OutreachTarget.org_id == org.id)
    if appid is not None:
        q = q.where(OutreachTarget.appid == appid)
    targets = db.scalars(q.order_by(OutreachTarget.updated_at.desc())).all()

    note_counts: dict[int, int] = {}
    if targets:
        rows = db.execute(
            select(OutreachNote.target_id, func.count())
            .where(OutreachNote.target_id.in_([t.id for t in targets]))
            .group_by(OutreachNote.target_id)
        ).all()
        note_counts = {tid: n for tid, n in rows}

    grouped: dict[str, list[TargetOut]] = {s: [] for s in STAGES}
    for t in targets:
        grouped.setdefault(t.stage, []).append(_to_target_out(t, note_counts.get(t.id, 0)))

    return BoardResponse(
        appid=appid,
        stages=[StageGroup(stage=s, label=STAGE_LABELS[s], targets=grouped.get(s, [])) for s in STAGES],
    )


def _to_target_out(t: OutreachTarget, note_count: int) -> TargetOut:
    return TargetOut(
        id=t.id,
        appid=t.appid,
        platform=t.platform,
        creator_handle=t.creator_handle,
        display_name=t.display_name,
        genre=t.genre,
        stage=t.stage,
        reach=t.reach,
        contacted_at=_dt_iso(t.contacted_at),
        replied_at=_dt_iso(t.replied_at),
        updated_at=_dt_iso(t.updated_at),
        note_count=note_count,
    )


@router.post("/target", response_model=TargetOut)
def upsert_target(
    payload: TargetIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> TargetOut:
    """Pull a creator onto the board (or update it) at a stage. Idempotent per
    (org, platform, creator_handle, appid-scope): re-adding updates the existing card's stage
    and metadata rather than duplicating it. Stage timeline anchors are stamped by _apply_stage.
    """
    q = select(OutreachTarget).where(
        OutreachTarget.org_id == org.id,
        OutreachTarget.platform == payload.platform,
        OutreachTarget.creator_handle == payload.creator_handle,
    )
    # NULLs are distinct in a SQLite UNIQUE index, so match the genre-wide row explicitly.
    q = q.where(OutreachTarget.appid == payload.appid) if payload.appid is not None else q.where(OutreachTarget.appid.is_(None))
    target = db.scalar(q)

    if target is None:
        target = OutreachTarget(
            org_id=org.id,
            appid=payload.appid,
            platform=payload.platform,
            creator_handle=payload.creator_handle,
            display_name=payload.display_name,
            genre=payload.genre,
            reach=payload.reach,
        )
        db.add(target)
    else:
        # Refresh cheap metadata on re-add (name/genre/reach can improve over time).
        if payload.display_name is not None:
            target.display_name = payload.display_name
        if payload.genre is not None:
            target.genre = payload.genre
        if payload.reach is not None:
            target.reach = payload.reach
    _apply_stage(target, payload.stage)
    db.commit()
    db.refresh(target)
    return _to_target_out(target, len(target.notes))


@router.post("/stage", response_model=TargetOut)
def move_stage(
    payload: StageIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> TargetOut:
    """Move a target to a new stage (drag-and-drop / stage buttons). Sets contacted_at on the
    first move into pitched/replied/covered and replied_at on the first move into replied."""
    target = _owned_target(db, org, payload.target_id)
    _apply_stage(target, payload.stage)
    db.commit()
    db.refresh(target)
    return _to_target_out(target, len(target.notes))


@router.get("/creator", response_model=CreatorDetail)
def creator_detail(
    platform: str = Query(..., description="'youtube' | 'twitch'."),
    handle: str = Query(..., description="Stable per-platform handle key."),
    org: Org = Depends(get_current_org),
) -> CreatorDetail:
    """One creator across every genre they cover — reach + the mart_creator_pitch row(s) so the
    drawer can show which genres/games they touch and an example mention per genre."""
    rows = analytics_db.query(
        f"SELECT {_CREATOR_COLS} FROM mart_creator_pitch WHERE platform = ? AND handle = ? "
        f"ORDER BY n_games_covered DESC, pitch_score DESC NULLS LAST",
        [platform, handle],
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Creator not found in the pitch marts.")

    first = rows[0]
    # reach is a per-creator snapshot; take the first non-null across the creator's rows.
    reach_row = next((r for r in rows if r["reach"] is not None), None)
    return CreatorDetail(
        platform=platform,
        handle=handle,
        display_name=first["display_name"],
        creator_url=first["creator_url"],
        reach=reach_row["reach"] if reach_row else None,
        reach_captured_at=reach_row["reach_captured_at"] if reach_row else None,
        coverage=[
            CreatorGenreRow(
                genre=r["genre"],
                n_mentions=r["n_mentions"],
                n_mentions_recent=r["n_mentions_recent"],
                n_games_covered=r["n_games_covered"],
                pitch_score=r["pitch_score"],
                example_title=r["example_title"],
                example_url=r["example_url"],
                example_published_at=r["example_published_at"],
            )
            for r in rows
        ],
    )


@router.get("/template", response_model=PitchTemplate)
def pitch_template(
    platform: str = Query(..., description="'youtube' | 'twitch'."),
    handle: str = Query(..., description="Stable per-platform handle key."),
    appid: Optional[int] = Query(None, description="Merge this game's name + genre into the draft."),
    org: Org = Depends(get_current_org),
) -> PitchTemplate:
    """A ready-to-edit pitch email, merging the creator's display name, the game's name (from
    mart_game), and a *comparable they actually covered* (their example_title in the game's
    genre). Works without appid too — it just leaves game specifics as light placeholders."""
    creator = analytics_db.query_one(
        "SELECT display_name FROM mart_creator_pitch WHERE platform = ? AND handle = ? LIMIT 1",
        [platform, handle],
    )
    creator_name = (creator or {}).get("display_name") or handle

    game = analytics_db.query_one(
        "SELECT name, primary_genre FROM mart_game WHERE appid = ?", [appid]
    ) if appid is not None else None
    game_name = (game or {}).get("name") or "my game"
    genre = (game or {}).get("primary_genre")

    # The comparable: prefer their example in the game's genre, else any example they have.
    comparable = None
    if genre:
        c = analytics_db.query_one(
            "SELECT example_title FROM mart_creator_pitch "
            "WHERE platform = ? AND handle = ? AND genre = ? AND example_title IS NOT NULL LIMIT 1",
            [platform, handle, genre],
        )
        comparable = (c or {}).get("example_title")
    if not comparable:
        c = analytics_db.query_one(
            "SELECT example_title FROM mart_creator_pitch "
            "WHERE platform = ? AND handle = ? AND example_title IS NOT NULL LIMIT 1",
            [platform, handle],
        )
        comparable = (c or {}).get("example_title")

    genre_clause = f", {_article(genre)} {genre} game," if genre else ""
    comp_clause = (
        f' I really enjoyed your coverage of "{comparable}" — it\'s the kind of game '
        f"{game_name} sits right alongside." if comparable else ""
    )
    subject = (
        f"{game_name} — {_article(genre)} {genre} game I think would suit your channel"
        if genre
        else f"{game_name} — a game I think would suit your channel"
    )
    body = (
        f"Hi {creator_name},\n\n"
        f"I'm an indie developer working on {game_name}{genre_clause} launching on Steam.\n\n"
        f"I've been following your {platform} channel and think {game_name} would be a great "
        f"fit for your audience.{comp_clause}\n\n"
        f"[One line on your hook — what makes {game_name} stand out.]\n\n"
        f"I'd love to send you a free key so you can check it out ahead of launch — happy to "
        f"share a build, a press kit, or answer any questions.\n\n"
        f"Thanks for taking a look,\n"
        f"[Your name]"
    )
    return PitchTemplate(subject=subject, body=body)


@router.get("/notes", response_model=list[NoteOut])
def list_notes(
    target_id: int = Query(...),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> list[NoteOut]:
    """Notes on one target, oldest-first. 404s if the target isn't this org's."""
    _owned_target(db, org, target_id)
    notes = db.scalars(
        select(OutreachNote).where(OutreachNote.target_id == target_id).order_by(OutreachNote.created_at)
    ).all()
    return [NoteOut(id=n.id, target_id=n.target_id, body=n.body, created_at=_dt_iso(n.created_at)) for n in notes]


@router.post("/note", response_model=NoteOut)
def add_note(
    payload: NoteIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> NoteOut:
    """Attach a note to a target (bumps nothing else). 404s if the target isn't this org's."""
    _owned_target(db, org, payload.target_id)
    note = OutreachNote(target_id=payload.target_id, body=payload.body)
    db.add(note)
    db.commit()
    db.refresh(note)
    return NoteOut(id=note.id, target_id=note.target_id, body=note.body, created_at=_dt_iso(note.created_at))
