"""The full-text mart cadence: --fulltext {auto,build,copy}, the provenance it reads and
writes (mart_meta.fulltext_mode / fulltext_built_at / fulltext_scored_reviews), and the copy
path a FULL build now shares with --light.

Why it exists: the two full-text marts (mart_game_teardown.sql's family and
mart_game_aspect_reviews) were re-derived from the whole scored corpus every night —
mart_game_aspect_reviews.sql alone took 1401s of the last 3154s nightly, and its
materialisation is the ~18GB spill that filled the disk on 2026-08-30 — while their input
only moves by the night's newly scored reviews. A full build now decides, after scoring,
whether to rebuild them or copy them forward from the published mart, and records which.

The decision function is pure (clock and thresholds injectable) and is pinned branch by
branch; the round trips go through write_meta / _read_mart_meta on real files; and the
end-to-end tests drive main() through the smoke harness with the sentiment cache ON, so the
scored-review count the cadence measures is the real one.
"""
from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402
from test_full_build_smoke import _run, build_source  # noqa: E402  (one fixture source, not two)
from test_validation_gate import _make_mart  # noqa: E402

NOW = datetime(2026, 9, 3, 21, 25, 0, tzinfo=timezone.utc)
PREV = "prospect_20260902"
FULLTEXT_TABLES = [t for tables in bm.FULLTEXT_COPY_TABLES.values() for t in tables]


@pytest.fixture(autouse=True)
def hermetic_env(monkeypatch):
    """Floors off (the fixture is 40 games), sentiment cache ON (the count the cadence
    measures is the cache's scored_review), and no ambient knob leaking in."""
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    for var in ("PROSPECT_VALIDATE_MAX_DROP_PCT", "PROSPECT_ALLOW_NO_CLASSIFIER",
                "PROSPECT_FULLTEXT_MAX_AGE_HOURS", "PROSPECT_FULLTEXT_REBUILD_DELTA",
                "PROSPECT_SENTIMENT_DEADLINE_SECONDS", "PROSPECT_RESCORE_BUCKET_REVIEWS"):
        monkeypatch.delenv(var, raising=False)


# ------------------------------------------------------------------------------------------
# _decide_fulltext, branch by branch
# ------------------------------------------------------------------------------------------
def _prov(built_hours_ago: float, scored: int) -> dict[str, str]:
    """A published mart's full-text provenance, exactly as write_meta stores it."""
    built_at = NOW - timedelta(hours=built_hours_ago)
    return {"fulltext_built_at": built_at.isoformat(timespec="seconds"),
            "fulltext_scored_reviews": str(scored)}


def _decide(requested: str = "auto", prev_name: str | None = PREV,
            prev_meta: dict[str, str] | None = None, scored_now: int | None = 16_041_203,
            **kw) -> bm.FulltextPlan:
    kw.setdefault("now", NOW)
    kw.setdefault("max_age_hours", 44.0)
    kw.setdefault("rebuild_delta", 500_000)
    return bm._decide_fulltext(requested, prev_name, {} if prev_meta is None else prev_meta,
                               scored_now, **kw)


def test_no_published_mart_builds_with_fresh_provenance():
    plan = _decide(prev_name=None)
    assert plan.mode == "build"
    assert plan.reason == "rebuilding (no published mart to copy from)"
    assert plan.built_at == "2026-09-03T21:25:00+00:00"
    assert plan.scored_reviews == "16041203"


@pytest.mark.parametrize("meta", [
    {},                                                        # a pre-cadence mart
    {"fulltext_built_at": "2026-09-02T21:31:07+00:00"},        # count missing
    {"fulltext_scored_reviews": "16000000"},                   # timestamp missing
    {"fulltext_built_at": "", "fulltext_scored_reviews": ""},  # a cache-off build's blanks
    {"fulltext_built_at": "yesterday-ish", "fulltext_scored_reviews": "16000000"},
    {"fulltext_built_at": "2026-09-02T21:31:07+00:00", "fulltext_scored_reviews": "lots"},
], ids=["absent", "no-count", "no-timestamp", "blank", "bad-timestamp", "bad-count"])
def test_missing_or_unparseable_provenance_builds(meta):
    """The first night after this lands is exactly this case: the keys are not there yet."""
    plan = _decide(prev_meta=meta)
    assert plan.mode == "build"
    assert "no full-text provenance" in plan.reason
    assert plan.built_at == NOW.isoformat(timespec="seconds")


def test_fresh_tables_are_copied_and_their_provenance_carried_forward():
    """The spec's own log line: 23.5h old, +41,203 scored since — both under the thresholds."""
    prov = _prov(23.5, 16_000_000)
    plan = _decide(prev_meta=prov, scored_now=16_041_203)
    assert plan.mode == "copy"
    assert plan.reason == ("copied from prospect_20260902 (built 23.5h ago, +41,203 scored "
                           "since; thresholds 44h / 500,000)")
    # Carried forward UNCHANGED, not re-stamped: the age keeps counting from the real build.
    assert plan.built_at == prov["fulltext_built_at"]
    assert plan.scored_reviews == "16000000"


def test_stale_by_age_rebuilds():
    plan = _decide(prev_meta=_prov(47.9, 16_000_000), scored_now=16_041_203)
    assert plan.mode == "build"
    assert plan.reason == "rebuilding (age 47.9h > 44h)"
    assert (plan.built_at, plan.scored_reviews) == (NOW.isoformat(timespec="seconds"), "16041203")


def test_stale_by_scored_delta_rebuilds():
    plan = _decide(prev_meta=_prov(10.0, 16_000_000), scored_now=16_600_001)
    assert plan.mode == "build"
    assert plan.reason.startswith("rebuilding (+600,001 scored since prospect_20260902")
    assert "> 500,000" in plan.reason
    assert plan.scored_reviews == "16600001"


def test_thresholds_are_strict_greater_than():
    """'older than' / 'more than': landing exactly on a threshold still copies."""
    assert _decide(prev_meta=_prov(44.0, 16_000_000), scored_now=16_000_000).mode == "copy"
    assert _decide(prev_meta=_prov(1.0, 16_000_000), scored_now=16_500_000).mode == "copy"
    assert _decide(prev_meta=_prov(44.01, 16_000_000), scored_now=16_000_000).mode == "build"
    assert _decide(prev_meta=_prov(1.0, 16_000_000), scored_now=16_500_001).mode == "build"


def test_a_shrunken_cache_is_not_a_reason_to_rebuild():
    """A wiped-and-refilling cache (config-hash change) reads as a negative delta; the age
    rule still decides, and the log shows the sign rather than hiding it."""
    plan = _decide(prev_meta=_prov(5.0, 16_000_000), scored_now=4_000_000)
    assert plan.mode == "copy"
    assert "-12,000,000 scored since" in plan.reason


def test_cache_off_cannot_bound_the_delta_and_rebuilds():
    """With PROSPECT_SENTIMENT_CACHE=off every run rescans the whole corpus and there is no
    durable scored set to count: `auto` rebuilds, and records a blank count so the next
    night's `auto` rebuilds too rather than trusting an age alone."""
    plan = _decide(prev_meta=_prov(1.0, 16_000_000), scored_now=None)
    assert plan.mode == "build"
    assert "sentiment cache disabled" in plan.reason
    assert plan.scored_reviews == ""
    assert _decide(prev_meta={"fulltext_built_at": plan.built_at,
                              "fulltext_scored_reviews": plan.scored_reviews}).mode == "build"


def test_explicit_build_ignores_freshness():
    plan = _decide("build", prev_meta=_prov(0.1, 16_000_000), scored_now=16_000_000)
    assert plan.mode == "build"
    assert plan.reason == "rebuilding (--fulltext build)"
    assert (plan.built_at, plan.scored_reviews) == (NOW.isoformat(timespec="seconds"), "16000000")


def test_explicit_copy_ignores_staleness_and_carries_whatever_is_there():
    prov = _prov(200.0, 1)
    plan = _decide("copy", prev_meta=prov, scored_now=99_000_000)
    assert plan.mode == "copy"
    assert plan.reason == "copied from prospect_20260902 (--fulltext copy)"
    assert (plan.built_at, plan.scored_reviews) == (prov["fulltext_built_at"], "1")
    # A pre-cadence mart has nothing to carry: the blanks travel, and `auto` rebuilds next time.
    blank = _decide("copy", prev_meta={}, scored_now=99_000_000)
    assert (blank.mode, blank.built_at, blank.scored_reviews) == ("copy", "", "")


def test_unknown_mode_is_a_programming_error():
    with pytest.raises(ValueError):
        _decide("sometimes")


def test_naive_timestamps_are_read_as_utc():
    meta = {"fulltext_built_at": "2026-09-02T21:25:00", "fulltext_scored_reviews": "16000000"}
    plan = _decide(prev_meta=meta, scored_now=16_000_000)
    assert plan.mode == "copy"
    assert "built 24.0h ago" in plan.reason


# ------------------------------------------------------------------------------------------
# The env knobs
# ------------------------------------------------------------------------------------------
def test_env_knobs_drive_the_thresholds(monkeypatch):
    prov = _prov(23.5, 16_000_000)
    assert (bm._fulltext_max_age_hours(), bm._fulltext_rebuild_delta()) == (44.0, 500_000)
    # None for a threshold = read the env (what main() does).
    assert bm._decide_fulltext("auto", PREV, prov, 16_041_203, now=NOW).mode == "copy"

    monkeypatch.setenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "20")
    plan = bm._decide_fulltext("auto", PREV, prov, 16_041_203, now=NOW)
    assert (plan.mode, plan.reason) == ("build", "rebuilding (age 23.5h > 20h)")

    monkeypatch.setenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "0")   # 0 = rebuild every night
    assert bm._decide_fulltext("auto", PREV, _prov(0.001, 1), 1, now=NOW).mode == "build"

    monkeypatch.delenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS")
    monkeypatch.setenv("PROSPECT_FULLTEXT_REBUILD_DELTA", "40000")
    plan = bm._decide_fulltext("auto", PREV, prov, 16_041_203, now=NOW)
    assert plan.mode == "build"
    assert "+41,203 scored since" in plan.reason and "> 40,000" in plan.reason

    # A garbled value falls back to the default at the reader (main() refuses it earlier).
    monkeypatch.setenv("PROSPECT_FULLTEXT_REBUILD_DELTA", "half a million")
    assert bm._fulltext_rebuild_delta() == 500_000
    monkeypatch.setenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "two days")
    assert bm._fulltext_max_age_hours() == 44.0


def test_garbled_knobs_are_refused_at_startup(monkeypatch):
    """_env_config_errors is the 10-second check that keeps a typo from crashing a build an
    hour in — and the cadence verdict is evaluated after staging and scoring, exactly there."""
    assert bm._env_config_errors() == []
    monkeypatch.setenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "0")
    monkeypatch.setenv("PROSPECT_FULLTEXT_REBUILD_DELTA", "0")
    assert bm._env_config_errors() == []
    monkeypatch.setenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "inf")   # = never stale by age
    assert bm._env_config_errors() == []

    monkeypatch.setenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "-1")
    monkeypatch.setenv("PROSPECT_FULLTEXT_REBUILD_DELTA", "1.5")
    errors = bm._env_config_errors()
    assert len(errors) == 2, errors
    assert any("PROSPECT_FULLTEXT_MAX_AGE_HOURS" in e for e in errors)
    assert any("PROSPECT_FULLTEXT_REBUILD_DELTA" in e for e in errors)

    monkeypatch.setenv("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "nan")
    monkeypatch.setenv("PROSPECT_FULLTEXT_REBUILD_DELTA", "lots")
    assert len(bm._env_config_errors()) == 2


# ------------------------------------------------------------------------------------------
# The provenance round trip: write_meta -> a real file -> _read_mart_meta -> the next verdict
# ------------------------------------------------------------------------------------------
def _meta_fixture() -> duckdb.DuckDBPyConnection:
    """The minimum staging write_meta() reads (as in test_model_fingerprint_and_probes)."""
    con = duckdb.connect(":memory:")
    con.execute("CREATE TABLE stg_game(appid INTEGER, total_reviews INTEGER, "
                "est_rev_reviews DOUBLE, price_initial DOUBLE)")
    con.execute("INSERT INTO stg_game VALUES (1, 100, 5000.0, 9.99)")
    con.execute("CREATE TABLE stg_genre_boxleiter(genre VARCHAR, slope DOUBLE)")
    con.execute("INSERT INTO stg_genre_boxleiter VALUES ('__all__', 31.5)")
    con.execute("CREATE TABLE _pl_panel(appid INTEGER)")
    con.execute("CREATE TABLE mart_game_players_daily(appid INTEGER, date DATE)")
    return con


def _mart_meta(con: duckdb.DuckDBPyConnection) -> dict[str, str]:
    return dict(con.execute("SELECT key, value FROM mart_meta").fetchall())


def test_write_meta_records_the_plan_and_defaults_to_unknown():
    con = _meta_fixture()
    try:
        plan = _decide(prev_meta=_prov(23.5, 16_000_000), scored_now=16_041_203)
        bm.write_meta(con, "src.db", "20260903", fulltext_mode=plan.mode,
                      fulltext_built_at=plan.built_at, fulltext_scored_reviews=plan.scored_reviews)
        meta = _mart_meta(con)
        assert meta["fulltext_mode"] == "copy"
        assert meta["fulltext_built_at"] == plan.built_at
        assert meta["fulltext_scored_reviews"] == "16000000"
        assert meta["build_mode"] == "full", "copying the full-text marts does not make a build light"

        # A caller that passes nothing gets 'build' with blank provenance: unknown, so the next
        # `auto` rebuilds rather than trusting an age it cannot see.
        bm.write_meta(con, "src.db", "20260903")
        meta = _mart_meta(con)
        assert (meta["fulltext_mode"], meta["fulltext_built_at"],
                meta["fulltext_scored_reviews"]) == ("build", "", "")
        assert bm._decide_fulltext("auto", "prospect_20260903", meta, 1, now=NOW).mode == "build"
    finally:
        con.close()


def _mart_with_provenance(path: Path, plan: bm.FulltextPlan) -> Path:
    return _make_mart(path, {"mart_game": 3}, meta={
        "fulltext_mode": plan.mode, "fulltext_built_at": plan.built_at,
        "fulltext_scored_reviews": plan.scored_reviews,
    })


def test_provenance_round_trips_through_real_mart_files(tmp_path):
    """Night 1 builds; night 2 copies and carries the values forward through its OWN file;
    night 3 reads those and finds the tables two nights old — the every-second-night rhythm."""
    night1 = _decide(prev_name=None, scored_now=16_000_000)
    mart1 = _mart_with_provenance(tmp_path / "prospect_20260901.duckdb", night1)

    night2 = _decide(prev_name=mart1.stem, prev_meta=bm._read_mart_meta(mart1),
                     scored_now=16_041_203, now=NOW + timedelta(hours=24))
    assert night2.mode == "copy"
    assert night2.built_at == night1.built_at
    mart2 = _mart_with_provenance(tmp_path / "prospect_20260902.duckdb", night2)

    night3 = _decide(prev_name=mart2.stem, prev_meta=bm._read_mart_meta(mart2),
                     scored_now=16_080_000, now=NOW + timedelta(hours=48))
    assert (night3.mode, night3.reason) == ("build", "rebuilding (age 48.0h > 44h)")
    assert night3.built_at == (NOW + timedelta(hours=48)).isoformat(timespec="seconds")


def test_read_mart_meta_is_tolerant_of_what_it_cannot_read(tmp_path):
    assert bm._read_mart_meta(tmp_path / "missing.duckdb") == {}
    con = duckdb.connect(str(tmp_path / "nometa.duckdb"))
    con.execute("CREATE TABLE mart_game(appid INTEGER)")
    con.close()
    assert bm._read_mart_meta(tmp_path / "nometa.duckdb") == {}
    ok = _make_mart(tmp_path / "ok.duckdb", {"mart_game": 1}, meta={"a": "1", "b": ""})
    assert bm._read_mart_meta(ok) == {"a": "1", "b": ""}


def test_validation_gate_accepts_row_identical_copied_tables(tmp_path):
    """Copied tables are row-for-row what the published mart has: a 0% change must read as
    healthy, never as 'suspiciously unchanged'."""
    tables = {t: 100 + i for i, t in enumerate(FULLTEXT_TABLES)}
    prev = _make_mart(tmp_path / "prev.duckdb", {"mart_game": 500, **tables})
    new = _make_mart(tmp_path / "new.duckdb", {"mart_game": 510, **tables})
    assert bm.validate_mart(new, prev) == []


# ------------------------------------------------------------------------------------------
# End to end through main(), sentiment cache ON
# ------------------------------------------------------------------------------------------
def _published(data: Path) -> Path:
    return (data / "current.duckdb").resolve()


def _meta(data: Path) -> dict[str, str]:
    return bm._read_mart_meta(_published(data))


def _counts(data: Path) -> dict[str, int]:
    con = duckdb.connect(str(_published(data)), read_only=True)
    try:
        return {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                for t in FULLTEXT_TABLES}
    finally:
        con.close()


def _rewrite_published_provenance(data: Path, **values: str) -> None:
    """Edit the published mart's fulltext_* rows in place: the test's stand-in for nights
    passing (and for a corpus that moved)."""
    con = duckdb.connect(str(_published(data)))
    try:
        for key, value in values.items():
            con.execute("UPDATE mart_meta SET value = ? WHERE key = ?", [value, key])
    finally:
        con.close()


def _fresh_source(tmp_path: Path) -> tuple[Path, list[str]]:
    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    return data, ["--source", str(src), "--data-dir", str(data)]


def _hours_ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")


def test_full_builds_copy_fresh_fulltext_marts_and_rebuild_when_stale(tmp_path, monkeypatch,
                                                                       capsys):
    data, argv = _fresh_source(tmp_path)

    # Night 1: nothing published -> build, stamped with the real scored count.
    assert _run(argv) == 0
    out = capsys.readouterr().out
    assert "[etl] full-text marts: rebuilding (no published mart to copy from)" in out
    assert "ran mart_game_aspect_reviews.sql" in out
    first = _meta(data)
    assert (first["build_mode"], first["fulltext_mode"]) == ("full", "build")
    datetime.fromisoformat(first["fulltext_built_at"])
    assert first["fulltext_scored_reviews"] == "1200", "40 games x 30 reviews, all eligible"
    counts = _counts(data)
    assert all(n > 0 for n in counts.values()), counts

    # Night 2: 0h old, +0 scored -> copy. Provenance carried forward, the gate passes, swapped.
    assert _run(argv) == 0
    out = capsys.readouterr().out
    assert re.search(r"\[etl\] full-text marts: copied from prospect_\d{8} \(built 0\.0h ago, "
                     r"\+0 scored since; thresholds 44h / 500,000\)", out), out
    assert "copied mart_game_teardown.sql" in out
    assert "copied mart_game_aspect_reviews.sql" in out
    assert "ran mart_game_teardown.sql" not in out
    assert "ran mart_game_aspect_reviews.sql" not in out
    assert "[etl] swapped" in out
    second = _meta(data)
    assert second["build_mode"] == "full", "a full build with copied tables is still FULL"
    assert second["fulltext_mode"] == "copy"
    assert second["fulltext_built_at"] == first["fulltext_built_at"]
    assert second["fulltext_scored_reviews"] == first["fulltext_scored_reviews"]
    assert _counts(data) == counts

    # Night 3: the published provenance is 50h old -> rebuild, re-stamped.
    aged = _hours_ago(50)
    _rewrite_published_provenance(data, fulltext_built_at=aged)
    assert _run(argv) == 0
    out = capsys.readouterr().out
    assert "[etl] full-text marts: rebuilding (age 50.0h > 44h)" in out
    assert "ran mart_game_aspect_reviews.sql" in out
    third = _meta(data)
    assert third["fulltext_mode"] == "build"
    assert third["fulltext_built_at"] > aged

    # Night 4: fresh, but the corpus moved past the (lowered) delta -> rebuild.
    _rewrite_published_provenance(data, fulltext_scored_reviews="0")
    monkeypatch.setenv("PROSPECT_FULLTEXT_REBUILD_DELTA", "1000")
    assert _run(argv) == 0
    out = capsys.readouterr().out
    assert re.search(r"rebuilding \(\+1,200 scored since prospect_\d{8}'s full-text build "
                     r"0\.0h ago > 1,000\)", out), out
    assert _meta(data)["fulltext_scored_reviews"] == "1200"


def test_explicit_fulltext_modes_override_the_verdict(tmp_path, capsys):
    data, argv = _fresh_source(tmp_path)
    assert _run(argv) == 0
    first = _meta(data)
    capsys.readouterr()

    # Fresh, yet --fulltext build rebuilds (and re-stamps).
    assert _run(argv + ["--fulltext", "build"]) == 0
    out = capsys.readouterr().out
    assert "[etl] full-text marts: rebuilding (--fulltext build)" in out
    assert "ran mart_game_aspect_reviews.sql" in out
    rebuilt = _meta(data)
    assert rebuilt["fulltext_mode"] == "build"
    assert rebuilt["fulltext_built_at"] >= first["fulltext_built_at"]

    # 50h old, yet --fulltext copy copies (and carries the old stamp).
    aged = _hours_ago(50)
    _rewrite_published_provenance(data, fulltext_built_at=aged)
    assert _run(argv + ["--fulltext", "copy"]) == 0
    out = capsys.readouterr().out
    assert re.search(r"\[etl\] full-text marts: copied from prospect_\d{8} \(--fulltext copy\)",
                     out), out
    assert "copied mart_game_aspect_reviews.sql" in out
    copied = _meta(data)
    assert (copied["build_mode"], copied["fulltext_mode"],
            copied["fulltext_built_at"]) == ("full", "copy", aged)


def test_light_build_carries_the_provenance_forward_too(tmp_path, capsys):
    """The 13:30 --light build publishes a mart every day; if IT dropped the keys, every
    nightly would find no provenance and rebuild — the cadence would never engage."""
    data, argv = _fresh_source(tmp_path)
    assert _run(argv) == 0
    first = _meta(data)
    # --light refuses to replace a same-day FULL build, so rename it away (as the smoke
    # tests do) and point current.duckdb at the renamed file.
    _published(data).rename(data / "prospect_20000101.duckdb")
    (data / "current.duckdb").unlink()
    (data / "current.duckdb").symlink_to("prospect_20000101.duckdb")
    capsys.readouterr()

    assert _run(argv + ["--light"]) == 0
    out = capsys.readouterr().out
    assert "[etl] LIGHT build: heavy tables copied from prospect_20000101.duckdb" in out
    assert "full-text marts:" not in out, "--light's own line already says it copied"
    light = _meta(data)
    assert (light["build_mode"], light["fulltext_mode"]) == ("light", "copy")
    assert light["fulltext_built_at"] == first["fulltext_built_at"]
    assert light["fulltext_scored_reviews"] == first["fulltext_scored_reviews"]

    # ...and the next full build reads the light mart's carried provenance and still copies.
    assert _run(argv) == 0
    out = capsys.readouterr().out
    assert re.search(r"full-text marts: copied from prospect_\d{8} \(built 0\.0h ago", out), out
    assert _meta(data)["fulltext_built_at"] == first["fulltext_built_at"]


def test_flag_conflicts_are_refused_before_any_work(tmp_path):
    data, argv = _fresh_source(tmp_path)
    assert _run(argv + ["--light", "--fulltext", "build"]) == 2
    assert _run(argv + ["--rescore-only", "--fulltext", "copy"]) == 2
    assert _run(argv + ["--rescore-only", "--fulltext", "build"]) == 2
    assert _run(argv + ["--fulltext", "copy"]) == 2, "nothing published to copy from"
    assert sorted(p.name for p in data.iterdir()) == [], "a refusal must not touch the data dir"
    with pytest.raises(SystemExit):
        _run(argv + ["--fulltext", "sometimes"])
