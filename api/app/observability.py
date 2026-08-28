"""Observability middleware.

Wired once from main.py via setup_observability(app), called BEFORE the existing
CORSMiddleware registration — Starlette's add_middleware() makes the LAST-added
middleware outermost (see main.py for the full ordering rationale), so calling this
first keeps CORS wrapping everything else, including an early exception, exactly as
it does today.

Four pieces:
  - Metrics: prometheus-fastapi-instrumentator exposes GET /metrics in the standard
    Prometheus exposition format — VictoriaMetrics (or Prometheus) scrapes this
    directly, no special wiring needed on the VM side beyond a scrape target.
  - Request logging: a pure-ASGI middleware (NOT BaseHTTPMiddleware, which buffers/
    re-chunks response bodies through its own iterator — kept raw so any streamed
    response passes through untouched) that stamps every request with a UUID
    (`X-Request-ID` response header + `request.state.request_id`), times it, and
    emits one structured JSON log line per request.
  - Rate limiting: rate_limit.RateLimitMiddleware (per-IP sliding window on
    POST /api/analytics/collect + /mcp; env-tunable, see that module). Added FIRST,
    so it sits innermost — its 429s still get request IDs and access-log lines.
  - Sentry: env-gated on PROSPECT_SENTRY_DSN. A no-op (no init call at all) when
    unset, so local dev has zero Sentry footprint and no network calls.
"""
from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import settings

_JSON_LOG_CONFIGURED = False


# ==========================================================================================
# Structured JSON logging (shared by the request-logging middleware and any other
# `logging.getLogger(...)` call in the process once configured).
# ==========================================================================================
class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_json_logging(level: int = logging.INFO) -> None:
    """Idempotent — safe to call every time main.py is imported (e.g. uvicorn --reload)."""
    global _JSON_LOG_CONFIGURED
    if _JSON_LOG_CONFIGURED:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    _JSON_LOG_CONFIGURED = True


request_logger = logging.getLogger("prospect.request")


# ==========================================================================================
# O3(b): request-ID + structured access-log middleware
# ==========================================================================================
class RequestContextMiddleware:
    """Pure-ASGI middleware: assigns a per-request UUID (returned as the `X-Request-ID`
    response header, and stashed on `scope['state']['request_id']` so route handlers can
    read it via `request.state.request_id`), times the request, and emits one JSON access-
    log line on completion.

    Written as raw ASGI rather than Starlette's BaseHTTPMiddleware so response bodies
    pass through untouched instead of being buffered/re-chunked — BaseHTTPMiddleware
    wraps the whole body in its own iterator, which is exactly the kind of interference
    a streamed response (SSE, chunked downloads) can't tolerate. No current route
    streams (the old chat SSE router is gone), but the raw-ASGI form costs nothing and
    keeps that door open.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = uuid.uuid4().hex
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        start = time.perf_counter()
        status_holder = {"status": 0}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                headers = MutableHeaders(scope=message)
                headers.append("X-Request-ID", request_id)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            self._log(scope, request_id, status_holder["status"] or 500, start)
            raise
        else:
            self._log(scope, request_id, status_holder["status"], start)

    @staticmethod
    def _log(scope: Scope, request_id: str, status_code: int, start: float) -> None:
        duration_ms = (time.perf_counter() - start) * 1000
        client = scope.get("client")
        request_logger.info(
            "request",
            extra={
                "fields": {
                    "request_id": request_id,
                    "method": scope.get("method"),
                    "path": scope.get("path"),
                    "query": (scope.get("query_string") or b"").decode("latin-1"),
                    "status_code": status_code,
                    "duration_ms": round(duration_ms, 2),
                    "client_ip": client[0] if client else None,
                }
            },
        )


# ==========================================================================================
# O3(a): metrics (VictoriaMetrics/Prometheus scrape target)
# ==========================================================================================
def _setup_metrics(app: Any) -> None:
    from prometheus_fastapi_instrumentator import Instrumentator, metrics

    inst = Instrumentator(
        should_group_status_codes=True,
        should_ignore_untemplated=True,
        # Long-lived streamed responses would skew the request-latency histogram, so
        # streaming duration is excluded (request COUNT is still tracked). No current
        # route streams — kept for the same forward-compatibility reason as the raw-ASGI
        # RequestContextMiddleware.
        should_exclude_streaming_duration=True,
        excluded_handlers=["/metrics"],
    )
    # Explicit metrics so the latency histogram has FINE buckets. The instrumentator default
    # is only 0.1/0.5/1s, which clamps p95/p99 for a fast API where nearly everything finishes
    # under 100ms (why every endpoint looked ~50-95ms). Adding our own metrics also replaces
    # the coarse default set. Names (http_requests_total / http_request_duration_seconds) are
    # unchanged, so existing dashboards keep working — just with real percentile resolution.
    inst.add(metrics.requests())
    inst.add(
        metrics.latency(
            buckets=(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 10.0),
        )
    )
    inst.instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


# ==========================================================================================
# O3(c): Sentry — env-gated, NO-OP without PROSPECT_SENTRY_DSN
# ==========================================================================================
def _setup_sentry() -> None:
    if not settings.sentry_dsn:
        return  # NO-OP: no DSN configured -> no import, no init, zero footprint.
    try:
        import sentry_sdk
    except ImportError:
        request_logger.warning(
            "PROSPECT_SENTRY_DSN is set but sentry-sdk isn't installed; skipping Sentry init."
        )
        return
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        release=f"{settings.api_title}@{settings.api_version}",
        traces_sample_rate=settings.sentry_traces_sample_rate,
        send_default_pii=False,
    )



# ==========================================================================================
# Entry point — call once, right after `FastAPI()` and BEFORE `app.add_middleware(CORSMiddleware, ...)`.
# ==========================================================================================
def setup_observability(app: Any) -> None:
    from .rate_limit import RateLimitMiddleware

    configure_json_logging()
    _setup_sentry()
    _setup_metrics(app)
    # Order is load-bearing (last-added = outermost): the rate limiter goes innermost so
    # RequestContextMiddleware still logs its 429s, and CORS (added later, in main.py)
    # wraps both.
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(RequestContextMiddleware)  # outermost here: logs everything
