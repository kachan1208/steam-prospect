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

Degradation is never SILENT, though: fetch() says WHICH empty it is.
  ok           the read worked (the rows may still legitimately be empty — a game the
               rotating collector hasn't reached yet)
  missing      no signals.db file, or the table isn't created yet: the collector never ran.
               Benign, and the same contract as a missing file.
  unavailable  the file is there but could not be read — corrupt ("file is not a
               database", "database disk image is malformed"), locked, or unopenable.
               Logged as a warning AND flagged to the caller, so an endpoint can say
               "price history unavailable" instead of passing a broken store off as
               "no price history yet".
"""
from __future__ import annotations

import logging
import sqlite3
from pathlib import Path
from typing import Literal, NamedTuple

from .config import settings

logger = logging.getLogger(__name__)

SignalsStatus = Literal["ok", "missing", "unavailable"]


class SignalsResult(NamedTuple):
    rows: list[dict]
    status: SignalsStatus


def fetch(sql: str, params: tuple = ()) -> SignalsResult:
    # Read at query time (settings, not a module constant): the path is then overridable
    # per process via PROSPECT_SIGNALS_DB / Settings without an import-order constraint.
    db_path = settings.signals_db
    if not Path(db_path).exists():
        return SignalsResult([], "missing")
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        logger.warning("signals.db connect failed at %s: %s", db_path, exc)
        return SignalsResult([], "unavailable")
    try:
        con.row_factory = sqlite3.Row
        try:
            return SignalsResult([dict(r) for r in con.execute(sql, params).fetchall()], "ok")
        except sqlite3.DatabaseError as exc:
            # DatabaseError, not just its OperationalError subclass: a CORRUPT file raises
            # the base class ("file is not a database" / "database disk image is
            # malformed"), which used to escape this handler and 500 the endpoint.
            # Graceful either way, but never SILENT: logged, and flagged unless it is the
            # one benign case — the table not created yet because the collector never ran.
            logger.warning("signals.db query failed (%s): %s", db_path, exc)
            if isinstance(exc, sqlite3.OperationalError) and "no such table" in str(exc):
                return SignalsResult([], "missing")
            return SignalsResult([], "unavailable")
    finally:
        con.close()


def query(sql: str, params: tuple = ()) -> list[dict]:
    """Rows only (every failure mode reads as empty) — see fetch() for the status."""
    return fetch(sql, params).rows
