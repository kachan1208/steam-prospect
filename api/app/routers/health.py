from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import analytics_db
from ..schemas import Health

router = APIRouter(tags=["health"])


@router.get("/api/health", response_model=Health)
def health() -> Health:
    # Liveness: ALWAYS 200 (existing probes and the deploy healthcheck rely on it) — the
    # body says "degraded" when the analytics DB is absent. For a readiness signal that
    # actually gates traffic, use /api/health/ready below.
    #
    # The mart description comes from analytics_db's init-time copy of mart_meta, NOT from a
    # query: querying takes a cursor from the pool, and a saturated pool now sheds with a
    # 503 — which on this endpoint would tell DigitalOcean's health check and the nightly
    # restart verification that the container is dead precisely when it is merely busy, i.e.
    # restart-loop the box under load. Liveness must not depend on the pool.
    meta = analytics_db.mart_meta()
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
