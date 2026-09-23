"""End-to-end data contract of the 2026-09-22 correctness changes, through build_marts.main().

Reuses test_full_build_smoke's tiny synthetic source (with the optional player/histogram tables
added), runs the whole pipeline, and asserts what only a full run can show:
  * no mart column is DECIMAL — a bare `1.0` literal summed in DuckDB is DECIMAL(38,1), which
    Python reads back as decimal.Decimal; mart_channel_buzz shipped two, and the MCP's
    `float += Decimal` crashed on them;
  * the new columns are published where the API/MCP/web will look for them, and the
    market-relative player trend is exactly niche minus market;
  * mart_tag_alias and the new mart_meta keys exist;
  * a previous mart that still carries the retired mart_lang does not fail the gate.
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


def test_new_columns_are_published(built):
    _src, data = built
    con = duckdb.connect(str(data / "current.duckdb"), read_only=True)
    try:
        game, niche = _cols(con, "mart_game"), _cols(con, "mart_niche")
        alias = _cols(con, "mart_tag_alias")
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        rel = con.execute(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE players_trend_7d_rel_pct IS NULL), "
            "max(abs(players_trend_7d_rel_pct - "
            "    round(players_trend_7d_pct - players_trend_7d_market_pct, 2))) "
            "FROM mart_niche WHERE players_trend_7d_pct IS NOT NULL").fetchone()
        split = con.execute(
            "SELECT COUNT(*) FROM mart_niche WHERE n_paid + n_free + n_price_unknown != n_games"
        ).fetchone()[0]
    finally:
        con.close()
    for col in ("store_release_date", "release_date_source", "is_ea_graduate", "price_status",
                "owners_source", "players_trend_7d_market_pct", "players_trend_7d_rel_pct"):
        assert col in game, f"mart_game.{col} missing"
    for col in ("n_paid", "n_free", "n_price_unknown", "players_trend_7d_market_pct",
                "players_trend_7d_rel_pct"):
        assert col in niche, f"mart_niche.{col} missing"
    assert set(alias) == {"dimension", "alias", "canonical", "reason", "n_games"}, alias
    for key in ("owners_as_of", "owners_as_of_min", "n_games_scored_free",
                "n_games_scored_price_unknown", "players_trend_7d_market_pct"):
        assert key in meta, f"mart_meta.{key} missing"
    assert meta["players_trend_7d_market_pct"] != "", "the fixture has a CCU panel"
    assert rel[0] > 0 and rel[1] == 0, f"the fixture's niches must carry a relative trend: {rel}"
    assert rel[2] <= 0.011, f"players_trend_7d_rel_pct is not niche - market: max drift {rel[2]}"
    assert split == 0, "n_paid + n_free + n_price_unknown must equal n_games on every row"


def test_a_previous_mart_carrying_mart_lang_passes_the_gate(built, capsys):
    src, data = built
    prev = (data / "current.duckdb").resolve()
    con = duckdb.connect(str(prev))
    try:
        con.execute("CREATE TABLE mart_lang AS SELECT 'Action' AS genre, 'english' AS language, "
                    "10 AS n FROM range(20)")
    finally:
        con.close()
    saved = bm.VALIDATE_MIN_ROWS
    bm.VALIDATE_MIN_ROWS = {}
    try:
        capsys.readouterr()
        # a same-day rebuild is refused only for --light; a full rebuild replaces the file
        assert _run(["--source", str(src), "--data-dir", str(data)]) == 0
    finally:
        bm.VALIDATE_MIN_ROWS = saved
    assert "RETIRED" in capsys.readouterr().out
