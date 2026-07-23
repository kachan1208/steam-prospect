"""Alerts + Weekly Digest router.

Owns the whole alerts surface for the current org:

  - Rules   — ``GET/POST /rules``, ``PATCH /rules/{id}`` (toggle enabled). A rule is a
              ``kind`` + a JSON ``params`` bag of thresholds (see alerts_engine for the
              supported kinds and their defaults).
  - Evaluate— ``POST /evaluate`` runs alerts_engine over the org's *enabled* rules now,
              dedupes the candidate signals against already-stored events, persists the
              genuinely new ones, and returns just those new events.
  - Feed    — ``GET /feed`` (recent events, newest first), ``POST /feed/{id}/seen``.
  - Digest  — ``GET /digest`` (last-7-day counts by kind + the newest handful of events).

The engine reads the analytics marts read-only; everything written here (rules + events)
lives in the control DB via the org-scoped ``AlertRule`` / ``AlertEvent`` models in
``alert_models``. Response models are defined in-file.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import alerts_engine
from ..alert_models import AlertEvent, AlertRule, SentDigest
from ..auth import get_current_org
from ..control_db import get_db
from ..models import Org

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

_DIGEST_DAYS = 7
_DIGEST_TOP = 5

# Human labels for every rule kind (point-in-time + edge) — used in the digest text body and
# surfaced to the client via GET /presets. Keep in sync with alerts_engine's registries.
KIND_LABELS: dict[str, str] = {
    "watchlist_velocity": "Watchlist velocity",
    "new_in_niche": "New in niche",
    "niche_median_rev": "Niche median revenue",
    "velocity_change": "Momentum shift",
    "comp_launch": "Competitor launch",
    "sentiment_drop": "Sentiment drop",
}


def _kind_label(kind: str) -> str:
    return KIND_LABELS.get(kind, kind)


# ---- presets ----------------------------------------------------------------------------
# One-click, ready-made rules. Each is a curated (kind, params) a user can add without knowing
# the threshold knobs. The edge presets are the headline feature — they fire on change.

_PRESETS: list[dict[str, Any]] = [
    {
        "key": "momentum_shift",
        "label": "Momentum shift",
        "description": "Fire when a watched game's trailing-30d review pace jumps 50%+ or drops 25%+ vs. the last check.",
        "kind": "velocity_change",
        "params": {"jump_pct": 50, "drop_pct": 25, "min_base": 10},
    },
    {
        "key": "competitor_launch",
        "label": "Competitor crosses 1,000 reviews",
        "description": "Fire the moment a watched competitor crosses the 1,000 lifetime-review mark — a real launch/traction signal.",
        "kind": "comp_launch",
        "params": {"threshold": 1000},
    },
    {
        "key": "sentiment_slip",
        "label": "Rating slipping",
        "description": "Fire when a watched game's positive rating falls 5+ percentage points vs. the last check.",
        "kind": "sentiment_drop",
        "params": {"drop_pp": 5},
    },
    {
        "key": "new_in_your_genre",
        "label": "Strong new release in your genre",
        "description": "Well-reviewed games released this year in a genre you already watch.",
        "kind": "new_in_niche",
        "params": {"min_reviews": 200, "min_positive": 0.80},
    },
    {
        "key": "niche_heating_up",
        "label": "Watched niche revenue over $10k",
        "description": "A genre you watch has a median estimated revenue at or above $10,000.",
        "kind": "niche_median_rev",
        "params": {"threshold": 10000, "direction": "above"},
    },
]

_PRESET_BY_KEY: dict[str, dict[str, Any]] = {p["key"]: p for p in _PRESETS}


# ---- schemas ----------------------------------------------------------------------------

class RuleIn(BaseModel):
    # Validated against alerts_engine.ALL_RULE_KINDS in the endpoint (the engine registries are
    # the single source of truth for which kinds exist), so this stays a plain str.
    kind: str
    params: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class RulePatch(BaseModel):
    enabled: bool


class RuleOut(BaseModel):
    id: int
    kind: str
    params: dict[str, Any]
    enabled: bool
    created_at: str


class EventOut(BaseModel):
    id: int
    kind: str
    title: str
    body: str
    appid: Optional[int] = None
    created_at: str
    seen: bool
    edge: bool = False  # fired by an edge-triggered rule (change), not a standing condition


class PresetOut(BaseModel):
    key: str
    label: str
    description: str
    kind: str
    kind_label: str
    edge: bool
    params: dict[str, Any]
    added: bool  # an identical (kind, params) rule already exists for this org


class SentDigestOut(BaseModel):
    id: int
    subject: str
    body: str
    signal_count: int
    created_at: str


class DigestKindCount(BaseModel):
    kind: str
    count: int


class DigestOut(BaseModel):
    since: str
    until: str
    days: int
    total: int
    by_kind: list[DigestKindCount]
    top: list[EventOut]


# ---- serialization helpers --------------------------------------------------------------

def _parse_params(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _rule_out(r: AlertRule) -> RuleOut:
    return RuleOut(
        id=r.id,
        kind=r.kind,
        params=_parse_params(r.params_json),
        enabled=bool(r.enabled),
        created_at=r.created_at.isoformat() if r.created_at else "",
    )


def _event_out(e: AlertEvent) -> EventOut:
    return EventOut(
        id=e.id,
        kind=e.kind,
        title=e.title,
        body=e.body or "",
        appid=e.appid,
        created_at=e.created_at.isoformat() if e.created_at else "",
        seen=bool(e.seen),
        edge=e.kind in alerts_engine.EDGE_RULE_KINDS,
    )


def _as_naive_utc(dt: datetime | None) -> datetime | None:
    """Normalize to naive-UTC so we can compare events regardless of whether the control DB
    (SQLite in solo mode) hands datetimes back tz-aware or naive."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


# ---- rules ------------------------------------------------------------------------------

@router.get("/rules", response_model=list[RuleOut])
def list_rules(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(AlertRule).where(AlertRule.org_id == org.id).order_by(AlertRule.created_at.desc())
    ).all()
    return [_rule_out(r) for r in rows]


@router.post("/rules", response_model=RuleOut, status_code=201)
def create_rule(
    payload: RuleIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    if payload.kind not in alerts_engine.ALL_RULE_KINDS:
        raise HTTPException(status_code=422, detail=f"unknown alert kind {payload.kind!r}")
    row = AlertRule(
        org_id=org.id,
        kind=payload.kind,
        params_json=json.dumps(payload.params or {}),
        enabled=payload.enabled,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _rule_out(row)


@router.patch("/rules/{rule_id}", response_model=RuleOut)
def toggle_rule(
    rule_id: int,
    payload: RulePatch,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    row = db.get(AlertRule, rule_id)
    if row is None or row.org_id != org.id:
        raise HTTPException(status_code=404, detail="Alert rule not found.")
    row.enabled = payload.enabled
    db.commit()
    db.refresh(row)
    return _rule_out(row)


# ---- presets ----------------------------------------------------------------------------

def _existing_rule_for_preset(db: Session, org_id: int, preset: dict[str, Any]) -> AlertRule | None:
    """An enabled-or-disabled rule whose (kind, params) exactly matches this preset, if any."""
    rows = db.scalars(
        select(AlertRule).where(AlertRule.org_id == org_id, AlertRule.kind == preset["kind"])
    ).all()
    for r in rows:
        if _parse_params(r.params_json) == preset["params"]:
            return r
    return None


@router.get("/presets", response_model=list[PresetOut])
def list_presets(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    """Ready-made rules a user can add in one click. ``added`` marks presets already present."""
    out: list[PresetOut] = []
    for p in _PRESETS:
        out.append(
            PresetOut(
                key=p["key"],
                label=p["label"],
                description=p["description"],
                kind=p["kind"],
                kind_label=_kind_label(p["kind"]),
                edge=p["kind"] in alerts_engine.EDGE_RULE_KINDS,
                params=p["params"],
                added=_existing_rule_for_preset(db, org.id, p) is not None,
            )
        )
    return out


@router.post("/presets/{key}", response_model=RuleOut, status_code=201)
def add_preset(
    key: str,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    preset = _PRESET_BY_KEY.get(key)
    if preset is None:
        raise HTTPException(status_code=404, detail=f"unknown preset {key!r}")

    # Idempotent: if the exact rule already exists, return it rather than creating a duplicate.
    existing = _existing_rule_for_preset(db, org.id, preset)
    if existing is not None:
        if not existing.enabled:
            existing.enabled = True
            db.commit()
            db.refresh(existing)
        return _rule_out(existing)

    row = AlertRule(
        org_id=org.id,
        kind=preset["kind"],
        params_json=json.dumps(preset["params"]),
        enabled=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _rule_out(row)


# ---- evaluate ---------------------------------------------------------------------------

@router.post("/evaluate", response_model=list[EventOut])
def evaluate_now(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    """Run every enabled rule now and persist the genuinely-new signals.

    Point-in-time rules yield snapshot candidates that are deduped against already-stored events
    (a standing condition records once). Edge rules read/write AlertState and yield candidates
    only on a real change; those carry ``edge=True`` and bypass the standing dedup because their
    state machine already guarantees one fire per change. Either way AlertState writes done by
    the edge evaluators are flushed by the single commit below — even on a seed run with no new
    events, so the next run has a prior to compare against."""
    rules = db.scalars(
        select(AlertRule).where(AlertRule.org_id == org.id, AlertRule.enabled.is_(True))
    ).all()

    candidates: list[dict] = []
    for rule in rules:
        params = _parse_params(rule.params_json)
        if rule.kind in alerts_engine.EDGE_RULE_KINDS:
            candidates.extend(alerts_engine.evaluate_rule_edge(db, org.id, rule.id, rule.kind, params))
        else:
            candidates.extend(alerts_engine.evaluate_rule(db, org.id, rule.kind, params))

    created: list[AlertEvent] = []
    seen_keys: set[tuple] = set()
    for c in candidates:
        kind = c.get("kind") or ""
        title = (c.get("title") or "")[:300]
        appid = c.get("appid")
        is_edge = bool(c.get("edge"))
        key = (kind, title, appid)
        if key in seen_keys:
            continue  # two rules produced the same signal in one run
        seen_keys.add(key)

        if not is_edge:
            # Standing-condition dedup: a point-in-time signal records at most once. Edge signals
            # skip this — the same title recurs every time the metric changes, which is the point.
            conds = [
                AlertEvent.org_id == org.id,
                AlertEvent.kind == kind,
                AlertEvent.title == title,
            ]
            conds.append(AlertEvent.appid.is_(None) if appid is None else AlertEvent.appid == appid)
            if db.scalar(select(AlertEvent.id).where(*conds)) is not None:
                continue  # already recorded on a previous run — don't re-fire a standing signal

        ev = AlertEvent(org_id=org.id, kind=kind, title=title, body=c.get("body") or "", appid=appid)
        db.add(ev)
        created.append(ev)

    # Always commit: edge evaluators may have updated AlertState even when no event fired (a seed
    # run, or a reading that changed but stayed under threshold). Persisting that is what makes the
    # next run edge-triggered rather than re-seeding.
    db.commit()
    for ev in created:
        db.refresh(ev)

    created.sort(key=lambda e: e.id, reverse=True)
    return [_event_out(e) for e in created]


# ---- feed -------------------------------------------------------------------------------

@router.get("/feed", response_model=list[EventOut])
def feed(
    limit: int = Query(50, ge=1, le=200),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(AlertEvent)
        .where(AlertEvent.org_id == org.id)
        .order_by(AlertEvent.created_at.desc(), AlertEvent.id.desc())
        .limit(limit)
    ).all()
    return [_event_out(e) for e in rows]


@router.post("/feed/{event_id}/seen", response_model=EventOut)
def mark_seen(
    event_id: int,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    e = db.get(AlertEvent, event_id)
    if e is None or e.org_id != org.id:
        raise HTTPException(status_code=404, detail="Alert event not found.")
    e.seen = True
    db.commit()
    db.refresh(e)
    return _event_out(e)


# ---- digest -----------------------------------------------------------------------------

def _compute_digest(db: Session, org_id: int, top: int = _DIGEST_TOP) -> DigestOut:
    until = datetime.now(timezone.utc)
    since = until - timedelta(days=_DIGEST_DAYS)
    since_naive = _as_naive_utc(since)

    # Pull the org's recent events (bounded) and window them in Python, so the 7-day cutoff
    # is correct whether the control DB stored the timestamps tz-aware or naive.
    rows = db.scalars(
        select(AlertEvent)
        .where(AlertEvent.org_id == org_id)
        .order_by(AlertEvent.created_at.desc(), AlertEvent.id.desc())
        .limit(1000)
    ).all()

    recent = [
        e
        for e in rows
        if (ts := _as_naive_utc(e.created_at)) is not None and since_naive is not None and ts >= since_naive
    ]

    by_kind: dict[str, int] = {}
    for e in recent:
        by_kind[e.kind] = by_kind.get(e.kind, 0) + 1

    return DigestOut(
        since=since.isoformat(),
        until=until.isoformat(),
        days=_DIGEST_DAYS,
        total=len(recent),
        by_kind=[
            DigestKindCount(kind=k, count=v)
            for k, v in sorted(by_kind.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        top=[_event_out(e) for e in recent[:top]],
    )


def _fmt_day(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%b %-d, %Y")
    except (ValueError, TypeError):
        return iso[:10]


def _format_digest_text(org: Org, d: DigestOut) -> tuple[str, str]:
    """Render a digest into an (subject, body) email-style plaintext pair."""
    subject = (
        f"Prospect weekly digest — {d.total} signal{'' if d.total == 1 else 's'} this week"
    )
    lines: list[str] = []
    lines.append(subject)
    lines.append(f"{org.name} · {_fmt_day(d.since)} – {_fmt_day(d.until)}")
    lines.append("")

    if d.total == 0:
        lines.append("No new signals in the last 7 days.")
        lines.append("Add or enable a rule, then Run now to evaluate your watchlist and niches.")
    else:
        lines.append(f"{d.total} signal{'' if d.total == 1 else 's'} across your watchlist and niches:")
        lines.append("")
        for kc in d.by_kind:
            lines.append(f"  • {_kind_label(kc.kind)}: {kc.count}")
        lines.append("")
        lines.append("Top signals")
        lines.append("-----------")
        for i, e in enumerate(d.top, start=1):
            lines.append(f"{i}. [{_kind_label(e.kind)}] {e.title}")
            if e.body:
                lines.append(f"   {e.body}")
        lines.append("")

    lines.append("— Prospect watchtower")
    return subject, "\n".join(lines)


def _sent_digest_out(s: SentDigest) -> SentDigestOut:
    return SentDigestOut(
        id=s.id,
        subject=s.subject or "",
        body=s.body or "",
        signal_count=int(s.signal_count or 0),
        created_at=s.created_at.isoformat() if s.created_at else "",
    )


@router.get("/digest", response_model=DigestOut)
def digest(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    return _compute_digest(db, org.id)


@router.post("/digest/send", response_model=SentDigestOut, status_code=201)
def send_digest(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    """Render the current weekly digest to an email-style text body, log it as 'sent', and
    return the preview. No real SMTP — this is the delivery mechanism + preview in one call."""
    d = _compute_digest(db, org.id, top=_DIGEST_TOP)
    subject, body = _format_digest_text(org, d)
    row = SentDigest(org_id=org.id, subject=subject[:300], body=body, signal_count=d.total)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _sent_digest_out(row)


@router.get("/digest/history", response_model=list[SentDigestOut])
def digest_history(
    limit: int = Query(20, ge=1, le=100),
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(SentDigest)
        .where(SentDigest.org_id == org.id)
        .order_by(SentDigest.created_at.desc(), SentDigest.id.desc())
        .limit(limit)
    ).all()
    return [_sent_digest_out(s) for s in rows]
