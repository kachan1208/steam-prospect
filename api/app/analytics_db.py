"""Read-only DuckDB access to the analytics marts (current.duckdb).

A small **pool of cursors** over one shared read-only connection lets concurrent
requests run in parallel instead of serializing behind a single lock (the exact
bottleneck the load tests found: throughput flat, p95 growing linearly with
concurrency). Cursors created via `conn.cursor()` are independent execution
contexts that share the same in-memory database + buffer cache, so the pool is
memory-cheap (no per-connection reload of the marts). The pool is bounded — a
`queue.Queue` blocks when every cursor is checked out, so a request flood queues
gracefully rather than spawning unbounded work. Marts are precomputed and tiny,
so each query is short; a handful of cursors is plenty for a small box.

The whole DB is swapped atomically + the app restarted on each nightly ETL, so
the pool is simply rebuilt on startup — no live-reopen logic needed.
"""
from __future__ import annotations

import queue
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import duckdb
from fastapi import HTTPException

_conn: duckdb.DuckDBPyConnection | None = None
_pool: "queue.Queue[duckdb.DuckDBPyConnection] | None" = None
# mart_meta's mart_version, read ONCE at init (the DB is swapped atomically + the app
# restarted on each nightly ETL, so a per-process value can't go stale). None when the DB
# isn't initialised or the mart predates mart_meta — consumers treat None as "not cacheable".
_mart_version: str | None = None

# How long a request may wait for a free cursor before giving up with a 503. The pool is 4
# cursors against a public concurrency that has been measured at 40 — without a timeout a
# request flood parks every worker in `_pool.get()` forever (a documented production hang).
# Mart queries are sub-second, so a request that has already queued 10s is not going to be
# served usefully; shedding it keeps the process responsive.
_ACQUIRE_TIMEOUT_S = 10.0

_DB_MISSING_DETAIL = (
    "analytics database not available — the ETL hasn't produced current.duckdb yet"
)
_POOL_BUSY_DETAIL = (
    "server busy — all analytics cursors are in use; retry shortly"
)


def init(path: str, pool_size: int = 4) -> None:
    global _conn, _pool, _mart_version
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"Analytics DB not found at {path}. Run `make etl` first to build the marts."
        )
    n = max(1, pool_size)
    _conn = duckdb.connect(str(p), read_only=True)
    _pool = queue.Queue(maxsize=n)
    for _ in range(n):
        _pool.put(_conn.cursor())
    try:
        row = _conn.execute(
            "SELECT value FROM mart_meta WHERE key = 'mart_version'"
        ).fetchone()
        _mart_version = str(row[0]) if row and row[0] is not None else None
    except duckdb.Error:  # mart predates mart_meta — nothing to key caches on
        _mart_version = None


def close() -> None:
    global _conn, _pool, _mart_version
    if _pool is not None:
        while True:
            try:
                _pool.get_nowait().close()
            except Exception:
                break
        _pool = None
    if _conn is not None:
        _conn.close()
        _conn = None
    _mart_version = None


def is_ready() -> bool:
    return _pool is not None


def mart_version() -> str | None:
    """The loaded mart's version string (mart_meta.mart_version), or None when the DB is
    absent / predates mart_meta. Read once at init — see _mart_version."""
    return _mart_version


@contextmanager
def _cursor():
    # Raised as an HTTPException so EVERY router keeps the deploy contract main.py promises
    # ("endpoints will 503" when the ETL hasn't produced the DB) without each handler
    # re-checking is_ready() — previously only entities/timing checked, and everything else
    # leaked a RuntimeError 500.
    if _pool is None:
        raise HTTPException(status_code=503, detail=_DB_MISSING_DETAIL)
    try:
        # Bounded wait (was: block forever — pool of 4 vs concurrency 40 parked every
        # worker in this call, a documented production hang). On timeout, shed the request.
        cur = _pool.get(timeout=_ACQUIRE_TIMEOUT_S)
    except queue.Empty:
        raise HTTPException(
            status_code=503, detail=_POOL_BUSY_DETAIL, headers={"Retry-After": "5"}
        )
    try:
        yield cur
    except Exception:
        # A failed query can leave the cursor in an odd state — replace it with a fresh
        # one so it doesn't poison the pool, then re-raise for the caller.
        try:
            cur.close()
        except Exception:
            pass
        _pool.put(_conn.cursor() if _conn is not None else cur)
        raise
    else:
        _pool.put(cur)


def query(sql: str, params: list[Any] | None = None) -> list[dict]:
    with _cursor() as cur:
        cur.execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return [dict(zip(cols, row)) for row in rows]


def query_one(sql: str, params: list[Any] | None = None) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def scalar(sql: str, params: list[Any] | None = None) -> Any:
    with _cursor() as cur:
        cur.execute(sql, params or [])
        row = cur.fetchone()
    return row[0] if row else None
