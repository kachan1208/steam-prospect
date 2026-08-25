"""Read-only access to signals.db — the live collector signals (followers, price snapshots).

A SEPARATE SQLite file from both steam_games.db and the DuckDB mart, by design
(deploy/collectors/*): its collectors are the file's only writers, so there is no lock war to
inherit, and the API reading it live is what lets these signals skip the nightly mart cycle
entirely — a follower count captured at 05:30 is servable at 05:31, not after the next 3-hour
build.

Every read opens a short-lived sqlite3 connection in `mode=ro`. That is deliberate: WAL lets a
read snapshot coexist with the collectors' writes, `ro` makes it impossible for the API to
take a write lock by accident, and per-request connections mean a missing/mid-rotation file
degrades that one request instead of poisoning a pool. An absent file (fresh deploy, collector
not yet run) returns empty rows — the endpoints treat "no signals yet" as data, never a 500.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

SIGNALS_DB_PATH = os.environ.get("PROSPECT_SIGNALS_DB", "/app/data/signals.db")


def query(sql: str, params: tuple = ()) -> list[dict]:
    if not Path(SIGNALS_DB_PATH).exists():
        return []
    try:
        con = sqlite3.connect(f"file:{SIGNALS_DB_PATH}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return []
    try:
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql, params).fetchall()]
        except sqlite3.OperationalError:
            # table not created yet (collector never ran) — same contract as a missing file
            return []
    finally:
        con.close()
