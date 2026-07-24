"""Dev-log input models (SQLAlchemy 2.0) — the manual, org-authored side of the app.

The Dev Log's wishlist goals and milestone history used to live here too
(WishlistGoal/WishlistMilestone), but the minimal-tool trim moved that side of the log to
browser localStorage only (see web/src/pages/DevLog.tsx) — no server writes, nothing to
migrate. This module now only carries the one *input* still server-side: dated marketing
events (the feedback log the trends chart's event overlay reads back). It lives on the
control plane next to the other ORM tables and shares the same Base, so
init_db()'s Base.metadata.create_all(engine) creates it — this module must be imported
before that runs (see main.py). No create_all() here on purpose.

Dates are stored as ISO 'YYYY-MM-DD' strings: SQLite has no native DATE type and the UI
only ever deals in day-granularity ISO strings, so a TEXT column keeps write/read/sort
lossless without any driver-specific date handling.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
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
