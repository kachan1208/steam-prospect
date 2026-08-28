"""Model fingerprint stability, the fatal-missing-classifier rule, and honest source probes.

Three defects pinned down here:

1. _aspect_model_fingerprint() returned "size:mtime". The 6MB model ships by scp/git
   checkout, and both rewrite mtime freely — re-copying the IDENTICAL file changed the
   fingerprint, which changed the sentiment config hash, which WIPED the 16M-row sentiment
   cache and forced a multi-hour rescore for no reason. It now hashes file CONTENT.

2. _get_classifier() returned None with a printed warning when the model was missing, and
   the pipeline degraded silently: the 'NONE' aspect class stopped being dropped and aspect
   counts inflated ~28%, shipping as if real. It is now fatal unless explicitly overridden.

3. _sqlite_table_exists() was `except duckdb.Error: return False`, so a broken ATTACH was
   indistinguishable from an absent table and whole mart families went empty with exit 0.
   Presence is now a lookup against the enumerated source catalog, and a source that
   exposes nothing at all hard-fails.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402


# ------------------------------------------------------------------------------------
# 1. Content-hash fingerprint
# ------------------------------------------------------------------------------------
def test_fingerprint_ignores_mtime_only_changes(tmp_path):
    """THE bug: a re-copy of the same bytes (new mtime, same content) must NOT invalidate
    the sentiment cache."""
    model = tmp_path / "aspect_model.json.gz"
    model.write_bytes(b"pretend model bytes")

    before = bm._aspect_model_fingerprint(str(model))

    # Exactly what `scp` (without -p) or a git checkout does: same bytes, later mtime.
    future = time.time() + 10_000
    os.utime(model, (future, future))

    assert bm._aspect_model_fingerprint(str(model)) == before, (
        "an mtime-only change must not change the fingerprint (this is what wiped the "
        "16M-row cache and triggered multi-hour rescores)"
    )


def test_fingerprint_changes_when_content_changes(tmp_path):
    """The property the fingerprint exists for: a genuinely different model must invalidate
    the cache, or old clf_* verdicts would be served for a new model."""
    model = tmp_path / "aspect_model.json.gz"
    model.write_bytes(b"model version one")
    before = bm._aspect_model_fingerprint(str(model))

    model.write_bytes(b"model version two")
    assert bm._aspect_model_fingerprint(str(model)) != before


def test_fingerprint_is_same_size_content_sensitive(tmp_path):
    """A size:mtime fingerprint could not see an in-place edit that kept the byte count.
    A content hash can."""
    model = tmp_path / "aspect_model.json.gz"
    model.write_bytes(b"AAAA")
    a = bm._aspect_model_fingerprint(str(model))
    model.write_bytes(b"BBBB")  # same size, different bytes
    assert bm._aspect_model_fingerprint(str(model)) != a


def test_fingerprint_reports_absent_model(tmp_path):
    assert bm._aspect_model_fingerprint(str(tmp_path / "nope.json.gz")) == "absent"


def test_config_hash_folds_in_the_model_and_is_stable():
    once = bm._sentiment_config_hash()
    assert once == bm._sentiment_config_hash(), "the config hash must be deterministic"
    assert len(once) == 64, "sha256 hexdigest"


# ------------------------------------------------------------------------------------
# 2. Missing classifier is fatal by default
# ------------------------------------------------------------------------------------
@pytest.fixture
def clean_classifier_state(monkeypatch):
    """_get_classifier caches in module globals; reset around each test."""
    monkeypatch.setattr(bm, "_CLF", None)
    monkeypatch.setattr(bm, "_CLF_ABSENT", False)
    yield
    bm._CLF = None
    bm._CLF_ABSENT = False


def test_missing_model_is_fatal_by_default(monkeypatch, clean_classifier_state):
    monkeypatch.delenv("PROSPECT_ALLOW_NO_CLASSIFIER", raising=False)
    monkeypatch.setattr(bm.aspect_classifier, "load_default", lambda _d: None)

    with pytest.raises(RuntimeError) as e:
        bm._get_classifier()
    msg = str(e.value)
    assert "not found" in msg
    assert "PROSPECT_ALLOW_NO_CLASSIFIER" in msg, "the error must name its own escape hatch"


def test_unloadable_model_is_also_fatal(monkeypatch, clean_classifier_state):
    """A corrupt/truncated model must fail like a missing one, not crash mid-build hours in."""
    monkeypatch.delenv("PROSPECT_ALLOW_NO_CLASSIFIER", raising=False)

    def boom(_d):
        raise ValueError("truncated gzip stream")

    monkeypatch.setattr(bm.aspect_classifier, "load_default", boom)
    with pytest.raises(RuntimeError, match="unloadable"):
        bm._get_classifier()


def test_degraded_mode_is_opt_in_and_recorded(monkeypatch, clean_classifier_state):
    monkeypatch.setenv("PROSPECT_ALLOW_NO_CLASSIFIER", "1")
    monkeypatch.setattr(bm.aspect_classifier, "load_default", lambda _d: None)

    assert bm._get_classifier() is None, "degraded mode still returns None to callers"
    assert bm._CLF_ABSENT is True, "the degraded build must be flagged for mart_meta"


def test_degraded_flag_reaches_mart_meta(tmp_path):
    """The provenance row is the only way to tell, after the fact, that a shipped mart's
    aspect counts are keyword-only (inflated ~28%)."""
    con = _meta_fixture()
    try:
        bm.write_meta(con, "src.db", "20260828", build_mode="full", classifier_absent=True)
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        assert meta["sentiment_classifier"] == "absent"

        # ...and is absent entirely on a healthy build (no misleading 'present' row to read).
        bm.write_meta(con, "src.db", "20260828", build_mode="full", classifier_absent=False)
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        assert "sentiment_classifier" not in meta
    finally:
        con.close()


# ------------------------------------------------------------------------------------
# 3. Honest source probes + absent_sources provenance
# ------------------------------------------------------------------------------------
def _src_con(tables: dict[str, str]) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute("CREATE SCHEMA src")
    for name, cols in tables.items():
        con.execute(f"CREATE TABLE src.{name}({cols})")
    return con


def test_probe_finds_present_tables_and_misses_absent_ones():
    con = _src_con({"games": "appid INTEGER", "player_counts": "appid INTEGER"})
    try:
        assert bm._sqlite_table_exists(con, "player_counts") is True
        assert bm._sqlite_table_exists(con, "review_histogram") is False
    finally:
        con.close()


def test_verify_source_attach_hard_fails_on_an_empty_catalog():
    """The defect: a broken ATTACH used to look exactly like 'every optional table is
    absent', and the build shipped empty mart families with exit 0."""
    con = duckdb.connect(":memory:")
    try:
        with pytest.raises(RuntimeError, match="no tables at all"):
            bm._verify_source_attach(con)
    finally:
        con.close()


def test_verify_source_attach_returns_the_table_listing():
    con = _src_con({"games": "appid INTEGER", "reviews": "appid INTEGER"})
    try:
        assert bm._verify_source_attach(con) == {"games", "reviews"}
    finally:
        con.close()


def test_guarded_staging_builds_empty_typed_tables_when_absent():
    """Absence must still produce correctly-typed staging, so the mart SQL runs unchanged."""
    con = _src_con({"games": "appid INTEGER"})
    try:
        src_tables = bm._verify_source_attach(con)
        assert bm.create_ccu_staging(con, src_tables) is False
        assert bm.create_timing_staging(con, src_tables) is False
        assert bm.create_socials_staging(con, src_tables) is False
        for t in ("stg_player_count_latest", "stg_player_counts_daily",
                  "stg_player_history_external", "stg_review_histogram", "stg_game_socials"):
            assert con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0
    finally:
        con.close()


def test_guarded_staging_uses_real_rows_when_present():
    con = _src_con({
        "games": "appid INTEGER",
        "review_histogram": "appid INTEGER, period VARCHAR, recommendations_up INTEGER, "
                            "recommendations_down INTEGER",
    })
    try:
        con.execute("INSERT INTO src.review_histogram VALUES (7, '2026-01', 5, 3)")
        src_tables = bm._verify_source_attach(con)
        assert bm.create_timing_staging(con, src_tables) is True
        appid, n = con.execute(
            "SELECT appid, n_reviews FROM stg_review_histogram"
        ).fetchone()
        assert (appid, n) == (7, 8), "n_reviews must be up+down"
    finally:
        con.close()


def _meta_fixture() -> duckdb.DuckDBPyConnection:
    """The minimum staging write_meta() reads, so its provenance rows can be asserted."""
    con = duckdb.connect(":memory:")
    con.execute(
        "CREATE TABLE stg_game(appid INTEGER, total_reviews INTEGER, est_rev_reviews DOUBLE,"
        " price_initial DOUBLE)"
    )
    con.execute("INSERT INTO stg_game VALUES (1, 100, 5000.0, 9.99)")
    con.execute("CREATE TABLE stg_genre_boxleiter(genre VARCHAR, slope DOUBLE)")
    con.execute("INSERT INTO stg_genre_boxleiter VALUES ('__all__', 31.5)")
    con.execute("CREATE TABLE _pl_panel(appid INTEGER)")
    con.execute("CREATE TABLE mart_game_players_daily(appid INTEGER, date DATE)")
    return con


def test_absent_sources_are_recorded_in_mart_meta():
    """The queryable record of which mart families were built empty on purpose."""
    con = _meta_fixture()
    try:
        bm.write_meta(con, "src.db", "20260828",
                      absent_sources=["game_socials", "review_histogram"])
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        assert meta["absent_sources"] == "game_socials,review_histogram"
    finally:
        con.close()


def test_absent_sources_is_empty_when_every_source_is_present():
    con = _meta_fixture()
    try:
        bm.write_meta(con, "src.db", "20260828", absent_sources=[])
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        assert meta["absent_sources"] == ""
    finally:
        con.close()


def test_build_mode_is_recorded(tmp_path):
    for mode in ("full", "light"):
        con = _meta_fixture()
        try:
            bm.write_meta(con, "src.db", "20260828", build_mode=mode)
            meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
            assert meta["build_mode"] == mode
        finally:
            con.close()


def test_write_meta_defaults_to_full_build_mode():
    """A caller that forgets the argument must not silently produce an unmarked mart."""
    con = _meta_fixture()
    try:
        bm.write_meta(con, "src.db", "20260828")
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        assert meta["build_mode"] == "full"
    finally:
        con.close()
