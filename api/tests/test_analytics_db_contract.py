"""analytics_db's request-facing failure contract.

main.py's lifespan deliberately keeps the app up when the ETL hasn't produced
current.duckdb ("endpoints will 503") — that promise is enforced centrally in
analytics_db._cursor(), so EVERY router honors it, not just the two that used to check
is_ready() themselves. Same place enforces the bounded pool wait: with 4 cursors against
a 40-connection flood, an unbounded `Queue.get()` parked every worker forever (a
documented production hang); now it sheds with a 503 + Retry-After.
"""
from __future__ import annotations

import pytest

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
