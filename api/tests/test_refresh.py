"""GET /api/refresh/history — the run log's envelope, and the `limit` param actually
limiting.

`limit` was accepted and silently ignored: every call returned the newest 60 runs
regardless (verified against production, where ?limit=2 came back with 40 runs). It is
honoured now, and the response carries the envelope (total/limit) the pagination needs.
"""
from __future__ import annotations

import json

import pytest

from app.config import settings

# finished_at deliberately out of order on disk — the router sorts newest-first.
RUNS = [
    {"finished_at": "2026-08-24T04:10:00+00:00", "games_added": 12},
    {"finished_at": "2026-08-26T04:10:00+00:00", "games_added": 30},
    {"finished_at": "2026-08-25T04:10:00+00:00", "games_added": 21},
]


@pytest.fixture
def history_file(tmp_path, monkeypatch):
    path = tmp_path / "refresh_history.json"
    path.write_text("\n".join(json.dumps(r) for r in RUNS) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    return path


def test_returns_runs_newest_first_with_the_envelope(client, history_file):
    body = client.get("/api/refresh/history").json()
    assert [r["games_added"] for r in body["runs"]] == [30, 21, 12]
    assert body["total"] == 3
    assert body["limit"] == 60  # the default, unchanged


def test_limit_actually_limits(client, history_file):
    body = client.get("/api/refresh/history", params={"limit": 2}).json()
    assert [r["games_added"] for r in body["runs"]] == [30, 21]
    assert body["limit"] == 2
    assert body["total"] == 3  # total is what's on disk, not what was returned


def test_limit_is_validated(client, history_file):
    assert client.get("/api/refresh/history", params={"limit": 0}).status_code == 422
    assert client.get("/api/refresh/history", params={"limit": 501}).status_code == 422


def test_missing_file_is_an_empty_log_not_an_error(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "refresh_history_path", str(tmp_path / "nope.json"))
    body = client.get("/api/refresh/history").json()
    assert body == {"runs": [], "total": 0, "limit": 60}


def test_corrupt_file_degrades_to_empty(client, tmp_path, monkeypatch):
    path = tmp_path / "broken.json"
    path.write_text("{not json at all\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    assert client.get("/api/refresh/history").json()["runs"] == []


def test_free_form_run_keys_survive_the_response_model(client, tmp_path, monkeypatch):
    """The cron grows new delta keys without an API deploy, so run records stay dicts —
    a typed row model would silently drop tomorrow's fields."""
    path = tmp_path / "history.json"
    path.write_text(
        json.dumps({"finished_at": "2026-08-27T04:00:00+00:00", "brand_new_metric": 7}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    (run,) = client.get("/api/refresh/history").json()["runs"]
    assert run["brand_new_metric"] == 7
