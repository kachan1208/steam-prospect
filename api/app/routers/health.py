from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import analytics_db
from ..auth import get_current_org
from ..models import Org
from ..schemas import Health

router = APIRouter(tags=["health"])


def _meta() -> dict:
    if not analytics_db.is_ready():
        return {}
    rows = analytics_db.query("SELECT key, value FROM mart_meta")
    return {r["key"]: r["value"] for r in rows}


@router.get("/api/health", response_model=Health)
def health(org: Org = Depends(get_current_org)) -> Health:
    meta = _meta()
    return Health(
        status="ok" if analytics_db.is_ready() else "degraded",
        mart_version=meta.get("mart_version"),
        built_at=meta.get("built_at"),
        source_db=meta.get("source_db"),
    )
