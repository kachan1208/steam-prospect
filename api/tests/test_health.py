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
