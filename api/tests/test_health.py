"""api/app/routers/health.py — cheap end-to-end smoke that the app boots, the control-plane
solo org seeds correctly (get_current_org succeeds), and analytics_db reads the fixture mart's
mart_meta table."""
from __future__ import annotations


def test_health_reports_ready_against_the_fixture_mart(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["mart_version"] == "test-fixture"


def test_ready_200_when_db_open(client):
    r = client.get("/api/health/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ready"}


def test_ready_503_but_health_still_200_when_db_absent(client, monkeypatch):
    """/api/health is LIVENESS (always 200 — existing probes rely on it); /api/health/ready
    is READINESS and must go 503 the moment the analytics DB isn't there."""
    from app import analytics_db

    monkeypatch.setattr(analytics_db, "is_ready", lambda: False)
    r = client.get("/api/health/ready")
    assert r.status_code == 503
    assert "analytics database not available" in r.json()["detail"]

    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "degraded"


def test_health_stays_200_when_the_cursor_pool_is_saturated(client, monkeypatch):
    """Liveness must NOT depend on the DuckDB pool. It used to read mart_meta with a query,
    which takes a cursor — and a saturated pool sheds with 503, so DigitalOcean's health
    check and the nightly restart verification would have read "busy" as "dead" and
    restarted the container under exactly the load that saturated it."""
    from app import analytics_db

    monkeypatch.setattr(analytics_db, "_ACQUIRE_TIMEOUT_S", 0.05)  # don't wait it out
    pool = analytics_db._pool
    assert pool is not None
    held = []
    while True:  # drain every cursor: nothing can acquire one until we put them back
        try:
            held.append(pool.get_nowait())
        except Exception:
            break
    try:
        r = client.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["mart_version"] == "test-fixture"  # still describes the mart
        assert body["built_at"] == "2026-01-01T00:00:00+00:00"
        # ...while a data endpoint correctly sheds.
        assert client.get("/api/games/1001").status_code == 503
    finally:
        for cur in held:
            pool.put(cur)


def test_health_never_queries_the_mart(client, monkeypatch):
    """The mart description comes from analytics_db's init-time copy, not a live read."""
    from app import analytics_db

    def _boom(sql, params=None):
        raise AssertionError("/api/health queried the mart")

    monkeypatch.setattr(analytics_db, "query", _boom)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["mart_version"] == "test-fixture"
