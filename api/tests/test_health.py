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
