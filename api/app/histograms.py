"""One honest rendering of the marts' half-decade LOG histograms.

Every log-binned histogram in the marts (mart_niche_hist, mart_market_hist's revenue /
reviews / owners, mart_niche_players_hist) buckets with
    bucket_index = floor(log10(GREATEST(v, 1)) * 2),  x_min = 10^(i/2),  x_max = 10^((i+1)/2)
so bucket 0 is labelled [1, 3.16) — but GREATEST(v, 1) FLOORS every value below 1 into it,
$0 included. Served raw, the niche page drew "$1–$3.16" over a bar that was mostly free
games (and /api/market/distribution's reviews histogram did the same with 0-review games).
Only /niches/{d}/{k}/distribution used to fix the lower edge, and only on one of its two
paths; niche_detail's revenue_histogram passed the mart rows through untouched.

log_buckets() is now the single path for all of them: bucket 0's lower edge becomes 0.0
(so the bucket round-trips into the [x_min, x_max) cross-filters — a 1.0 edge silently
dropped the $0 games) and the bucket is marked floored=True: its lower edge is a floor
sentinel, and it must be read as "< x_max (anything lower was clamped in, $0 included)",
never as "x_min–x_max". Once the ETL stops flooring (free / unknown-price revenue becomes
NULL and simply drops out) bucket 0 may not exist at all — then nothing is marked, which
is exactly right.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .schemas import HistBucket

FLOOR_BUCKET = 0


def log_buckets(rows: Iterable[Mapping[str, Any]]) -> list[HistBucket]:
    out: list[HistBucket] = []
    for row in rows:
        b = dict(row)
        if int(b["bucket_index"]) == FLOOR_BUCKET:
            b["x_min"] = 0.0
            b["floored"] = True
        out.append(HistBucket(**b))
    return out
