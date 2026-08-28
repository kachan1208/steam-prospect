"""rate_limit.RateLimitMiddleware — per-IP sliding window on the two abusable surfaces.

Scope: POST /api/analytics/collect and /mcp/* are limited; the read-only mart API is not.
The limit is read from settings per request (PROSPECT_RATE_LIMIT_PER_MIN; 0 disables), so
these tests tune it with monkeypatch instead of firing 120 requests. The clock is the
module's injectable `_now`, so window expiry is tested by moving time, not sleeping.
"""
from __future__ import annotations

import pytest

from app import rate_limit
from app.config import settings

_BATCH = {"events": [{"type": "pageview", "path": "/games"}]}


@pytest.fixture(autouse=True)
def _clean_buckets():
    rate_limit.reset()
    yield
    rate_limit.reset()


def test_collect_429s_past_the_limit_with_retry_after(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_per_min", 3)
    for _ in range(3):
        assert client.post("/api/analytics/collect", json=_BATCH).status_code == 204
    r = client.post("/api/analytics/collect", json=_BATCH)
    assert r.status_code == 429
    assert r.json()["detail"] == "rate limit exceeded, retry later"
    assert 1 <= int(r.headers["Retry-After"]) <= 60


def test_window_slides_open_again(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_per_min", 2)
    t = {"now": 1000.0}
    monkeypatch.setattr(rate_limit, "_now", lambda: t["now"])

    assert client.post("/api/analytics/collect", json=_BATCH).status_code == 204
    assert client.post("/api/analytics/collect", json=_BATCH).status_code == 204
    assert client.post("/api/analytics/collect", json=_BATCH).status_code == 429

    t["now"] += 61.0  # both recorded requests age out of the 60s window
    assert client.post("/api/analytics/collect", json=_BATCH).status_code == 204


def test_zero_disables_the_limiter(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_per_min", 0)
    for _ in range(10):
        assert client.post("/api/analytics/collect", json=_BATCH).status_code == 204


def test_mcp_paths_are_limited_even_when_the_mount_is_off(client, monkeypatch):
    """PROSPECT_ENABLE_MCP is off in tests so /mcp 404s — but the limiter sits in front of
    routing, which is exactly what production wants (it guards the mount when enabled)."""
    monkeypatch.setattr(settings, "rate_limit_per_min", 2)
    assert client.get("/mcp/tools").status_code == 404
    assert client.get("/mcp/tools").status_code == 404
    assert client.get("/mcp/tools").status_code == 429


def test_read_api_is_never_limited(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_per_min", 1)
    for _ in range(4):
        assert client.get("/api/health").status_code == 200


def test_429_still_carries_a_request_id(client, monkeypatch):
    """The limiter is registered inside RequestContextMiddleware — its rejections must
    still be observable (X-Request-ID + an access-log line)."""
    monkeypatch.setattr(settings, "rate_limit_per_min", 1)
    assert client.post("/api/analytics/collect", json=_BATCH).status_code == 204
    r = client.post("/api/analytics/collect", json=_BATCH)
    assert r.status_code == 429
    assert r.headers.get("X-Request-ID")
