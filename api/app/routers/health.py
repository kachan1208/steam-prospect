from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import analytics_db
from ..schemas import Health

router = APIRouter(tags=["health"])


def _meta() -> dict:
    if not analytics_db.is_ready():
        return {}
    rows = analytics_db.query("SELECT key, value FROM mart_meta")
    return {r["key"]: r["value"] for r in rows}


@router.get("/api/health", response_model=Health)
def health() -> Health:
    # Liveness: ALWAYS 200 (existing probes and the deploy healthcheck rely on it) — the
    # body says "degraded" when the analytics DB is absent. For a readiness signal that
    # actually gates traffic, use /api/health/ready below.
    meta = _meta()
    return Health(
        status="ok" if analytics_db.is_ready() else "degraded",
        mart_version=meta.get("mart_version"),
        built_at=meta.get("built_at"),
        source_db=meta.get("source_db"),
    )


@router.get("/api/health/ready")
def ready() -> dict:
    """Readiness: 200 only when the analytics DB is open (endpoints can serve), 503
    otherwise — same status the data endpoints themselves return pre-ETL, so a router
    pointing traffic at this signal never sends requests into a wall of 503s."""
    if not analytics_db.is_ready():
        raise HTTPException(
            status_code=503,
            detail="analytics database not available — the ETL hasn't produced current.duckdb yet",
        )
    return {"status": "ready"}
