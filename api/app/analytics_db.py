"""Read-only DuckDB access to the analytics marts (current.duckdb).

A single read-only connection is opened at startup; each query runs on a fresh cursor
under a lock. Marts are tiny/precomputed so responses are sub-millisecond.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import duckdb

_conn: duckdb.DuckDBPyConnection | None = None
_lock = threading.Lock()


def init(path: str) -> None:
    global _conn
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"Analytics DB not found at {path}. Run `make etl` first to build the marts."
        )
    _conn = duckdb.connect(str(p), read_only=True)


def close() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


def is_ready() -> bool:
    return _conn is not None


def query(sql: str, params: list[Any] | None = None) -> list[dict]:
    if _conn is None:
        raise RuntimeError("analytics db not initialised")
    with _lock:
        cur = _conn.cursor()
        cur.execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return [dict(zip(cols, row)) for row in rows]


def query_one(sql: str, params: list[Any] | None = None) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def scalar(sql: str, params: list[Any] | None = None) -> Any:
    if _conn is None:
        raise RuntimeError("analytics db not initialised")
    with _lock:
        cur = _conn.cursor()
        cur.execute(sql, params or [])
        row = cur.fetchone()
    return row[0] if row else None
