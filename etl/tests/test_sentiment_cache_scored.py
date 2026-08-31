"""The sentiment cache must not re-scan reviews that matched nothing.

The defect this pins down: the incremental delta used to be "reviews with no row in
cache.aspect_mention", but a review whose text matches no aspect keyword never GETS a row there —
so it stayed "new" forever and was re-regexed every night. Measured before the fix: three
consecutive nightlies re-scanned 10.96M / 10.38M / 10.77M reviews (~20 min/night on the 2-core
droplet), one of them producing exactly 0 new mention rows. cache.scored_review records the scan
itself, which is the fact the delta actually needs.

Runs the REAL compute_aspect_sentiment() twice over a fixture with both mention-bearing and
zero-mention reviews, against a real on-disk cache file in a temp dir.
"""
from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

# 4 reviews that mention an aspect, 6 that mention nothing an arm could match. The zero-mention
# ones are the point of the test: under the old delta they were "new" on every run.
MENTIONING = [
    ("m1", "The combat is excellent and the bosses are brutal."),
    ("m2", "Great soundtrack, the music carries the whole game."),
    ("m3", "The art style is gorgeous."),
    ("m4", "Way too expensive for what you get, not worth the price."),
]
SILENT = [(f"s{i}", "qqq zzz " * 12) for i in range(6)]


def _capture_new_reviews(fn, con, data_dir) -> int:
    """Run compute_aspect_sentiment and parse 'N new review(s) scored' from its own log line —
    the same figure the nightly log shows, so the assertion is about what an operator reads."""
    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        fn(con, data_dir)
    m = re.search(r"([\d,]+) new review\(s\) scored", buf.getvalue())
    assert m, f"no cache log line in: {buf.getvalue()!r}"
    return int(m.group(1).replace(",", ""))


def _fresh_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute("CREATE SCHEMA src")
    con.execute(
        "CREATE TABLE src.reviews(appid INTEGER, recommendationid VARCHAR, review_text VARCHAR,"
        " language VARCHAR, voted_up INTEGER)"
    )
    rows = [(1, rid, txt, "english", 1) for rid, txt in MENTIONING + SILENT]
    con.executemany("INSERT INTO src.reviews VALUES (?,?,?,?,?)", rows)
    # compute_aspect_sentiment reads the LEAN key table staging builds (stg_review_key — no
    # review text) for the pool, and goes to src.reviews for the delta's text. Mirror that here.
    con.execute(
        "CREATE TEMP TABLE stg_review_key AS "
        "SELECT appid, recommendationid, voted_up "
        "FROM src.reviews WHERE language = 'english'"
    )
    return con


def test_zero_mention_reviews_are_scanned_once():
    bm.TEARDOWN_MIN_REVIEWS = 1  # fixture-sized floor
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)

        con = _fresh_con()
        n1 = _capture_new_reviews(bm.compute_aspect_sentiment, con, data_dir)
        first = con.execute(
            "SELECT appid, recommendationid, aspect, text_sentiment "
            "FROM stg_aspect_mention_sentiment ORDER BY 1,2,3"
        ).fetchall()
        con.close()

        # Run 2 on a FRESH connection (new nightly), same cache file, no new reviews.
        con = _fresh_con()
        n2 = _capture_new_reviews(bm.compute_aspect_sentiment, con, data_dir)
        second = con.execute(
            "SELECT appid, recommendationid, aspect, text_sentiment "
            "FROM stg_aspect_mention_sentiment ORDER BY 1,2,3"
        ).fetchall()

        assert n1 == len(MENTIONING) + len(SILENT), f"run 1 must scan everything, scanned {n1}"
        # THE defect: under the old delta n2 == len(SILENT) (6), re-scanned forever.
        assert n2 == 0, f"run 2 re-scanned {n2} review(s); zero-mention reviews must stay cached"
        assert first == second, "cached output must be identical to the freshly-scored one"
        assert len(first) > 0, "fixture must actually produce mentions"

        # A genuinely new review is still picked up (the cache must not go stale-forever).
        # Staging is rebuilt every nightly, so rebuild it here too after the insert.
        con.execute(
            "INSERT INTO src.reviews VALUES (1, 'late', 'The combat is fun.', 'english', 1)")
        con.execute("DROP TABLE stg_review_key")
        con.execute(
            "CREATE TEMP TABLE stg_review_key AS "
            "SELECT appid, recommendationid, voted_up "
            "FROM src.reviews WHERE language = 'english'"
        )
        n3 = _capture_new_reviews(bm.compute_aspect_sentiment, con, data_dir)
        assert n3 == 1, f"a new review must be scanned exactly alone, got {n3}"
        con.close()


def test_config_change_still_forces_full_rescan():
    """scored_review must die with aspect_mention on a config wipe, or the wipe silently no-ops."""
    bm.TEARDOWN_MIN_REVIEWS = 1
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        con = _fresh_con()
        _capture_new_reviews(bm.compute_aspect_sentiment, con, data_dir)
        con.close()

        # Simulate a config change by rewriting the stored hash.
        cache = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        cache.execute("UPDATE meta SET value = 'stale' WHERE key = 'config_hash'")
        cache.close()

        con = _fresh_con()
        n = _capture_new_reviews(bm.compute_aspect_sentiment, con, data_dir)
        assert n == len(MENTIONING) + len(SILENT), (
            f"config change must rescan everything, rescanned {n}"
        )
        con.close()


def test_crash_recovery_rescans_without_duplicates():
    """A review whose mentions landed but whose scored_review record did not (crash between the
    two) must be re-scanned — and the re-insert must not double its rows."""
    bm.TEARDOWN_MIN_REVIEWS = 1
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        con = _fresh_con()
        _capture_new_reviews(bm.compute_aspect_sentiment, con, data_dir)
        con.close()

        cache = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        # the crash: scan record lost, mention rows kept
        cache.execute("DELETE FROM scored_review WHERE recommendationid = 'm1'")
        before = cache.execute(
            "SELECT count(*) FROM aspect_mention WHERE recommendationid = 'm1'"
        ).fetchone()[0]
        cache.close()
        assert before > 0

        con = _fresh_con()
        n = _capture_new_reviews(bm.compute_aspect_sentiment, con, data_dir)
        assert n == 1, f"exactly the crashed review must be rescanned, got {n}"
        rows = con.execute(
            "SELECT count(*) FROM stg_aspect_mention_sentiment WHERE recommendationid = 'm1'"
        ).fetchone()[0]
        con.close()

        cache = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        after = cache.execute(
            "SELECT count(*) FROM aspect_mention WHERE recommendationid = 'm1'"
        ).fetchone()[0]
        cache.close()
        assert after == before, f"duplicate mention rows after crash-rescan: {before} -> {after}"
        assert rows > 0
