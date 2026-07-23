"""Creator Outreach — control-plane models (SQLAlchemy 2.0).

The Outreach page is a per-game / per-genre PITCH PIPELINE (a kanban workbench), not just a
status list. Two tables back it:

* ``OutreachTarget`` — one creator you've pulled onto your board, scoped to an optional game
  (``appid``) or, when ``appid`` is NULL, to a genre-wide pipeline. Carries the pipeline
  ``stage`` and the two timeline anchors (``contacted_at`` / ``replied_at``). ``reach`` is
  snapshotted at add-time so the card is self-describing even if the mart later changes.
* ``OutreachNote`` — free-text notes attached to a target (a lightweight activity log).

The legacy ``OutreachStatus`` table below is retained UNCHANGED (SQLite ``create_all`` only
creates missing tables, never alters existing ones) but is no longer read or written by the
rebuilt router — the pipeline supersedes it. It is kept only so an existing DB keeps its rows.

Lives in its own module (not models.py) so it can be built in parallel; it imports the shared
``Base`` and every class is registered on ``Base.metadata`` simply by being imported. main.py
imports this module before ``init_db()`` runs, so ``Base.metadata.create_all()`` (control_db.py)
creates the two new tables at startup. This module deliberately does NOT call create_all itself.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .models import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class OutreachTarget(Base):
    """A creator on the org's pitch board, scoped to a game (``appid``) or a genre-wide list.

    Unique on (org_id, platform, creator_handle, appid): the same creator can sit on both a
    game-specific board and a genre-wide board independently. NOTE: SQLite treats NULLs as
    distinct in a UNIQUE constraint, so the genre-wide (appid IS NULL) upsert is resolved in
    the router with an explicit ``appid IS NULL`` predicate rather than relying on the index.
    """

    __tablename__ = "outreach_target"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "platform", "creator_handle", "appid", name="uq_outreach_target"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    # NULL = a genre-wide pipeline; set = this creator is targeted for one specific game.
    appid: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    platform: Mapped[str] = mapped_column(String(40))          # 'youtube' | 'twitch' | ...
    creator_handle: Mapped[str] = mapped_column(String(200))   # stable per-platform handle key
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    genre: Mapped[str | None] = mapped_column(String(120), nullable=True)  # Steam genre label
    # Pipeline stage: to_pitch -> queued -> pitched -> replied -> covered, or declined.
    stage: Mapped[str] = mapped_column(String(20), default="to_pitch")
    # Reach snapshotted at add-time (the mart is a moving snapshot); NULL = no snapshot yet.
    reach: Mapped[int | None] = mapped_column(Integer, nullable=True)
    contacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    notes: Mapped[list["OutreachNote"]] = relationship(
        back_populates="target",
        cascade="all, delete-orphan",
        order_by="OutreachNote.created_at",
    )


class OutreachNote(Base):
    """A free-text note on a target — a lightweight per-creator activity log."""

    __tablename__ = "outreach_note"

    id: Mapped[int] = mapped_column(primary_key=True)
    target_id: Mapped[int] = mapped_column(
        ForeignKey("outreach_target.id", ondelete="CASCADE"), index=True
    )
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    target: Mapped["OutreachTarget"] = relationship(back_populates="notes")


class OutreachStatus(Base):
    """LEGACY — retained unchanged for backward compatibility; superseded by OutreachTarget.

    No longer read or written by the router. Kept so pre-existing rows survive; ``create_all``
    won't drop or alter it. New work goes to OutreachTarget/OutreachNote above.
    """

    __tablename__ = "outreach_status"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "platform", "creator_handle", "genre", name="uq_outreach_status"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    platform: Mapped[str] = mapped_column(String(40))          # 'youtube' | 'twitch' | ...
    creator_handle: Mapped[str] = mapped_column(String(200))   # stable per-platform handle key
    genre: Mapped[str] = mapped_column(String(120))            # Steam genre label
    # Pitch pipeline stage: to_pitch -> pitched -> covered, or skip.
    status: Mapped[str] = mapped_column(String(20), default="to_pitch")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )
