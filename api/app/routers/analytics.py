"""Collect endpoint for frontend usage analytics -> Prometheus counters (see analytics_metrics).

Public, unauthenticated, and deliberately thin: it validates a small batch, increments bounded
counters, and returns 204. Nothing is stored — the counters ARE the storage, scraped by
VictoriaMetrics and charted in Grafana. Unknown routes/events are silently ignored (bounded
cardinality), so the worst a bad client can do is inflate a known counter, never mint new series.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import analytics_metrics

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
