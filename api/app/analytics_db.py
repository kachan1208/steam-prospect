"""Read-only DuckDB access to the analytics marts (current.duckdb), with hot reload.

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

MART GENERATIONS + HOT RELOAD (2026-09). The nightly ETL publishes a mart by atomically
repointing the current.duckdb symlink, and a same-day rebuild os.replace()s a NEW file over
the SAME versioned name. This module used to open current.duckdb once per process and trust
"the app is restarted after every swap" — nothing enforced that, so a worker kept serving the
old file while a respawned sibling worker read the new one, and responses alternated between
two marts. Now:

  * Each opened mart is a _Generation: its own DuckDB instance, cursor pool, mart_meta copy,
    SCHEMA SNAPSHOT (every table -> its columns, read once at open) and memo of mart-derived
    values. Every capability probe in the routers answers from that snapshot, so a reload
    invalidates all of them in one place — they used to be ~20 separate process-lifetime
    lru_caches that nothing could clear.
  * A request PINS one generation the first time it touches the DB (request_budget() opens
    the scope), so a 12-query handler can never mix two marts, and a generation is closed
    only once no pinned request and no checked-out cursor still references it.
  * At most every `_reload_interval_s` (settings.mart_reload_interval_s: 30s; 0 disables) a
    request os.stat()s the watched path — microseconds. If the file it resolves to changed
    (target, inode, size or mtime), ONE thread opens the new generation while the others
    keep serving the current one; it is swapped in atomically, the swap listeners clear the
    caches that live outside generations (response_cache), and the old generation retires
    when its last user finishes. A degraded boot (no mart yet) recovers the same way.
  * A reload that FAILS (corrupt or half-copied target) keeps serving the current mart, is
    logged and surfaces in /api/health; the same broken file is not retried every interval —
    only another change of the file triggers a new attempt.

WHY A PRIVATE INSTANCE (ATTACH into ":memory:", not duckdb.connect(path)): DuckDB caches
database instances per process by path. Measured on 1.5.5: once a same-day rebuild has
os.replace()d a new file over the same name, duckdb.connect(path) — while ANY connection to
the old file is still open (in-flight requests on the old generation, or the mounted MCP's
module-level connection, which never closes) — silently returns the OLD instance: the
"reload" would keep serving yesterday's data under a fresh generation. An in-memory
connection is never cached and ATTACH ... (READ_ONLY) opens the file itself, so every
generation reads exactly the file it resolved to. Every cursor then needs `USE` to make the
attached mart its default catalog, which _Generation.new_cursor() does.
"""
from __future__ import annotations

import logging
import os
import queue
import re
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, TypeVar

import duckdb
from fastapi import HTTPException

from .config import settings

logger = logging.getLogger(__name__)

T = TypeVar("T")

# How long ONE acquisition may wait for a free cursor before giving up with a 503. The pool
# is 4 cursors against a public concurrency that has been measured at 40 — without a timeout
# a request flood parks every worker in `pool.get()` forever (a documented production hang).
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

# The catalog name each generation ATTACHes its mart file under (see the module docstring).
_ALIAS = "prospect_mart"

# The nightly's published file name carries the version: current.duckdb -> prospect_YYYYMMDD.duckdb.
_VERSION_IN_NAME = re.compile(r"prospect_(\d{8})\.duckdb$")


class MartUnavailable(RuntimeError):
    """A mart could not be opened. str(exc) is the operator-facing reason.

    Raised for EVERY way the open can fail — a missing file, but also a 0-byte, truncated
    or garbage file (duckdb.IOException), an unreadable one (PermissionError) or a DuckDB
    file with no tables in it. main.py's lifespan catches exactly this and keeps the API up
    in degraded mode; before it existed only FileNotFoundError was caught, so a corrupt
    mart raised straight out of the lifespan, the worker died with STARTUP_FAILURE and the
    container exited — the opposite of the documented "endpoints will 503" contract."""


def _one_line(exc: BaseException, limit: int = 300) -> str:
    text = " ".join(str(exc).split())
    return f"{type(exc).__name__}: {text[:limit]}"


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


@dataclass(frozen=True)
class _FileKey:
    """Identity of the file the watched path resolves to. A symlink repoint changes
    `target`; a same-day rebuild os.replace()d over the same name changes `ino`; an in-place
    rewrite changes size/mtime — any of them means "a different mart"."""

    target: str
    dev: int
    ino: int
    size: int
    mtime_ns: int


def _file_key(path: str) -> _FileKey | None:
    try:
        target = os.path.realpath(path)
        st = os.stat(target)
    except OSError:
        return None  # missing file / dangling link
    return _FileKey(target, st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)


class _Generation:
    """One opened mart: a private DuckDB instance, its cursor pool, and everything derived
    from THAT file (mart_meta, the schema snapshot, memoized values). Immutable once built,
    apart from the memo and the reference count."""

    def __init__(self, path: str, key: _FileKey, pool_size: int) -> None:
        self.path = path
        self.key = key
        self.opened_at = time.time()
        self.refs = 0  # pinned requests + checked-out cursors; guarded by _lock
        self.retired = False
        self.closed = False
        self.memo: dict[str, Any] = {}
        # temp_directory mirrors what a file-backed instance would use (<db>.tmp next to
        # it): an in-memory instance would otherwise spill into the process CWD.
        conn = duckdb.connect(":memory:", config={"temp_directory": f"{path}.tmp"})
        try:
            conn.execute(f"ATTACH {_sql_string(key.target)} AS {_ALIAS} (READ_ONLY)")
            conn.execute(f"USE {_ALIAS}")
            schema: dict[str, set[str]] = {}
            for table, column in conn.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_catalog = current_database()"
            ).fetchall():
                schema.setdefault(str(table), set()).add(str(column))
            # An EMPTY DuckDB file is a valid database with nothing in it — every query would
            # then fail one at a time. A mart with zero tables is not a mart.
            if not schema:
                raise MartUnavailable(f"{path} is a DuckDB file with no tables in it")
            self.schema: dict[str, frozenset[str]] = {t: frozenset(c) for t, c in schema.items()}
            self.meta: dict[str, str] = {}
            if "mart_meta" in self.schema:  # absent on marts that predate mart_meta
                self.meta = {
                    str(k): str(v)
                    for k, v in conn.execute("SELECT key, value FROM mart_meta").fetchall()
                    if k is not None and v is not None
                }
            self.conn = conn
            self.pool: queue.Queue[duckdb.DuckDBPyConnection] = queue.Queue(maxsize=max(1, pool_size))
            for _ in range(max(1, pool_size)):
                self.pool.put(self.new_cursor())
        except BaseException:
            conn.close()
            raise

    def new_cursor(self) -> duckdb.DuckDBPyConnection:
        cur = self.conn.cursor()
        cur.execute(f"USE {_ALIAS}")  # a cursor is a new connection: default catalog is ":memory:"
        return cur

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        while True:
            try:
                cur = self.pool.get_nowait()
            except queue.Empty:
                break
            try:
                cur.close()
            except Exception:
                pass
        try:
            self.conn.close()
        except Exception:
            pass


# ---- module state ------------------------------------------------------------------------
_lock = threading.Lock()  # guards _current and every generation's refs/retired/closed
_current: _Generation | None = None

_reload_lock = threading.Lock()  # one opener at a time; never held while serving
_watch_path: str | None = None  # None = not watching (closed on purpose)
_pool_size = 4
_reload_interval_s = 30.0
_next_check = 0.0
_failed_key: _FileKey | None = None  # the file the last failed open was about

# Why there is no generation at all (a failed init, or a failed recovery from one), in
# operator-facing words — main.py keeps the app up on a failed open, and /api/health plus
# every 503 then say WHICH failure it was instead of always blaming the ETL.
_init_error: str | None = None
# The last failed RELOAD while a generation keeps serving (health reports it).
_reload_error: str | None = None

_swap_listeners: list[Callable[[], None]] = []


def add_swap_listener(fn: Callable[[], None]) -> None:
    """Call `fn` whenever the served mart changes (or is closed). For caches that live
    OUTSIDE a generation — e.g. response_cache — so they are dropped on a reload instead of
    lingering until LRU eviction."""
    _swap_listeners.append(fn)


def _notify_swap() -> None:
    for fn in list(_swap_listeners):
        try:
            fn()
        except Exception:
            logger.exception("mart swap listener failed")


def _retire(gen: _Generation) -> None:
    """Caller holds _lock. Close now if unused, else when the last user releases it."""
    gen.retired = True
    if gen.refs <= 0:
        gen.close()


def _release(gen: _Generation) -> None:
    with _lock:
        gen.refs -= 1
        if gen.retired and gen.refs <= 0:
            gen.close()


def _open(path: str, key: _FileKey | None) -> _Generation:
    if key is None:
        raise MartUnavailable(f"no analytics database at {path} (the ETL hasn't produced it yet)")
    try:
        return _Generation(path, key, _pool_size)
    except MartUnavailable as exc:
        raise MartUnavailable(f"analytics database at {path} is unusable — {exc}") from exc
    except Exception as exc:  # duckdb.Error (IOException: 0-byte/garbage/truncated), OSError
        raise MartUnavailable(
            f"analytics database at {path} is unusable — {_one_line(exc)}"
        ) from exc


def _swap_in(gen: _Generation, *, path: str) -> bool:
    """Install `gen` as the served mart, retiring the previous one. Refused (and `gen`
    closed) if the watch was disarmed or re-pointed while `gen` was being opened."""
    global _current, _init_error, _reload_error, _failed_key
    with _lock:
        if _watch_path != path:
            gen.close()
            return False
        old, _current = _current, gen
        _init_error = _reload_error = None
        _failed_key = None
        if old is not None:
            _retire(old)
    _notify_swap()
    return True


def init(path: str, pool_size: int = 4, *, reload_interval_s: float | None = None) -> None:
    """Serve the mart at `path` (usually the current.duckdb symlink) and keep watching it.

    Whatever was served before is retired first, so a failed open leaves the API honestly
    degraded rather than silently serving the previous file. Raises MartUnavailable on
    failure — the watch stays armed, so the mart is picked up once a usable file appears
    (the degraded boot heals itself without a restart)."""
    global _watch_path, _pool_size, _reload_interval_s, _next_check, _failed_key, _init_error
    with _reload_lock:
        close()
        _pool_size = max(1, pool_size)
        _reload_interval_s = (
            settings.mart_reload_interval_s if reload_interval_s is None else reload_interval_s
        )
        _next_check = time.monotonic() + max(0.0, _reload_interval_s)
        _watch_path = path
        key = _file_key(path)
        try:
            gen = _open(path, key)
        except MartUnavailable as exc:
            _failed_key = key
            _init_error = str(exc)
            raise
        _swap_in(gen, path=path)


def close() -> None:
    """Stop serving and stop watching (shutdown, or a test simulating 'no mart')."""
    global _current, _watch_path, _init_error, _reload_error, _failed_key
    with _lock:
        gen, _current = _current, None
        _watch_path = None
        _init_error = _reload_error = None  # closed on purpose: nothing failed
        _failed_key = None
        if gen is not None:
            _retire(gen)
    _notify_swap()


def maybe_reload(force: bool = False) -> bool:
    """Swap in a new generation if the watched path now resolves to a different file.

    Cheap on the hot path: a monotonic-clock compare, and at most once per interval one
    os.stat. Non-blocking: if another thread is already checking/reloading, return at once
    and keep serving the current generation. Returns True when a new mart was swapped in."""
    global _next_check, _failed_key, _init_error, _reload_error
    if _watch_path is None:
        return False
    if not force and (_reload_interval_s <= 0 or time.monotonic() < _next_check):
        return False
    if not _reload_lock.acquire(blocking=False):
        return False
    try:
        path = _watch_path
        if path is None:
            return False
        _next_check = time.monotonic() + max(0.0, _reload_interval_s)
        key = _file_key(path)
        serving = _current
        if key is None:
            return False  # dangling link / file gone: keep serving what we have
        if serving is not None and key == serving.key:
            return False
        if key == _failed_key:
            return False  # the same broken file as last time — only a change retries
        try:
            gen = _open(path, key)
        except MartUnavailable as exc:
            _failed_key = key
            if serving is None:
                _init_error = str(exc)
            else:
                _reload_error = str(exc)
            logger.error("analytics mart reload failed, still serving %s: %s",
                         os.path.basename(serving.key.target) if serving else "nothing", exc)
            return False
        if not _swap_in(gen, path=path):
            return False
        logger.info(
            "analytics mart reloaded: %s -> %s (mart_version %s)",
            os.path.basename(serving.key.target) if serving else "none",
            os.path.basename(key.target),
            gen.meta.get("mart_version"),
        )
        return True
    finally:
        _reload_lock.release()


# ---- per-request pinning -----------------------------------------------------------------
class _Scope:
    """One request's view: the generation it pinned on first DB use (None until then)."""

    __slots__ = ("gen",)

    def __init__(self) -> None:
        self.gen: _Generation | None = None


# ContextVars, so they are per asyncio task AND copied into the threadpool worker that runs
# a sync route handler (the _Scope OBJECT is shared by reference, so a pin taken in the
# worker thread is released by request_budget() back in the event loop). Unset (None)
# outside a request, where the per-acquire bound alone applies and each call reads the
# current generation.
_wait_deadline: ContextVar[float | None] = ContextVar("analytics_wait_deadline", default=None)
_scope: ContextVar[_Scope | None] = ContextVar("analytics_mart_scope", default=None)


@contextmanager
def request_budget(seconds: float | None = None):
    """Bound the total time everything inside may spend WAITING for a pool cursor, and pin
    one mart generation for everything inside (taken lazily, on first DB use).

    Wrapped around every HTTP request by observability.RequestContextMiddleware."""
    budget = _REQUEST_WAIT_BUDGET_S if seconds is None else seconds
    token = _wait_deadline.set(time.monotonic() + budget)
    scope = _Scope()
    scope_token = _scope.set(scope)
    try:
        yield
    finally:
        _scope.reset(scope_token)
        _wait_deadline.reset(token)
        if scope.gen is not None:
            _release(scope.gen)


@contextmanager
def _pinned_for_call():
    """Outside a request, pin the current generation for the duration of the block, so a
    multi-query computation (memo()) reads ONE mart. Request scopes already pin."""
    if _scope.get() is not None:
        yield
        return
    scope = _Scope()
    token = _scope.set(scope)
    try:
        yield
    finally:
        _scope.reset(token)
        if scope.gen is not None:
            _release(scope.gen)


def _view() -> _Generation | None:
    """The generation this caller reads: the request's pinned one (pinning the current one
    on first use), else the current one. Never takes a cursor, never queries."""
    scope = _scope.get()
    if scope is not None and scope.gen is not None:
        return scope.gen
    maybe_reload()
    with _lock:
        if scope is None:
            return _current
        if scope.gen is None and _current is not None:
            _current.refs += 1
            scope.gen = _current
        return scope.gen


def _acquire() -> _Generation | None:
    """_view() plus one reference for the caller's own use (release with _release)."""
    gen = _view()
    if gen is None:
        return None
    with _lock:
        if gen.closed:  # only possible unpinned: swapped out AND closed since _view()
            gen = _current
            if gen is None:
                return None
        gen.refs += 1
    return gen


# ---- what the routers read ----------------------------------------------------------------
def is_ready() -> bool:
    return _view() is not None


def unavailable_reason() -> str | None:
    """Why the analytics DB is not open (None when it is, or when it was closed on
    purpose). Surfaced by /api/health and folded into every data endpoint's 503."""
    return _init_error if _current is None else None


def missing_detail() -> str:
    """The 503 detail for "no usable mart": the specific reason when an open failed."""
    reason = unavailable_reason()
    return f"analytics database not available — {reason}" if reason else _DB_MISSING_DETAIL


def mart_meta() -> dict[str, str]:
    """The served mart's mart_meta table as a dict, empty when the DB is absent / predates
    mart_meta. Read once per generation, so callers (notably the ALWAYS-200 liveness probe)
    never take a cursor to describe the mart."""
    gen = _view()
    return dict(gen.meta) if gen is not None else {}


def mart_version() -> str | None:
    """The served mart's version string (mart_meta.mart_version), or None when the DB is
    absent / predates mart_meta."""
    gen = _view()
    return gen.meta.get("mart_version") if gen is not None else None


def built_at() -> str | None:
    """When the served mart was BUILT (mart_meta.built_at), or None. mart_version is only
    the build DATE, so two builds on one day (a light build + the nightly, or a rebuild
    after a fix) share it — caches that must not mix them key on both."""
    gen = _view()
    return gen.meta.get("built_at") if gen is not None else None


def has_table(table: str) -> bool:
    """Capability probe, answered from the served generation's schema snapshot (no query).
    False while no mart is open — and, unlike the lru_caches it replaced, that answer is
    never remembered past the moment a mart appears."""
    gen = _view()
    return gen is not None and table in gen.schema


def has_column(table: str, column: str) -> bool:
    """Capability probe for one column — see has_table()."""
    gen = _view()
    return gen is not None and column in gen.schema.get(table, ())


_MISS = object()


def memo(name: str, compute: Callable[[], T]) -> T:
    """Memoize a mart-derived value (a row probe, a DISTINCT over a mart, a small lookup
    table) on the served generation — computed once per mart, dropped with it on a reload.
    Failures (e.g. an HTTPException 503) are not cached. Keys are module-qualified by the
    caller ("niches.list_cuts") so routers can't collide."""
    with _pinned_for_call():
        gen = _view()
        if gen is None:
            return compute()  # raises the proper 503 through query()
        hit = gen.memo.get(name, _MISS)
        if hit is not _MISS:
            return hit
        value = compute()
        gen.memo[name] = value
        return value


def _version_from_name(target: str | None) -> str | None:
    if not target:
        return None
    m = _VERSION_IN_NAME.search(os.path.basename(target))
    return m.group(1) if m else None


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def watch_status() -> dict[str, Any]:
    """What /api/health reports about loaded-vs-published, without touching DuckDB: the
    file this process serves, the file the watched link points at NOW, and whether they
    differ (true for up to one check interval after a nightly swap — or for good, with
    `reload_error` set, when the new file could not be opened)."""
    gen = _view()
    path = _watch_path
    now_key = _file_key(path) if path else None
    link_target = os.path.realpath(path) if path else None
    loaded = gen.key if gen is not None else None
    return {
        "loaded_file": os.path.basename(loaded.target) if loaded else None,
        "loaded_version": gen.meta.get("mart_version") if gen is not None else None,
        "loaded_at": _iso(gen.opened_at) if gen is not None else None,
        "link_target": os.path.basename(link_target) if link_target else None,
        "link_target_exists": now_key is not None,
        "link_target_version": _version_from_name(link_target),
        "target_differs": bool(loaded is not None and now_key is not None and now_key != loaded),
        "reload_error": _reload_error if gen is not None else None,
        "reload_interval_s": _reload_interval_s if path else None,
    }


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
    gen = _acquire()
    if gen is None:
        raise HTTPException(status_code=503, detail=missing_detail())
    try:
        try:
            # Bounded wait (was: block forever — pool of 4 vs concurrency 40 parked every
            # worker in this call, a documented production hang), and bounded again by what
            # is left of the request's budget. On timeout, shed the request.
            cur = gen.pool.get(timeout=_acquire_timeout())
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
            try:
                gen.pool.put(gen.new_cursor())
            except Exception:
                gen.pool.put(cur)  # keep the pool size; the next use replaces it again
            if isinstance(exc, duckdb.IOException):
                # The file went bad UNDER an open connection (a block past EOF on a truncated
                # mart, a failing disk). Not a client error and not a bug in the handler:
                # shed it as the same 503 family as "no mart", loudly logged, never a 500.
                logger.error("analytics DB read failed: %s", _one_line(exc))
                raise HTTPException(status_code=503, detail=_UNREADABLE_DETAIL) from exc
            raise
        else:
            gen.pool.put(cur)
    finally:
        _release(gen)


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
