"""Benchmark the sentiment scoring stream on REAL review text: the old executemany path, the
new inline path, and the worker pool at 2 and 3 workers — rows/s, worker RSS, and a proof
that every path produced the same rows. Not collected by pytest (no test_ prefix); run it:

    cd etl && .venv/bin/python tests/bench_sentiment_workers.py \\
        [--source /path/to/steam_games.db] [--reviews 35000] [--modulo 37] \\
        [--workers 1,2,3] [--context fork|spawn]

Real text, not synthetic: a memory note in this repo records synthetic reviews reporting a
meaningless 0.96x where real ones showed 19x, so the source is the scraper's SQLite corpus
(the laptop's stale snapshot by default) and the windows are cut by the production
_aspect_window_sql. If the corpus is absent the script refuses rather than benchmark the
fixture's eight template sentences. It asserts a non-zero, identical row set for every path,
so it cannot pass vacuously."""
from __future__ import annotations

import argparse
import os
import platform
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

DEFAULT_SOURCE = Path.home() / "hobby" / "steam-scraper" / "steam_games.db"
OUT_DDL = ("recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE, clf_aspect VARCHAR, "
           "clf_sentiment VARCHAR, clf_margin DOUBLE")
SELECT = "SELECT recommendationid, aspect, window_text FROM _bench_windows"
INSERT = "INSERT INTO _bench_out VALUES (?, ?, ?, ?, ?, ?)"


def rss_mb(pid: int) -> float | None:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True,
                             timeout=10).stdout.strip()
        return int(out) / 1024 if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def load_reviews(source: Path, n: int, modulo: int) -> list[tuple]:
    con = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        return con.execute(
            "SELECT appid, recommendationid, review_text FROM reviews "
            "WHERE rowid % ? = 0 AND language = 'english' "
            "AND length(review_text) BETWEEN 80 AND 6000 LIMIT ?", [modulo, n]).fetchall()
    finally:
        con.close()


def old_executemany_path(con, clf) -> int:
    """The pre-2026-09-09 _stream_vader_and_classify, verbatim: the baseline."""
    analyzer = bm._get_analyzer()
    read = con.cursor()
    read.execute(SELECT)
    n = 0
    while True:
        batch = read.fetchmany(bm.SENTIMENT_SCORE_BATCH)
        if not batch:
            break
        rows = []
        for row in batch:
            text = row[-1] or ""
            compound = float(analyzer.polarity_scores(text)["compound"])
            clf_aspect, clf_sent, margin = clf.classify(text)
            rows.append((*row[:-1], compound, clf_aspect, clf_sent, float(margin)))
        con.executemany(INSERT, rows)
        n += len(rows)
    read.close()
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    ap.add_argument("--reviews", type=int, default=35000)
    ap.add_argument("--modulo", type=int, default=37, help="sample every Nth sqlite rowid")
    ap.add_argument("--workers", default="1,2,3")
    ap.add_argument("--context", default=None, help="fork|spawn (default: the platform's)")
    ap.add_argument("--skip-old", action="store_true", help="skip the executemany baseline")
    args = ap.parse_args()
    if not args.source.exists():
        print(f"ERROR: {args.source} not found — this benchmark needs the real review corpus",
              file=sys.stderr)
        return 2
    if args.context:
        os.environ["PROSPECT_SCORE_CONTEXT"] = args.context

    t0 = time.perf_counter()
    reviews = load_reviews(args.source, args.reviews, args.modulo)
    print(f"[bench] {len(reviews):,} english reviews sampled from {args.source} "
          f"in {time.perf_counter() - t0:.1f}s")
    assert reviews, "no reviews sampled"

    con = duckdb.connect(":memory:")
    con.execute("SET memory_limit='2GB'")
    con.execute("CREATE TABLE _bench_pool(appid INTEGER, recommendationid VARCHAR, review_text VARCHAR)")
    con.executemany("INSERT INTO _bench_pool VALUES (?, ?, ?)", reviews)
    t0 = time.perf_counter()
    con.execute(f"CREATE TABLE _bench_windows AS {bm._aspect_window_sql('_bench_pool')}")
    t_windows = time.perf_counter() - t0
    n_windows, avg_chars = con.execute(
        "SELECT COUNT(*), AVG(length(window_text)) FROM _bench_windows").fetchone()
    print(f"[bench] {n_windows:,} windows (avg {avg_chars:.0f} chars) cut by _aspect_window_sql "
          f"in {t_windows:.1f}s ({len(reviews) / t_windows:,.0f} reviews/s, DuckDB threads="
          f"{con.execute('SELECT current_setting(\'threads\')').fetchone()[0]})")
    assert n_windows > 0

    clf = bm._get_classifier()
    results = []   # (label, seconds, rows, worker rss list, main rss)
    reference = None

    def fresh_out():
        con.execute("DROP TABLE IF EXISTS _bench_out")
        con.execute(f"CREATE TEMP TABLE _bench_out({OUT_DDL})")

    def check(label):
        nonlocal reference
        rows = sorted(con.execute("SELECT * FROM _bench_out").fetchall())
        assert rows and len(rows) == n_windows, f"{label}: {len(rows)} rows, expected {n_windows}"
        if reference is None:
            reference = rows
        else:
            assert rows == reference, f"{label}: rows differ from the first path's"

    if not args.skip_old:
        fresh_out()
        t0 = time.perf_counter()
        n = old_executemany_path(con, clf)
        dt = time.perf_counter() - t0
        check("old executemany")
        results.append(("old: inline + executemany", dt, n, [], rss_mb(os.getpid())))
        print(f"[bench] old executemany path: {n:,} rows in {dt:.1f}s ({n / dt:,.0f} rows/s)")

    for w in [int(x) for x in args.workers.split(",")]:
        os.environ["PROSPECT_SCORE_WORKERS"] = str(w)
        fresh_out()
        t0 = time.perf_counter()
        with bm._scoring_pool() as pool:
            n = bm._stream_vader_and_classify(con, SELECT, INSERT, clf)
            dt = time.perf_counter() - t0
            worker_rss = [r for r in (rss_mb(p) for p in (pool.pids() if pool else [])) if r]
            context = pool.context if pool else "inline"
        check(f"workers={w}")
        label = (f"new: inline (workers={w})" if w <= 1
                 else f"new: {w} workers ({context})")
        results.append((label, dt, n, worker_rss, rss_mb(os.getpid())))
        print(f"[bench] {label}: {n:,} rows in {dt:.1f}s ({n / dt:,.0f} rows/s)"
              + (f"; worker RSS MB {[round(r) for r in worker_rss]}" if worker_rss else ""))

    base = results[0][1]
    print()
    print(f"machine: {platform.platform()}, {os.cpu_count()} CPUs, python {platform.python_version()}, "
          f"duckdb {duckdb.__version__}; {n_windows:,} real windows (avg {avg_chars:.0f} chars) "
          f"from {len(reviews):,} english reviews; window build {t_windows:.1f}s")
    print()
    print("| path | rows | seconds | rows/s | speedup vs first row | worker RSS (MB) | main RSS (MB) |")
    print("|---|---:|---:|---:|---:|---|---:|")
    for label, dt, n, worker_rss, main_rss in results:
        wr = ", ".join(f"{r:.0f}" for r in worker_rss) if worker_rss else "-"
        print(f"| {label} | {n:,} | {dt:.1f} | {n / dt:,.0f} | {base / dt:.1f}x | {wr} | "
              f"{main_rss:.0f} |" if main_rss else
              f"| {label} | {n:,} | {dt:.1f} | {n / dt:,.0f} | {base / dt:.1f}x | {wr} | - |")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
