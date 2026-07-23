"""SQLAlchemy models for the PROJECT concept — a dev's own in-development game.

A Project is the spine the whole app pivots around: the dev's game, its stage, and a
short list of competitor appids (``ProjectComp``). Both tables hang off the shared
control-plane ``models.Base`` so they are created by ``control_db.init_db()``'s
``Base.metadata.create_all()`` — importing this module is what registers them on the
shared metadata, so it must be imported before ``init_db()`` runs. ``routers/projects.py``
imports it (and main.py imports that router), and main.py should also import it explicitly
alongside the other watchtower models so the tables are always registered by the time the
FastAPI lifespan calls ``init_db()``.

We deliberately do NOT call ``create_all`` here (the control plane owns that) and do NOT add
ORM relationships back onto ``Org`` (that would require editing models.py) — the plain
foreign key is all the engine and router need.

  - ``projects``      — one row per game a dev is working on; ``is_active`` marks the spine.
  - ``project_comps`` — competitor appids attached to a project (validated against mart_game).
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base

# The lifecycle stages a project can be in. Mirrored by the web MyGame stage <select> and
# validated in routers/projects.py; kept here as the single source of truth.
STAGES = ("prototype", "production", "announced", "demo", "launched")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id"), index=True)
    # The dev's game on Steam, or NULL while it's still a draft (unannounced / no store page).
    appid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    name: Mapped[str] = mapped_column(String(200))
    genre: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # One of STAGES; free-form column so a future stage doesn't need a migration.
    stage: Mapped[str] = mapped_column(String(40), default="production")
    # Exactly one project per org is the "active" spine (enforced in the router, not the DB).
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class ProjectComp(Base):
    __tablename__ = "project_comps"
    __table_args__ = (UniqueConstraint("project_id", "appid", name="uq_project_comp"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    appid: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
