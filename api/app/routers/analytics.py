"""Collect endpoint for frontend usage analytics -> Prometheus counters (see analytics_metrics).

Public, unauthenticated, and deliberately thin: it validates a small batch, increments bounded
counters, and returns 204. Nothing is stored — the counters ARE the storage, scraped by
VictoriaMetrics and charted in Grafana. Unknown routes/events are silently ignored (bounded
cardinality), so the worst a bad client can do is inflate a known counter, never mint new series.
"""
from __future__ import annotations

import hmac
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import analytics_metrics
from ..config import settings

router = APIRouter(tags=["analytics"])

_MAX_BATCH = 50  # cap per request so one call can't do unbounded work


class AnalyticsEvent(BaseModel):
    type: str                 # "pageview" | "event"
    path: str | None = None   # present for type="pageview"
    name: str | None = None   # present for type="event"


class AnalyticsBatch(BaseModel):
    events: list[AnalyticsEvent] = Field(default_factory=list)


@router.post("/api/analytics/collect", status_code=204)
def collect(batch: AnalyticsBatch) -> None:
    for ev in batch.events[:_MAX_BATCH]:
        if ev.type == "pageview" and ev.path:
            analytics_metrics.record_pageview(ev.path)
        elif ev.type == "event" and ev.name:
            analytics_metrics.record_event(ev.name)


@router.get("/api/analytics/mcp-log", include_in_schema=False)
def mcp_log(token: str = Query(""), limit: int = Query(100, ge=1, le=500)) -> dict:
    """Owner-only viewer for the hosted MCP call log (what people ask the data).

    Gated by PROSPECT_ADMIN_TOKEN: with the token unset the endpoint 404s, so the log can
    never be exposed by a config that merely forgot to set it. Entries carry no user
    identifiers — see mcp_mount._log_call.
    """
    if not settings.admin_token:
        raise HTTPException(status_code=404)
    if not hmac.compare_digest(token, settings.admin_token):
        raise HTTPException(status_code=403)

    path = Path(settings.mcp_call_log_path) if settings.mcp_call_log_path else None
    if path is None or not path.exists():
        return {"total": 0, "entries": []}

    with path.open(encoding="utf-8") as fh:
        lines = fh.readlines()
    entries = []
    for line in lines[-limit:]:
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    entries.reverse()  # newest first
    return {"total": len(lines), "entries": entries}
