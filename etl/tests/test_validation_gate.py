"""The pre-swap validation gate, the build_mode marker, and the light-overwrite guard.

The defect these pin down: build_marts.main() used to swap data/current.duckdb
UNCONDITIONALLY. A build that lost a table (broken source join, regressed mart SQL, an
empty staging family) shipped straight to production with exit 0 — the first signal was a
user seeing a blank page. validate_mart() compares the finished build against the mart
currently being served and refuses the swap when data went missing.

Builds tiny real .duckdb files (not mocks) so the gate is exercised through the same
duckdb read-only open + information_schema scan it uses in production.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402


def _make_mart(path: Path, counts: dict[str, int], meta: dict[str, str] | None = None) -> Path:
    """A minimal but REAL mart file: one mart_<name> table per entry, filled with `n` rows."""
    con = duckdb.connect(str(path))
    try:
        for tbl, n in counts.items():
            con.execute(f'CREATE TABLE "{tbl}"(appid INTEGER)')
            if n:
                con.execute(
                    f'INSERT INTO "{tbl}" SELECT * FROM range(?)', [n]
                )
        con.execute("CREATE TABLE mart_meta(key VARCHAR, value VARCHAR)")
        if meta:
            con.executemany("INSERT INTO mart_meta VALUES (?, ?)", list(meta.items()))
    finally:
        con.close()
    return path


# Floors are asserted separately (test_absolute_floor_*); everything else in this module is
# about the previous-vs-new comparison, so it runs with the floors disabled.
@pytest.fixture
def no_floors(monkeypatch):
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})


def test_first_build_passes_with_no_previous_mart(tmp_path, no_floors):
    """No previous mart = nothing to compare against; the gate must not block the first build."""
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 10, "mart_niche": 5})
    assert bm.validate_mart(new, None) == []
    # A path that simply doesn't exist yet is the same case.
    assert bm.validate_mart(new, tmp_path / "gone.duckdb") == []


def test_healthy_build_passes(tmp_path, no_floors):
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_niche": 50})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 105, "mart_niche": 50})
    assert bm.validate_mart(new, prev) == []


def test_table_emptied_fails(tmp_path, no_floors):
    """THE headline case: a previously non-empty table is now empty (the silent-blank-page bug)."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_niche": 50})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_niche": 0})
    failures = bm.validate_mart(new, prev)
    assert len(failures) == 1, failures
    assert "mart_niche" in failures[0] and "0" in failures[0]


def test_table_disappeared_fails(tmp_path, no_floors):
    """A table that vanished entirely counts as emptied, not as 'no longer compared'."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_niche": 50})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100})
    failures = bm.validate_mart(new, prev)
    assert len(failures) == 1 and "mart_niche" in failures[0], failures


def test_drop_over_threshold_fails_and_under_passes(tmp_path, no_floors):
    """The >40% rule, checked on both sides of the boundary with the same fixture shape."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 1000})

    # -50%: over the 40% limit -> fail.
    big_drop = _make_mart(tmp_path / "big.duckdb", {"mart_game": 500})
    failures = bm.validate_mart(big_drop, prev)
    assert len(failures) == 1 and "mart_game" in failures[0], failures

    # -30%: a real but plausible shrink -> pass.
    small_drop = _make_mart(tmp_path / "small.duckdb", {"mart_game": 700})
    assert bm.validate_mart(small_drop, prev) == []


def test_max_drop_pct_is_env_overridable(tmp_path, monkeypatch, no_floors):
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 1000})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 700})  # -30%

    monkeypatch.setenv("PROSPECT_VALIDATE_MAX_DROP_PCT", "10")
    assert bm.validate_mart(new, prev), "a 30% drop must fail once the limit is tightened to 10%"

    monkeypatch.setenv("PROSPECT_VALIDATE_MAX_DROP_PCT", "90")
    assert bm.validate_mart(new, prev) == []

    # A garbled value must not crash the nightly — it falls back to the module default.
    monkeypatch.setenv("PROSPECT_VALIDATE_MAX_DROP_PCT", "not-a-number")
    assert bm._validate_max_drop_pct() == bm.VALIDATE_MAX_DROP_PCT


def test_new_table_and_growth_are_not_failures(tmp_path, no_floors):
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 400, "mart_brand_new": 7})
    assert bm.validate_mart(new, prev) == []


def test_previously_empty_table_staying_empty_passes(tmp_path, no_floors):
    """A mart that is legitimately empty on this source (absent optional table) must not
    fail forever just for staying empty."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_timing_demand": 0})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_timing_demand": 0})
    assert bm.validate_mart(new, prev) == []


def test_mart_meta_is_exempt_from_comparison(tmp_path, no_floors):
    """mart_meta's keys legitimately come and go (build_mode, sentiment_classifier, ...), so
    it must not be able to fail a build on its own row count."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100},
                      meta={f"k{i}": "v" for i in range(20)})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100}, meta={"k0": "v"})
    assert bm.validate_mart(new, prev) == []


# ------------------------------------------------------------------------------------
# Absent OPTIONAL sources: emptiness the build can EXPLAIN must not fail it
# ------------------------------------------------------------------------------------
def test_absent_optional_source_exempts_its_marts(tmp_path, no_floors, capsys):
    """THE regression this exists for: the timing/players/socials families go empty BY
    DESIGN when their optional source table is missing (that is what the guarded staging and
    mart_meta.absent_sources exist to record). Failing the nightly for doing exactly what it
    documents is how a gate gets switched off at 3am."""
    prev = _make_mart(tmp_path / "prev.duckdb",
                      {"mart_game": 100, "mart_timing_demand": 50, "mart_niche_players": 40})
    new = _make_mart(tmp_path / "new.duckdb",
                     {"mart_game": 100, "mart_timing_demand": 0, "mart_niche_players": 0},
                     meta={"absent_sources": "player_counts,review_histogram"})

    assert bm.validate_mart(new, prev) == []

    # ...and the report has to SAY so — an unexplained pass is as bad as a wrong failure.
    out = capsys.readouterr().out
    assert "EXEMPT" in out
    assert "mart_timing_demand" in out and "review_histogram" in out
    assert "mart_niche_players" in out and "player_counts" in out


def test_same_emptiness_still_fails_when_the_source_is_present(tmp_path, no_floors):
    """The other half of the rule: the exemption is keyed on the build's OWN provenance, so
    the identical empty table with no absent source recorded is unexplained -> fail."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_timing_demand": 50})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_timing_demand": 0},
                     meta={"absent_sources": ""})
    failures = bm.validate_mart(new, prev)
    assert len(failures) == 1 and "mart_timing_demand" in failures[0], failures


def test_absent_source_exempts_a_large_drop_not_just_emptiness(tmp_path, no_floors):
    """mart_game_trends does not empty without review_histogram — it falls back to the
    recency-biased reviews sample and shrinks a lot. That is the same documented degradation
    and must be exempt from the max-drop rule too."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_game_trends": 1000})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_game_trends": 200},
                     meta={"absent_sources": "review_histogram"})
    assert bm.validate_mart(new, prev) == []


def test_an_absent_source_only_exempts_its_own_marts(tmp_path, no_floors):
    """The exemption must be scoped: player_counts going missing explains the player marts,
    never an unrelated one."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_niche_press": 30})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_niche_press": 0},
                     meta={"absent_sources": "player_counts"})
    failures = bm.validate_mart(new, prev)
    assert len(failures) == 1 and "mart_niche_press" in failures[0], failures


def test_absent_game_socials_exempts_nothing(tmp_path, no_floors):
    """game_socials only NULLs columns (dev_x_handle/x_handle) — it never empties a table,
    so it must not buy any table an exemption."""
    assert bm.ABSENT_SOURCE_EMPTY_MARTS.get("game_socials") is None
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_niche_players": 40})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_niche_players": 0},
                     meta={"absent_sources": "game_socials"})
    assert bm.validate_mart(new, prev), "game_socials cannot explain an empty player mart"


def test_congestion_is_not_exempted_by_an_absent_histogram(tmp_path, no_floors):
    """mart_timing_congestion is built from stg_game/stg_genre_membership, NOT from the
    histogram — it survives an absent review_histogram, so it must keep failing when empty."""
    assert "mart_timing_congestion" not in bm.ABSENT_SOURCE_EMPTY_MARTS["review_histogram"]
    prev = _make_mart(tmp_path / "prev.duckdb",
                      {"mart_game": 100, "mart_timing_congestion": 12})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 100, "mart_timing_congestion": 0},
                     meta={"absent_sources": "review_histogram"})
    failures = bm.validate_mart(new, prev)
    assert len(failures) == 1 and "mart_timing_congestion" in failures[0], failures


def test_a_mart_without_meta_gets_no_exemptions(tmp_path, no_floors):
    """Refuse to explain away emptiness we cannot prove was intended: no readable
    mart_meta = no absent_sources record = no exemption."""
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 100, "mart_timing_demand": 50})
    new = tmp_path / "new.duckdb"
    con = duckdb.connect(str(new))
    try:
        con.execute("CREATE TABLE mart_game(appid INTEGER)")
        con.execute("INSERT INTO mart_game SELECT * FROM range(100)")
        con.execute("CREATE TABLE mart_timing_demand(appid INTEGER)")
    finally:
        con.close()
    assert bm._recorded_absent_sources(new) == set()
    assert bm.validate_mart(new, prev), "no provenance must mean no exemption"


def test_absolute_floors_fail_without_any_previous_mart(tmp_path):
    """The floors are the safety net for the case a comparison cannot cover: the very first
    build, where a structurally broken mart has nothing to be compared against."""
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 10, "mart_niche": 5})
    failures = bm.validate_mart(new, None)
    assert len(failures) == 2, failures
    assert any("mart_game" in f and "floor" in f for f in failures)
    assert any("mart_niche" in f and "floor" in f for f in failures)


def test_absolute_floors_use_the_real_shipped_values():
    """Floors must stay far below the real catalog (mart_game is ~174K rows, mart_niche a few
    thousand) — high enough to catch a structural break, low enough that organic shrinkage
    never trips them."""
    assert bm.VALIDATE_MIN_ROWS["mart_game"] == 100_000
    assert bm.VALIDATE_MIN_ROWS["mart_niche"] == 1_000
    assert bm.VALIDATE_MAX_DROP_PCT == 40.0


def test_skip_validation_flag_exists_and_defaults_off():
    """--skip-validation is the documented escape hatch; main() runs the gate unless it is set."""
    assert bm.build_arg_parser().parse_args([]).skip_validation is False
    assert bm.build_arg_parser().parse_args(["--skip-validation"]).skip_validation is True


# ------------------------------------------------------------------------------------
# build_mode provenance + the light-overwrite guard
# ------------------------------------------------------------------------------------
def test_light_guard_refuses_to_replace_a_full_build(tmp_path):
    """A --light build copies STALE teardown/aspect tables from the previous mart but writes
    the same prospect_<date>.duckdb filename — it must never land on top of a same-day full
    build."""
    versioned = _make_mart(tmp_path / "prospect_20260828.duckdb", {"mart_game": 1},
                           meta={"build_mode": "full"})
    err = bm._light_overwrite_error(versioned)
    assert err is not None and "--light refused" in err


def test_light_guard_allows_replacing_another_light_build(tmp_path):
    versioned = _make_mart(tmp_path / "prospect_20260828.duckdb", {"mart_game": 1},
                           meta={"build_mode": "light"})
    assert bm._light_overwrite_error(versioned) is None


def test_light_guard_allows_a_fresh_filename(tmp_path):
    assert bm._light_overwrite_error(tmp_path / "prospect_20260829.duckdb") is None


def test_light_guard_treats_unknown_provenance_as_full(tmp_path):
    """A pre-build_mode mart carries no marker. Refuse rather than guess — an unmarked file
    is far more likely to be a full build than a light one."""
    unmarked = _make_mart(tmp_path / "prospect_20260828.duckdb", {"mart_game": 1})
    err = bm._light_overwrite_error(unmarked)
    assert err is not None and "assumed full" in err


def test_light_guard_refuses_an_unreadable_file(tmp_path):
    """Refuse-on-doubt: a file that cannot be opened may be a full build."""
    junk = tmp_path / "prospect_20260828.duckdb"
    junk.write_bytes(b"not a duckdb file at all")
    err = bm._light_overwrite_error(junk)
    assert err is not None and "--light refused" in err
