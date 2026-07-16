from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_org, get_entitlements
from ..control_db import get_db
from ..entitlements import Entitlements
from ..models import Org, SavedView
from ..schemas import SavedViewIn, SavedViewOut

router = APIRouter(prefix="/api/views", tags=["views"])


def _to_out(v: SavedView) -> SavedViewOut:
    try:
        config = json.loads(v.config_json)
    except (json.JSONDecodeError, TypeError):
        config = {}
    return SavedViewOut(
        id=v.id, name=v.name, surface=v.surface, config=config,
        created_at=v.created_at.isoformat() if v.created_at else "",
    )


@router.get("", response_model=list[SavedViewOut])
def list_views(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    views = db.scalars(
        select(SavedView).where(SavedView.org_id == org.id).order_by(SavedView.created_at.desc())
    ).all()
    return [_to_out(v) for v in views]


@router.post("", response_model=SavedViewOut, status_code=201)
def create_view(
    payload: SavedViewIn,
    org: Org = Depends(get_current_org),
    ent: Entitlements = Depends(get_entitlements),
    db: Session = Depends(get_db),
):
    if ent.max_saved_views is not None:
        count = len(db.scalars(select(SavedView).where(SavedView.org_id == org.id)).all())
        if count >= ent.max_saved_views:
            raise HTTPException(status_code=402, detail="Saved-view limit reached for your plan.")
    view = SavedView(
        org_id=org.id,
        name=payload.name,
        surface=payload.surface,
        config_json=json.dumps(payload.config),
    )
    db.add(view)
    db.commit()
    db.refresh(view)
    return _to_out(view)


@router.delete("/{view_id}", status_code=204)
def delete_view(view_id: int, org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    view = db.get(SavedView, view_id)
    if view is None or view.org_id != org.id:
        raise HTTPException(status_code=404, detail="View not found.")
    db.delete(view)
    db.commit()
