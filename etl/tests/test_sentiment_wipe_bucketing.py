"""The WIPE path of compute_aspect_sentiment: score the whole pool in resumable hash buckets,
where the BUCKET IS THE UNIT OF WORK.

WHY THIS FILE EXISTS. A SENTIMENT_CACHE_VERSION bump empties cache.scored_review, so the
anti-join that normally yields a ~1.1M-review nightly delta yields the ENTIRE 24.4M-review pool,
and the delta's review text (a TEMP table, and therefore charged to DuckDB's
max_temp_directory_size) becomes a corpus-wide copy. The 2026-09-01 nightly, the first full build
after 1 -> 2, died exactly there after 13,473s:

    OutOfMemoryException: failed to offload data block of size 256.0 KiB (14.9 GiB/15.0 GiB used)

Bucketing fixed the memory. It did not, and could not, fix the CLOCK: at the droplet's measured
~116 mention-rows/s a full rescore is ~52 hours of scoring, against a nightly that runs under
`timeout 21600`. So the rescore has to survive being stopped and resumed, night after night, and
that is what this file pins.

THE INVARIANT, and the whole reason the loop is shaped the way it is. Each iteration DELETEs,
SCORES and RECORDS one bucket under the IDENTICAL predicate over the IDENTICAL table:

    DELETE that bucket's stale rows -> score it -> INSERT that bucket's ids into scored_review

so "the id-set in scored_review is exactly the id-set whose mention rows are all committed" holds
BY CONSTRUCTION, at any slicing granularity. It does not depend on buckets happening to split on
review boundaries — that accident would stop holding the moment anything sliced a review's own
keyword arms across iterations, which is bit-for-bit the 0.62% prefix hole (1,962 of 314,626
mentions, every one in the last two arms of the UNION) that this rescore exists to repair and
that is invisible from the cache alone.

What that buys, and what is tested below: a run that stops for ANY reason leaves every COMPLETED
bucket permanently done, and the next run resumes from the anti-join and lands on exactly the
cache an uninterrupted run would have produced.

Every test runs the REAL compute_aspect_sentiment against a real on-disk cache file.
"""
from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from contextlib import contextmanager, redirect_stdout
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

# Reviews deliberately written to match SEVERAL keyword arms each. A one-arm-per-review fixture
# cannot see the prefix defect described above at all: "a clean prefix of the arms the text
# matches" needs reviews that match more than one arm.
_TEMPLATES = [
    "The combat is brutal and the boss fights are hard, but the art is gorgeous.",
    "Great soundtrack, and the music fits the world exploration perfectly.",
    "The story and the writing are excellent, though the dialogue drags a little.",
    "Way too expensive for the content on offer, and not worth the price at all.",
    "The map is confusing and the backtracking is tedious, plus bugs everywhere.",
    "Tight controls, very responsive, and the visuals are stunning for the price.",
    "Too short for the money, but the ending and the characters are memorable.",
    "Challenging difficulty with brutal bosses, and the level design is superb.",
]
N_REVIEWS = 96
POOL = [(f"rev{i:04d}", f"{_TEMPLATES[i % len(_TEMPLATES)]} Playthrough {i}.")
        for i in range(N_REVIEWS)]
POOL_IDS = {rid for rid, _ in POOL}

# Reviews per bucket, fed to the real _rescore_bucket_count via its env knob. 96/12 = 8 buckets,
# enough that "stopped after bucket 2" is meaningfully different from "did nothing" and from
# "did everything".
BUCKET_REVIEWS = 12
N_BUCKETS = 8


def _fresh_con() -> duckdb.DuckDBPyConnection:
    """A build connection shaped like the real one at the point compute_aspect_sentiment runs:
    src.reviews attached, and the LEAN key table staging builds (stg_review_key — no text)."""
    con = duckdb.connect(":memory:")
    con.execute("SET threads=3")
    con.execute("SET memory_limit='1GB'")
    con.execute("CREATE SCHEMA src")
    con.execute(
        "CREATE TABLE src.reviews(appid INTEGER, recommendationid VARCHAR, review_text VARCHAR,"
        " language VARCHAR, voted_up INTEGER)"
    )
    con.executemany(
        "INSERT INTO src.reviews VALUES (?,?,?,?,?)",
        [(7, rid, txt, "english", i % 2) for i, (rid, txt) in enumerate(POOL)],
    )
    con.execute(
        "CREATE TEMP TABLE stg_review_key AS "
        "SELECT appid, recommendationid, voted_up FROM src.reviews WHERE language = 'english'"
    )
    return con


@contextmanager
def _env(bucket_reviews: int | None = BUCKET_REVIEWS, deadline: str | None = None):
    """Set the scoring knobs for the duration and restore them. This module must not leak
    environment or module state into the rest of the suite."""
    keys = {
        "PROSPECT_RESCORE_BUCKET_REVIEWS": None if bucket_reviews is None else str(bucket_reviews),
        "PROSPECT_SENTIMENT_DEADLINE_SECONDS": deadline,
    }
    prev = {k: os.environ.get(k) for k in keys}
    prev_floor = bm.TEARDOWN_MIN_REVIEWS
    for k, v in keys.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    bm.TEARDOWN_MIN_REVIEWS = 1  # fixture-sized eligibility floor
    try:
        yield
    finally:
        bm.TEARDOWN_MIN_REVIEWS = prev_floor
        for k, v in prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _score(data_dir: Path, bucket_reviews: int | None = BUCKET_REVIEWS,
           deadline: str | None = None) -> int:
    """One run of the real function against the cache in `data_dir`. Returns the
    'N new review(s) scored' figure from its own log line — reviews actually RECORDED this run,
    which a deadline stop makes different from the size of the delta."""
    with _env(bucket_reviews, deadline):
        con = _fresh_con()
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                bm.compute_aspect_sentiment(con, data_dir)
        finally:
            con.close()
    m = re.search(r"([\d,]+) new review\(s\) scored", buf.getvalue())
    assert m, f"no cache log line in: {buf.getvalue()!r}"
    return int(m.group(1).replace(",", ""))


def _cache(data_dir: Path):
    """(mention rows, scored ids) straight out of the cache file."""
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
    try:
        mentions = set(c.execute(
            "SELECT recommendationid, aspect, compound, clf_aspect, clf_sentiment, clf_margin "
            "FROM aspect_mention"
        ).fetchall())
        scored = {r[0] for r in c.execute("SELECT recommendationid FROM scored_review").fetchall()}
        return mentions, scored
    finally:
        c.close()


def _status(data_dir: Path) -> dict:
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
    try:
        cols = [r[1] for r in c.execute("PRAGMA table_info('rescore_status')").fetchall()]
        rows = c.execute("SELECT * FROM rescore_status").fetchall()
        assert len(rows) <= 1, f"rescore_status must hold at most one row, has {len(rows)}"
        return dict(zip(cols, rows[0])) if rows else {}
    finally:
        c.close()


def _arms(mentions) -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for row in mentions:
        out[row[0]].add(row[1])
    return out


def _buckets_of(ids, n: int) -> dict[str, int]:
    """review id -> its bucket, computed with the same hash() the loop uses."""
    c = duckdb.connect(":memory:")
    try:
        c.execute("CREATE TABLE ids(rid VARCHAR)")
        c.executemany("INSERT INTO ids VALUES (?)", [(r,) for r in sorted(ids)])
        return {rid: int(b) for rid, b in
                c.execute(f"SELECT rid, hash(rid) % {n} FROM ids").fetchall()}
    finally:
        c.close()


def _occupied(n: int) -> list[int]:
    return sorted(set(_buckets_of(POOL_IDS, n).values()))


class _FakeClock:
    """time.monotonic under test control, so a deadline test is deterministic rather than a
    race against the fixture's real runtime. Everything except monotonic() falls through to the
    real module (build_marts uses perf_counter elsewhere and must keep working)."""

    def __init__(self, real, now: float = 0.0):
        self._real = real
        self.now = now

    def monotonic(self) -> float:
        return self.now

    def __getattr__(self, name):
        return getattr(self._real, name)


def test_bucket_count_is_derived_from_the_delta_size():
    """A FIXED bucket count cannot serve both regimes, which is why this is a function of the
    delta: 8 buckets is right for an ordinary night and gives a wipe 6.5-HOUR buckets that can
    never complete inside the nightly, so a resumable rescore would never advance one step."""
    with _env(bucket_reviews=None):  # exercise the shipped default
        assert bm._rescore_bucket_count(0) == 1
        assert bm._rescore_bucket_count(1) == 1
        assert bm._rescore_bucket_count(bm.RESCORE_BUCKET_REVIEWS) == 1
        assert bm._rescore_bucket_count(bm.RESCORE_BUCKET_REVIEWS + 1) == 2
        # The two real regimes, at the live corpus sizes.
        nightly = bm._rescore_bucket_count(1_100_000)
        wipe = bm._rescore_bucket_count(24_458_199)
        assert nightly == 9, nightly
        assert wipe == 196, wipe
    with _env(bucket_reviews=1000):
        assert bm._rescore_bucket_count(10_000) == 10


def test_wipe_path_scores_the_full_pool_across_buckets():
    """N buckets must reproduce the 1-bucket cache exactly — every review, every arm."""
    occupied = _occupied(N_BUCKETS)
    # Guard against a vacuous run: if the fixture's ids all hashed into one bucket the loop
    # would execute once and prove nothing about bucketing.
    assert len(occupied) >= 2, f"fixture must span several buckets, spans {len(occupied)}"

    with tempfile.TemporaryDirectory() as td_ref, tempfile.TemporaryDirectory() as td_bkt:
        ref_dir, bkt_dir = Path(td_ref), Path(td_bkt)

        # One bucket: ask for more reviews per bucket than the fixture has.
        n_ref = _score(ref_dir, bucket_reviews=10_000)
        ref_mentions, ref_scored = _cache(ref_dir)

        n_bkt = _score(bkt_dir, bucket_reviews=BUCKET_REVIEWS)
        bkt_mentions, bkt_scored = _cache(bkt_dir)

        assert n_ref == N_REVIEWS, f"the wipe must scan the whole pool, scanned {n_ref}"
        assert ref_scored == POOL_IDS
        assert len(ref_mentions) > 0, "fixture must actually produce mention rows"
        ref_arms = _arms(ref_mentions)
        assert max(len(a) for a in ref_arms.values()) >= 3, (
            "fixture must contain reviews matching several arms, or the prefix defect in the "
            "module docstring is untestable"
        )

        assert n_bkt == N_REVIEWS, f"bucketed wipe scanned {n_bkt} of {N_REVIEWS}"
        assert bkt_scored == ref_scored == POOL_IDS
        assert bkt_mentions == ref_mentions, (
            f"bucketed cache differs from the single-pass cache: "
            f"{len(ref_mentions - bkt_mentions)} row(s) missing, "
            f"{len(bkt_mentions - ref_mentions)} extra"
        )

        bkt_arms = _arms(bkt_mentions)
        for rid in sorted(bkt_scored):
            assert bkt_arms[rid] == ref_arms[rid], (
                f"{rid} is marked scanned with arms {sorted(bkt_arms[rid])}, but its text "
                f"matches {sorted(ref_arms[rid])}"
            )


def test_scorer_runs_once_per_occupied_bucket():
    """The loop must really loop, and must visit every bucket that has reviews in it. Counting
    the scorer calls pins the skipped-bucket failure directly, rather than inferring it from a
    row count a partially-populated cache can still satisfy by luck."""
    occupied = _occupied(N_BUCKETS)
    assert len(occupied) >= 2

    calls: list[int] = []
    real = bm._stream_vader_and_classify

    def counting(con, select_sql, insert_sql, clf):
        n = real(con, select_sql, insert_sql, clf)
        calls.append(n)
        return n

    with tempfile.TemporaryDirectory() as td:
        bm._stream_vader_and_classify = counting
        try:
            _score(Path(td))
        finally:
            bm._stream_vader_and_classify = real
        mentions, scored = _cache(Path(td))

    assert len(calls) == len(occupied), (
        f"expected one scoring pass per occupied bucket ({len(occupied)}), got {len(calls)}"
    )
    assert sum(calls) == len(mentions), "every scored window must reach the cache"
    assert scored == POOL_IDS


def test_legacy_cache_without_scored_review_is_still_seeded():
    """The seed guard: a cache file predating scored_review (mention rows, no such table) must
    still be migrated rather than rescanned — that is the ~1.8M-review saving it was written
    for. Only the crash-wreckage case (table present, empty) is supposed to stop being seeded,
    because seeding THAT is what froze the 0.62% hole."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        _score(data_dir, bucket_reviews=10_000)
        mentions, scored = _cache(data_dir)
        assert scored == POOL_IDS and len(mentions) > 0

        c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        c.execute("DROP TABLE scored_review")
        c.close()

        n = _score(data_dir)
        assert n == 0, f"a legacy cache must be seeded, not rescanned; rescanned {n}"
        _, seeded = _cache(data_dir)
        assert seeded == {row[0] for row in mentions}


# ------------------------------------------------------------------------------------------
# Resumability — the reason the bucket is the unit of work.
# ------------------------------------------------------------------------------------------

def _crash_after(k_buckets: int, partial_rows: int = 3):
    """A scorer that completes `k_buckets` buckets, then scores a PARTIAL set of windows for the
    next one and dies inside it. The partial write matters: without it the test would only prove
    that a bucket which did nothing records nothing, which is trivially true.

    Since 2026-09-02 those partial rows land in the LOCAL staging table, not in the cache — the
    scoring pass runs with the cache detached so a multi-day rescore does not lock out the light
    build. The crash window that could leave rows in the CACHE without their ids therefore
    shrank to the three-statement commit; that path is covered by
    test_sentiment_cache_scored.py::test_crash_recovery_rescans_without_duplicates, which
    reproduces it directly by deleting a scored_review row."""
    real = bm._stream_vader_and_classify
    state = {"calls": 0}

    def scorer(con, select_sql, insert_sql, clf):
        state["calls"] += 1
        if state["calls"] > k_buckets:
            real(con, f"{select_sql} LIMIT {partial_rows}", insert_sql, clf)
            raise RuntimeError("simulated mid-bucket death")
        return real(con, select_sql, insert_sql, clf)

    return scorer, real, state


def test_interrupted_bucket_is_not_recorded():
    """A bucket whose scoring dies partway must leave ZERO of its ids in scored_review, even
    though it has already written mention rows — while the buckets that finished before it stay
    recorded. This is the invariant stated in one assertion: `scored_review` never contains an
    id whose rows are incomplete."""
    occupied = _occupied(N_BUCKETS)
    assert len(occupied) >= 4, "need enough buckets for 'some done, one interrupted, rest not'"
    k = 2
    by_bucket = _buckets_of(POOL_IDS, N_BUCKETS)
    done_ids = {r for r, b in by_bucket.items() if b in occupied[:k]}
    interrupted_ids = {r for r, b in by_bucket.items() if b == occupied[k]}
    assert done_ids and interrupted_ids

    scorer, real, state = _crash_after(k)
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        bm._stream_vader_and_classify = scorer
        try:
            with _env():
                con = _fresh_con()
                try:
                    with pytest.raises(RuntimeError, match="simulated mid-bucket death"):
                        with redirect_stdout(io.StringIO()):
                            bm.compute_aspect_sentiment(con, data_dir)
                finally:
                    con.close()
        finally:
            bm._stream_vader_and_classify = real

        mentions, scored = _cache(data_dir)

    assert state["calls"] == k + 1, "the fixture must actually reach the interrupted bucket"
    # Not a vacuous "nothing happened at all" run: the buckets before it really did commit.
    mention_ids = {row[0] for row in mentions}
    assert mention_ids & done_ids, "the completed buckets must have committed mention rows"
    # Not one id of the interrupted bucket is claimed as scanned...
    assert not (scored & interrupted_ids), (
        f"{len(scored & interrupted_ids)} id(s) from the interrupted bucket were recorded in "
        "scored_review; a bucket must be recorded only after all of its rows are committed"
    )
    # ...and since scoring now runs with the cache detached, it left no rows there either, so
    # there is nothing for the next run to clean up. Strictly stronger than "ids absent".
    assert not (mention_ids & interrupted_ids), (
        f"{len(mention_ids & interrupted_ids)} id(s) of the interrupted bucket wrote mention "
        "rows; scoring must stage locally and commit only in the bucket's own attach window"
    )
    # ...while the buckets that completed before it are durably done.
    assert scored == done_ids, (
        f"expected exactly the {len(done_ids)} completed-bucket ids in scored_review, got "
        f"{len(scored)}"
    )


def test_run_that_dies_after_bucket_k_resumes_and_matches_a_clean_run():
    """THE HEADLINE REQUIREMENT. A partial night must leave real, durable progress: the buckets
    it completed stay completed, the next run's anti-join skips them and scores ONLY the rest,
    and the cache it ends with is identical to one an uninterrupted run produces.

    Under an end-of-delta scored_review write this test fails: nothing survives the crash, so
    the second run rescores all 96 reviews. That is not a hypothetical inefficiency — at 52h of
    scoring against a 6h nightly it is the difference between a rescore that completes over ~4
    weeks and one that can never complete at all."""
    k = 3
    scorer, real, state = _crash_after(k)

    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as td_clean:
        data_dir, clean_dir = Path(td), Path(td_clean)

        bm._stream_vader_and_classify = scorer
        try:
            with _env():
                con = _fresh_con()
                try:
                    with pytest.raises(RuntimeError):
                        with redirect_stdout(io.StringIO()):
                            bm.compute_aspect_sentiment(con, data_dir)
                finally:
                    con.close()
        finally:
            bm._stream_vader_and_classify = real

        _, scored_after_crash = _cache(data_dir)
        assert state["calls"] == k + 1
        assert 0 < len(scored_after_crash) < N_REVIEWS, (
            f"the crash must leave PARTIAL progress, left {len(scored_after_crash)}"
        )

        # Night two: same cache file, no interference.
        n_resume = _score(data_dir)
        resumed_mentions, resumed_scored = _cache(data_dir)

        # Exactly the reviews the first run did not record, and not one more.
        assert n_resume == N_REVIEWS - len(scored_after_crash), (
            f"the resume must score only the {N_REVIEWS - len(scored_after_crash)} remaining "
            f"review(s), scored {n_resume}"
        )
        assert resumed_scored == POOL_IDS

        # ...and the result is indistinguishable from never having been interrupted.
        _score(clean_dir)
        clean_mentions, clean_scored = _cache(clean_dir)
        assert resumed_scored == clean_scored
        assert resumed_mentions == clean_mentions, (
            f"resumed cache differs from an uninterrupted one: "
            f"{len(clean_mentions - resumed_mentions)} row(s) missing, "
            f"{len(resumed_mentions - clean_mentions)} extra (duplicates from the partial "
            f"bucket would show up here)"
        )


def test_deadline_stops_between_buckets_and_the_next_run_finishes():
    """The build must exit CLEANLY when it runs out of time rather than be SIGKILLed mid-bucket
    by `timeout`. The deadline is checked only BETWEEN buckets — a bucket is atomic, so
    interrupting one throws its work away — and the run then carries on and publishes normally.

    Deterministic via a fake clock: each bucket advances it by 100s, the budget is 250s, so
    exactly two buckets fit (0+0<250 -> run; 100+100<250 -> run; 200+100>=250 -> stop)."""
    occupied = _occupied(N_BUCKETS)
    assert len(occupied) >= 4

    real_time = bm.time
    real_t0 = bm._PROC_T0
    real_scorer = bm._stream_vader_and_classify
    clock = _FakeClock(real_time, 0.0)

    def ticking(con, select_sql, insert_sql, clf):
        n = real_scorer(con, select_sql, insert_sql, clf)
        clock.now += 100.0
        return n

    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as td_clean:
        data_dir, clean_dir = Path(td), Path(td_clean)
        bm.time = clock
        bm._PROC_T0 = 0.0
        bm._stream_vader_and_classify = ticking
        try:
            with _env(deadline="250"):
                con = _fresh_con()
                buf = io.StringIO()
                try:
                    # No exception: a deadline stop is a normal return, not a failure.
                    with redirect_stdout(buf):
                        bm.compute_aspect_sentiment(con, data_dir)
                finally:
                    con.close()
        finally:
            bm._stream_vader_and_classify = real_scorer
            bm._PROC_T0 = real_t0
            bm.time = real_time

        log = buf.getvalue()
        _, scored = _cache(data_dir)
        status = _status(data_dir)

        assert "STOPPED EARLY" in log, f"the stop must be reported, log was:\n{log}"
        assert status["buckets_done"] == 2, (
            f"exactly the two buckets that fit the budget must complete, "
            f"{status['buckets_done']} did"
        )
        assert status["buckets_total"] == len(occupied)
        assert status["stopped_early"], "the stop reason must be recorded in the cache"
        # Progress is real and durable, not a no-op stop.
        expected = {r for r, b in _buckets_of(POOL_IDS, N_BUCKETS).items() if b in occupied[:2]}
        assert scored == expected and 0 < len(scored) < N_REVIEWS

        # The next run has no deadline and finishes the job, landing on the clean cache.
        n_rest = _score(data_dir)
        assert n_rest == N_REVIEWS - len(scored)
        resumed_mentions, resumed_scored = _cache(data_dir)
        _score(clean_dir)
        clean_mentions, _ = _cache(clean_dir)
        assert resumed_scored == POOL_IDS
        assert resumed_mentions == clean_mentions


def test_rescore_status_reports_progress_from_the_cache_alone():
    """Progress must be answerable without reading logs:
        duckdb data/sentiment_cache.duckdb -c 'SELECT * FROM rescore_status'
    """
    k = 3
    scorer, real, _state = _crash_after(k)
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)

        bm._stream_vader_and_classify = scorer
        try:
            with _env():
                con = _fresh_con()
                try:
                    with pytest.raises(RuntimeError):
                        with redirect_stdout(io.StringIO()):
                            bm.compute_aspect_sentiment(con, data_dir)
                finally:
                    con.close()
        finally:
            bm._stream_vader_and_classify = real

        # A run that DIED never got to write its status row; the next run reports the truth.
        _score(data_dir)
        st = _status(data_dir)
        assert st["reviews_in_pool"] == N_REVIEWS
        assert st["reviews_scored"] == N_REVIEWS
        assert st["stopped_early"] is None
        assert st["mention_rows"] == len(_cache(data_dir)[0])
        assert st["buckets_done"] == st["buckets_total"] >= 1
        assert st["updated_at"] is not None

        # A wipe must reset the report, or a fresh rescore reads as already complete.
        c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        c.execute("UPDATE meta SET value = 'stale' WHERE key = 'config_hash'")
        c.close()
        con = _fresh_con()
        with _env():
            try:
                with redirect_stdout(io.StringIO()):
                    bm._attach_sentiment_cache(con, data_dir)
                    bm._refresh_sentiment_cache(con)
                    bm._detach_sentiment_cache(con)
            finally:
                con.close()
        assert _status(data_dir) == {}, "a config wipe must clear the progress report"


# ------------------------------------------------------------------------------------------
# Coexistence — a multi-day rescore must not lock the light build out of the cache.
#
# MEASURED FACTS this rests on (duckdb 1.5.4, two real OS processes, not the docs):
#   * the cache lock is per FILE, cross-process, and exclusive in BOTH directions: while one
#     process holds it read-write, a second process's ATTACH fails at once with
#     `IOException: Could not set lock on file ...: Conflicting lock`, and a READ_ONLY attach
#     fails identically — there is no read-only escape hatch;
#   * release is instant: a poller re-acquires within one poll interval of the holder's DETACH;
#   * committing one 125k-review bucket into a production-sized cache holds it ~0.8s on a
#     laptop, ~3s scaled to the droplet — against ~16 min of scoring per bucket, a duty cycle
#     near 0.3%.
# Those two together are what make coexistence real rather than nominal, and they are only
# true because the scoring pass runs with the cache DETACHED. Both directions are pinned here.
# ------------------------------------------------------------------------------------------

# A real light-build press pass, in its own process, against the same cache file. Not a bare
# ATTACH: the thing that has to work is compute_press_sentiment, which attaches read-write,
# writes cache.press_article and detaches — the exact call that died on 2026-08-31.
_PRESS_PASS = r'''
import sys, json
sys.path.insert(0, {etl!r})
import duckdb, build_marts as bm
bm.SENTIMENT_CACHE_LOCK_WAIT_SECONDS = {wait}
bm.SENTIMENT_CACHE_LOCK_POLL_SECONDS = 0.05
con = duckdb.connect(":memory:")
con.execute("SET threads=3"); con.execute("SET memory_limit='1GB'")
con.execute("CREATE SCHEMA src")
con.execute("CREATE TABLE src.articles(id BIGINT, title VARCHAR, summary VARCHAR, source VARCHAR)")
con.execute("CREATE TABLE src.article_game_mentions(article_id BIGINT, appid INTEGER)")
con.executemany("INSERT INTO src.articles VALUES (?,?,?,?)",
                [(i, f"Review {{i}}", "The combat is excellent and the price is fair.", "press")
                 for i in range({n_articles})])
con.executemany("INSERT INTO src.article_game_mentions VALUES (?,?)",
                [(i, 7) for i in range({n_articles})])
n = bm.compute_press_sentiment(con, {data_dir!r})
print(json.dumps({{"scored": n}}))
'''

# Holds the cache read-write for a fixed time, like a light build's press pass in progress.
_HOLDER = r'''
import sys, time
sys.path.insert(0, {etl!r})
import duckdb
con = duckdb.connect(":memory:")
con.execute("SET threads=3"); con.execute("SET memory_limit='1GB'")
con.execute("ATTACH '{cache}' AS cache")
open({marker!r}, "w").write("held")
time.sleep({hold})
con.execute("DETACH cache")
'''


def _run_press_pass(data_dir: Path, wait: float = 5.0, n_articles: int = 150):
    return subprocess.run(
        [sys.executable, "-c", _PRESS_PASS.format(
            etl=str(ETL), wait=wait, data_dir=str(data_dir), n_articles=n_articles)],
        capture_output=True, text=True, timeout=180,
    )


def test_light_build_press_pass_runs_while_a_rescore_is_scoring():
    """THE COEXISTENCE REQUIREMENT. While the rescore is inside a scoring pass, a separate
    process must be able to run a full press pass — attach read-write, write, detach — and
    finish. The rescore then carries on and completes normally.

    Deterministic, not a race: the rescore's scorer is hooked to launch the press process and
    BLOCK until it exits, so the overlap is guaranteed rather than hoped for. The press process
    is given a short lock wait, so if the rescore were holding the cache (as it did before the
    scoring pass was moved outside the attach window) it fails in seconds instead of hanging."""
    real = bm._stream_vader_and_classify
    result = {}

    def scorer_with_concurrent_press(con, select_sql, insert_sql, clf):
        n = real(con, select_sql, insert_sql, clf)
        if "proc" not in result:                       # once, during the first bucket
            result["proc"] = _run_press_pass(result["data_dir"])
        return n

    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        result["data_dir"] = data_dir
        bm._stream_vader_and_classify = scorer_with_concurrent_press
        try:
            n_scored = _score(data_dir)
        finally:
            bm._stream_vader_and_classify = real

        proc = result["proc"]
        assert proc.returncode == 0, (
            "a light build's press pass could not run while the rescore was scoring:\n"
            f"{proc.stderr[-1500:]}"
        )
        assert json.loads(proc.stdout.strip().splitlines()[-1])["scored"] == 150

        # The rescore was not damaged by the handoff: it finished every bucket, and the press
        # rows the other process wrote are still there.
        assert n_scored == N_REVIEWS
        mentions, scored = _cache(data_dir)
        assert scored == POOL_IDS and len(mentions) > 0
        c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        try:
            assert c.execute("SELECT count(*) FROM press_article").fetchone()[0] == 150
        finally:
            c.close()


def test_rescore_waits_for_a_light_build_instead_of_dying_on_the_lock():
    """The other direction. When the light build holds the cache, the rescore's per-bucket
    commit must WAIT for it — the 2026-08-31 failure was exactly this attach dying on
    `Conflicting lock` instead of retrying. Bounded, so a genuinely wedged holder still fails
    the build rather than hanging a nightly forever."""
    real = bm._stream_vader_and_classify
    state = {}
    HOLD = 3.0

    def scorer_then_take_the_lock(con, select_sql, insert_sql, clf):
        n = real(con, select_sql, insert_sql, clf)
        if "proc" not in state:
            # Hand the cache to another process right before this bucket's commit, and do not
            # return until it actually holds it — otherwise the rescore might commit first and
            # the test would prove nothing.
            marker = state["data_dir"] / "held.marker"
            state["proc"] = subprocess.Popen(
                [sys.executable, "-c", _HOLDER.format(
                    etl=str(ETL), cache=str(state["data_dir"] / bm.SENTIMENT_CACHE_DB_NAME),
                    marker=str(marker), hold=HOLD)])
            t0 = time.monotonic()
            while not marker.exists() and time.monotonic() - t0 < 30:
                time.sleep(0.02)
            assert marker.exists(), "the holder process never acquired the cache"
            state["handed_off_at"] = time.monotonic()
        return n

    prev_wait = bm.SENTIMENT_CACHE_LOCK_WAIT_SECONDS
    prev_poll = bm.SENTIMENT_CACHE_LOCK_POLL_SECONDS
    bm.SENTIMENT_CACHE_LOCK_WAIT_SECONDS = 60.0
    bm.SENTIMENT_CACHE_LOCK_POLL_SECONDS = 0.05
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        state["data_dir"] = data_dir
        # The cache file has to exist before the holder can attach it, so seed it with a run.
        _score(data_dir, bucket_reviews=10_000)
        c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        c.execute("DELETE FROM scored_review")   # make everything unscored again
        c.execute("DELETE FROM aspect_mention")
        c.close()

        bm._stream_vader_and_classify = scorer_then_take_the_lock
        try:
            n_scored = _score(data_dir)          # must SUCCEED, having waited
        finally:
            bm._stream_vader_and_classify = real
            bm.SENTIMENT_CACHE_LOCK_WAIT_SECONDS = prev_wait
            bm.SENTIMENT_CACHE_LOCK_POLL_SECONDS = prev_poll
            state["proc"].wait(timeout=60)

        assert "handed_off_at" in state, "the fixture never handed the lock over"
        assert n_scored == N_REVIEWS, f"the rescore lost work to the handoff: {n_scored}"
        _, scored = _cache(data_dir)
        assert scored == POOL_IDS
