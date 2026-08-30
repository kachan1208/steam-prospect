"""mart_game_aspect_reviews must order by a TOTAL order, so its contents cannot churn.

Found 2026-08-30 while benchmarking the rewrite: the mart was non-deterministic. The same SQL
over the same 120K real reviews returned DIFFERENT reviews on consecutive runs, and different
again at threads=1 vs threads=4.

Why: the top-K window ordered by (votes_up DESC, timestamp_created DESC) and the final ORDER
BY by (appid, aspect, sentiment, votes_up DESC). Neither is a total order — many groups hold
several reviews sharing a vote count and a timestamp — so row_number() and the sort picked
among tied rows however the plan happened to be executed.

Why it matters: the drill-down claims "the top reviews about combat in this game". Rows
churning for unchanged data reads as new information and isn't. It also makes the mart
undiffable against yesterday's, which defeats any content-level check the pre-swap validation
gate might grow.

WHY THIS TEST IS STRUCTURAL RATHER THAN BEHAVIOURAL. The obvious test — build the mart twice
and compare — was written first and PASSED WITH THE FIX REMOVED: at a unit-test-sized fixture
DuckDB never parallelises the plan, so the tie order is stable by luck and the bug is
invisible. Reproducing it needs ~100K+ rows, which is far too slow here. A test that cannot
fail is worse than no test, so this asserts the property that actually prevents the bug: both
ordering sites must END with a key that is unique per review. Verified to fail when either
tiebreak is deleted.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

SQL_PATH = ETL / "marts" / "mart_game_aspect_reviews.sql"
SQL = SQL_PATH.read_text()

# recommendationid is Steam's per-review primary key: unique, always present, already carried
# through every stage of this mart. Any other unique key would do; this one costs no extra join.
UNIQUE_KEY = "recommendationid"


def _normalise(chunk: str) -> str:
    """Collapse whitespace and strip SQL line comments so the assertions survive reformatting."""
    no_comments = re.sub(r"--[^\n]*", " ", chunk)
    return re.sub(r"\s+", " ", no_comments).strip()


def test_topk_window_breaks_ties_on_a_unique_key() -> None:
    """The row_number() that picks the top-K reviews per (appid, aspect, sentiment)."""
    m = re.search(r"row_number\(\)\s*OVER\s*\((.*?)\)\s*AS\s+rn", SQL, re.S | re.I)
    assert m, "could not find the top-K row_number() window in " + str(SQL_PATH)
    window = _normalise(m.group(1))
    order_by = window.split("ORDER BY", 1)
    assert len(order_by) == 2, f"row_number() window has no ORDER BY: {window}"
    keys = order_by[1]
    assert UNIQUE_KEY in keys, (
        "the top-K window's ORDER BY does not end in a unique key, so row_number() picks "
        "arbitrarily among reviews tied on votes_up and timestamp_created and the mart churns "
        f"between runs. ORDER BY was: {keys}"
    )
    assert keys.rstrip().endswith(UNIQUE_KEY), (
        f"{UNIQUE_KEY} must be the LAST ordering key to act as the tiebreak; got: {keys}"
    )


def test_final_order_by_breaks_ties_on_a_unique_key() -> None:
    """The ORDER BY on the CREATE TABLE, which fixes the stored row order."""
    m = re.search(r"ORDER BY\s+m\.appid\s*,\s*m\.aspect\s*,\s*m\.sentiment(.*?);", SQL, re.S | re.I)
    assert m, "could not find the final ORDER BY of the mart's CREATE TABLE"
    tail = _normalise(m.group(1))
    assert UNIQUE_KEY in tail, (
        "the mart's final ORDER BY does not end in a unique key, so the STORED row order "
        f"varies run to run. Tail was: {tail}"
    )


if __name__ == "__main__":
    test_topk_window_breaks_ties_on_a_unique_key()
    test_final_order_by_breaks_ties_on_a_unique_key()
    print("both ordering sites break ties on a unique key")
