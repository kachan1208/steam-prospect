"""The WIPE path of compute_aspect_sentiment: score the whole pool in bounded hash buckets, and
never record a review as scanned before every one of its mention rows is committed.

WHY THIS FILE EXISTS. A SENTIMENT_CACHE_VERSION bump empties cache.scored_review, so the
anti-join that normally yields a ~1-2M-review nightly delta yields the ENTIRE pool instead, and
the two delta-proportional materialisations in that block — the delta's review text (a TEMP
table, and therefore charged to DuckDB's max_temp_directory_size) and the 10-arm window
explosion built from it — become corpus-sized. The 2026-09-01 nightly, the first full build
after 1 -> 2, died exactly there after 13,473s:

    OutOfMemoryException: failed to offload data block of size 256.0 KiB (14.9 GiB/15.0 GiB used)

and left the cache wiped but unrefilled, which makes every subsequent build retry the same
full-corpus rescore and hit the same wall. The fix is the bucketing the rest of that function
already uses (PROSPECT_SENTIMENT_BUCKETS, default 8): materialise and score one bucket of
reviews at a time.

WHAT IS ACTUALLY PINNED HERE, because bucketing a loop is easy to get subtly, silently wrong:

  1. FULL COVERAGE. Scoring in N buckets must produce byte-for-byte the cache a single-bucket
     run produces — same mention rows, same scored_review set, no bucket quietly dropped. A
     dropped bucket is invisible in aggregate (the marts just get slightly smaller numbers), so
     it is compared against a real one-bucket reference run rather than against a row count.

  2. COMPLETENESS BEFORE SCANNED. cache.scored_review is the assertion "this review has been
     scanned under the current config, and every mention row it produces is in
     cache.aspect_mention". It is written ONCE, after the last bucket. Writing it per bucket
     would be a tempting checkpoint and would re-introduce the failure class this whole rescore
     exists to repair: on 2026-08-31 the live cache was found to hold 1,962 of 314,626 mentions
     short (0.62%), every one of them in the last two arms of the window UNION, every affected
     review carrying a clean PREFIX of the arms its text matches — the fingerprint of a scoring
     stream cut off mid-corpus while its reviews were already marked scanned. That state is not
     detectable from the cache alone. So the test crashes the scorer mid-loop and demands that
     NOTHING is recorded as scanned, even though earlier buckets committed real rows.

Both tests run the REAL compute_aspect_sentiment against a real on-disk cache file.
"""
from __future__ import annotations

import io
import os
import re
import sys
import tempfile
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
# cannot see the defect in (2) above at all: "a clean prefix of the arms the text matches" needs
# reviews that match more than one arm.
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
# Enough ids that hash(recommendationid) % 8 lands in every bucket (asserted, not assumed).
N_REVIEWS = 96
POOL = [(f"rev{i:04d}", f"{_TEMPLATES[i % len(_TEMPLATES)]} Playthrough {i}.")
        for i in range(N_REVIEWS)]
POOL_IDS = {rid for rid, _ in POOL}


def _fresh_con() -> duckdb.DuckDBPyConnection:
    """A build connection shaped like the real one at the point compute_aspect_sentiment runs:
    src.reviews attached, and the LEAN key table staging builds (stg_review_key — no text)."""
    con = duckdb.connect(":memory:")
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
def _buckets(n: int):
    """Set PROSPECT_SENTIMENT_BUCKETS for the duration, and drop the floor so the fixture's one
    game is eligible. Both are restored — this module must not leak state into the rest of the
    suite."""
    prev_env = os.environ.get("PROSPECT_SENTIMENT_BUCKETS")
    prev_floor = bm.TEARDOWN_MIN_REVIEWS
    os.environ["PROSPECT_SENTIMENT_BUCKETS"] = str(n)
    bm.TEARDOWN_MIN_REVIEWS = 1
    try:
        yield
    finally:
        bm.TEARDOWN_MIN_REVIEWS = prev_floor
        if prev_env is None:
            os.environ.pop("PROSPECT_SENTIMENT_BUCKETS", None)
        else:
            os.environ["PROSPECT_SENTIMENT_BUCKETS"] = prev_env


def _score(data_dir: Path, n_buckets: int) -> int:
    """One full run of the real function against a fresh (i.e. wiped) cache in `data_dir`.
    Returns the 'N new review(s) scored' figure from its own log line."""
    with _buckets(n_buckets):
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
        scored = set(r[0] for r in c.execute("SELECT recommendationid FROM scored_review").fetchall())
        return mentions, scored
    finally:
        c.close()


def _arms(mentions) -> dict[str, set[str]]:
    """review id -> the set of keyword arms recorded for it."""
    out: dict[str, set[str]] = defaultdict(set)
    for row in mentions:
        out[row[0]].add(row[1])
    return out


def _occupied_buckets(n: int) -> int:
    c = duckdb.connect(":memory:")
    try:
        c.execute("CREATE TABLE ids(rid VARCHAR)")
        c.executemany("INSERT INTO ids VALUES (?)", [(r,) for r in sorted(POOL_IDS)])
        return c.execute(f"SELECT count(DISTINCT hash(rid) % {n}) FROM ids").fetchone()[0]
    finally:
        c.close()


def test_wipe_path_scores_the_full_pool_across_buckets():
    """N buckets must reproduce the 1-bucket cache exactly — every review, every arm."""
    n_buckets = 8
    occupied = _occupied_buckets(n_buckets)
    # Guard against a vacuous run: if the fixture's ids all hashed into one bucket the loop
    # would execute once and prove nothing about bucketing.
    assert occupied >= 2, f"fixture must span several buckets, spans {occupied}"

    with tempfile.TemporaryDirectory() as td_ref, tempfile.TemporaryDirectory() as td_bkt:
        ref_dir, bkt_dir = Path(td_ref), Path(td_bkt)

        n_ref = _score(ref_dir, 1)
        ref_mentions, ref_scored = _cache(ref_dir)

        n_bkt = _score(bkt_dir, n_buckets)
        bkt_mentions, bkt_scored = _cache(bkt_dir)

        # The reference itself has to be worth comparing against.
        assert n_ref == N_REVIEWS, f"the wipe must scan the whole pool, scanned {n_ref}"
        assert ref_scored == POOL_IDS
        assert len(ref_mentions) > 0, "fixture must actually produce mention rows"
        ref_arms = _arms(ref_mentions)
        assert max(len(a) for a in ref_arms.values()) >= 3, (
            "fixture must contain reviews matching several arms, or the prefix defect in the "
            "module docstring is untestable"
        )

        # THE ASSERTION: bucketing changes nothing but the peak footprint.
        assert n_bkt == N_REVIEWS, f"bucketed wipe scanned {n_bkt} of {N_REVIEWS}"
        assert bkt_scored == ref_scored == POOL_IDS
        assert bkt_mentions == ref_mentions, (
            f"bucketed cache differs from the single-pass cache: "
            f"{len(ref_mentions - bkt_mentions)} row(s) missing, "
            f"{len(bkt_mentions - ref_mentions)} extra"
        )

        # Stated per review as well as in aggregate, because that is the invariant the marts
        # depend on: membership in scored_review means "fully represented in aspect_mention".
        bkt_arms = _arms(bkt_mentions)
        for rid in sorted(bkt_scored):
            assert bkt_arms[rid] == ref_arms[rid], (
                f"{rid} is marked scanned with arms {sorted(bkt_arms[rid])}, but its text "
                f"matches {sorted(ref_arms[rid])}"
            )


def test_scorer_runs_once_per_occupied_bucket():
    """The loop must really loop, and must visit every bucket that has reviews in it. Counting
    the scorer calls pins the skipped-bucket failure directly, rather than inferring it from a
    row count that a partially-populated cache can still satisfy by luck."""
    n_buckets = 8
    occupied = _occupied_buckets(n_buckets)
    assert occupied >= 2

    calls: list[int] = []
    real = bm._stream_vader_and_classify

    def counting(con, select_sql, insert_sql, clf):
        n = real(con, select_sql, insert_sql, clf)
        calls.append(n)
        return n

    with tempfile.TemporaryDirectory() as td:
        bm._stream_vader_and_classify = counting
        try:
            _score(Path(td), n_buckets)
        finally:
            bm._stream_vader_and_classify = real
        mentions, scored = _cache(Path(td))

    assert len(calls) == occupied, (
        f"expected one scoring pass per occupied bucket ({occupied}), got {len(calls)}"
    )
    assert sum(calls) == len(mentions), "every scored window must reach the cache"
    assert scored == POOL_IDS


def test_legacy_cache_without_scored_review_is_still_seeded():
    """The other half of the seed guard changed alongside the loop: a cache file predating
    scored_review (mention rows, no such table) must still be migrated rather than rescanned —
    that is the ~1.8M-review saving the seed was written for. Only the crash-wreckage case is
    supposed to stop being seeded."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        _score(data_dir, 1)
        mentions, scored = _cache(data_dir)
        assert scored == POOL_IDS and len(mentions) > 0

        # Roll the file back to the legacy shape: mention rows, no scored_review at all.
        c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
        c.execute("DROP TABLE scored_review")
        c.close()

        n = _score(data_dir, 8)
        assert n == 0, f"a legacy cache must be seeded, not rescanned; rescanned {n}"
        _, seeded = _cache(data_dir)
        # Only reviews that HAVE mention rows can be seeded — the zero-mention ones have no
        # trace to seed from and are (correctly) not claimed as scanned by the migration.
        assert seeded == {row[0] for row in mentions}


def test_crash_mid_bucket_records_nothing_as_scanned():
    """A death partway through the bucket loop must leave scored_review EMPTY.

    This is the crash-safety half of the completeness invariant, and it is why the
    scored_review INSERT sits after the loop rather than inside it. Per-bucket writes would
    survive this fixture's arithmetic (the split is by review, so an early bucket's reviews are
    genuinely complete) while destroying the property the invariant actually asserts — that the
    boundary of "scanned" is the boundary of "all its rows are in" — and the next slicing change
    to this loop would then reproduce the 0.62% prefix hole silently.
    """
    n_buckets = 8
    assert _occupied_buckets(n_buckets) >= 2

    real = bm._stream_vader_and_classify
    seen = {"n": 0}

    def die_after_first_bucket(con, select_sql, insert_sql, clf):
        seen["n"] += 1
        if seen["n"] > 1:
            # A real one of these is an OutOfMemoryException from DuckDB's spill budget; what
            # matters is only that it escapes from inside the loop, after a bucket committed.
            raise RuntimeError("simulated mid-scoring death")
        return real(con, select_sql, insert_sql, clf)

    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)

        bm._stream_vader_and_classify = die_after_first_bucket
        try:
            with _buckets(n_buckets):
                con = _fresh_con()
                try:
                    with pytest.raises(RuntimeError, match="simulated mid-scoring death"):
                        with redirect_stdout(io.StringIO()):
                            bm.compute_aspect_sentiment(con, data_dir)
                finally:
                    con.close()
        finally:
            bm._stream_vader_and_classify = real

        crashed_mentions, crashed_scored = _cache(data_dir)
        # The crash has to be a real mid-flight one, or the assertion below is vacuous.
        assert seen["n"] > 1, "the fixture never reached a second bucket"
        assert len(crashed_mentions) > 0, (
            "the first bucket must have committed rows before the crash, otherwise this proves "
            "nothing about partial state"
        )
        assert crashed_scored == set(), (
            f"{len(crashed_scored)} review(s) recorded as scanned by a run that died mid-loop; "
            "scored_review must be written once, after the last bucket"
        )

        # And the wreckage is recoverable: the next run redoes the whole delta (the DELETE
        # clears the orphaned rows first) and lands on exactly the cache a clean run produces.
        n = _score(data_dir, n_buckets)
        assert n == N_REVIEWS, f"the rerun must rescan the whole pool, rescanned {n}"
        recovered_mentions, recovered_scored = _cache(data_dir)
        assert recovered_scored == POOL_IDS

    with tempfile.TemporaryDirectory() as td2:
        _score(Path(td2), n_buckets)
        clean_mentions, _ = _cache(Path(td2))
    assert recovered_mentions == clean_mentions, (
        "recovery after a mid-loop crash must reproduce the clean cache exactly (no duplicated "
        "and no missing mention rows)"
    )
