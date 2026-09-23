"""WHERE a build reads and writes must be stated, never defaulted — and a stale source must be loud.

Until 2026-09-22 --source defaulted to a hard-coded laptop path (by then a stale August copy of
the scraper DB), --data-dir to the repo's own data/, and `task etl` passed neither: a bare run
built a weeks-old mart in the wrong place and exited 0. Now:

  * --source / --data-dir are required unless PROSPECT_SOURCE_DB / PROSPECT_DATA_DIR are set
    (exit 2 otherwise), and the data dir must already exist — a typo'd one is never created,
    because it would start a fresh mart AND a full multi-night sentiment rescore;
  * the run logs both resolved paths and when the source was last written — WAL-aware: in WAL
    mode recent writes sit in <db>-wal until a checkpoint, so the main file's mtime alone lies;
  * past --max-source-age-hours (default 48) it warns loudly and still builds;
  * mart_meta records that snapshot as it was at build START (the scraper keeps writing while
    the build runs).
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_marts as bm  # noqa: E402
from test_fulltext_cadence import _meta  # noqa: E402
from test_full_build_smoke import _run, build_source  # noqa: E402


@pytest.fixture(autouse=True)
def hermetic(monkeypatch):
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "off")
    for var in ("PROSPECT_SOURCE_DB", "PROSPECT_DATA_DIR"):
        monkeypatch.delenv(var, raising=False)


def _age(path: Path, hours: float) -> None:
    when = time.time() - hours * 3600
    os.utime(path, (when, when))


def test_no_paths_no_build(tmp_path, capsys):
    src = tmp_path / "steam_games.db"
    build_source(src)
    data = tmp_path / "data"
    data.mkdir()
    assert _run([]) == 2
    err = capsys.readouterr().err
    assert "--source (or $PROSPECT_SOURCE_DB) and --data-dir (or $PROSPECT_DATA_DIR) must be given" in err
    assert _run(["--source", str(src)]) == 2
    assert "--data-dir (or $PROSPECT_DATA_DIR)" in capsys.readouterr().err
    assert _run(["--data-dir", str(data)]) == 2
    assert list(data.iterdir()) == [], "a refused run must not touch the data dir"


def test_the_env_vars_stand_in_for_the_flags(tmp_path, monkeypatch, capsys):
    src = tmp_path / "steam_games.db"
    build_source(src)
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("PROSPECT_SOURCE_DB", str(src))
    monkeypatch.setenv("PROSPECT_DATA_DIR", str(data))
    assert _run([]) == 0
    out = capsys.readouterr().out
    assert f"[etl] source     : {src.resolve()}" in out
    assert f"[etl] data dir   : {data.resolve()}" in out
    assert (data / "current.duckdb").is_symlink()


def test_a_missing_data_dir_is_refused_not_created(tmp_path, capsys):
    src = tmp_path / "steam_games.db"
    build_source(src)
    typo = tmp_path / "dtaa"
    assert _run(["--source", str(src), "--data-dir", str(typo)]) == 2
    assert "data dir not found" in capsys.readouterr().err
    assert not typo.exists()
    assert _run(["--source", str(tmp_path / "nope.db"), "--data-dir", str(tmp_path)]) == 2
    assert _run(["--source", str(src), "--data-dir", str(tmp_path),
                 "--max-source-age-hours", "-1"]) == 2


def test_the_source_age_is_logged_warned_about_and_recorded(tmp_path, capsys):
    src = tmp_path / "steam_games.db"
    build_source(src)
    data = tmp_path / "data"
    data.mkdir()
    argv = ["--source", str(src), "--data-dir", str(data)]

    # Fresh: logged, no warning, recorded as of build start.
    t_start = datetime.now(timezone.utc)
    assert _run(argv) == 0
    out, err = capsys.readouterr()
    assert "last written" in out and "h ago" in out
    assert "WARNING: the source was last written" not in err
    meta = _meta(data)
    assert meta["source_db"] == str(src.resolve())
    assert float(meta["source_age_hours"]) < 1.0
    assert datetime.fromisoformat(meta["source_last_write_at"]) <= t_start
    assert meta["source_db_wal_mtime"] == ""

    # Three days stale: the build still publishes, but says so loudly — and records it.
    _age(src, 72)
    (data / "current.duckdb").resolve().rename(data / "prospect_20000101.duckdb")
    assert _run(argv) == 0
    out, err = capsys.readouterr()
    assert "WARNING: the source was last written 72.0h ago" in err
    assert "--max-source-age-hours (48)" in err
    assert "[etl] swapped" in out
    assert abs(float(_meta(data)["source_age_hours"]) - 72.0) < 0.2

    # ...unless the operator raised the bar (or turned it off with 0).
    (data / "current.duckdb").resolve().rename(data / "prospect_20000102.duckdb")
    assert _run(argv + ["--max-source-age-hours", "100"]) == 0
    assert "WARNING: the source was last written" not in capsys.readouterr().err


def test_a_fresh_wal_is_what_counts_in_wal_mode(tmp_path, capsys):
    """WAL mode: the scraper's writes land in <db>-wal and reach the main file only at a
    checkpoint, so a main file a day old next to a -wal written a minute ago is a LIVE source."""
    src = tmp_path / "steam_games.db"
    build_source(src)
    _age(src, 30)
    wal = Path(f"{src}-wal")
    wal.write_bytes(b"")          # an empty -wal is a valid (fully checkpointed) one
    snap = bm._source_snapshot(str(src))
    assert snap["source_db_wal_mtime"] and snap["source_last_write_at"] == snap["source_db_wal_mtime"]
    assert float(snap["source_age_hours"]) < 0.1
    assert abs((datetime.fromisoformat(snap["source_db_wal_mtime"])
                - datetime.fromisoformat(snap["source_db_mtime"])).total_seconds() - 30 * 3600) < 5

    _age(wal, 50)                 # both stale: the newer of the two still decides
    assert abs(float(bm._source_snapshot(str(src))["source_age_hours"]) - 30.0) < 0.1
