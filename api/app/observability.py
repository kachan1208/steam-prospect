"""Observability (O3) + request-level hardening (O4) middleware.

Wired once from main.py via setup_observability(app), called BEFORE the existing
CORSMiddleware registration — Starlette's add_middleware() makes the LAST-added
middleware outermost (see main.py for the full ordering rationale), so calling this
first keeps CORS wrapping everything else, including a 429 from the rate limiter or
an early exception, exactly as it does today.

Three O3 pieces:
  - Metrics: prometheus-fastapi-instrumentator exposes GET /metrics in the standard
    Prometheus exposition format — VictoriaMetrics (or Prometheus) scrapes this
    directly, no special wiring needed on the VM side beyond a scrape target.
  - Request logging: a pure-ASGI middleware (NOT BaseHTTPMiddleware, which can
    buffer/interfere with StreamingResponse — the chat endpoint streams SSE and must
    reach the client incrementally) that stamps every request with a UUID
    (`X-Request-ID` response header + `request.state.request_id`), times it, and
    emits one structured JSON log line per request.
  - Sentry: env-gated on PROSPECT_SENTRY_DSN. A no-op (no init call at all) when
    unset, so local/solo dev has zero Sentry footprint and no network calls.

One O4 piece (bundled here rather than a new file, to keep this task's edit surface
to the files it was scoped to touch):
  - Rate limiting: an in-process, per-key request throttle. Keyed by org today (solo
    mode's single seeded org) with a header/IP-keyed fallback for whenever real
    multi-tenant auth exists; the ceiling is always read from entitlements.py, never
    hardcoded here. In solo mode entitlements() returns rate_limit_per_minute=None
    (unlimited), so this is a pass-through today by construction — see
    RateLimitMiddleware's docstring.
"""
from __future__ import annotations

import json
import logging
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
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

    Written as raw ASGI rather than Starlette's BaseHTTPMiddleware so StreamingResponse
    bodies (the chat SSE endpoint, routers/chat.py) pass through untouched instead of being
    buffered/re-chunked — BaseHTTPMiddleware wraps the whole response body in its own
    iterator, which is exactly the kind of interference an SSE stream can't tolerate.
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
    from prometheus_fastapi_instrumentator import Instrumentator

    Instrumentator(
        should_group_status_codes=True,
        should_ignore_untemplated=True,
        # The chat SSE stream can run for tens of seconds; excluding streaming duration
        # keeps the request-latency histogram meaningful for the rest of the API instead
        # of getting skewed by long-lived connections (request COUNT is still tracked).
        should_exclude_streaming_duration=True,
        excluded_handlers=["/metrics"],
    ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


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
# O4: rate-limit middleware (per-key, in-process)
# ==========================================================================================
class _FixedWindowLimiter:
    """In-process fixed-window counter (per key, per 60s window). No external store —
    correct for a single-process deployment; swap for a Redis-backed limiter if/when this
    ever runs multi-worker/multi-process."""

    def __init__(self) -> None:
        self._windows: dict[str, tuple[int, int]] = {}  # key -> (window_start_minute, count)
        self._lock = threading.Lock()

    def hit(self, key: str, limit_per_minute: int) -> tuple[bool, int]:
        """Record one hit for `key`; returns (allowed, retry_after_seconds)."""
        now = time.time()
        window = int(now // 60)
        with self._lock:
            win_start, count = self._windows.get(key, (window, 0))
            if win_start != window:
                win_start, count = window, 0
            count += 1
            self._windows[key] = (win_start, count)
            # Cheap, bounded cleanup: an in-process dict of recent keys never grows large
            # for this app's traffic shape, but drop clearly-stale entries opportunistically
            # so a long-running process doesn't accumulate one entry per distinct IP forever.
            if len(self._windows) > 10_000:
                stale = [k for k, (w, _) in self._windows.items() if w < window - 2]
                for k in stale:
                    del self._windows[k]
        if count > limit_per_minute:
            return False, 60 - int(now % 60)
        return True, 0


_solo_org_cache: Any = None
_solo_org_lock = threading.Lock()


def _get_solo_org() -> Any:
    """Cached lookup of the seeded solo org (there is only ever one). Looking this up for
    real — rather than re-deriving the solo_mode shortcut here — is what lets the rate
    limiter genuinely source its ceiling from entitlements.py instead of hardcoding
    "unlimited" a second time in this file."""
    global _solo_org_cache
    if _solo_org_cache is None:
        with _solo_org_lock:
            if _solo_org_cache is None:
                from sqlalchemy import select

                from . import control_db
                from .models import Org

                db = control_db.SessionLocal()
                try:
                    _solo_org_cache = db.scalar(
                        select(Org).where(Org.slug == settings.solo_org_slug)
                    )
                finally:
                    db.close()
    return _solo_org_cache


class RateLimitMiddleware:
    """Per-key request throttle. The ceiling always comes from `entitlements.py` — never a
    number hardcoded here — so plan changes there apply without touching this file.

    In solo mode (the only mode that runs today: auth.py's non-solo branch
    unconditionally 401s, so `settings.solo_mode` is effectively always True in any real
    deployment of this codebase) this resolves to the single seeded org and
    `entitlements()` returns `rate_limit_per_minute=None` -> unlimited -> pass-through by
    construction, per the plan's "pass-through/unlimited in solo mode" requirement.

    The non-solo branch is scaffolding for once auth.py can resolve a real org from an
    API key: it buckets by the presented `X-API-Key` header (or client IP with none) and
    applies a flat config default (`settings.rate_limit_per_minute`) today, since there is
    no verified org to call `entitlements()` on yet — swap in a verified-org lookup +
    `entitlements(org).rate_limit_per_minute` there the moment auth.py can produce one,
    mirroring the solo-mode branch below.
    """

    PUBLIC_PATHS = {"/metrics", "/", "/docs", "/openapi.json", "/redoc"}

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self._limiter = _FixedWindowLimiter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") == "OPTIONS"
            or scope.get("path") in self.PUBLIC_PATHS
        ):
            await self.app(scope, receive, send)
            return

        key, limit = self._resolve(scope)
        if limit is not None:
            allowed, retry_after = self._limiter.hit(key, limit)
            if not allowed:
                response = JSONResponse(
                    {"detail": "Rate limit exceeded. Slow down and retry shortly."},
                    status_code=429,
                    headers={"Retry-After": str(retry_after)},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)

    @staticmethod
    def _resolve(scope: Scope) -> tuple[str, int | None]:
        from .entitlements import entitlements

        if settings.solo_mode:
            org = _get_solo_org()
            limit = entitlements(org).rate_limit_per_minute if org is not None else None
            return f"org:{settings.solo_org_slug}", limit

        headers = Headers(scope=scope)
        api_key = headers.get("x-api-key")
        if api_key:
            return f"key:{api_key[:12]}", settings.rate_limit_per_minute
        client = scope.get("client")
        return f"ip:{client[0] if client else 'unknown'}", settings.rate_limit_per_minute


# ==========================================================================================
# Entry point — call once, right after `FastAPI()` and BEFORE `app.add_middleware(CORSMiddleware, ...)`.
# ==========================================================================================
def setup_observability(app: Any) -> None:
    configure_json_logging()
    _setup_sentry()
    app.add_middleware(RateLimitMiddleware)  # innermost of these three: throttle first
    _setup_metrics(app)  # wraps the limiter so 429s are still counted in /metrics
    app.add_middleware(RequestContextMiddleware)  # outermost of these three: logs everything
