"""Data-refresh changelog.

Reads the newline-delimited JSON the Droplet's nightly refresh appends (one record per run)
and serves it for the in-app "Data log" page. Public + read-only; returns an empty list when
no runs have been recorded yet.

A record's `result` is one of OK / FAILED / HELD / SKIPPED. OK and FAILED runs carry the
data counts, the deltas vs. the previous run and per-source freshness; HELD (a build hold
was on) and SKIPPED (the refresh lock was already held) never started the pipeline, so they
carry a `reason` and NO counts/deltas/freshness keys. Records are served as the dicts they
are on disk — nothing is filled in, coerced or dropped.
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
                rec = json.loads(line)
            except ValueError:
                # Per-line, like the mcp-log viewer in analytics.py: ONE corrupt line
                # (a torn append from a crash mid-write) skips itself instead of wiping
                # the whole history.
                continue
            if not isinstance(rec, dict):
                # Valid JSON but not a record (a bare scalar or list): the `.get` in the
                # sort below would raise and take the whole endpoint down with it.
                continue
            runs.append(rec)
    # A record without finished_at (or with it null) sorts oldest instead of crashing the
    # str-vs-None comparison — a 500 here blanks the page for every run, not just that one.
    runs.sort(key=lambda r: str(r.get("finished_at") or ""), reverse=True)
    return RefreshHistory(runs=runs[:limit], total=len(runs), limit=limit)
