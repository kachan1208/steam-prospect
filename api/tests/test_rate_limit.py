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


# ---- client identity: only the hops OUR infrastructure wrote are believed ----------------
def test_a_spoofed_left_most_forwarded_for_cannot_mint_new_buckets(client, monkeypatch):
    """The killer bug: keying on the FIRST X-Forwarded-For hop let any client send a fresh
    fake address per request and never hit the limit. Production has exactly one trusted
    proxy (Caddy), which APPENDS the real peer — so only the last hop counts."""
    monkeypatch.setattr(settings, "rate_limit_per_min", 2)
    monkeypatch.setattr(settings, "trusted_proxy_hops", 1)
    spoofs = ("1.1.1.1", "2.2.2.2", "3.3.3.3")
    codes = [
        client.post(
            "/api/analytics/collect",
            json=_BATCH,
            headers={"X-Forwarded-For": f"{spoof}, 203.0.113.9"},  # ...Caddy's append
        ).status_code
        for spoof in spoofs
    ]
    assert codes == [204, 204, 429]
    assert list(rate_limit._buckets) == ["203.0.113.9"]  # one client, one bucket


def test_distinct_real_clients_still_get_their_own_window(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_per_min", 1)
    monkeypatch.setattr(settings, "trusted_proxy_hops", 1)
    for ip in ("203.0.113.1", "203.0.113.2"):
        r = client.post("/api/analytics/collect", json=_BATCH, headers={"X-Forwarded-For": ip})
        assert r.status_code == 204
    r = client.post(
        "/api/analytics/collect", json=_BATCH, headers={"X-Forwarded-For": "203.0.113.1"}
    )
    assert r.status_code == 429


def test_forwarded_for_is_ignored_without_a_trusted_proxy(client, monkeypatch):
    """PROSPECT_TRUSTED_PROXY_HOPS=0 (plain uvicorn, local dev): the header is unverifiable,
    so it is not read at all — every request buckets under the socket peer."""
    monkeypatch.setattr(settings, "rate_limit_per_min", 1)
    monkeypatch.setattr(settings, "trusted_proxy_hops", 0)
    assert client.post(
        "/api/analytics/collect", json=_BATCH, headers={"X-Forwarded-For": "9.9.9.9"}
    ).status_code == 204
    assert client.post(
        "/api/analytics/collect", json=_BATCH, headers={"X-Forwarded-For": "8.8.8.8"}
    ).status_code == 429
    assert list(rate_limit._buckets) == ["testclient"]  # the TestClient's socket peer


def test_a_chain_shorter_than_the_trusted_hops_falls_back_to_the_peer(client, monkeypatch):
    """Header present but the request did NOT come through the expected proxy chain — the
    only entry is the caller's own, so it is not trusted."""
    monkeypatch.setattr(settings, "rate_limit_per_min", 5)
    monkeypatch.setattr(settings, "trusted_proxy_hops", 2)
    client.post("/api/analytics/collect", json=_BATCH, headers={"X-Forwarded-For": "9.9.9.9"})
    assert list(rate_limit._buckets) == ["testclient"]


def test_overflow_evicts_the_stalest_key_not_the_whole_table(client, monkeypatch):
    """Clearing the table dropped every honest client's window — and lifted the limit for a
    minute — whenever an attacker churned enough keys. Now the oldest key goes, one at a
    time, and an active client's window survives the churn."""
    monkeypatch.setattr(settings, "rate_limit_per_min", 100)
    monkeypatch.setattr(settings, "trusted_proxy_hops", 1)
    monkeypatch.setattr(rate_limit, "_MAX_TRACKED_IPS", 3)

    victim = {"X-Forwarded-For": "203.0.113.7"}
    assert client.post("/api/analytics/collect", json=_BATCH, headers=victim).status_code == 204
    for i in range(20):  # attacker churns source addresses
        client.post(
            "/api/analytics/collect", json=_BATCH, headers={"X-Forwarded-For": f"198.51.100.{i}"}
        )
        client.post("/api/analytics/collect", json=_BATCH, headers=victim)  # stays warm

    assert len(rate_limit._buckets) <= 3  # bounded
    # The active client was never evicted and — the point — never lost its window: all 21
    # of its requests are still counted. The old whole-table clear reset it on every churn.
    assert len(rate_limit._buckets["203.0.113.7"]) == 21


def test_429_still_carries_a_request_id(client, monkeypatch):
    """The limiter is registered inside RequestContextMiddleware — its rejections must
    still be observable (X-Request-ID + an access-log line)."""
    monkeypatch.setattr(settings, "rate_limit_per_min", 1)
    assert client.post("/api/analytics/collect", json=_BATCH).status_code == 204
    r = client.post("/api/analytics/collect", json=_BATCH)
    assert r.status_code == 429
    assert r.headers.get("X-Request-ID")
