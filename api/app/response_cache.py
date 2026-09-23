"""In-process response cache for handlers that are pure functions of the mart.

A few endpoints (market benchmarks, seasonality, launch curve, timing overview) read
precomputed mart tables and do arithmetic on them — no request state, no user data. The
mart itself only changes when the nightly ETL publishes a new DuckDB file, so between two
publishes their answers are constants. Computing them per request is pure waste
(timing/overview alone is three queries plus a 12-month scoring pass).

Every entry is keyed by the served mart's IDENTITY — `analytics_db.mart_version()` AND
`analytics_db.built_at()`, both read off the generation the request is pinned to —
alongside the handler name and its parameters, so a request served by one mart can never
hand back another mart's numbers. Both halves are needed: mart_version is only the build
DATE, so a light build and the nightly build of the same day (or a rebuild after a fix)
share it; built_at is the build timestamp and separates them. analytics_db hot-reloads a
newly published mart without a restart and calls clear() on every swap (a swap listener,
registered below), so the previous mart's entries are dropped at once rather than lingering
until LRU eviction; the identity key is what keeps a request still pinned to the OLD mart
during the swap from reading or writing the new mart's answers.
When the mart carries no version (pre-mart_meta build, or the DB isn't open at all) the
result is computed and NOT cached — an unversioned answer has nothing safe to key on.

Bounded like the rate limiter: `genre` is a free-form query param, so an adversarial client
could otherwise mint entries forever. Two defenses: handlers pass `cache_if` so an answer
for an unrecognized key (an unknown genre reads as an EMPTY payload, not a 404) is computed
but never stored, and past _MAX_ENTRIES the LEAST-RECENTLY-USED entries are evicted one at
a time rather than the table being cleared wholesale. A hit moves its entry to the young
end (OrderedDict.move_to_end), so a hot genre can't be evicted by a burst of one-shot
enumeration keys, and eviction still costs O(1) on the read path.

These same handlers go through serve(): `Cache-Control: public, max-age=300` plus an ETag
that IS the mart identity + handler + params, so a browser revalidates every 5 minutes and
gets a body-less 304 while the mart is unchanged (computed before any DB work — the ETag
needs no data). It used to be `max-age=3600` with no validator: once the app hot-reloads a
new mart, a browser kept serving the old mart's seasonality/timing/benchmarks for up to
an hour next to fresh answers from every other endpoint — two marts on one screen. Five
minutes bounds that window; the 304s keep the repeat traffic nearly free.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from typing import Any, Callable, TypeVar

from fastapi import Request, Response

from . import analytics_db

# Five minutes of freshness, then a cheap revalidation (see serve()).
CACHE_CONTROL = "public, max-age=300"

_MAX_ENTRIES = 256

# OrderedDict (not a plain dict): eviction is LRU, so a hit must be able to move its entry
# to the young end — see get_or_compute.
_cache: "OrderedDict[tuple, Any]" = OrderedDict()

_MISS = object()

T = TypeVar("T")


def clear() -> None:
    """Drop every cached response (called on every mart swap, and a test hook)."""
    _cache.clear()


analytics_db.add_swap_listener(clear)


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


def etag_for(name: str, params: tuple) -> str | None:
    """A validator for a mart-pure response: a hash of the served mart's identity + the
    handler + its params — the same things the in-process cache keys on, so equal ETags
    mean byte-identical bodies. None for an unversioned mart (nothing safe to key on)."""
    version = analytics_db.mart_version()
    if version is None:
        return None
    raw = f"{version}|{analytics_db.built_at()}|{name}|{params!r}"
    return 'W/"' + hashlib.sha256(raw.encode()).hexdigest()[:24] + '"'


def _matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    tags = [t.strip() for t in if_none_match.split(",")]
    return "*" in tags or etag in tags


def serve(
    request: Request,
    response: Response,
    name: str,
    params: tuple,
    compute: Callable[[], T],
    cache_if: Callable[[T], bool] | None = None,
) -> T | Response:
    """get_or_compute() plus the HTTP caching contract: Cache-Control + ETag on every
    successful answer, and a body-less 304 — decided BEFORE any DB work — when the client
    already holds this mart's answer. Errors (a 404 for an unknown genre, a 503) carry
    neither header, so they are never cached or revalidated."""
    headers = {"Cache-Control": CACHE_CONTROL}
    etag = etag_for(name, params)
    if etag is not None:
        headers["ETag"] = etag
        if _matches(request.headers.get("if-none-match"), etag):
            return Response(status_code=304, headers=headers)
    value = get_or_compute(name, params, compute, cache_if=cache_if)
    response.headers.update(headers)
    return value
