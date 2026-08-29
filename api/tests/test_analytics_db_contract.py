"""analytics_db's request-facing failure contract.

main.py's lifespan deliberately keeps the app up when the ETL hasn't produced
current.duckdb ("endpoints will 503") — that promise is enforced centrally in
analytics_db._cursor(), so EVERY router honors it, not just the two that used to check
is_ready() themselves. Same place enforces the bounded pool wait: with 4 cursors against
a 40-connection flood, an unbounded `Queue.get()` parked every worker forever (a
documented production hang); now it sheds with a 503 + Retry-After — bounded per
acquisition AND per request, since handlers acquire once per query.
"""
from __future__ import annotations

import time

import pytest
from fastapi import HTTPException

from app import analytics_db
from app.config import settings


@pytest.fixture
def uninitialised_db(client):
    """Close the analytics DB for one test, then restore the shared fixture mart.

    Depends on `client` so the app's lifespan has already run init() — otherwise the
    restore would race the session fixture's own startup."""
    analytics_db.close()
    try:
        yield client
    finally:
        analytics_db.init(settings.analytics_db_path, settings.analytics_pool_size)


def test_endpoints_503_not_500_when_db_missing(uninitialised_db):
    # A sample of routers that historically had NO is_ready() check of their own and
    # leaked RuntimeError 500s: games, niches, market, seasonality.
    for path in (
        "/api/games/search",
        "/api/games/1001",
        "/api/niches",
        "/api/market/benchmarks",
        "/api/seasonality",
        "/api/launch-curve",
    ):
        r = uninitialised_db.get(path)
        assert r.status_code == 503, path
        assert "analytics database not available" in r.json()["detail"], path


def test_routers_with_their_own_check_still_503(uninitialised_db):
    # entities/timing had their own is_ready() guard — behavior unchanged.
    assert uninitialised_db.get("/api/entities/search").status_code == 503
    assert uninitialised_db.get("/api/timing/overview").status_code == 503


def test_pool_exhaustion_sheds_with_503_and_retry_after(client, monkeypatch):
    monkeypatch.setattr(analytics_db, "_ACQUIRE_TIMEOUT_S", 0.05)
    pool = analytics_db._pool
    assert pool is not None
    held = []
    while True:  # drain every cursor so the next request finds an empty pool
        try:
            held.append(pool.get_nowait())
        except Exception:
            break
    try:
        r = client.get("/api/games/1001")
        assert r.status_code == 503
        assert "server busy" in r.json()["detail"]
        assert r.headers.get("Retry-After") == "5"
    finally:
        for cur in held:
            pool.put(cur)
    # Pool restored: the same request works again.
    assert client.get("/api/games/1001").status_code == 200


def test_mart_version_read_once_at_init(client):
    assert analytics_db.mart_version() == "test-fixture"


def test_mart_version_none_when_closed(uninitialised_db):
    assert analytics_db.mart_version() is None


def test_mart_meta_is_cached_whole(client):
    """The liveness probe describes the mart from this dict instead of querying it."""
    meta = analytics_db.mart_meta()
    assert meta["mart_version"] == "test-fixture"
    assert meta["built_at"] == "2026-01-01T00:00:00+00:00"
    assert meta["source_db"] == "fixture"
    assert analytics_db.built_at() == "2026-01-01T00:00:00+00:00"
    analytics_db.mart_meta()["mart_version"] = "mutated"  # a copy: callers can't corrupt it
    assert analytics_db.mart_version() == "test-fixture"


def test_mart_meta_empty_when_closed(uninitialised_db):
    assert analytics_db.mart_meta() == {}
    assert analytics_db.built_at() is None


# ---- the per-REQUEST wait budget -------------------------------------------------------
@pytest.fixture
def drained_pool(client):
    """Check out every cursor for the duration of a test, then put them all back."""
    pool = analytics_db._pool
    assert pool is not None
    held = []
    while True:
        try:
            held.append(pool.get_nowait())
        except Exception:
            break
    try:
        yield pool
    finally:
        for cur in held:
            pool.put(cur)


def test_budget_bounds_the_whole_request_not_each_query(drained_pool, monkeypatch):
    """_ACQUIRE_TIMEOUT_S bounds ONE acquisition, and handlers acquire per query (niche
    detail issues ~12), so the per-acquire bound alone allowed 12x the wait — minutes, the
    very wedge the bound exists to prevent. The request-wide deadline caps the total."""
    monkeypatch.setattr(analytics_db, "_ACQUIRE_TIMEOUT_S", 0.2)
    shed = 0
    started = time.monotonic()
    with analytics_db.request_budget(0.3):
        for _ in range(12):  # a niche_detail-sized handler
            try:
                with analytics_db._cursor():
                    pass
            except HTTPException as exc:
                assert exc.status_code == 503
                shed += 1
    elapsed = time.monotonic() - started
    assert shed == 12
    assert elapsed < 1.0  # not 12 x 0.2s = 2.4s


def test_expired_budget_still_serves_a_free_cursor(client):
    """Past the deadline only WAITING is refused — an idle pool is still served, so a
    long-lived caller (an MCP session) doesn't start failing just because it is old."""
    with analytics_db.request_budget(0.0):
        with analytics_db._cursor() as cur:
            assert cur.execute("SELECT 1").fetchone() == (1,)


def test_no_budget_outside_a_request_falls_back_to_the_per_acquire_bound(drained_pool, monkeypatch):
    monkeypatch.setattr(analytics_db, "_ACQUIRE_TIMEOUT_S", 0.05)
    with pytest.raises(HTTPException):
        with analytics_db._cursor():
            pass
    assert analytics_db._acquire_timeout() == 0.05  # no deadline set -> full per-acquire wait


def test_the_request_budget_reaches_the_route_handler(drained_pool, client, monkeypatch):
    """End-to-end: the deadline is a ContextVar stamped by RequestContextMiddleware in the
    event loop, and route handlers are sync (threadpool) — this pins that it survives the
    hop. Without it the request would sit for the full _ACQUIRE_TIMEOUT_S below."""
    monkeypatch.setattr(analytics_db, "_ACQUIRE_TIMEOUT_S", 5.0)
    monkeypatch.setattr(analytics_db, "_REQUEST_WAIT_BUDGET_S", 0.05)
    started = time.monotonic()
    r = client.get("/api/games/1001")
    elapsed = time.monotonic() - started
    assert r.status_code == 503
    assert "server busy" in r.json()["detail"]
    assert elapsed < 2.0
