"""Settings defaults (api/app/config.py).

signals_db defaulted to the container-only "/app/data/signals.db" while every other path
default is repo-relative, so any non-container run (task api, a new server laid out
differently) silently served empty price history. It now defaults to signals.db in the SAME
directory as the analytics DB — which in the container is that same /app/data/signals.db —
and PROSPECT_SIGNALS_DB still overrides it.
"""
from __future__ import annotations

from app.config import REPO_ROOT, Settings


def _settings(monkeypatch, **kwargs) -> Settings:
    for var in ("PROSPECT_SIGNALS_DB", "PROSPECT_ANALYTICS_DB_PATH"):
        monkeypatch.delenv(var, raising=False)
    return Settings(_env_file=None, **kwargs)


def test_signals_db_follows_the_analytics_db_directory(monkeypatch):
    s = _settings(monkeypatch, analytics_db_path="/srv/prospect/data/current.duckdb")
    assert s.signals_db == "/srv/prospect/data/signals.db"


def test_container_layout_keeps_its_old_path(monkeypatch):
    s = _settings(monkeypatch, analytics_db_path="/app/data/current.duckdb")
    assert s.signals_db == "/app/data/signals.db"


def test_repo_default_is_repo_relative(monkeypatch):
    s = _settings(monkeypatch)
    assert s.signals_db == str(REPO_ROOT / "data" / "signals.db")


def test_env_override_still_wins(monkeypatch):
    monkeypatch.delenv("PROSPECT_ANALYTICS_DB_PATH", raising=False)
    monkeypatch.setenv("PROSPECT_SIGNALS_DB", "/elsewhere/signals.db")
    s = Settings(_env_file=None, analytics_db_path="/srv/prospect/data/current.duckdb")
    assert s.signals_db == "/elsewhere/signals.db"


def test_reload_interval_default_and_override(monkeypatch):
    monkeypatch.delenv("PROSPECT_MART_RELOAD_INTERVAL_S", raising=False)
    assert Settings(_env_file=None).mart_reload_interval_s == 30.0
    monkeypatch.setenv("PROSPECT_MART_RELOAD_INTERVAL_S", "0")
    assert Settings(_env_file=None).mart_reload_interval_s == 0.0
