"""Minimal in-process per-IP rate limiter (no new dependencies).

Applies ONLY to the surfaces a hostile or busted client can actually hammer to some
effect: POST /api/analytics/collect (public, unauthenticated, increments counters) and
everything under /mcp (the hosted MCP mount — each call runs real DuckDB work). The rest
of the API is read-only over precomputed marts and already bounded by the cursor pool, so
it is deliberately left un-limited.

Sliding window, per client IP: a deque of request timestamps within the last 60s per key.
Over the limit -> 429 with a Retry-After header (seconds until the oldest request leaves
the window). The limit is read from settings per request (env PROSPECT_RATE_LIMIT_PER_MIN,
default 120; 0 disables the middleware entirely), so tests — and a live operator via a
restart — can tune it without rebuilding the middleware stack.

In-process on purpose: the API is a single-process deployment (one uvicorn in one
container), so shared state is a dict, not Redis. State resets on restart — fine, the
window is a minute. Memory is bounded: timestamps are pruned as they age out, and the
whole table is cleared if it ever exceeds _MAX_TRACKED_IPS keys (an attacker cycling
spoofed source addresses would otherwise grow it without bound).

Registered by observability.setup_observability() INSIDE RequestContextMiddleware, so
429s still get request IDs + access-log lines, and CORS (outermost, see main.py) still
stamps its headers on them.
"""
from __future__ import annotations

import json
import time
from collections import deque
from math import ceil

from starlette.types import ASGIApp, Receive, Scope, Send

from .config import settings

_WINDOW_S = 60.0
_MAX_TRACKED_IPS = 10_000

# Injectable clock (monotonic — wall-clock jumps must not open/close the window).
_now = time.monotonic

# key (client ip) -> timestamps of requests inside the current window, oldest first.
_buckets: dict[str, deque[float]] = {}


def reset() -> None:
    """Drop all rate-limit state (test hook)."""
    _buckets.clear()


def _client_key(scope: Scope) -> str:
    # Behind the hosting proxy the peer address is the proxy's, so prefer the first
    # X-Forwarded-For hop when present. A direct client could spoof the header, but the
    # fallback (peer address) still buckets it — this is a coarse abuse valve, not auth.
    for name, value in scope.get("headers") or []:
        if name == b"x-forwarded-for":
            first = value.decode("latin-1").split(",")[0].strip()
            if first:
                return first
    client = scope.get("client")
    return client[0] if client else "unknown"


def _is_limited(scope: Scope) -> bool:
    path = scope.get("path", "")
    if path == "/mcp" or path.startswith("/mcp/"):
        return True
    return scope.get("method") == "POST" and path == "/api/analytics/collect"


class RateLimitMiddleware:
    """Pure-ASGI (same idiom as RequestContextMiddleware — nothing here buffers bodies)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        limit = settings.rate_limit_per_min
        if scope["type"] != "http" or limit <= 0 or not _is_limited(scope):
            await self.app(scope, receive, send)
            return

        now = _now()
        key = _client_key(scope)
        if len(_buckets) > _MAX_TRACKED_IPS:
            _buckets.clear()  # pathological key churn — shed state rather than memory
        bucket = _buckets.get(key)
        if bucket is None:
            bucket = _buckets[key] = deque()
        while bucket and bucket[0] <= now - _WINDOW_S:
            bucket.popleft()

        if len(bucket) >= limit:
            retry_after = max(1, ceil(bucket[0] + _WINDOW_S - now))
            body = json.dumps({"detail": "rate limit exceeded, retry later"}).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 429,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                        (b"retry-after", str(retry_after).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return

        bucket.append(now)
        await self.app(scope, receive, send)
