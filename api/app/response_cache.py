"""In-process response cache for handlers that are pure functions of the mart.

A few endpoints (market benchmarks, seasonality, launch curve, timing overview) read
precomputed mart tables and do arithmetic on them — no request state, no user data. The
mart itself only changes when the nightly ETL swaps the whole DuckDB file in and the app
restarts, so within one process their answers are constants. Computing them per request
is pure waste (timing/overview alone is three queries plus a 12-month scoring pass).

Every entry is keyed by the loaded mart's IDENTITY — `analytics_db.mart_version()` AND
`analytics_db.built_at()` — alongside the handler name and its parameters, so a process
serving an older mart can never hand back a newer mart's numbers. Both halves are needed:
mart_version is only the build DATE, so a light build and the nightly build of the same day
(or a rebuild after a fix) share it; built_at is the build timestamp and separates them. In
the deployment the app restarts on every swap, so entries are simply never read again after
one; the pair is what makes the key safe if the DB is ever re-opened live instead.
When the mart carries no version (pre-mart_meta build, or the DB isn't open at all) the
result is computed and NOT cached — an unversioned answer has nothing safe to key on.

Bounded like the rate limiter: `genre` is a free-form query param, so an adversarial client
could otherwise mint entries forever. Two defenses: handlers pass `cache_if` so an answer
for an unrecognized key (an unknown genre reads as an EMPTY payload, not a 404) is computed
but never stored, and past _MAX_ENTRIES the LEAST-RECENTLY-USED entries are evicted one at
a time rather than the table being cleared wholesale. A hit moves its entry to the young
end (OrderedDict.move_to_end), so a hot genre can't be evicted by a burst of one-shot
enumeration keys, and eviction still costs O(1) on the read path.

These same handlers send `Cache-Control: public, max-age=3600` (see CACHE_CONTROL): the
data is public, identical for everyone, and at most a day old — an hour of browser/CDN
caching costs nothing and takes the repeat traffic off the box entirely.
"""
from __future__ import annotations

from collections import OrderedDict
from typing import Any, Callable, TypeVar

from . import analytics_db

# One hour: comfortably shorter than the nightly rebuild cadence, so a client can never
# hold yesterday's numbers past the next morning's ETL by more than an hour.
CACHE_CONTROL = "public, max-age=3600"

_MAX_ENTRIES = 256

# OrderedDict (not a plain dict): eviction is LRU, so a hit must be able to move its entry
# to the young end — see get_or_compute.
_cache: "OrderedDict[tuple, Any]" = OrderedDict()

_MISS = object()

T = TypeVar("T")


def clear() -> None:
    """Drop every cached response (test hook; also handy after a live DB swap)."""
    _cache.clear()


def size() -> int:
    return len(_cache)


def get_or_compute(
    name: str,
    params: tuple,
    compute: Callable[[], T],
    cache_if: Callable[[T], bool] | None = None,
) -> T:
    """Return the cached response for (mart identity, name, params), computing it on a miss.

    `compute` raising (a 404 for an unknown genre, a 503 for a missing mart) propagates and
    stores nothing — only successful answers are remembered. `cache_if`, when given, gets the
    computed answer and vetoes storing it: handlers whose unknown-key answer is a successful
    but EMPTY payload use it so enumerating keys can't fill the cache."""
    version = analytics_db.mart_version()
    if version is None:  # unversioned mart / DB not open: nothing safe to key on
        return compute()
    key = (version, analytics_db.built_at(), name, params)
    # One atomic lookup: `key in _cache` followed by `_cache[key]` could KeyError against a
    # concurrent clear() (the test hook, and a live DB swap would use it too).
    hit = _cache.get(key, _MISS)
    if hit is not _MISS:
        # LRU: a hit protects its entry from the next eviction. MUST be guarded — the get()
        # above is atomic, but between it and this line another thread's popitem() (or the
        # clear() test hook) can evict the very key we just read, and a bare move_to_end
        # would then raise KeyError straight out of a request handler as a 500. Handlers run
        # in a threadpool across 2 uvicorn workers, so this is reachable, not theoretical.
        # Losing the LRU bump on that race is free: the value is already in hand and the
        # entry is gone anyway.
        try:
            _cache.move_to_end(key)
        except KeyError:
            pass
        return hit
    value = compute()
    if cache_if is not None and not cache_if(value):
        return value
    while len(_cache) >= _MAX_ENTRIES:
        # Bounded: `genre` is caller-supplied and unbounded in principle. Drop the
        # LEAST-RECENTLY-USED entry, not the whole table — a full clear threw away every
        # real genre's answer (and the mart-pure handlers' whole reason to exist) on one
        # adversarial burst, and plain oldest-first eviction let a burst of one-shot keys
        # evict a hot genre that was just read.
        try:
            _cache.popitem(last=False)
        except KeyError:  # emptied under us — nothing to do
            break
    _cache[key] = value
    return value
