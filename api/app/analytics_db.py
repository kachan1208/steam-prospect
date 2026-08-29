"""Read-only DuckDB access to the analytics marts (current.duckdb).

A small **pool of cursors** over one shared read-only connection lets concurrent
requests run in parallel instead of serializing behind a single lock (the exact
bottleneck the load tests found: throughput flat, p95 growing linearly with
concurrency). Cursors created via `conn.cursor()` are independent execution
contexts that share the same in-memory database + buffer cache, so the pool is
memory-cheap (no per-connection reload of the marts). The pool is bounded AND the
wait for it is bounded twice over — per acquisition (`_ACQUIRE_TIMEOUT_S`) and per
request (`_REQUEST_WAIT_BUDGET_S`, see request_budget()) — so a request flood is
SHED with 503 + Retry-After instead of parking every worker in `queue.Queue.get()`
(the documented production hang) or stacking one full wait per query into a
minutes-long request. Marts are precomputed and tiny, so each query is short; a
handful of cursors is plenty for a small box.

The whole DB is swapped atomically + the app restarted on each nightly ETL, so
the pool is simply rebuilt on startup — no live-reopen logic needed.
"""
from __future__ import annotations

import queue
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import duckdb
from fastapi import HTTPException

_conn: duckdb.DuckDBPyConnection | None = None
_pool: "queue.Queue[duckdb.DuckDBPyConnection] | None" = None
# The whole mart_meta table (mart_version / built_at / source_db), read ONCE at init (the DB
# is swapped atomically + the app restarted on each nightly ETL, so a per-process copy can't
# go stale). Empty when the DB isn't initialised or the mart predates mart_meta. Cached
# rather than re-queried so the liveness probe never has to touch the cursor pool.
_mart_meta: dict[str, str] = {}

# How long ONE acquisition may wait for a free cursor before giving up with a 503. The pool
# is 4 cursors against a public concurrency that has been measured at 40 — without a timeout
# a request flood parks every worker in `_pool.get()` forever (a documented production hang).
_ACQUIRE_TIMEOUT_S = 5.0

# ...and how long a single REQUEST may spend queueing in total. Handlers acquire the pool
# once per query and the heaviest (niche_detail) issues ~12 sequential queries, so a
# per-acquire bound alone still allows 12 x _ACQUIRE_TIMEOUT_S of hanging on — recreating
# the wedge the bound exists to prevent. request_budget() stamps a deadline on the request;
# every acquire clamps its wait to what is left of it, so the worst case is bounded ONCE per
# request, not once per query. Past the deadline the wait is 0 — a free cursor is still
# served immediately, only WAITING is refused, so a long-lived caller (e.g. an MCP session)
# keeps working as long as the pool isn't contended.
_REQUEST_WAIT_BUDGET_S = 10.0

# No per-query watchdog: duckdb 1.5.4 exposes no query-timeout setting at all (none of the
# 160 rows of `duckdb_settings()` is one) — only `cursor.interrupt()`. Interrupting from a
# timer would have to be armed around every execute on a POOLED cursor, and
# `threading.Timer.cancel()` cannot stop a timer that has already begun firing, so a
# watchdog that expires just as its query returns can land on the NEXT request's query on
# that same cursor. (Contrary to the note in commit 92797e2, a late interrupt does not
# poison the cursor: on 1.5.4 an interrupt of an IDLE cursor is a no-op and the cursor is
# reusable after a real interrupt — both verified. The hazard is the cross-request hit, not
# a sticky flag.) Since the marts are precomputed and every query is sub-second, the real
# failure mode here is queueing, not runaway queries — so we bound WAITING, above.

_DB_MISSING_DETAIL = (
    "analytics database not available — the ETL hasn't produced current.duckdb yet"
)
_POOL_BUSY_DETAIL = (
    "server busy — all analytics cursors are in use; retry shortly"
)


def init(path: str, pool_size: int = 4) -> None:
    global _conn, _pool, _mart_meta
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
        rows = _conn.execute("SELECT key, value FROM mart_meta").fetchall()
        _mart_meta = {str(k): str(v) for k, v in rows if k is not None and v is not None}
    except duckdb.Error:  # mart predates mart_meta — nothing to key caches on
        _mart_meta = {}


def close() -> None:
    global _conn, _pool, _mart_meta
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
    _mart_meta = {}


def is_ready() -> bool:
    return _pool is not None


def mart_meta() -> dict[str, str]:
    """The loaded mart's mart_meta table as a dict, empty when the DB is absent / predates
    mart_meta. Read once at init — see _mart_meta — so callers (notably the ALWAYS-200
    liveness probe) never take a cursor to describe the mart."""
    return dict(_mart_meta)


def mart_version() -> str | None:
    """The loaded mart's version string (mart_meta.mart_version), or None when the DB is
    absent / predates mart_meta. Read once at init — see _mart_meta."""
    return _mart_meta.get("mart_version")


def built_at() -> str | None:
    """When the loaded mart was BUILT (mart_meta.built_at), or None. mart_version is only
    the build DATE, so two builds on one day (a light build + the nightly, or a rebuild
    after a fix) share it — caches that must not mix them key on both."""
    return _mart_meta.get("built_at")


# Per-request deadline for pool waits (see _REQUEST_WAIT_BUDGET_S). A ContextVar, so it is
# per asyncio task AND is copied into the threadpool worker that runs a sync route handler;
# unset (None) outside a request, where the per-acquire bound alone applies.
_wait_deadline: ContextVar[float | None] = ContextVar("analytics_wait_deadline", default=None)


@contextmanager
def request_budget(seconds: float | None = None):
    """Bound the total time everything inside may spend WAITING for a pool cursor.

    Wrapped around every HTTP request by observability.RequestContextMiddleware."""
    budget = _REQUEST_WAIT_BUDGET_S if seconds is None else seconds
    token = _wait_deadline.set(time.monotonic() + budget)
    try:
        yield
    finally:
        _wait_deadline.reset(token)


def _acquire_timeout() -> float:
    """Per-acquire wait, clamped to whatever is left of the request's budget."""
    deadline = _wait_deadline.get()
    if deadline is None:
        return _ACQUIRE_TIMEOUT_S
    return max(0.0, min(_ACQUIRE_TIMEOUT_S, deadline - time.monotonic()))


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
        # worker in this call, a documented production hang), and bounded again by what is
        # left of the request's budget. On timeout, shed the request.
        cur = _pool.get(timeout=_acquire_timeout())
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
