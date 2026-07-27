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

_conn: duckdb.DuckDBPyConnection | None = None
_pool: "queue.Queue[duckdb.DuckDBPyConnection] | None" = None


def init(path: str, pool_size: int = 4) -> None:
    global _conn, _pool
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


def close() -> None:
    global _conn, _pool
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


def is_ready() -> bool:
    return _pool is not None


@contextmanager
def _cursor():
    if _pool is None:
        raise RuntimeError("analytics db not initialised")
    cur = _pool.get()  # blocks (bounding concurrency) when all cursors are in use
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
