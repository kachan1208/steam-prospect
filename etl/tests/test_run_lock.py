"""The run lock, and the scratch sweep that now trusts it instead of the clock.

THE DEFECT (2026-09-22 review, reproduced with a holder process + bm.main()): main() opened its
scratch with `duckdb.connect(building)` as the first line INSIDE the try whose finally sweeps
that version's scratch. A second run of the same version — a manual run during the nightly, an
overlapping --light build, a second --rescore-only — was correctly refused by DuckDB's file
lock, and then its finally deleted the LIVE build's .building, .wal and .tmp/ spill. The live
build died at its next spill or at validate_mart, and the night's mart was lost.

Separately, the pre-build sweep decided liveness by AGE: a same-version scratch was "dead" after
an hour without writes (a long quiet query is not dead) and a dead one was spared for an hour
(a killed build's 18GB spill kept eating the disk the next run needed).

Every run now holds an exclusive flock on the data dir for its life (bm._RunLock): mart builds on
.build.lock, --rescore-only on its own .rescore.lock (so it still runs beside a build), and
--repair-arms on both. A second run exits bm.EXIT_BUSY (3) having touched nothing; the sweep
reclaims exactly the scratch no lock-holder and no open DuckDB handle can own; and the connect
sits outside the sweeping try, so a refused connect cannot reach the sweep.

Every "live build" here is a real second process (tests/scratch_holder.py) that holds what a
running build holds, and must still be able to write, checkpoint and close afterwards.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_marts as bm  # noqa: E402
from scratch_holder import hold, listing  # noqa: E402
from test_full_build_smoke import _run, build_source  # noqa: E402


@pytest.fixture(autouse=True)
def hermetic(monkeypatch):
    monkeypatch.setattr(bm, "LOCK_GRACE_SECONDS", 0.3)   # a refusal need not wait 15s here
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "off")
    for var in ("PROSPECT_SENTIMENT_DEADLINE_SECONDS", "PROSPECT_DUCKDB_TEMP_DIR"):
        monkeypatch.delenv(var, raising=False)


def _setup(tmp_path: Path) -> tuple[Path, list[str]]:
    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    return data, ["--source", str(src), "--data-dir", str(data)]


def _todays_scratch() -> str:
    return f"prospect_{bm._utc_today():%Y%m%d}.duckdb.building"


def _dead_scratch(data: Path, name: str, age_seconds: float) -> list[Path]:
    """What a SIGKILLed run leaves: the scratch file, its .wal, a spill dir with a block."""
    base = data / name
    paths = [base, Path(f"{base}.wal"), Path(f"{base}.tmp")]
    base.write_bytes(b"dead")
    paths[1].write_bytes(b"")
    paths[2].mkdir()
    (paths[2] / "duckdb_temp_storage-0.tmp").write_bytes(b"x")
    when = time.time() - age_seconds
    for p in [*paths, paths[2] / "duckdb_temp_storage-0.tmp"]:
        os.utime(p, (when, when))
    return paths


# ------------------------------------------------------------------------------------------
# The defect itself, both ways a live build can be recognised.
# ------------------------------------------------------------------------------------------
def test_a_second_build_exits_busy_and_leaves_the_live_one_alone(tmp_path, capsys):
    data, argv = _setup(tmp_path)
    with hold(data, _todays_scratch(), bm.BUILD_LOCK_NAME) as (scratch, wal, spill):
        had_wal = wal.exists()
        assert _run(argv) == bm.EXIT_BUSY
        assert scratch.exists() and wal.exists() == had_wal
        assert (spill / "duckdb_temp_storage-0.tmp").exists()
        err = capsys.readouterr().err
        assert "BUSY" in err and "argv=holder" in err, "the refusal must say who holds the lock"
        # ...and touched nothing: no scratch of its own, nothing swept, nothing published.
        assert listing(data) == sorted([scratch.name, spill.name]
                                       + ([wal.name] if had_wal else []))
    # hold() has now made the live build write, checkpoint and close — it survived.


def test_a_refused_connect_never_reaches_the_sweep(tmp_path, capsys):
    """The exact mechanism of the defect, with the lock taken out of the picture: a live build
    that holds NO run lock (a build_marts from before it, a duckdb shell on the scratch). This
    run gets the flock, its sweep must spare the open scratch, and its connect is refused by
    DuckDB's file lock — which must end the run (exit 3) without its finally sweeping anything."""
    data, argv = _setup(tmp_path)
    with hold(data, _todays_scratch(), None) as (scratch, wal, spill):
        had_wal = wal.exists()
        assert _run(argv) == bm.EXIT_BUSY
        assert scratch.exists() and wal.exists() == had_wal and spill.is_dir()
        out = capsys.readouterr()
        assert "NOT sweeping" in out.out and "open in another process" in out.out
        assert "BUSY" in out.err


# ------------------------------------------------------------------------------------------
# The sweep: liveness is the lock (and DuckDB's own file lock), never the file's age.
# ------------------------------------------------------------------------------------------
def test_a_dead_scratch_is_swept_at_once_however_fresh(tmp_path):
    """A SIGKILLed build's scratch used to be spared for an hour after its last write, still
    holding its spill on the disk the next run needed. The lock proves it dead immediately."""
    data, argv = _setup(tmp_path)
    dead = _dead_scratch(data, _todays_scratch(), age_seconds=5)
    other = _dead_scratch(data, "prospect_20260101.duckdb.building", age_seconds=5)
    assert _run(argv) == 0
    assert not any(p.exists() for p in dead + other)
    assert (data / "current.duckdb").is_symlink(), "and the build then ran normally"


def test_a_live_scratch_is_spared_however_idle(tmp_path):
    """The other half: a live build that has not written for two days (the old rule's 'dead
    after an hour') is spared — whether it holds the family lock the sweeper would need, or
    holds no lock at all but has the scratch open."""
    two_days = time.time() - 2 * 86400
    with hold(tmp_path, "prospect_20260920.duckdb.building", bm.BUILD_LOCK_NAME) as live_locked, \
            hold(tmp_path, "prospect_20260919.duckdb.building", None) as live_open:
        for p in (*live_locked, *live_open):
            if p.exists():
                os.utime(p, (two_days, two_days))
        # a rescore-family run cannot borrow the build lock -> spares the locked one; and
        # a build-family run that holds the lock still spares the scratch open elsewhere
        bm._sweep_stale_scratch(tmp_path, frozenset({"rescore"}))
        assert live_locked[0].exists() and live_locked[2].is_dir()
        assert live_open[0].exists() and live_open[2].is_dir()


# ------------------------------------------------------------------------------------------
# The families: --rescore-only beside a build (by design), never beside another rescore;
# --repair-arms beside neither.
# ------------------------------------------------------------------------------------------
def test_rescore_only_still_runs_beside_a_live_build(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    data, argv = _setup(tmp_path)
    with hold(data, _todays_scratch(), bm.BUILD_LOCK_NAME) as (scratch, _wal, spill):
        assert _run(argv + ["--rescore-only"]) == 0
        assert scratch.exists() and spill.is_dir()
        assert "NOT sweeping" in capsys.readouterr().out
    assert (data / bm.SENTIMENT_CACHE_DB_NAME).exists()


def test_a_second_rescore_exits_busy_and_a_build_beside_it_spares_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    data, argv = _setup(tmp_path)
    with hold(data, bm.RESCORE_SCRATCH_DB_NAME, bm.RESCORE_LOCK_NAME) as (scratch, _wal, spill):
        assert _run(argv + ["--rescore-only"]) == bm.EXIT_BUSY
        monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "off")
        assert _run(argv) == 0, "a mart build is not blocked by a rescore"
        assert scratch.exists() and spill.is_dir(), "...and must not sweep the rescore's scratch"


def test_repair_arms_runs_beside_neither(tmp_path, monkeypatch):
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    data, argv = _setup(tmp_path)
    with hold(data, _todays_scratch(), bm.BUILD_LOCK_NAME):
        assert _run(argv + ["--repair-arms"]) == bm.EXIT_BUSY
    with hold(data, bm.RESCORE_SCRATCH_DB_NAME, bm.RESCORE_LOCK_NAME):
        assert _run(argv + ["--repair-arms"]) == bm.EXIT_BUSY
    assert not (data / bm.SENTIMENT_CACHE_DB_NAME).exists(), "refused before touching the cache"


def test_the_lock_is_released_on_every_exit_and_a_refusal_takes_none(tmp_path):
    """A finished run must not leave its lock held (the next run would exit 3 forever), and a
    run refused by a flag must not even create the lock file."""
    data, argv = _setup(tmp_path)
    assert _run(argv + ["--light", "--fulltext", "build"]) == 2
    assert not (data / bm.BUILD_LOCK_NAME).exists()
    assert _run(argv) == 0
    probe = bm._RunLock(data / bm.BUILD_LOCK_NAME)
    assert probe.acquire(), "the build's lock outlived the build"
    probe.release()
