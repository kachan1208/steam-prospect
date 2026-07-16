"""Alerts CRUD — create/list/delete saved alerts for the current org.

Alerts are *evaluated* by api/app/alerts_eval.py (invoked post-ETL via
`python -m app.alerts_eval`), not here — this router only manages the Alert rows
themselves. See alerts_eval.py's module docstring for the supported `kind` values and what
`target`/`threshold` mean for each; validate_alert_fields() there is reused here so a
malformed alert is rejected at creation time instead of silently no-op-ing forever at
eval time.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alerts_eval import validate_alert_fields
from ..auth import get_current_org
from ..control_db import get_db
from ..models import Alert, Org

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


class AlertIn(BaseModel):
    kind: Literal["new_in_niche", "niche_median_rev", "watchlist_velocity"]
    target: str = ""
    threshold: Optional[str] = None


class AlertOut(BaseModel):
    id: int
    kind: str
    target: str
    threshold: Optional[str] = None
    active: bool
    created_at: str


def _to_out(a: Alert) -> AlertOut:
    return AlertOut(
        id=a.id,
        kind=a.kind,
        target=a.target,
        threshold=a.threshold,
        active=a.active,
        created_at=a.created_at.isoformat() if a.created_at else "",
    )


@router.get("", response_model=list[AlertOut])
def list_alerts(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Alert).where(Alert.org_id == org.id).order_by(Alert.created_at.desc())
    ).all()
    return [_to_out(a) for a in rows]


@router.post("", response_model=AlertOut, status_code=201)
def create_alert(
    payload: AlertIn,
    org: Org = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    try:
        validate_alert_fields(payload.kind, payload.target, payload.threshold)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    row = Alert(org_id=org.id, kind=payload.kind, target=payload.target, threshold=payload.threshold)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/{alert_id}", status_code=204)
def delete_alert(alert_id: int, org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    row = db.get(Alert, alert_id)
    if row is None or row.org_id != org.id:
        raise HTTPException(status_code=404, detail="Alert not found.")
    db.delete(row)
    db.commit()
