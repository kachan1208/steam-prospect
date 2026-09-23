"""A deliberately RETIRED mart table may vanish without failing the validation gate.

mart_lang stopped being built on 2026-09-22 (no reader in api/, mcp/ or web/). The gate fails a
table that "had rows and is gone" — correct for an accident, but for a retirement it would fail
the first nightly after the merge, and every one after it, until someone reached for
--skip-validation (which is how a gate gets switched off for good). RETIRED_MART_TABLES lists
the tables that may vanish; anything else vanishing still fails, and a retired table that is
somehow still BUILT is compared like any other.

Separate from test_validation_gate.py only to keep this change's tests in one place.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402


def _mart(path: Path, counts: dict[str, int]) -> Path:
    con = duckdb.connect(str(path))
    try:
        for tbl, n in counts.items():
            con.execute(f'CREATE TABLE "{tbl}"(appid INTEGER)')
            if n:
                con.execute(f'INSERT INTO "{tbl}" SELECT * FROM range(?)', [n])
        con.execute("CREATE TABLE mart_meta(key VARCHAR, value VARCHAR)")
    finally:
        con.close()
    return path


@pytest.fixture(autouse=True)
def no_floors(monkeypatch):
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})


def test_mart_lang_is_retired_and_no_longer_built():
    assert "mart_lang" in bm.RETIRED_MART_TABLES
    assert "mart_lang.sql" not in bm.MART_FILES
    assert not (ETL / "marts" / "mart_lang.sql").exists()


def test_a_retired_table_may_vanish(tmp_path, capsys):
    prev = _mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_lang": 400})
    new = _mart(tmp_path / "new.duckdb", {"mart_game": 100})
    assert bm.validate_mart(new, prev) == []
    assert "RETIRED" in capsys.readouterr().out


def test_any_other_table_vanishing_still_fails(tmp_path):
    prev = _mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_lang": 400, "mart_niche": 50})
    new = _mart(tmp_path / "new.duckdb", {"mart_game": 100})
    failures = bm.validate_mart(new, prev)
    assert len(failures) == 1 and "mart_niche" in failures[0], failures


def test_a_retired_table_that_is_still_built_is_compared_as_usual(tmp_path):
    """Retirement exempts disappearance only — an emptied or collapsed table is still caught."""
    prev = _mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_lang": 400})
    new = _mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_lang": 0})
    failures = bm.validate_mart(new, prev)
    assert len(failures) == 1 and "mart_lang" in failures[0], failures
