from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import analytics_db
from ..schemas import Health

router = APIRouter(tags=["health"])

_NOT_OPEN = "analytics database not open — the ETL hasn't produced current.duckdb yet"


@router.get("/api/health", response_model=Health)
def health() -> Health:
    # Liveness: ALWAYS 200 (existing probes and the deploy healthcheck rely on it) — the
    # body says "degraded" when the analytics DB is absent. For a readiness signal that
    # actually gates traffic, use /api/health/ready below.
    #
    # The mart description comes from analytics_db's per-generation copy of mart_meta and
    # an os.stat of the watched link, NOT from a query: querying takes a cursor from the
    # pool, and a saturated pool sheds with a 503 — which on this endpoint would tell the
    # deploy health check that the container is dead precisely when it is merely busy, i.e.
    # restart-loop the box under load. Liveness must not depend on the pool.
    meta = analytics_db.mart_meta()
    ready = analytics_db.is_ready()
    watch = analytics_db.watch_status()
    return Health(
        status="ok" if ready else "degraded",
        # WHY degraded, in words: "no mart yet" and "the mart file is corrupt" need very
        # different fixes, and both used to look identical from the outside.
        detail=None if ready else (analytics_db.unavailable_reason() or _NOT_OPEN),
        mart_version=meta.get("mart_version"),
        built_at=meta.get("built_at"),
        source_db=meta.get("source_db"),
        loaded_file=watch["loaded_file"],
        loaded_at=watch["loaded_at"],
        link_target=watch["link_target"],
        link_target_exists=watch["link_target_exists"],
        link_target_version=watch["link_target_version"],
        target_differs=watch["target_differs"],
        reload_error=watch["reload_error"],
        reload_interval_s=watch["reload_interval_s"],
    )


@router.get("/api/health/ready")
def ready() -> dict:
    """Readiness: 200 only when the analytics DB is open (endpoints can serve), 503
    otherwise — same status the data endpoints themselves return pre-ETL, so a router
    pointing traffic at this signal never sends requests into a wall of 503s."""
    if not analytics_db.is_ready():
        raise HTTPException(status_code=503, detail=analytics_db.missing_detail())
    return {"status": "ready"}
