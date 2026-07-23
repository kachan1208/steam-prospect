"""PROJECT router — the dev's own in-development game, its stage, and its competitors.

Owns the whole project surface for the current org:

  - Projects — ``GET ""`` (list), ``POST ""`` (create; the first project an org creates
               becomes active), ``PATCH /{id}`` (edit name/genre/stage/appid/is_active —
               setting one active unsets the others), ``DELETE /{id}`` (also drops its comps),
               and ``GET /active`` (the single active project, or ``null``).
  - Comps    — ``GET/POST/DELETE /{id}/comps``. A comp is just an appid, validated against
               ``mart_game``; the response enriches it with name + header_image.

Everything written here lives in the control DB via the org-scoped ``Project`` /
``ProjectComp`` models in ``project_models``; game facts (name, header_image, live signals)
are read from the analytics marts. Response models are defined in-file.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import analytics_db
from ..auth import get_current_org
from ..control_db import get_db
from ..models import Org
from ..project_models import STAGES, Project, ProjectComp

router = APIRouter(prefix="/api/projects", tags=["projects"])


# ---- schemas ----------------------------------------------------------------------------

class ProjectIn(BaseModel):
    name: str
    genre: Optional[str] = None
    stage: str = "production"
    appid: Optional[int] = None


class ProjectPatch(BaseModel):
    # All optional; only fields explicitly present in the request body are applied (so
    # `appid: null` / `genre: null` clears the value, while omitting it leaves it untouched).
    name: Optional[str] = None
    genre: Optional[str] = None
    stage: Optional[str] = None
    appid: Optional[int] = None
    is_active: Optional[bool] = None


class CompIn(BaseModel):
    appid: int


class ProjectCompOut(BaseModel):
    id: int
    appid: int
    name: Optional[str] = None
    header_image: Optional[str] = None
    primary_genre: Optional[str] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None
    live_players: Optional[int] = None


class ProjectOut(BaseModel):
    id: int
    appid: Optional[int] = None
    name: str
    genre: Optional[str] = None
    stage: str
    is_active: bool
    created_at: str
    comps_count: int
    # Enrichment of the project's own appid from mart_game (all null while it's a draft).
    header_image: Optional[str] = None
    steam_name: Optional[str] = None
    steam_genre: Optional[str] = None
    live_players: Optional[int] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None


# ---- helpers ----------------------------------------------------------------------------

def _validate_stage(stage: str) -> None:
    if stage not in STAGES:
        raise HTTPException(status_code=422, detail=f"stage must be one of {list(STAGES)}")


def _validate_appid(appid: int) -> None:
    exists = analytics_db.scalar("SELECT COUNT(*) FROM mart_game WHERE appid = ?", [appid])
    if not exists:
        raise HTTPException(status_code=404, detail=f"game not found: {appid}")


def _get_owned(db: Session, org: Org, project_id: int) -> Project:
    p = db.get(Project, project_id)
    if p is None or p.org_id != org.id:
        raise HTTPException(status_code=404, detail="Project not found.")
    return p


def _enrich_project(p: Project, db: Session) -> ProjectOut:
    comps_count = (
        db.scalar(select(func.count()).select_from(ProjectComp).where(ProjectComp.project_id == p.id))
        or 0
    )
    game: dict = {}
    if p.appid is not None:
        game = (
            analytics_db.query_one(
                "SELECT name, header_image, primary_genre, live_players, total_reviews, "
                "positive_ratio FROM mart_game WHERE appid = ?",
                [p.appid],
            )
            or {}
        )
    return ProjectOut(
        id=p.id,
        appid=p.appid,
        name=p.name,
        genre=p.genre,
        stage=p.stage,
        is_active=bool(p.is_active),
        created_at=p.created_at.isoformat() if p.created_at else "",
        comps_count=int(comps_count),
        header_image=game.get("header_image"),
        steam_name=game.get("name"),
        steam_genre=game.get("primary_genre"),
        live_players=game.get("live_players"),
        total_reviews=game.get("total_reviews"),
        positive_ratio=game.get("positive_ratio"),
    )


def _enrich_comp(c: ProjectComp) -> ProjectCompOut:
    game = (
        analytics_db.query_one(
            "SELECT name, header_image, primary_genre, total_reviews, positive_ratio, "
            "live_players FROM mart_game WHERE appid = ?",
            [c.appid],
        )
        or {}
    )
    return ProjectCompOut(
        id=c.id,
        appid=c.appid,
        name=game.get("name"),
        header_image=game.get("header_image"),
        primary_genre=game.get("primary_genre"),
        total_reviews=game.get("total_reviews"),
        positive_ratio=game.get("positive_ratio"),
        live_players=game.get("live_players"),
    )


def _deactivate_others(db: Session, org: Org, keep_id: int) -> None:
    others = db.scalars(
        select(Project).where(
            Project.org_id == org.id, Project.is_active.is_(True), Project.id != keep_id
        )
    ).all()
    for o in others:
        o.is_active = False


# ---- projects ---------------------------------------------------------------------------

@router.get("", response_model=list[ProjectOut])
def list_projects(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Project)
        .where(Project.org_id == org.id)
        .order_by(Project.is_active.desc(), Project.created_at.desc())
    ).all()
    return [_enrich_project(p, db) for p in rows]


@router.get("/active", response_model=Optional[ProjectOut])
def active_project(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    p = db.scalar(
        select(Project).where(Project.org_id == org.id, Project.is_active.is_(True))
    )
    return _enrich_project(p, db) if p is not None else None


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _validate_stage(payload.stage)
    if payload.appid is not None:
        _validate_appid(payload.appid)

    # The org's first project becomes the active spine automatically.
    has_any = db.scalar(select(Project.id).where(Project.org_id == org.id)) is not None
    is_active = not has_any

    row = Project(
        org_id=org.id,
        name=payload.name,
        genre=payload.genre,
        stage=payload.stage,
        appid=payload.appid,
        is_active=is_active,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _enrich_project(row, db)


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: int,
    payload: ProjectPatch,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    p = _get_owned(db, org, project_id)
    fields = payload.model_fields_set

    if "stage" in fields and payload.stage is not None:
        _validate_stage(payload.stage)
        p.stage = payload.stage
    if "name" in fields and payload.name is not None:
        p.name = payload.name
    if "genre" in fields:
        p.genre = payload.genre  # may be None to clear
    if "appid" in fields:
        if payload.appid is not None:
            _validate_appid(payload.appid)
        p.appid = payload.appid  # may be None to unlink (back to draft)
    if "is_active" in fields and payload.is_active is not None:
        if payload.is_active:
            _deactivate_others(db, org, keep_id=p.id)
            p.is_active = True
        else:
            p.is_active = False

    db.commit()
    db.refresh(p)
    return _enrich_project(p, db)


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: int,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    p = _get_owned(db, org, project_id)
    # No ORM cascade (no relationship on Org), so drop the project's comps explicitly.
    for c in db.scalars(select(ProjectComp).where(ProjectComp.project_id == p.id)).all():
        db.delete(c)
    db.delete(p)
    db.commit()


# ---- comps ------------------------------------------------------------------------------

@router.get("/{project_id}/comps", response_model=list[ProjectCompOut])
def list_comps(
    project_id: int,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _get_owned(db, org, project_id)
    rows = db.scalars(
        select(ProjectComp)
        .where(ProjectComp.project_id == project_id)
        .order_by(ProjectComp.created_at.desc())
    ).all()
    return [_enrich_comp(c) for c in rows]


@router.post("/{project_id}/comps", response_model=ProjectCompOut, status_code=201)
def add_comp(
    project_id: int,
    payload: CompIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _get_owned(db, org, project_id)
    _validate_appid(payload.appid)

    existing = db.scalar(
        select(ProjectComp).where(
            ProjectComp.project_id == project_id, ProjectComp.appid == payload.appid
        )
    )
    if existing is not None:
        # Idempotent: adding the same competitor twice just returns the existing row.
        return _enrich_comp(existing)

    row = ProjectComp(project_id=project_id, appid=payload.appid)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _enrich_comp(row)


@router.delete("/{project_id}/comps/{appid}", status_code=204)
def remove_comp(
    project_id: int,
    appid: int,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    _get_owned(db, org, project_id)
    row = db.scalar(
        select(ProjectComp).where(
            ProjectComp.project_id == project_id, ProjectComp.appid == appid
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Competitor not found on this project.")
    db.delete(row)
    db.commit()
