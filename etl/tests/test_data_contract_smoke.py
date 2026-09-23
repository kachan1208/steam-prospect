"""End-to-end data contract of the 2026-09-22 correctness changes, through build_marts.main().

Reuses test_full_build_smoke's tiny synthetic source (with the optional player/histogram tables
added), runs the whole pipeline, and asserts what only a full run can show:
  * no mart column is DECIMAL — a bare `1.0` literal summed in DuckDB is DECIMAL(38,1), which
    Python reads back as decimal.Decimal; mart_channel_buzz shipped two, and the MCP's
    `float += Decimal` crashed on them.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402
from test_full_build_smoke import add_optional_tables, build_source  # noqa: E402


def _run(argv: list[str]) -> int:
    sys.argv = ["build_marts.py"] + argv
    return bm.main()


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    saved_floors, saved_cache = bm.VALIDATE_MIN_ROWS, os.environ.get("PROSPECT_SENTIMENT_CACHE")
    bm.VALIDATE_MIN_ROWS = {}
    os.environ["PROSPECT_SENTIMENT_CACHE"] = "off"
    try:
        root = tmp_path_factory.mktemp("contract")
        src, data = root / "steam_games.db", root / "data"
        data.mkdir()
        build_source(src)
        add_optional_tables(src)
        assert _run(["--source", str(src), "--data-dir", str(data)]) == 0
        yield src, data
    finally:
        bm.VALIDATE_MIN_ROWS = saved_floors
        if saved_cache is None:
            os.environ.pop("PROSPECT_SENTIMENT_CACHE", None)
        else:
            os.environ["PROSPECT_SENTIMENT_CACHE"] = saved_cache


def _cols(con, table: str) -> dict[str, str]:
    return dict(con.execute(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ?",
        [table]).fetchall())


def test_no_mart_column_is_decimal(built):
    _src, data = built
    con = duckdb.connect(str(data / "current.duckdb"), read_only=True)
    try:
        bad = con.execute(
            "SELECT table_name, column_name, data_type FROM duckdb_columns() "
            "WHERE table_name LIKE 'mart%' AND data_type LIKE 'DECIMAL%' ORDER BY 1, 2"
        ).fetchall()
        buzz = _cols(con, "mart_channel_buzz")
    finally:
        con.close()
    assert bad == [], f"DECIMAL columns reach Python as decimal.Decimal: {bad}"
    assert buzz["reach_weighted_score"] == "DOUBLE", buzz
