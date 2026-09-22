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

import logging
import queue
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import duckdb
from fastapi import HTTPException

logger = logging.getLogger(__name__)

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
_UNREADABLE_DETAIL = (
    "analytics database unreadable — an I/O error while reading the mart (truncated or "
    "corrupt file?); it needs rebuilding or restoring"
)

# Why the last init() failed, in operator-facing words (None = never failed, or the DB is
# open). main.py keeps the app up on a failed open — the health endpoint and every 503 then
# say WHICH failure it was, instead of all of them claiming "the ETL hasn't run yet" when
# the real story is a truncated download or a corrupt file.
_init_error: str | None = None


class MartUnavailable(RuntimeError):
    """init() could not open a usable mart. str(exc) is the operator-facing reason.

    Raised for EVERY way the open can fail — a missing file, but also a 0-byte, truncated
    or garbage file (duckdb.IOException), an unreadable one (PermissionError) or a DuckDB
    file with no tables in it. main.py's lifespan catches exactly this and keeps the API up
    in degraded mode; before it existed only FileNotFoundError was caught, so a corrupt
    mart raised straight out of the lifespan, the worker died with STARTUP_FAILURE and the
    container exited — the opposite of the documented "endpoints will 503" contract."""


def _one_line(exc: BaseException, limit: int = 300) -> str:
    text = " ".join(str(exc).split())
    return f"{type(exc).__name__}: {text[:limit]}"


def init(path: str, pool_size: int = 4) -> None:
    global _conn, _pool, _mart_meta, _init_error
    # init() means "serve THIS mart": whatever was open before is closed first, so a failed
    # open leaves the API honestly degraded rather than silently serving the previous file.
    close()
    p = Path(path)
    if not p.exists():
        _init_error = f"no analytics database at {path} (the ETL hasn't produced it yet)"
        raise MartUnavailable(
            f"Analytics DB not found at {path}. Run `task etl` first to build the marts."
        )
    n = max(1, pool_size)
    conn: duckdb.DuckDBPyConnection | None = None
    try:
        conn = duckdb.connect(str(p), read_only=True)
        # An EMPTY DuckDB file is a valid database with nothing in it — every query would
        # then fail one by one. A mart with zero tables is not a mart: refuse it up front.
        n_tables = conn.execute("SELECT COUNT(*) FROM information_schema.tables").fetchone()[0]
        if not n_tables:
            raise MartUnavailable(f"{path} is a DuckDB file with no tables in it")
        pool: queue.Queue[duckdb.DuckDBPyConnection] = queue.Queue(maxsize=n)
        for _ in range(n):
            pool.put(conn.cursor())
        try:
            rows = conn.execute("SELECT key, value FROM mart_meta").fetchall()
            meta = {str(k): str(v) for k, v in rows if k is not None and v is not None}
        except duckdb.CatalogException:  # mart predates mart_meta — nothing to key caches on
            meta = {}
    except Exception as exc:  # duckdb.Error (IOException: 0-byte/garbage/truncated), OSError
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        reason = str(exc) if isinstance(exc, MartUnavailable) else _one_line(exc)
        _init_error = f"analytics database at {path} is unusable — {reason}"
        raise MartUnavailable(_init_error) from exc
    _conn, _pool, _mart_meta, _init_error = conn, pool, meta, None


def unavailable_reason() -> str | None:
    """Why the analytics DB is not open (None when it is, or when it was closed on
    purpose). Surfaced by /api/health and folded into every data endpoint's 503."""
    return _init_error if _pool is None else None


def missing_detail() -> str:
    """The 503 detail for "no usable mart": the specific reason when init() failed."""
    reason = unavailable_reason()
    return f"analytics database not available — {reason}" if reason else _DB_MISSING_DETAIL


def close() -> None:
    global _conn, _pool, _mart_meta, _init_error
    _init_error = None  # closed on purpose: nothing failed
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
        raise HTTPException(status_code=503, detail=missing_detail())
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
    except Exception as exc:
        # A failed query can leave the cursor in an odd state — replace it with a fresh
        # one so it doesn't poison the pool, then re-raise for the caller.
        try:
            cur.close()
        except Exception:
            pass
        _pool.put(_conn.cursor() if _conn is not None else cur)
        if isinstance(exc, duckdb.IOException):
            # The file went bad UNDER an open connection (a block past EOF on a truncated
            # mart, a failing disk). Not a client error and not a bug in the handler: shed
            # it as the same 503 family as "no mart", loudly logged, never a bare 500.
            logger.error("analytics DB read failed: %s", _one_line(exc))
            raise HTTPException(status_code=503, detail=_UNREADABLE_DETAIL) from exc
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
