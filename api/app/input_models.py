"""Dev-log input models (SQLAlchemy 2.0) — the manual, org-authored side of the app.

These are *inputs* the indie dev types in about their own game(s): dated marketing events
(the feedback log) and wishlist/follower milestone counts (the manual wishlist-ingest
fallback). They live on the control plane next to the other ORM tables and share the same
Base, so init_db()'s Base.metadata.create_all(engine) creates them — this module must be
imported before that runs (see main.py). No create_all() here on purpose.

Dates are stored as ISO 'YYYY-MM-DD' strings: SQLite has no native DATE type and the UI
only ever deals in day-granularity ISO strings, so a TEXT column keeps write/read/sort
lossless without any driver-specific date handling.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MarketingEvent(Base):
    """A dated thing the dev did to market a game — trailer drop, festival, press hit,
    build update, or a catch-all 'other' — with an optional free-text note."""

    __tablename__ = "marketing_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    appid: Mapped[int] = mapped_column(Integer, index=True)
    event_date: Mapped[str] = mapped_column(String(10))  # ISO 'YYYY-MM-DD'
    kind: Mapped[str] = mapped_column(String(40))        # trailer|festival|press|update|other
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class WishlistMilestone(Base):
    """A manually-recorded wishlist/follower count for a game on a given date — the
    fallback when there's no automated Steamworks ingest. Either count may be null (the
    dev might only know one), but the API requires at least one to be present."""

    __tablename__ = "wishlist_milestones"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    appid: Mapped[int] = mapped_column(Integer, index=True)
    on_date: Mapped[str] = mapped_column(String(10))  # ISO 'YYYY-MM-DD'
    wishlists: Mapped[int | None] = mapped_column(Integer, nullable=True)
    followers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(40), default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class WishlistGoal(Base):
    """An org's self-set wishlist target for one game — the number they're aiming to hit
    (typically before launch). One goal per (org, appid): re-setting it replaces the row.
    The Dev Log shows progress toward this target against the latest WishlistMilestone,
    falling back to a heuristic suggested target when the dev hasn't set one."""

    __tablename__ = "wishlist_goals"
    __table_args__ = (
        UniqueConstraint("org_id", "appid", name="uq_wishlist_goal_org_appid"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    appid: Mapped[int] = mapped_column(Integer, index=True)
    target: Mapped[int] = mapped_column(Integer)  # wishlists the dev is aiming for
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )
