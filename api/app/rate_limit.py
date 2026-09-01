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

The client identity is the last TRUSTED hop, never a client-supplied one — see
_client_key(): the left-most X-Forwarded-For entry is written by whoever is calling, so
keying on it let any client mint a fresh bucket per request and ignore the limit entirely.

PER WORKER, not per deployment: production runs `uvicorn --workers 2` (deploy/entrypoint.sh
— one worker per vCPU), and each forked worker has its own copy of this dict, so the
GLOBAL ceiling for one client is workers x rate_limit_per_min (240/min today) and which
worker sees a given connection is up to the kernel's accept balancing. Left that way
deliberately: dividing the configured limit by WEB_CONCURRENCY would make the ceiling exact
but the FLOOR limit/workers, throttling an honest client whose connections all land on one
worker (the SPA's own analytics beacons, first), and the only correct fix is shared state
(Redis) — a network dependency and a new failure mode for a personal-scale tool. This is a
coarse abuse valve on two surfaces, not a quota: 120 vs 240 req/min is the same answer to
"is someone hammering us". State also resets on restart — fine, the window is a minute.

Memory is bounded: timestamps are pruned as they age out, and past _MAX_TRACKED_IPS keys
the LEAST-RECENTLY-SEEN entries are evicted one at a time (an attacker cycling source
addresses would otherwise grow the table without bound; clearing the WHOLE table instead
would reset every honest client's window — and briefly lift the limit — exactly when the
limiter is most needed).

Registered by observability.setup_observability() INSIDE RequestContextMiddleware, so
429s still get request IDs + access-log lines, and CORS (outermost, see main.py) still
stamps its headers on them.
"""
from __future__ import annotations

import json
import time
from collections import OrderedDict, deque
from math import ceil

from starlette.types import ASGIApp, Receive, Scope, Send

from .config import settings

_WINDOW_S = 60.0
_MAX_TRACKED_IPS = 10_000

# Injectable clock (monotonic — wall-clock jumps must not open/close the window).
_now = time.monotonic

# key (client ip) -> timestamps of requests inside the current window, oldest first.
# Ordered least-recently-seen first, so overflow evicts the stalest key (see __call__).
_buckets: "OrderedDict[str, deque[float]]" = OrderedDict()


def reset() -> None:
    """Drop all rate-limit state (test hook)."""
    _buckets.clear()


def _client_key(scope: Scope) -> str:
    """Identify the caller by the last hop we can actually trust.

    X-Forwarded-For is a client-writable list: the app must only believe the entries its own
    infrastructure appended, i.e. the right-most `settings.trusted_proxy_hops` of them. In
    production that is 1 (deploy/entrypoint.sh sets it) — Caddy on the droplet terminates
    TLS and reverse-proxies to 127.0.0.1:8080 (the container port is bound to loopback, so
    nothing else can reach the app), and Caddy appends the real peer address to whatever the
    client sent. Taking the LEFT-most hop instead, as this did, handed the key straight to
    the caller: `X-Forwarded-For: <random>` on every request meant a fresh bucket every
    request and no limit at all.

    With trusted_proxy_hops = 0 (no trusted proxy in front — plain `uvicorn`, local dev) the
    header is ignored entirely and the socket peer is used. Same fallback whenever the chain
    is shorter than the configured number of trusted hops, i.e. the request did not come
    through the expected proxy.
    """
    hops = settings.trusted_proxy_hops
    if hops > 0:
        # Split on ALL x-forwarded-for headers in order: a proxy that folds multiples into
        # one (Caddy/Go does) still leaves the address it wrote itself last.
        chain: list[str] = []
        for name, value in scope.get("headers") or []:
            if name == b"x-forwarded-for":
                chain += [p.strip() for p in value.decode("latin-1").split(",") if p.strip()]
        if len(chain) >= hops:
            return chain[-hops]
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
        bucket = _buckets.get(key)
        if bucket is None:
            bucket = _buckets[key] = deque()
        else:
            _buckets.move_to_end(key)  # seen now -> youngest end; eviction takes the other
        while len(_buckets) > _MAX_TRACKED_IPS:
            # Pathological key churn: drop the least-recently-seen key, NOT the whole table
            # (that reset every honest client's window and briefly disabled the limit).
            _buckets.popitem(last=False)
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
