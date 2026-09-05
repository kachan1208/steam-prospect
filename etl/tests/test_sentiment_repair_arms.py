"""--repair-arms: the targeted repair of the sentiment cache's frozen mention hole.

WHY THIS FILE EXISTS. The 2026-08-31 diff (the commit that bumped SENTIMENT_CACHE_VERSION)
found cache.aspect_mention a strict SUBSET of what the raw 10-arm regex produces: 1,962 of
314,626 mentions missing, all in arms 9-10, on reviews whose scoring stream an OOM-killed
build cut mid-corpus and whose partial arm set the 2026-08-22 scored_review seed then froze
in — every affected review's cached arms a clean PREFIX of its raw arms. The repair chosen
then was a version bump: a wipe and 57 hours of rescoring that held three nightlies.
repair_sentiment_arms reaches the same hole with one regex pass and a rescore of only the
mismatched reviews, and these tests pin what "only" means: the holed review is rescored, its
missing arm comes back, every other row is byte-identical, and a second pass finds nothing.

Fixture and helpers are test_sentiment_wipe_bucketing's: the same multi-arm reviews (a
one-arm-per-review fixture cannot express a prefix hole), the same real on-disk cache seeded
by the real scorer. The hole is punched the way production got it — a mention row deleted
while the review stays in scored_review — so the cache alone cannot see it.
"""
from __future__ import annotations

import io
import re
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402
from test_full_build_smoke import _run, build_source  # noqa: E402  (one fixture source, not two)
from test_sentiment_wipe_bucketing import (  # noqa: E402
    N_BUCKETS, POOL_IDS, _buckets_of, _cache, _fresh_con, _score)

# The last arm of _aspect_window_sql's UNION ALL — where 1,902 of the 1,962 missing rows were.
ARM_10 = "Price & Value"
BUCKET_LINE = re.compile(r"\[etl\] repair-arms bucket (\d+)/(\d+): checked ([\d,]+), "
                         r"mismatched ([\d,]+), rescored ([\d,]+)")
SUMMARY_LINE = re.compile(r"\[etl\] repair-arms summary: .*?checked ([\d,]+) review\(s\), "
                          r"mismatched ([\d,]+) \([\d.]+%\), rescored ([\d,]+); "
                          r"([\d,]+) of ([\d,]+) raw mention row\(s\) were missing")


@pytest.fixture(autouse=True)
def hermetic_env(monkeypatch):
    """Fixture-sized floors, the cache ON, 96 reviews -> 8 repair buckets (so a run really
    loops and a death mid-pass leaves a meaningful prefix of buckets), and no ambient knob."""
    monkeypatch.setattr(bm, "TEARDOWN_MIN_REVIEWS", 1)
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    monkeypatch.setenv("PROSPECT_REPAIR_BUCKET_REVIEWS", "12")
    for var in ("PROSPECT_SENTIMENT_DEADLINE_SECONDS", "PROSPECT_RESCORE_BUCKET_REVIEWS",
                "PROSPECT_SENTIMENT_POOL_CAP", "PROSPECT_ALLOW_NO_CLASSIFIER"):
        monkeypatch.delenv(var, raising=False)


def _n(s: str) -> int:
    return int(s.replace(",", ""))


def _bucket_lines(log: str) -> list[tuple[int, int, int, int, int]]:
    """(bucket, of, checked, mismatched, rescored) per '[etl] repair-arms bucket i/N' line."""
    return [(int(i), int(n), _n(c), _n(m), _n(r)) for i, n, c, m, r in BUCKET_LINE.findall(log)]


def _summary(log: str) -> tuple[int, int, int, int, int]:
    """(checked, mismatched, rescored, missing mention rows, raw mention rows)."""
    m = SUMMARY_LINE.search(log)
    assert m, f"no summary line in:\n{log}"
    return tuple(_n(g) for g in m.groups())  # type: ignore[return-value]


def _repair(data_dir: Path) -> tuple[dict | None, str]:
    """One run of the real repair_sentiment_arms against the cache in data_dir, on a build
    connection shaped like the real one after staging. Returns (totals, log)."""
    con = _fresh_con()
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            totals = bm.repair_sentiment_arms(con, data_dir)
    finally:
        con.close()
    return totals, buf.getvalue()


def _seed(data_dir: Path):
    """Fill the cache with the real scorer (one bucket — the seed is not what is under test)
    and return the clean (mentions, scored) state."""
    _score(data_dir, bucket_reviews=10_000)
    mentions, scored = _cache(data_dir)
    assert scored == POOL_IDS and mentions, "fixture must populate the cache"
    return mentions, scored


def _with_arm(mentions, aspect: str = ARM_10) -> list[str]:
    return sorted({row[0] for row in mentions if row[1] == aspect})


def _punch_hole(data_dir: Path, rid: str, aspect: str = ARM_10) -> None:
    """The production defect, reproduced exactly: the review's row for `aspect` is gone, the
    review stays in scored_review, so the cache believes it fully scanned it."""
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
    try:
        before = c.execute("SELECT count(*) FROM aspect_mention").fetchone()[0]
        c.execute("DELETE FROM aspect_mention WHERE recommendationid = ? AND aspect = ?",
                  [rid, aspect])
        after = c.execute("SELECT count(*) FROM aspect_mention").fetchone()[0]
        assert before - after == 1, f"expected to punch exactly one row for {rid}/{aspect}"
        assert c.execute("SELECT count(*) FROM scored_review WHERE recommendationid = ?",
                         [rid]).fetchone()[0] == 1
    finally:
        c.close()


def _status(data_dir: Path) -> list[dict]:
    """One dict per repair_arms_status row, in bucket order; [] when the table does not exist
    yet (a run refused before its plan never creates it)."""
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME), read_only=True)
    try:
        if not c.execute("SELECT count(*) FROM duckdb_tables() "
                         "WHERE table_name = 'repair_arms_status'").fetchone()[0]:
            return []
        cols = [r[1] for r in c.execute("PRAGMA table_info('repair_arms_status')").fetchall()]
        rows = c.execute("SELECT * FROM repair_arms_status ORDER BY bucket").fetchall()
        return [dict(zip(cols, row)) for row in rows]
    finally:
        c.close()


def _rewrite_config_hash(data_dir: Path, value: str) -> None:
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
    try:
        c.execute("UPDATE meta SET value = ? WHERE key = 'config_hash'", [value])
    finally:
        c.close()


# ------------------------------------------------------------------------------------------
# The repair itself
# ------------------------------------------------------------------------------------------

def test_repair_rescores_only_the_holed_review_and_restores_its_arm(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        clean_mentions, _ = _seed(data_dir)
        with_arm10 = _with_arm(clean_mentions)
        assert with_arm10, "fixture must contain reviews matching arm 10 (Price & Value)"
        holed = with_arm10[0]
        assert len({r[1] for r in clean_mentions if r[0] == holed}) >= 2, (
            "the holed review must match several arms, or 'a strict prefix' is vacuous"
        )
        _punch_hole(data_dir, holed)
        holed_mentions, holed_scored = _cache(data_dir)
        assert holed_scored == POOL_IDS, "the hole must be invisible to scored_review"
        assert holed_mentions == {r for r in clean_mentions
                                  if not (r[0] == holed and r[1] == ARM_10)}

        # What the scorer is asked to score, read straight off the SELECT it is handed.
        scored_ids: list[str] = []
        real = bm._stream_vader_and_classify

        def spy(con, select_sql, insert_sql, clf):
            scored_ids.extend(r[0] for r in con.execute(select_sql).fetchall())
            return real(con, select_sql, insert_sql, clf)

        monkeypatch.setattr(bm, "_stream_vader_and_classify", spy)
        totals, log = _repair(data_dir)

        # ONLY the holed review was rescored...
        assert set(scored_ids) == {holed}, (
            f"rescored {sorted(set(scored_ids))}, expected only {holed}"
        )
        # ...the log says so, bucket by bucket and in total...
        lines = _bucket_lines(log)
        assert [b for b, *_ in lines] == list(range(1, N_BUCKETS + 1)), log
        assert all(n == N_BUCKETS for _, n, *_ in lines)
        assert sum(c for _, _, c, _, _ in lines) == len(POOL_IDS)
        assert sum(m for _, _, _, m, _ in lines) == 1
        assert sum(r for _, _, _, _, r in lines) == 1
        checked, mismatched, rescored, missing, raw = _summary(log)
        assert (checked, mismatched, rescored, missing) == (len(POOL_IDS), 1, 1, 1)
        assert raw == len(clean_mentions), (
            "raw mention rows = one per (review, arm) the text matches")
        assert totals is not None
        assert (totals["checked"], totals["mismatched"], totals["rescored"],
                totals["done"], totals["buckets"]) == (len(POOL_IDS), 1, 1, N_BUCKETS, N_BUCKETS)
        assert totals["superset"] == totals["mixed"] == 0
        # ...its arm-10 row is back, and the whole cache is byte-identical to the clean one:
        # the repair restores exactly what one clean scoring produced, other rows untouched.
        after_mentions, after_scored = _cache(data_dir)
        assert (holed, ARM_10) in {(r[0], r[1]) for r in after_mentions}
        assert after_scored == POOL_IDS
        assert after_mentions == clean_mentions, (
            f"{len(clean_mentions - after_mentions)} row(s) missing, "
            f"{len(after_mentions - clean_mentions)} extra after the repair"
        )
        others_before = {r for r in holed_mentions if r[0] != holed}
        others_after = {r for r in after_mentions if r[0] != holed}
        assert others_after == others_before, "rows of other reviews must be byte-identical"
        st = _status(data_dir)
        assert [r["bucket"] for r in st] == list(range(N_BUCKETS))
        assert sum(r["mismatched"] for r in st) == sum(r["rescored"] for r in st) == 1
        assert sum(r["checked"] for r in st) == len(POOL_IDS)

        # IDEMPOTENT: a second pass finds nothing, scores nothing and changes nothing.
        scored_ids.clear()
        totals2, log2 = _repair(data_dir)
        assert "the previous pass is complete" in log2 and "starting a fresh pass" in log2
        assert scored_ids == [], "a repaired cache must not be rescored again"
        assert totals2 is not None and totals2["mismatched"] == 0
        assert totals2["checked"] == len(POOL_IDS)
        assert _summary(log2) == (len(POOL_IDS), 0, 0, 0, len(clean_mentions))
        assert sum(m for _, _, _, m, _ in _bucket_lines(log2)) == 0
        assert _cache(data_dir) == (clean_mentions, POOL_IDS)


def test_a_review_with_no_cached_rows_at_all_is_a_hole_too():
    """The prefix can be EMPTY: a review cut off before its first arm has zero rows and a
    scored_review record, which is indistinguishable from a review that mentions nothing —
    until the text is re-read. Every one of its arms must come back."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        clean_mentions, _ = _seed(data_dir)
        victim = _with_arm(clean_mentions)[-1]
        arms = {r[1] for r in clean_mentions if r[0] == victim}
        assert len(arms) >= 2
        for arm in arms:
            _punch_hole(data_dir, victim, arm)
        totals, log = _repair(data_dir)
        assert totals is not None and totals["mismatched"] == 1
        assert totals["missing_mentions"] == len(arms)
        assert _cache(data_dir) == (clean_mentions, POOL_IDS)


def test_a_killed_pass_resumes_from_its_completed_buckets_and_ends_identical(monkeypatch):
    """Progress is per bucket and lives in the cache. A run that dies mid-bucket must leave
    every bucket it completed recorded (and never the one it died in), the rerun must skip
    those and finish the rest, and the cache must end identical to the clean one — the same
    contract test_sentiment_wipe_bucketing pins for the rescore."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        clean_mentions, _ = _seed(data_dir)
        by_bucket = _buckets_of(POOL_IDS, N_BUCKETS)
        # Two holes in two different buckets, neither in bucket 0: the buckets before the
        # first hole complete cleanly (so there is real progress to resume from), the run dies
        # in the first hole's bucket, and the second hole is what the resume has left to do.
        picks = sorted(_with_arm(clean_mentions), key=lambda r: (by_bucket[r], r))
        first = next(r for r in picks if by_bucket[r] >= 1)
        later = next(r for r in picks if by_bucket[r] > by_bucket[first])
        for rid in (first, later):
            _punch_hole(data_dir, rid)
        holed_state = _cache(data_dir)
        dead_bucket = by_bucket[first]
        assert dead_bucket >= 1, "at least one bucket must complete before the death"

        real = bm._stream_vader_and_classify

        def die_on_the_first_rescore(con, select_sql, insert_sql, clf):
            raise RuntimeError("simulated death mid-bucket")

        monkeypatch.setattr(bm, "_stream_vader_and_classify", die_on_the_first_rescore)
        con = _fresh_con()
        try:
            with pytest.raises(RuntimeError, match="simulated death"):
                with redirect_stdout(io.StringIO()):
                    bm.repair_sentiment_arms(con, data_dir)
        finally:
            con.close()
        monkeypatch.setattr(bm, "_stream_vader_and_classify", real)

        # Every bucket before the death is recorded (empty ones included — completeness is
        # "one row per bucket"), the one it died in is not, and the cache was not touched.
        assert [r["bucket"] for r in _status(data_dir)] == list(range(dead_bucket))
        assert _cache(data_dir) == holed_state, "a bucket that died must commit nothing"

        totals, log = _repair(data_dir)
        assert f"resuming — {dead_bucket}/{N_BUCKETS} bucket(s) already checked" in log
        assert [b for b, *_ in _bucket_lines(log)] == list(range(dead_bucket + 1, N_BUCKETS + 1))
        assert totals is not None
        assert (totals["done"], totals["mismatched"], totals["rescored"]) == (N_BUCKETS, 2, 2)
        assert totals["buckets_this_run"] == N_BUCKETS - dead_bucket
        assert _cache(data_dir) == (clean_mentions, POOL_IDS)
        st = _status(data_dir)
        assert [r["bucket"] for r in st] == list(range(N_BUCKETS))
        assert sum(r["mismatched"] for r in st) == 2
        assert sum(r["checked"] for r in st) == len(POOL_IDS)


def test_a_cache_keyed_to_another_config_is_refused_not_repaired(capsys):
    """Under a different config hash nothing in the cache is comparable to today's regex, and
    the next full build wipes it anyway. Refuse, touch nothing."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        clean = _seed(data_dir)
        _rewrite_config_hash(data_dir, "stale")
        totals, log = _repair(data_dir)
        assert totals is None
        assert "not keyed to the current scoring config" in capsys.readouterr().err
        assert "repair-arms bucket" not in log
        assert _cache(data_dir) == clean
        assert _status(data_dir) == [], "a refused run must record no progress"


def test_a_config_change_under_a_running_pass_aborts_before_committing(monkeypatch):
    """The cache is detached while a bucket is scored, so a concurrent full build could wipe
    and re-key it meanwhile. The commit must notice and abort rather than insert rows scored
    under the previous config into the new cache."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        clean_mentions, _ = _seed(data_dir)
        _punch_hole(data_dir, _with_arm(clean_mentions)[0])
        holed_state = _cache(data_dir)
        real = bm._stream_vader_and_classify

        def score_then_move_the_hash(con, select_sql, insert_sql, clf):
            n = real(con, select_sql, insert_sql, clf)
            _rewrite_config_hash(data_dir, "moved-by-a-concurrent-wipe")   # cache is detached
            return n

        monkeypatch.setattr(bm, "_stream_vader_and_classify", score_then_move_the_hash)
        con = _fresh_con()
        try:
            with pytest.raises(RuntimeError, match="config hash changed"):
                with redirect_stdout(io.StringIO()):
                    bm.repair_sentiment_arms(con, data_dir)
        finally:
            con.close()
        assert _cache(data_dir) == holed_state, "nothing may be committed after the hash moved"


def test_capped_out_reviews_are_neither_checked_nor_repaired(monkeypatch):
    """The in-scope pool is the nightly's own: the floor AND the per-game cap
    (SENTIMENT_POOL_CAP_PER_GAME, 2026-09-05). A review outside the cap has cache rows the
    nightly ignores, so the repair must not re-read its text or rewrite its rows — even when
    it is holed — while a holed review inside the pool is still repaired."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        clean_mentions, _ = _seed(data_dir)             # seeded UNCAPPED: all 96 scored
        cap = 60
        # The pool the cap selects, by the same rule as the CTAS: the ids are non-numeric here
        # (TRY_CAST -> NULL for all), so the raw key decides — the 60 highest ids.
        pool = set(sorted(POOL_IDS, reverse=True)[:cap])
        capped_out = POOL_IDS - pool
        with_arm10 = _with_arm(clean_mentions)
        out_holed = next(r for r in with_arm10 if r in capped_out)
        in_holed = next(r for r in with_arm10 if r in pool)
        _punch_hole(data_dir, out_holed)
        _punch_hole(data_dir, in_holed)
        monkeypatch.setenv("PROSPECT_SENTIMENT_POOL_CAP", str(cap))

        scored_ids: list[str] = []
        real = bm._stream_vader_and_classify

        def spy(con, select_sql, insert_sql, clf):
            scored_ids.extend(r[0] for r in con.execute(select_sql).fetchall())
            return real(con, select_sql, insert_sql, clf)

        monkeypatch.setattr(bm, "_stream_vader_and_classify", spy)
        totals, log = _repair(data_dir)

        assert totals is not None
        assert totals["checked"] == cap, (
            f"only the pool may be checked, checked {totals['checked']}")
        assert sum(c for _, _, c, _, _ in _bucket_lines(log)) == cap
        assert (totals["mismatched"], totals["rescored"]) == (1, 1)
        assert set(scored_ids) == {in_holed}, "the capped-out review's text must not be re-read"
        after_mentions, after_scored = _cache(data_dir)
        assert after_scored == POOL_IDS, "capped-out reviews keep their scored_review record"
        # The in-pool hole is closed; the capped-out one is exactly as it was.
        assert {r for r in after_mentions if r[0] == in_holed} == \
            {r for r in clean_mentions if r[0] == in_holed}
        assert (out_holed, ARM_10) not in {(r[0], r[1]) for r in after_mentions}
        assert after_mentions == {r for r in clean_mentions
                                  if not (r[0] == out_holed and r[1] == ARM_10)}


def test_bucket_count_and_knob():
    with pytest.MonkeyPatch.context() as mp:
        mp.delenv("PROSPECT_REPAIR_BUCKET_REVIEWS", raising=False)
        assert bm._repair_bucket_count(0) == 1
        assert bm._repair_bucket_count(bm.REPAIR_BUCKET_REVIEWS) == 1
        assert bm._repair_bucket_count(bm.REPAIR_BUCKET_REVIEWS + 1) == 2
        assert bm._repair_bucket_count(24_458_199) == 25, "the live pool, ~25 buckets"
        assert bm._repair_bucket_count(24_458_199) < bm._rescore_bucket_count(24_458_199), (
            "a repair bucket is sized for memory, not for a 16-minute scoring pass"
        )
        mp.setenv("PROSPECT_REPAIR_BUCKET_REVIEWS", "12")
        assert bm._repair_bucket_count(96) == 8
        mp.setenv("PROSPECT_REPAIR_BUCKET_REVIEWS", "lots")
        assert any("PROSPECT_REPAIR_BUCKET_REVIEWS" in e for e in bm._env_config_errors())
        mp.setenv("PROSPECT_REPAIR_BUCKET_REVIEWS", "0")
        assert any("PROSPECT_REPAIR_BUCKET_REVIEWS" in e for e in bm._env_config_errors())


# ------------------------------------------------------------------------------------------
# Through main(): the flag, its refusals, and the operator's path end to end.
# ------------------------------------------------------------------------------------------

def _source(tmp_path: Path) -> tuple[Path, list[str]]:
    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    return data, ["--source", str(src), "--data-dir", str(data)]


def test_repair_arms_refuses_flags_it_cannot_honour(tmp_path, monkeypatch):
    """No marts and no swap, so --light, --skip-validation and a non-default --fulltext have
    nothing to act on; --rescore-only is the mode it must never run inside; the cache off means
    nothing to repair. Each must fail in seconds, before staging, without touching the data
    dir. And it must refuse to start beside a live mart build."""
    data, argv = _source(tmp_path)
    base = argv + ["--repair-arms"]
    assert _run(base + ["--light"]) == 2
    assert _run(base + ["--rescore-only"]) == 2
    assert _run(argv + ["--rescore-only", "--repair-arms"]) == 2, "order must not matter"
    assert _run(base + ["--skip-validation"]) == 2
    assert _run(base + ["--fulltext", "build"]) == 2
    assert _run(base + ["--fulltext", "copy"]) == 2
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "off")
    assert _run(base) == 2
    assert sorted(p.name for p in data.iterdir()) == [], (
        "a refused --repair-arms must not touch the data dir"
    )

    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    live = data / "prospect_20990101.duckdb.building"    # a mart build, written just now
    live.write_bytes(b"")
    assert _run(base) == 2
    assert sorted(p.name for p in data.iterdir()) == [live.name], (
        "a live build's scratch must be neither swept nor built beside"
    )


def test_repair_arms_end_to_end_repairs_the_cache_and_publishes_nothing(tmp_path, monkeypatch,
                                                                         capsys):
    """The operator's path: a cache filled by --rescore-only, one review holed the way
    production's were, --repair-arms run through main(). It must repair exactly that review,
    stop after the pass (no read-back, no mart, no swap), leave only the cache behind, and
    report mismatched 0 when run again."""
    monkeypatch.setenv("PROSPECT_RESCORE_BUCKET_REVIEWS", "200")   # 1200 reviews -> 6 buckets
    monkeypatch.setenv("PROSPECT_REPAIR_BUCKET_REVIEWS", "300")    # 1200 reviews -> 4 buckets
    data, argv = _source(tmp_path)
    assert _run(argv + ["--rescore-only"]) == 0
    cache = data / bm.SENTIMENT_CACHE_DB_NAME
    c = duckdb.connect(str(cache))
    try:
        clean = set(c.execute("SELECT * FROM aspect_mention").fetchall())
        # Every smoke review reads the same text and matches two arms; hole the LATER one,
        # the shape of the production defect (a prefix of the UNION ALL's arm order).
        order = {label: i for i, (label, _p, _rx) in enumerate(bm.ASPECT_LEXICON)}
        arms = [a for (a,) in c.execute(
            "SELECT aspect FROM aspect_mention WHERE recommendationid = 'r1_0'").fetchall()]
        assert len(arms) >= 2, arms
        c.execute("DELETE FROM aspect_mention WHERE recommendationid = 'r1_0' AND aspect = ?",
                  [max(arms, key=order.__getitem__)])
    finally:
        c.close()
    capsys.readouterr()

    assert _run(argv + ["--repair-arms"]) == 0
    out = capsys.readouterr().out
    assert "[etl] REPAIR-ARMS" in out
    assert "[etl] output     : none — --repair-arms" in out
    assert _summary(out)[:3] == (1200, 1, 1), out
    assert [b for b, *_ in _bucket_lines(out)] == [1, 2, 3, 4]
    assert "mention rows in scope total" not in out, "--repair-arms must not run the read-back"
    assert "[etl] ran " not in out and "swapped" not in out, "no mart may be built or swapped"
    c = duckdb.connect(str(cache), read_only=True)
    try:
        assert set(c.execute("SELECT * FROM aspect_mention").fetchall()) == clean
        assert c.execute("SELECT count(*) FROM scored_review").fetchone()[0] == 1200
        assert c.execute("SELECT count(*), sum(mismatched) FROM repair_arms_status"
                         ).fetchone() == (4, 1)
    finally:
        c.close()
    assert sorted(p.name for p in data.iterdir()) == [bm.SENTIMENT_CACHE_DB_NAME], (
        "--repair-arms must leave only the cache behind"
    )

    capsys.readouterr()
    assert _run(argv + ["--repair-arms"]) == 0
    out = capsys.readouterr().out
    assert "the previous pass is complete" in out
    assert _summary(out)[:3] == (1200, 0, 0), out
    assert sorted(p.name for p in data.iterdir()) == [bm.SENTIMENT_CACHE_DB_NAME]
