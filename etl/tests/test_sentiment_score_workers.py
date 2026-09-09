"""Parallel sentiment scoring (PROSPECT_SCORE_WORKERS, 2026-09-09).

The contract: with a worker pool, the scoring stream must produce EXACTLY the rows the inline
single-process path produces — same rows, same values — through every caller that streams
(the delta bucket loop, the uncached full-pool path, --repair-arms); a deadline stop must
still leave every completed bucket committed with the pool gone; the staged bulk insert must
round-trip every value executemany did; the knobs must be refused up front when garbled; and
no worker may outlive the build that started it.

The stream-level tests shrink SENTIMENT_SCORE_BATCH and SCORE_CHUNK_WINDOWS so a few dozen
rows exercise many batches, many chunks per batch, uneven tails and the one-batch-ahead
overlap — the shapes a 20,000-row batch would only reach on a corpus."""
from __future__ import annotations

import io
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
from contextlib import redirect_stdout
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402
import test_sentiment_repair_arms as repair  # noqa: E402  (its seed/hole/repair helpers)
from test_sentiment_wipe_bucketing import (  # noqa: E402
    N_BUCKETS, POOL_IDS, _FakeClock, _buckets_of, _cache, _env, _fresh_con, _occupied, _score,
    _status,
)

ASPECTS = ["Combat & Difficulty", "Price & Value", "Map & Navigation / Backtracking"]
# Real-shaped windows plus the edge cases a corpus throws: empty, NULL, quotes, commas, CR/LF,
# tabs, non-ASCII, a signal-free fragment, shouting, and a token-free window at the slice cap.
TEXTS = [
    "The combat is brutal and the boss fights are hard, but the art is gorgeous.",
    "Way too expensive for the content on offer, and not worth the price at all.",
    "",
    None,
    'He said "this map is trash", then kept playing for 200 hours, go figure.',
    "Multi\nline\r\nreview with a tab\there and unicode: ünïcödé 日本語 🎮 — great music!",
    "no signal words at all here honestly",
    "GREAT GAME!!! 10/10 would recommend, the soundtrack slaps :)",
    "Terrible performance, crashes every 5 minutes, refund requested :(",
    "x" * 520,
    "The map is confusing and the backtracking is tedious, plus bugs everywhere.",
    "Tight controls, very responsive, and the visuals are stunning for the price.",
]
N_WINDOWS = 53   # not a multiple of the batch (7) or the chunk (3): uneven tails on both


def _windows(con: duckdb.DuckDBPyConnection) -> None:
    """A REGULAR table (the streaming cursor must see it) of N_WINDOWS windows over TEXTS."""
    con.execute("CREATE TABLE _w(recommendationid VARCHAR, aspect VARCHAR, window_text VARCHAR)")
    con.executemany(
        "INSERT INTO _w VALUES (?, ?, ?)",
        [(f"r{i:03d}", ASPECTS[i % len(ASPECTS)], TEXTS[i % len(TEXTS)]) for i in range(N_WINDOWS)],
    )


def _run_stream(con, monkeypatch, workers: int, classify: bool, batch: int = 7, chunk: int = 3):
    """One stream over _w with `workers`, into a fresh _out. Returns (n, rows in insertion
    order, log, pool, worker pids)."""
    monkeypatch.setenv("PROSPECT_SCORE_WORKERS", str(workers))
    monkeypatch.setattr(bm, "SENTIMENT_SCORE_BATCH", batch)
    monkeypatch.setattr(bm, "SCORE_CHUNK_WINDOWS", chunk)
    con.execute("DROP TABLE IF EXISTS _out")
    con.execute(
        "CREATE TEMP TABLE _out(recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE, "
        "clf_aspect VARCHAR, clf_sentiment VARCHAR, clf_margin DOUBLE)"
    )
    buf = io.StringIO()
    with redirect_stdout(buf), bm._scoring_pool() as pool:
        pids = pool.pids() if pool is not None else []
        if classify:
            n = bm._stream_vader_and_classify(
                con, "SELECT recommendationid, aspect, window_text FROM _w",
                "INSERT INTO _out VALUES (?, ?, ?, ?, ?, ?)", bm._get_classifier())
        else:
            n = bm._stream_vader_scores(
                con, "SELECT recommendationid, aspect, window_text FROM _w",
                "INSERT INTO _out (recommendationid, aspect, compound) VALUES (?, ?, ?)")
        if pool is not None:
            pids = pool.pids()
    return n, con.execute("SELECT * FROM _out").fetchall(), buf.getvalue(), pool, pids


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# ------------------------------------------------------------------------------------------
# The stream: pooled == inline, row for row
# ------------------------------------------------------------------------------------------

@pytest.mark.parametrize("classify", [True, False], ids=["vader+classifier", "vader-only"])
def test_pooled_stream_matches_inline_row_for_row(monkeypatch, classify):
    con = duckdb.connect(":memory:")
    _windows(con)
    n_inline, rows_inline, log_inline, pool_inline, _ = _run_stream(con, monkeypatch, 1, classify)
    n_pool, rows_pool, log_pool, pool, pids = _run_stream(con, monkeypatch, 2, classify)

    assert pool_inline is None and "[etl] scoring inline in the main process" in log_inline
    assert pool is not None and pool.workers == 2
    assert f"[etl] scoring with 2 worker processes (context={pool.context})" in log_pool
    assert pool.context in ("fork", "spawn", "forkserver")
    assert n_inline == n_pool == N_WINDOWS, "every window must be scored exactly once"
    # Same rows, same values — and in fact the same insertion order, since scores come back
    # in input order and batches are inserted in order (downstream must not rely on it).
    assert rows_pool == rows_inline
    assert sorted(rows_pool) == sorted(rows_inline)
    assert len({r[2] for r in rows_inline}) > 3, "the fixture must produce distinct compounds"
    if classify:
        assert {r[3] for r in rows_inline} - {None}, "classifier verdicts must be present"
        assert all(r[3] is not None and r[4] is not None for r in rows_inline)
    else:
        assert all(r[3] is None and r[4] is None and r[5] is None for r in rows_inline)
    # The pool is closed with the block, and its workers are reaped with it.
    assert bm._SCORE_POOL is None
    assert pids, "the pool must have started workers"
    deadline = time.monotonic() + 10
    while any(_alive(p) for p in pids) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not any(_alive(p) for p in pids), "workers must not survive their pool"


def test_empty_stream_scores_nothing_on_both_paths(monkeypatch):
    con = duckdb.connect(":memory:")
    con.execute("CREATE TABLE _w(recommendationid VARCHAR, aspect VARCHAR, window_text VARCHAR)")
    for workers in (1, 2):
        n, rows, _, _, _ = _run_stream(con, monkeypatch, workers, True)
        assert n == 0 and rows == []


def test_stream_signatures_still_take_the_classifier_positionally():
    """test_sentiment_repair_arms wraps _stream_vader_and_classify with a spy of this exact
    arity; the VADER-only entry point must refuse to be reached through it by accident."""
    con = duckdb.connect(":memory:")
    con.execute("CREATE TABLE _w(recommendationid VARCHAR, aspect VARCHAR, window_text VARCHAR)")
    con.execute("CREATE TEMP TABLE _out(recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE)")
    with pytest.raises(ValueError, match="needs a classifier"):
        bm._stream_vader_and_classify(con, "SELECT * FROM _w", "INSERT INTO _out VALUES (?, ?, ?)",
                                      None)


# ------------------------------------------------------------------------------------------
# The staged bulk insert that replaced executemany
# ------------------------------------------------------------------------------------------

EDGE_ROWS = [
    (None, "a", 0.0, "b", "c", 1.0),
    ("", "a", -0.0, "b", "c", 1.0),
    ('he said "hi", ok', "x,y", 1e-300, 'q"q', "\\back\\slash", 1.7976931348623157e308),
    ("multi\nline\r\ntext", "tab\tsep", 0.1 + 0.2, "ünïcödé 日本語 🎮", "", 5e-324),
    ("null", "NULL", 0.3, "\\N", "N/A", 0.0),
    ("227836074", "Price & Value", -0.4215, "NONE", "neutral", 0.0),
]
DDL = ("recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE, clf_aspect VARCHAR, "
       "clf_sentiment VARCHAR, clf_margin DOUBLE")


def test_staged_insert_round_trips_every_value_executemany_did():
    con = duckdb.connect(":memory:")
    con.execute(f"CREATE TEMP TABLE via_many({DDL})")
    con.execute(f"CREATE TEMP TABLE via_stage({DDL})")
    con.executemany("INSERT INTO via_many VALUES (?, ?, ?, ?, ?, ?)", EDGE_ROWS)
    bm._StagedInsert(con, "INSERT INTO via_stage VALUES (?, ?, ?, ?, ?, ?)").insert(EDGE_ROWS)
    # Equal in Python (NULL stays NULL, '' stays '', text is byte-exact, doubles exact)...
    many = con.execute("SELECT * FROM via_many ORDER BY ALL").fetchall()
    staged = con.execute("SELECT * FROM via_stage ORDER BY ALL").fetchall()
    assert staged == many
    assert ("", "a", 0.0, "b", "c", 1.0) in staged and (None, "a", 0.0, "b", "c", 1.0) in staged
    # ...and equal to DuckDB, both ways.
    assert con.execute("SELECT count(*) FROM (SELECT * FROM via_many EXCEPT SELECT * FROM via_stage)"
                       ).fetchone()[0] == 0
    assert con.execute("SELECT count(*) FROM (SELECT * FROM via_stage EXCEPT SELECT * FROM via_many)"
                       ).fetchone()[0] == 0
    # An empty batch writes nothing and touches no file.
    bm._StagedInsert(con, "INSERT INTO via_stage VALUES (?, ?, ?, ?, ?, ?)").insert([])
    assert con.execute("SELECT count(*) FROM via_stage").fetchone()[0] == len(EDGE_ROWS)


def test_staged_insert_honours_a_column_list_and_attached_targets(tmp_path):
    con = duckdb.connect(":memory:")
    con.execute(f"CREATE TEMP TABLE t({DDL})")
    bm._StagedInsert(con, "INSERT INTO t (recommendationid, aspect, compound) VALUES (?, ?, ?)"
                     ).insert([("r1", "Price & Value", -0.5), ("r2", "Story", 0.25)])
    assert con.execute("SELECT * FROM t ORDER BY 1").fetchall() == [
        ("r1", "Price & Value", -0.5, None, None, None), ("r2", "Story", 0.25, None, None, None)]
    # The press cache's shape: an INTEGER key in an ATTACHED database.
    con.execute(f"ATTACH '{tmp_path / 'c.duckdb'}' AS cache")
    con.execute("CREATE TABLE cache.press_article(article_id INTEGER, compound DOUBLE)")
    bm._StagedInsert(con, "INSERT INTO cache.press_article VALUES (?, ?)").insert(
        [(7, 0.1234), (8, None)])
    assert con.execute("SELECT * FROM cache.press_article ORDER BY 1").fetchall() == [
        (7, 0.1234), (8, None)]


@pytest.mark.parametrize("bad", [
    "INSERT INTO t SELECT 1",
    "INSERT INTO t (nope) VALUES (?)",
    "INSERT INTO t VALUES (?, ?)",               # 2 marks for 6 columns
    "INSERT INTO t (recommendationid) VALUES (?, ?)",
    "UPDATE t SET compound = ?",
])
def test_staged_insert_refuses_any_other_shape(bad):
    con = duckdb.connect(":memory:")
    con.execute(f"CREATE TEMP TABLE t({DDL})")
    with pytest.raises(ValueError, match="_StagedInsert"):
        bm._StagedInsert(con, bad)


# ------------------------------------------------------------------------------------------
# Every caller: the bucket loop, the uncached path, --repair-arms, and the deadline stop
# ------------------------------------------------------------------------------------------

def _score_logged(data_dir: Path, workers: int, monkeypatch, deadline: str | None = None) -> str:
    monkeypatch.setenv("PROSPECT_SCORE_WORKERS", str(workers))
    with _env(deadline=deadline):
        con = _fresh_con()
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                bm.compute_aspect_sentiment(con, data_dir)
        finally:
            con.close()
    return buf.getvalue()


def test_bucket_loop_pooled_matches_inline_cache(monkeypatch):
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    with tempfile.TemporaryDirectory() as td_pool, tempfile.TemporaryDirectory() as td_inline:
        log_pool = _score_logged(Path(td_pool), 2, monkeypatch)
        log_inline = _score_logged(Path(td_inline), 1, monkeypatch)
        assert log_pool.count("[etl] scoring with 2 worker processes") == 1, (
            "one pool per scoring phase, not one per bucket")
        assert "[etl] scoring inline in the main process" in log_inline
        assert "[etl] scoring with" not in log_inline
        pooled_mentions, pooled_scored = _cache(Path(td_pool))
        inline_mentions, inline_scored = _cache(Path(td_inline))
        assert pooled_scored == inline_scored == POOL_IDS
        assert pooled_mentions and pooled_mentions == inline_mentions
        # One timing line per occupied bucket, with a non-zero mention count in each.
        lines = [l for l in log_pool.splitlines() if "[etl] aspect sentiment bucket " in l]
        assert len(lines) == len(_occupied(N_BUCKETS)) == _status(Path(td_pool))["buckets_done"]
        assert all(" mention(s) scored in " in l and "commit " in l for l in lines)
        assert bm._SCORE_POOL is None


def test_uncached_full_pool_path_pooled_matches_inline(monkeypatch):
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "off")

    def run(workers: int):
        monkeypatch.setenv("PROSPECT_SCORE_WORKERS", str(workers))
        with _env(), tempfile.TemporaryDirectory() as td:
            con = _fresh_con()
            buf = io.StringIO()
            try:
                with redirect_stdout(buf):
                    n = bm.compute_aspect_sentiment(con, Path(td))
                rows = sorted(con.execute("SELECT * FROM stg_aspect_mention_sentiment").fetchall())
            finally:
                con.close()
        return n, rows, buf.getvalue()

    n_pool, rows_pool, log_pool = run(2)
    n_inline, rows_inline, log_inline = run(1)
    assert "[etl] scoring with 2 worker processes" in log_pool
    assert "[etl] scoring inline" in log_inline
    assert n_pool == n_inline > 0
    assert rows_pool == rows_inline


def test_pooled_deadline_stop_keeps_every_committed_bucket_and_closes_the_pool(monkeypatch):
    """The wipe test's deadline contract, through the pool: a fake clock advances 100s per
    bucket against a 250s budget, so exactly two buckets complete, both are committed, the
    pool is gone, and a later pooled run finishes onto the clean (inline) cache."""
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    occupied = _occupied(N_BUCKETS)
    assert len(occupied) >= 4
    real_time = bm.time
    real_scorer = bm._stream_vader_and_classify
    clock = _FakeClock(real_time, 0.0)

    def ticking(con, select_sql, insert_sql, clf):
        n = real_scorer(con, select_sql, insert_sql, clf)
        clock.now += 100.0
        return n

    with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as td_clean:
        data_dir, clean_dir = Path(td), Path(td_clean)
        monkeypatch.setattr(bm, "time", clock)
        monkeypatch.setattr(bm, "_PROC_T0", 0.0)
        monkeypatch.setattr(bm, "_stream_vader_and_classify", ticking)
        log = _score_logged(data_dir, 2, monkeypatch, deadline="250")
        monkeypatch.setattr(bm, "time", real_time)
        monkeypatch.setattr(bm, "_stream_vader_and_classify", real_scorer)

        assert "[etl] scoring with 2 worker processes" in log
        assert "STOPPED EARLY" in log, log
        assert bm._SCORE_POOL is None, "the deadline stop must close the pool"
        status = _status(data_dir)
        assert status["buckets_done"] == 2 and status["buckets_total"] == len(occupied)
        _, scored = _cache(data_dir)
        expected = {r for r, b in _buckets_of(POOL_IDS, N_BUCKETS).items() if b in occupied[:2]}
        assert scored == expected and scored, "both completed buckets must be committed"

        # The rest, pooled and without a deadline, lands on the INLINE clean cache.
        log_rest = _score_logged(data_dir, 2, monkeypatch)
        assert "[etl] scoring with 2 worker processes" in log_rest
        monkeypatch.setenv("PROSPECT_SCORE_WORKERS", "1")
        log_clean = _score_logged(clean_dir, 1, monkeypatch)
        assert "[etl] scoring inline" in log_clean and "[etl] scoring with" not in log_clean
        assert _cache(data_dir) == _cache(clean_dir)
        assert _cache(data_dir)[1] == POOL_IDS


def test_repair_arms_pooled_matches_inline(monkeypatch):
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    monkeypatch.setenv("PROSPECT_REPAIR_BUCKET_REVIEWS", "12")
    monkeypatch.setenv("PROSPECT_SCORE_WORKERS", "1")
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        clean_mentions, _ = repair._seed(data_dir)   # inline seed = the reference cache
        holed = repair._with_arm(clean_mentions)[0]
        repair._punch_hole(data_dir, holed)
        monkeypatch.setenv("PROSPECT_SCORE_WORKERS", "2")
        totals, log = repair._repair(data_dir)
        assert log.count("[etl] scoring with 2 worker processes") == 1
        assert totals is not None and totals["rescored"] == 1 and totals["mismatched"] == 1
        assert _cache(data_dir) == (clean_mentions, POOL_IDS), (
            "the pooled repair must restore exactly what inline scoring produced")
        assert bm._SCORE_POOL is None


# ------------------------------------------------------------------------------------------
# The knobs
# ------------------------------------------------------------------------------------------

CPUS = os.cpu_count() or 1


@pytest.mark.parametrize("bad", ["-1", "abc", "1.5", str(CPUS + 1), "0x2"])
def test_score_workers_knob_is_refused_when_garbled(monkeypatch, bad):
    monkeypatch.setenv("PROSPECT_SCORE_WORKERS", bad)
    errs = [e for e in bm._env_config_errors() if "PROSPECT_SCORE_WORKERS" in e]
    assert len(errs) == 1 and repr(bad) in errs[0] and str(CPUS) in errs[0]


@pytest.mark.parametrize("good", ["0", "1", str(CPUS), " 2 "])
def test_score_workers_knob_accepts_the_valid_range(monkeypatch, good):
    monkeypatch.setenv("PROSPECT_SCORE_WORKERS", good)
    assert not [e for e in bm._env_config_errors() if "PROSPECT_SCORE_WORKERS" in e]


def test_score_workers_default_and_fallback(monkeypatch):
    monkeypatch.delenv("PROSPECT_SCORE_WORKERS", raising=False)
    assert bm._score_workers() == bm._default_score_workers() == max(1, min(3, CPUS - 1))
    assert bm.SCORE_WORKERS_MAX == 3
    for raw, want in (("0", 0), ("1", 1), ("2", 2), (" 2 ", 2)):
        monkeypatch.setenv("PROSPECT_SCORE_WORKERS", raw)
        assert bm._score_workers() == want
    for garbled in ("abc", "-3", "1.5"):
        # Refused by _env_config_errors at startup; mid-build the default wins, never a crash.
        monkeypatch.setenv("PROSPECT_SCORE_WORKERS", garbled)
        assert bm._score_workers() == bm._default_score_workers()


def test_score_context_knob(monkeypatch):
    monkeypatch.setenv("PROSPECT_SCORE_CONTEXT", "thread")
    errs = [e for e in bm._env_config_errors() if "PROSPECT_SCORE_CONTEXT" in e]
    assert len(errs) == 1 and "'thread'" in errs[0]
    monkeypatch.setenv("PROSPECT_SCORE_CONTEXT", "spawn")
    assert not [e for e in bm._env_config_errors() if "PROSPECT_SCORE_CONTEXT" in e]
    assert bm._score_context() == "spawn"
    monkeypatch.delenv("PROSPECT_SCORE_CONTEXT")
    assert bm._score_context() == ("fork" if sys.platform.startswith("linux") else "spawn")


def test_inline_path_is_used_for_zero_and_one_workers(monkeypatch):
    for raw in ("0", "1"):
        monkeypatch.setenv("PROSPECT_SCORE_WORKERS", raw)
        buf = io.StringIO()
        with redirect_stdout(buf), bm._scoring_pool() as pool:
            assert pool is None and bm._SCORE_POOL is None
        assert f"scoring inline in the main process (workers={raw})" in buf.getvalue()


# ------------------------------------------------------------------------------------------
# No worker outlives the build
# ------------------------------------------------------------------------------------------

def test_workers_die_when_the_parent_is_killed():
    """`timeout 21600` SIGKILLs the nightly. Its workers must not linger: a lingering fork
    worker carries the parent's command line and would make the deploy guard believe a build
    is still running the next night."""
    script = textwrap.dedent(f"""
        import os, signal, sys
        sys.path.insert(0, {str(ETL)!r})
        import build_marts as bm
        pool = bm._ScoringPool(2, bm._score_context())
        # Two concurrent chunks so a spawn pool has started both workers before we die.
        pool.collect(pool.submit(["a fine game", "a poor game"] * bm.SCORE_CHUNK_WINDOWS, True))
        print("PIDS", *pool.pids(), flush=True)
        os.kill(os.getpid(), signal.SIGKILL)
    """)
    proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
                          timeout=120, cwd=str(ETL))
    pid_line = next((l for l in proc.stdout.splitlines() if l.startswith("PIDS ")), None)
    assert pid_line, f"no PIDS line in stdout:\n{proc.stdout}\n{proc.stderr}"
    pids = [int(p) for p in pid_line.split()[1:]]
    assert len(pids) == 2, pid_line
    assert proc.returncode == -signal.SIGKILL
    deadline = time.monotonic() + 15
    while any(_alive(p) for p in pids) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not any(_alive(p) for p in pids), f"orphaned scoring workers: {pids}"
