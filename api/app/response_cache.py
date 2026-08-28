"""In-process response cache for handlers that are pure functions of the mart.

A few endpoints (market benchmarks, seasonality, launch curve, timing overview) read
precomputed mart tables and do arithmetic on them — no request state, no user data. The
mart itself only changes when the nightly ETL swaps the whole DuckDB file in and the app
restarts, so within one process their answers are constants. Computing them per request
is pure waste (timing/overview alone is three queries plus a 12-month scoring pass).

Every entry is keyed by `analytics_db.mart_version()` alongside the handler name and its
parameters, so:
  * a process serving an older mart can never hand back a newer mart's numbers, and
  * the entries a swapped-in DB invalidates are simply never read again (no explicit
    invalidation pass, and no chance of a stale hit if the DB IS re-opened live).
When the mart carries no version (pre-mart_meta build, or the DB isn't open at all) the
result is computed and NOT cached — an unversioned answer has nothing safe to key on.

Bounded like the rate limiter: `genre` is a free-form query param, so an adversarial
client could otherwise mint entries forever. Past _MAX_ENTRIES the whole table is dropped
(cheap, and the working set is a handful of real genres that immediately repopulates).

These same handlers send `Cache-Control: public, max-age=3600` (see CACHE_CONTROL): the
data is public, identical for everyone, and at most a day old — an hour of browser/CDN
caching costs nothing and takes the repeat traffic off the box entirely.
"""
from __future__ import annotations

from typing import Any, Callable, TypeVar

from . import analytics_db

# One hour: comfortably shorter than the nightly rebuild cadence, so a client can never
# hold yesterday's numbers past the next morning's ETL by more than an hour.
CACHE_CONTROL = "public, max-age=3600"

_MAX_ENTRIES = 256

_cache: dict[tuple, Any] = {}

T = TypeVar("T")


def clear() -> None:
    """Drop every cached response (test hook; also handy after a live DB swap)."""
    _cache.clear()


def size() -> int:
    return len(_cache)


def get_or_compute(name: str, params: tuple, compute: Callable[[], T]) -> T:
    """Return the cached response for (mart_version, name, params), computing it on a miss.

    `compute` raising (a 404 for an unknown genre, a 503 for a missing mart) propagates and
    stores nothing — only successful answers are remembered."""
    version = analytics_db.mart_version()
    if version is None:  # unversioned mart / DB not open: nothing safe to key on
        return compute()
    key = (version, name, params)
    if key in _cache:
        return _cache[key]
    value = compute()
    if len(_cache) >= _MAX_ENTRIES:
        _cache.clear()  # bounded: `genre` is caller-supplied and unbounded in principle
    _cache[key] = value
    return value
