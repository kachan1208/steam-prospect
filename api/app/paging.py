"""A total ORDER BY for every paginated (LIMIT/OFFSET) list the API serves.

LIMIT/OFFSET paging is only correct when the ORDER BY is a TOTAL order. With ties, DuckDB
may return tied rows in a different order on every execution — its parallel scans over
several row groups make that the norm on real-sized tables, not an edge case — so page 2
can repeat rows from page 1 and silently skip others. Measured on the real mart
(2026-09-21): the "new releases" query (released_within_days=30, sort=release_date desc)
returned three different page-1 sets in six calls, and walking 8 pages of 25 yielded 38
duplicates — 38 games the user could never reach; the niche list sorted by n_games
duplicated two niches the same way.

order_by() always appends the table's UNIQUE KEY after the requested sort terms, so the
order is total whatever the caller sorts on. Use it for every query that pages, and for
every top-N (a LIMIT without OFFSET has the same problem: WHICH tied rows make the cut).
"""
from __future__ import annotations

from collections.abc import Sequence


def order_by(*terms: str, unique: Sequence[str]) -> str:
    """`ORDER BY <terms...>, <unique key columns ASC>`.

    `terms` are trusted SQL fragments (whitelisted sort columns + direction, never raw
    request strings); `unique` must be a key that identifies one row of the result — the
    appid for games, (dimension, key, win, min_reviews) for mart_niche, (role, name) for
    entities."""
    if not unique:
        raise ValueError("order_by() needs the result's unique key — ties would page unstably")
    parts = [t for t in terms if t]
    parts.extend(f"{col} ASC" for col in unique)
    return "ORDER BY " + ", ".join(parts)
