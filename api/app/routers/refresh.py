"""Data-refresh changelog.

Reads the newline-delimited JSON the Droplet's daily refresh cron appends (one record per run,
each carrying data deltas vs. the previous run) and serves it for the in-app "Data log" page.
Public + read-only; returns an empty list when no runs have been recorded yet.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Query

from ..config import settings
from ..schemas import RefreshHistory

router = APIRouter(tags=["refresh"])

_DEFAULT_LIMIT = 60


@router.get("/api/refresh/history", response_model=RefreshHistory)
def refresh_history(
    limit: int = Query(
        _DEFAULT_LIMIT, ge=1, le=500,
        description="How many of the most recent runs to return (newest first).",
    ),
) -> RefreshHistory:
    """Newest-first run records. `limit` is honoured (it was accepted and silently ignored
    until 2026-08-28 — every call returned the newest 60 regardless)."""
    path = Path(settings.refresh_history_path)
    runs: list[dict] = []
    if path.exists():
        try:
            text = path.read_text()
        except OSError:
            text = ""
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                runs.append(json.loads(line))
            except ValueError:
                # Per-line, like the mcp-log viewer in analytics.py: ONE corrupt line
                # (a torn append from a crash mid-write) skips itself instead of wiping
                # the whole history.
                continue
    runs.sort(key=lambda r: r.get("finished_at", ""), reverse=True)
    return RefreshHistory(runs=runs[:limit], total=len(runs), limit=limit)
