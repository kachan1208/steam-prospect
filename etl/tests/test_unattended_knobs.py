"""The guards that used to exist only in the droplet's shell wrappers, now in build_marts itself.

deploy/prospect-refresh.sh exported the spill cap and ran a `df` gate before the build; a build
started any other way — a laptop, a new server, a cron line without the wrapper — had neither,
and DuckDB's own defaults are the ones that filled the disk on 2026-08-30 (spill up to 90% of
free disk) and take 80% of RAM. What these tests pin:

  * the FREE-DISK GATE: below PROSPECT_DISK_MIN_FREE_GB (default 30 GiB) the run refuses with
    exit 4 — after the dead-scratch sweep, which may have freed the room — and builds nothing;
  * the SPILL BUDGET: max_temp_directory_size is PROSPECT_DUCKDB_TEMP_MAX, else the smaller of
    40GiB and half the free disk where the spill lands — never DuckDB's 90%;
  * PROSPECT_DUCKDB_THREADS / PROSPECT_DUCKDB_TEMP_DIR / PROSPECT_DUCKDB_MEMORY_LIMIT are applied
    and LOGGED as DuckDB reports them, and an unset memory limit is warned about;
  * a spill dir under PROSPECT_DUCKDB_TEMP_DIR is per data dir and swept like any scratch;
  * every knob is validated before any work; and on macOS the scoring workers are spawned —
    PROSPECT_SCORE_CONTEXT=fork is refused there.
"""
from __future__ import annotations

import hashlib
import sys
from collections import namedtuple
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_marts as bm  # noqa: E402
from scratch_holder import listing  # noqa: E402
from test_full_build_smoke import _run, build_source  # noqa: E402

KNOBS = ("PROSPECT_DISK_MIN_FREE_GB", "PROSPECT_DUCKDB_THREADS", "PROSPECT_DUCKDB_TEMP_DIR",
         "PROSPECT_DUCKDB_TEMP_MAX", "PROSPECT_DUCKDB_MEMORY_LIMIT", "PROSPECT_SCORE_CONTEXT")


@pytest.fixture(autouse=True)
def hermetic(monkeypatch):
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "off")
    for var in KNOBS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("PROSPECT_DISK_MIN_FREE_GB", "0")   # tests below that want a floor set it


def _setup(tmp_path: Path) -> tuple[Path, list[str]]:
    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    return data, ["--source", str(src), "--data-dir", str(data)]


# ------------------------------------------------------------------------------------------
# The free-disk gate
# ------------------------------------------------------------------------------------------
def test_below_the_disk_floor_nothing_is_built_but_dead_scratch_is_still_swept(
        tmp_path, monkeypatch, capsys):
    data, argv = _setup(tmp_path)
    dead = data / "prospect_20260101.duckdb.building.tmp"
    dead.mkdir()
    (dead / "duckdb_temp_storage-0.tmp").write_bytes(b"x" * 1024)
    monkeypatch.setenv("PROSPECT_DISK_MIN_FREE_GB", "999999")       # ~1 PiB: never met
    assert _run(argv) == bm.EXIT_LOW_DISK == 4
    err = capsys.readouterr().err
    assert "below the 999999 GiB floor (PROSPECT_DISK_MIN_FREE_GB)" in err
    assert not dead.exists(), "the sweep runs BEFORE the gate — it may be what frees the room"
    assert listing(data) == [], "a refused build must build nothing"


def test_the_default_floor_is_30_gib_and_0_turns_it_off(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("PROSPECT_DISK_MIN_FREE_GB")
    assert bm._disk_min_free_gb() == bm.DISK_MIN_FREE_GB_DEFAULT == 30.0
    data, argv = _setup(tmp_path)
    monkeypatch.setenv("PROSPECT_DISK_MIN_FREE_GB", "0")
    assert _run(argv) == 0
    assert "(floor 0 GiB, PROSPECT_DISK_MIN_FREE_GB)" in capsys.readouterr().out


def test_the_gate_measures_the_data_dirs_filesystem(tmp_path, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    seen = []
    monkeypatch.setattr(bm.shutil, "disk_usage",
                        lambda p: seen.append(Path(p)) or Usage(100 * 2**30, 90 * 2**30, 10 * 2**30))
    data, argv = _setup(tmp_path)
    monkeypatch.setenv("PROSPECT_DISK_MIN_FREE_GB", "10.5")
    assert _run(argv) == bm.EXIT_LOW_DISK
    assert data.resolve() in seen
    monkeypatch.setenv("PROSPECT_DISK_MIN_FREE_GB", "10")
    assert _run(argv) == 0, "exactly at the floor is enough"


# ------------------------------------------------------------------------------------------
# DuckDB resource knobs
# ------------------------------------------------------------------------------------------
def test_the_default_spill_budget_is_min_40gib_and_half_the_free_disk(tmp_path, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    monkeypatch.setattr(bm.shutil, "disk_usage", lambda p: Usage(0, 0, 10 * 2**30))
    assert bm._default_temp_max(tmp_path) == "5120MiB"
    monkeypatch.setattr(bm.shutil, "disk_usage", lambda p: Usage(0, 0, 500 * 2**30))
    assert bm._default_temp_max(tmp_path) == "40960MiB"
    monkeypatch.setattr(bm.shutil, "disk_usage", lambda p: Usage(0, 0, 0))
    assert bm._default_temp_max(tmp_path) == "1MiB", "never 0, which DuckDB reads as 'no spill'"


def test_unset_knobs_leave_duckdb_defaults_but_cap_the_spill_and_warn(tmp_path, capsys):
    data, argv = _setup(tmp_path)
    assert _run(argv) == 0
    out, err = capsys.readouterr()
    line = next(ln for ln in out.splitlines() if ln.startswith("[etl] duckdb     :"))
    assert "(DuckDB default)" in line and "default: min(40GiB, 50% of free disk)" in line, line
    assert "preserve_insertion_order=false" in line
    assert "WARNING: PROSPECT_DUCKDB_MEMORY_LIMIT is unset" in err


def test_set_knobs_are_applied_and_logged_as_duckdb_reports_them(tmp_path, monkeypatch, capsys):
    data, argv = _setup(tmp_path)
    spill_base = tmp_path / "fast-volume"
    spill_base.mkdir()
    monkeypatch.setenv("PROSPECT_DUCKDB_THREADS", "2")
    monkeypatch.setenv("PROSPECT_DUCKDB_MEMORY_LIMIT", "1GB")
    monkeypatch.setenv("PROSPECT_DUCKDB_TEMP_MAX", "3GiB")
    monkeypatch.setenv("PROSPECT_DUCKDB_TEMP_DIR", str(spill_base))

    seen: dict[str, str] = {}
    real_configure = bm._configure_duckdb

    def spy(con, building, spill_dir):
        real_configure(con, building, spill_dir)
        seen.update(con.execute(
            "SELECT name, value FROM duckdb_settings() WHERE name IN ('threads', 'memory_limit', "
            "'max_temp_directory_size', 'temp_directory')").fetchall())

    monkeypatch.setattr(bm, "_configure_duckdb", spy)
    assert _run(argv) == 0
    out, err = capsys.readouterr()
    tag = hashlib.sha256(str(data.resolve()).encode()).hexdigest()[:12]
    expect_spill = spill_base.resolve() / f"prospect-{tag}" / f"prospect_{bm._utc_today():%Y%m%d}.duckdb.building.tmp"
    assert seen["threads"] == "2"
    assert seen["max_temp_directory_size"] == "3.0 GiB"
    assert seen["temp_directory"] == str(expect_spill)
    assert seen["memory_limit"] in ("953.6 MiB", "1000.0 MB", "1.0 GB"), seen["memory_limit"]
    line = next(ln for ln in out.splitlines() if ln.startswith("[etl] duckdb     :"))
    assert "threads=2 " in line and "max_temp_directory_size=3.0 GiB" in line and str(expect_spill) in line
    assert "(DuckDB default)" not in line
    assert "PROSPECT_DUCKDB_MEMORY_LIMIT is unset" not in err


def test_a_spill_dir_under_the_temp_dir_is_per_data_dir_and_swept_like_scratch(tmp_path, monkeypatch):
    data, argv = _setup(tmp_path)
    spill_base = tmp_path / "fast-volume"
    spill_base.mkdir()
    monkeypatch.setenv("PROSPECT_DUCKDB_TEMP_DIR", str(spill_base))
    root = bm._spill_root(data.resolve())
    other = spill_base.resolve() / "prospect-0123456789ab" / "prospect_20260101.duckdb.building.tmp"
    for d in (root / "prospect_20260101.duckdb.building.tmp", other):
        d.mkdir(parents=True)
        (d / "duckdb_temp_storage-0.tmp").write_bytes(b"x")
    assert _run(argv) == 0
    assert not (root / "prospect_20260101.duckdb.building.tmp").exists(), (
        "a dead build's spill under PROSPECT_DUCKDB_TEMP_DIR must be swept like any scratch")
    assert other.exists(), "another data dir's spill in the same temp dir is not ours to touch"
    assert root.is_dir() and list(root.iterdir()) == [], "and this build cleaned up its own"


# ------------------------------------------------------------------------------------------
# Validation of every knob, before any work
# ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("var,bad,good", [
    ("PROSPECT_DISK_MIN_FREE_GB", ["-1", "lots", "nan"], ["0", "30", "12.5"]),
    ("PROSPECT_DUCKDB_THREADS", ["0", "-2", "four", "1.5"], ["1", "11"]),
    ("PROSPECT_DUCKDB_TEMP_MAX", ["lots", "40 potatoes"], ["40GiB", "500MB", "10GB"]),
    ("PROSPECT_DUCKDB_TEMP_DIR", ["/definitely/not/a/dir"], []),
])
def test_garbled_knobs_are_refused_up_front(var, bad, good, monkeypatch, tmp_path):
    for value in bad:
        monkeypatch.setenv(var, value)
        assert any(var in e for e in bm._env_config_errors()), (var, value)
    for value in good + ([str(tmp_path)] if var == "PROSPECT_DUCKDB_TEMP_DIR" else []):
        monkeypatch.setenv(var, value)
        assert not [e for e in bm._env_config_errors() if var in e], (var, value)


def test_a_garbled_knob_exits_2_before_touching_anything(tmp_path, monkeypatch):
    data, argv = _setup(tmp_path)
    monkeypatch.setenv("PROSPECT_DUCKDB_THREADS", "many")
    assert _run(argv) == 2
    assert list(data.iterdir()) == []


# ------------------------------------------------------------------------------------------
# macOS: scoring workers are spawned, never forked
# ------------------------------------------------------------------------------------------
def test_score_context_defaults_per_platform(monkeypatch):
    monkeypatch.setattr(bm.sys, "platform", "darwin")
    assert bm._score_context() == "spawn"
    if "fork" in bm.multiprocessing.get_all_start_methods():
        monkeypatch.setattr(bm.sys, "platform", "linux")
        assert bm._score_context() == "fork"


def test_fork_is_refused_on_macos_but_allowed_on_linux(monkeypatch):
    monkeypatch.setenv("PROSPECT_SCORE_CONTEXT", "fork")
    monkeypatch.setattr(bm.sys, "platform", "darwin")
    errs = [e for e in bm._env_config_errors() if "PROSPECT_SCORE_CONTEXT" in e]
    assert errs and "unsafe on macOS" in errs[0]
    for ok in ("spawn", "forkserver"):
        monkeypatch.setenv("PROSPECT_SCORE_CONTEXT", ok)
        assert not [e for e in bm._env_config_errors() if "PROSPECT_SCORE_CONTEXT" in e], ok
    if "fork" in bm.multiprocessing.get_all_start_methods():
        monkeypatch.setenv("PROSPECT_SCORE_CONTEXT", "fork")
        monkeypatch.setattr(bm.sys, "platform", "linux")
        assert not [e for e in bm._env_config_errors() if "PROSPECT_SCORE_CONTEXT" in e]
