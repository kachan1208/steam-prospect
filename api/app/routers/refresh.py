"""Data-refresh changelog.

Reads the newline-delimited JSON the Droplet's daily refresh cron appends (one record per run,
each carrying data deltas vs. the previous run) and serves it for the in-app "Data log" page.
Public + read-only; returns an empty list when no runs have been recorded yet.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter

from ..config import settings

router = APIRouter(tags=["refresh"])


@router.get("/api/refresh/history")
def refresh_history() -> dict:
    path = Path(settings.refresh_history_path)
    runs: list[dict] = []
    if path.exists():
        try:
            for line in path.read_text().splitlines():
                line = line.strip()
                if line:
                    runs.append(json.loads(line))
        except (OSError, ValueError):
            runs = []
    runs.sort(key=lambda r: r.get("finished_at", ""), reverse=True)
    return {"runs": runs[:60]}
