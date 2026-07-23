"""SQLAlchemy models for the Alerts + Weekly Digest feature.

Two tables, both hung off the shared control-plane ``models.Base`` so they are created by
``control_db.init_db()``'s ``Base.metadata.create_all()`` — importing this module is what
registers them on the shared metadata, so it must be imported before ``init_db()`` runs.
``routers/alerts.py`` imports it (and main.py imports that router), so the tables are always
registered by the time the FastAPI lifespan calls ``init_db()``. We deliberately do NOT call
``create_all`` here (the orchestrator/control-plane owns that) and do NOT add ORM
relationships back onto ``Org`` (that would require editing models.py) — the plain foreign
key is all the engine and router need.

  - ``alert_rules``  — per-org rule definitions the engine evaluates (kind + JSON params).
  - ``alert_events`` — materialized signals the engine produced; the feed and digest read these.
  - ``alert_states`` — the last observed value per (rule, metric_key); this is what turns the
        engine from point-in-time snapshots into *edge-triggered* alerts: the engine compares
        the current metric against the stored prior and only fires on a genuine change.
  - ``sent_digests`` — a log of formatted weekly-digest bodies "delivered" (previewed) to the org.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AlertRule(Base):
    __tablename__ = "alert_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))          # one of alerts_engine.RULE_KINDS
    params_json: Mapped[str] = mapped_column(Text, default="{}")  # JSON object of thresholds
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class AlertEvent(Base):
    __tablename__ = "alert_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    appid: Mapped[int | None] = mapped_column(Integer, nullable=True)  # deep-link target, if any
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, index=True
    )
    seen: Mapped[bool] = mapped_column(Boolean, default=False)


class AlertState(Base):
    """Remembers the last observed value of a metric so edge evaluators can fire on *change*.

    One row per (org, rule, metric_key). ``metric_key`` is an engine-defined string that
    identifies exactly what is being tracked, e.g. ``"velocity:730"`` (trailing-30d reviews for
    appid 730), ``"reviews:730"`` (lifetime review count), ``"sentiment:730"`` (positive ratio).
    ``rule_id`` is nullable so state can also be kept for rule-independent/global metrics, but
    the edge evaluators always scope it to the owning rule so two rules of the same kind keep
    independent history.
    """

    __tablename__ = "alert_states"
    __table_args__ = (
        UniqueConstraint("org_id", "rule_id", "metric_key", name="uq_alert_state"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    rule_id: Mapped[int | None] = mapped_column(
        ForeignKey("alert_rules.id"), nullable=True, index=True
    )
    metric_key: Mapped[str] = mapped_column(String(120), index=True)  # e.g. "velocity:730"
    value: Mapped[float] = mapped_column(Float, default=0.0)          # REAL — last observed value
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class SentDigest(Base):
    """A formatted weekly-digest body that was 'sent' (previewed) for an org.

    No real SMTP is wired up — POST /api/alerts/digest/send renders the current digest into an
    email-style text body, stores it here, and returns the preview. This gives us a delivery
    record + history without any external dependency.
    """

    __tablename__ = "sent_digests"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    subject: Mapped[str] = mapped_column(String(300), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    signal_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, index=True
    )
