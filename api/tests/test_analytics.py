"""The MCP call-log viewer must be invisible without a token and gated with one."""
import json

from app.config import settings


def test_mcp_log_404_when_token_unset(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", None)
    assert client.get("/api/analytics/mcp-log").status_code == 404


def test_mcp_log_403_on_wrong_token(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "s3cret")
    assert client.get("/api/analytics/mcp-log", params={"token": "nope"}).status_code == 403


def test_mcp_log_returns_entries_newest_first(client, monkeypatch, tmp_path):
    log = tmp_path / "mcp_calls.jsonl"
    rows = [
        {"ts": "2026-08-05T10:00:00+00:00", "tool": "find_niches", "args": "{}", "ok": True, "ms": 12},
        {"ts": "2026-08-05T11:00:00+00:00", "tool": "game_teardown", "args": '{"name": "Songs of Syx"}', "ok": True, "ms": 40},
    ]
    log.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "admin_token", "s3cret")
    monkeypatch.setattr(settings, "mcp_call_log_path", str(log))

    resp = client.get("/api/analytics/mcp-log", params={"token": "s3cret"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert [e["tool"] for e in body["entries"]] == ["game_teardown", "find_niches"]


def test_mcp_log_empty_when_file_missing(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "admin_token", "s3cret")
    monkeypatch.setattr(settings, "mcp_call_log_path", str(tmp_path / "nope.jsonl"))
    resp = client.get("/api/analytics/mcp-log", params={"token": "s3cret"})
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "entries": []}
