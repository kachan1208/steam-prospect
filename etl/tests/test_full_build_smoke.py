"""End-to-end build_marts.main() over a tiny synthetic SQLite source.

The other tests render ONE mart file over hand-built staging. This one runs the whole
pipeline — real ATTACH of a real sqlite file, create_staging, the sentiment scorers, all 21
files in MART_FILES on one shared connection, write_meta, the validation gate, the swap and
the scratch sweep — because several invariants only exist ACROSS files and nothing else
would catch them breaking:

  - the shared stg_press_base (build_marts.create_staging) must satisfy all four of its
    consumers: mart_game_teardown._press_base, mart_press._press_journalist,
    mart_niche_press._niche_press_last and mart_channel_mix._mix_press;
  - the end-of-file `DROP TABLE` hygiene must not drop a temp another file still needs —
    the cross-file handoffs are _game_players_summary/_game_lifetime (mart_players ->
    mart_game), _niche_players_now/_niche_lifetime (mart_players -> mart_niche), _niche_pop
    (mart_niche -> mart_niche_game), _pl_panel (mart_players -> write_meta) and
    stg_press_base itself (staging -> the last mart file);
  - every mart file must survive a source DB WITHOUT the optional tables (player_counts,
    review_histogram, game_socials, player_history_external) — a real crash shipped in
    mart_game_trends.sql for exactly this reason.

Deliberately tiny (40 games) so it runs in seconds; it asserts structure and wiring, never
statistical output.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

N_GAMES = 40


def build_source(path: Path) -> None:
    """A minimal source DB carrying only the REQUIRED tables — every optional/guarded table
    (player_counts, player_history_external, review_histogram, game_socials) is deliberately
    missing, which is also the absent_sources fixture."""
    c = sqlite3.connect(str(path))
    c.executescript(
        """
        CREATE TABLE games(appid INTEGER, name TEXT, type TEXT, release_date TEXT,
            price_initial INTEGER, is_free INTEGER, developers TEXT, publishers TEXT,
            metacritic_score INTEGER, achievements_count INTEGER, categories TEXT,
            header_image TEXT, short_description TEXT, first_seen TEXT,
            metacritic_url TEXT, demo_appid INTEGER, demos_checked_at TEXT);
        CREATE TABLE analysis_games(appid INTEGER, name TEXT, release_year INTEGER,
            release_date_iso TEXT, price_initial REAL, is_free INTEGER, developers TEXT,
            publishers TEXT, self_published INTEGER, dev_game_count INTEGER,
            is_indie INTEGER, metacritic_score INTEGER, achievements_count INTEGER,
            owners_mid REAL, est_rev_owners REAL, avg_playtime_forever REAL,
            ccu INTEGER, tag_count INTEGER, total_reviews INTEGER,
            positive_reviews INTEGER, negative_reviews INTEGER, positive_ratio REAL);
        CREATE TABLE game_genres(appid INTEGER, genre TEXT);
        CREATE TABLE game_tags(appid INTEGER, tag TEXT, votes INTEGER);
        CREATE TABLE reviews(appid INTEGER, recommendationid TEXT, voted_up INTEGER,
            timestamp_created INTEGER, language TEXT, playtime_at_review INTEGER,
            playtime_forever INTEGER, review_text TEXT, author_steamid TEXT,
            votes_up INTEGER);
        CREATE TABLE review_summary(appid INTEGER, total_reviews INTEGER,
            total_positive INTEGER, total_negative INTEGER);
        CREATE TABLE articles(id INTEGER, source TEXT, author TEXT, title TEXT,
            url TEXT, summary TEXT, published_at TEXT, appid INTEGER, channel TEXT);
        CREATE TABLE article_game_mentions(article_id INTEGER, appid INTEGER,
            match_confidence REAL);
        """
    )
    now = int(time.time())
    for appid in range(1, N_GAMES + 1):
        c.execute("INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (appid, f"Game {appid}", "game", "Jul 30, 2024", 999, 0,
                   "Dev, Inc.", "Pub", 80, 10, "Single-player",
                   f"http://img/{appid}.jpg", "A fixture game.", "2024-08-01",
                   None, None, None))
        c.execute("INSERT INTO analysis_games VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (appid, f"Game {appid}", 2024, "2024-07-30", 9.99, 0, "Dev, Inc.", "Pub",
                   1, 1, 1, 80, 10, 50000.0, 499500.0, 120.0, 25, 3, 200, 150, 50, 0.75))
        c.execute("INSERT INTO game_genres VALUES (?, 'Action')", (appid,))
        c.execute("INSERT INTO game_genres VALUES (?, 'Indie')", (appid,))
        c.execute("INSERT INTO game_tags VALUES (?, 'Roguelike', 50)", (appid,))
        c.execute("INSERT INTO game_tags VALUES (?, 'Pixel Graphics', 30)", (appid,))
        c.execute("INSERT INTO review_summary VALUES (?, 200, 150, 50)", (appid,))
        for i in range(30):
            c.execute("INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (appid, f"r{appid}_{i}", 1 if i % 3 else 0,
                       now - 86400 * (i * 9 + 3), "english", 100, 200,
                       "The combat is great but the map is confusing sometimes.",
                       f"steam{appid}{i}", 5))
        c.execute("INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?)",
                  (appid, "ign", "Jane Writer", f"Game {appid} roguelike review",
                   f"http://ign/{appid}", "A fine roguelike.", "2025-06-01 10:00:00",
                   appid, "press"))
        c.execute("INSERT INTO article_game_mentions VALUES (?, ?, 0.9)", (appid, appid))
    c.commit()
    c.close()


def add_optional_tables(path: Path) -> None:
    """Add the guarded/optional source tables the base fixture leaves out, so a build can be
    made to LOSE them again (the absent-source exemption case)."""
    c = sqlite3.connect(str(path))
    c.executescript(
        """
        CREATE TABLE player_counts(appid INTEGER, player_count INTEGER, captured_at TEXT);
        CREATE TABLE review_histogram(appid INTEGER, period TEXT,
            recommendations_up INTEGER, recommendations_down INTEGER);
        """
    )
    today = date.today()
    for appid in range(1, N_GAMES + 1):
        for back in range(14):
            day = today - timedelta(days=back)
            c.execute("INSERT INTO player_counts VALUES (?,?,?)",
                      (appid, 100 + appid + back, f"{day.isoformat()} 21:30:00"))
        for year in (2024, 2025):
            for month in range(1, 13):
                c.execute("INSERT INTO review_histogram VALUES (?,?,?,?)",
                          (appid, f"{year}-{month:02d}", 10, 3))
    c.commit()
    c.close()


def _run(argv: list[str]) -> int:
    sys.argv = ["build_marts.py"] + argv
    return bm.main()


def _build_into(tmp_path: Path) -> tuple[Path, Path]:
    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    rc = _run(["--source", str(src), "--data-dir", str(data)])
    assert rc == 0, f"the smoke build must succeed, got rc={rc}"
    return src, data


@pytest.fixture(autouse=True)
def hermetic_env(monkeypatch):
    """Every build in this module runs with the absolute row floors off (the fixture is 40
    games; the floors exist for the real ~174K catalog and are tested separately), no
    cross-run sentiment cache, and no ambient env leaking in."""
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "off")
    monkeypatch.delenv("PROSPECT_VALIDATE_MAX_DROP_PCT", raising=False)
    monkeypatch.delenv("PROSPECT_ALLOW_NO_CLASSIFIER", raising=False)


@pytest.fixture(scope="module")
def published(tmp_path_factory):
    """ONE completed build, shared by every read-only assertion below (a build is ~2s, and
    re-running it per test bought nothing). Tests that mutate the source or the data dir take
    the function-scoped `built` fixture instead."""
    # scope='module' cannot use the function-scoped monkeypatch, so set the same knobs by hand.
    saved_floors, saved_cache = bm.VALIDATE_MIN_ROWS, os.environ.get("PROSPECT_SENTIMENT_CACHE")
    bm.VALIDATE_MIN_ROWS = {}
    os.environ["PROSPECT_SENTIMENT_CACHE"] = "off"
    try:
        yield _build_into(tmp_path_factory.mktemp("published"))
    finally:
        bm.VALIDATE_MIN_ROWS = saved_floors
        if saved_cache is None:
            os.environ.pop("PROSPECT_SENTIMENT_CACHE", None)
        else:
            os.environ["PROSPECT_SENTIMENT_CACHE"] = saved_cache


@pytest.fixture
def built(tmp_path):
    """A private, freshly-built mart for tests that mutate the source or the data dir."""
    return _build_into(tmp_path)


def _open_current(data: Path) -> duckdb.DuckDBPyConnection:
    return duckdb.connect(str(data / "current.duckdb"), read_only=True)


def test_full_build_runs_every_mart_file_and_swaps(published):
    """The headline: all 21 files in MART_FILES execute on one connection and publish."""
    _src, data = published
    current = data / "current.duckdb"
    assert current.is_symlink(), "current.duckdb must be a symlink to the versioned file"

    con = _open_current(data)
    try:
        tables = {r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'mart%'"
        ).fetchall()}
    finally:
        con.close()
    # A representative table from each mart family, so a whole family going missing fails here.
    for expected in ("mart_game", "mart_niche", "mart_entity", "mart_market_pct",
                     "mart_game_trends", "mart_game_event", "mart_lang",
                     "mart_game_review_aspects", "mart_press_author", "mart_buzz_trends",
                     "mart_channel_mix", "mart_channel_buzz", "mart_tag_lift",
                     "mart_niche_themes", "mart_niche_press", "mart_meta"):
        assert expected in tables, f"{expected} missing from the built mart"


def test_shared_press_base_feeds_all_four_consumers(published):
    """stg_press_base replaced four separate re-derivations of the journalist-article join.
    Every consumer must still produce rows from the same fixture articles."""
    _src, data = published
    con = _open_current(data)
    try:
        for tbl in ("mart_game_press_summary",     # mart_game_teardown._press_base
                    "mart_press_author",           # mart_press._press_journalist
                    "mart_niche_press_outlets",    # mart_niche_press._niche_press_last
                    "mart_channel_mix"):           # mart_channel_mix._mix_press
            n = con.execute(f'SELECT COUNT(*) FROM "{tbl}"').fetchone()[0]
            assert n > 0, f"{tbl} is empty — its stg_press_base consumer is broken"

        # last_article_at comes from the shared base's pre-TRY_CAST published_at; a NULL
        # everywhere would mean the date lookup silently stopped matching.
        dated = con.execute(
            "SELECT COUNT(*) FROM mart_niche_press_outlets WHERE last_article_at IS NOT NULL"
        ).fetchone()[0]
        assert dated > 0, "stg_press_base.published_at is not reaching mart_niche_press_outlets"
    finally:
        con.close()


def test_cross_file_temp_handoffs_survive_the_drop_statements(published):
    """The temp-hygiene risk: dropping a temp that a LATER mart file still reads. Each
    handoff is asserted through an output column that could only be populated by it."""
    _src, data = published
    con = _open_current(data)
    try:
        # _game_players_summary / _game_lifetime -> mart_game (columns exist = the joins bound)
        game_cols = {r[1] for r in con.execute("PRAGMA table_info('mart_game')").fetchall()}
        assert "live_players" in game_cols or "players_now" in game_cols, sorted(game_cols)

        # _niche_pop -> mart_niche_game (its whole population comes from that handoff)
        assert con.execute("SELECT COUNT(*) FROM mart_niche_game").fetchone()[0] > 0

        # _pl_panel -> write_meta, AFTER every mart file has run and dropped its temps
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        assert "ccu_panel_games" in meta, "write_meta could not read _pl_panel"
    finally:
        con.close()


def test_no_scratch_or_temp_tables_leak(published):
    """Scratch is owned by the tool, and no `_`-prefixed working table may ship in the mart."""
    _src, data = published
    assert not list(data.glob("*.building")), "a .building file survived a successful build"
    assert not list(data.glob("*.building.wal")), "a .building.wal survived"
    assert not list(data.glob("*.building.tmp")), "a .building.tmp spill dir survived"

    con = _open_current(data)
    try:
        leaked = con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_name LIKE '\\_%' ESCAPE '\\'"
        ).fetchall()
    finally:
        con.close()
    assert leaked == [], f"working tables shipped in the mart: {leaked}"


def test_build_provenance_records_mode_and_absent_sources(published):
    """The fixture source deliberately lacks every optional table, so absent_sources must
    name all four — this is the queryable record of which marts were built empty on purpose."""
    _src, data = published
    con = _open_current(data)
    try:
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
    finally:
        con.close()
    assert meta["build_mode"] == "full"
    assert set(meta["absent_sources"].split(",")) == set(bm.GUARDED_SOURCE_TABLES)
    assert "sentiment_classifier" not in meta, "the real model is present; no degraded marker"


def test_marts_build_without_the_optional_source_tables(published):
    """The guarded families must be EMPTY, not missing, and must not have crashed the build
    (mart_game_trends.sql used to read src.review_histogram/src.player_counts directly)."""
    _src, data = published
    con = _open_current(data)
    try:
        for tbl in ("mart_timing_demand", "mart_niche_players", "mart_game_players_daily"):
            n = con.execute(f'SELECT COUNT(*) FROM "{tbl}"').fetchone()[0]
            assert n == 0, f"{tbl} should be empty without its optional source table"
        # ...while mart_game_trends still builds from the reviews-sample fallback.
        assert con.execute("SELECT COUNT(*) FROM mart_game_trends").fetchone()[0] > 0, (
            "mart_game_trends must fall back to the reviews sample when review_histogram "
            "is absent, not come out empty"
        )
    finally:
        con.close()


def test_second_build_passes_the_validation_gate(built, monkeypatch):
    """A rerun over the same source produces the same counts — the gate must let it through
    (a gate that fails on a healthy rebuild would be worse than no gate)."""
    src, data = built
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    assert _run(["--source", str(src), "--data-dir", str(data)]) == 0


def _gut_source(src: Path) -> None:
    c = sqlite3.connect(str(src))
    c.execute(f"DELETE FROM games WHERE appid > {N_GAMES // 10}")   # -90% of the catalog
    c.execute(f"DELETE FROM analysis_games WHERE appid > {N_GAMES // 10}")
    c.commit()
    c.close()


def test_validation_gate_blocks_the_swap_on_a_gutted_source(built, monkeypatch):
    """The real defect, end to end: a source that lost most of its data must NOT reach
    current.duckdb."""
    src, data = built
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    before = (data / "current.duckdb").resolve().read_bytes()

    _gut_source(src)

    rc = _run(["--source", str(src), "--data-dir", str(data)])
    assert rc == 1, "a 90% catalog loss must fail the build"
    assert (data / "current.duckdb").resolve().read_bytes() == before, (
        "current.duckdb was modified despite the validation failure"
    )


def test_validation_failure_keeps_the_finished_build_but_not_its_spill(built, monkeypatch,
                                                                      capsys):
    """A validation failure is the one exit where the BUILD succeeded — deleting the
    finished file made the printed '--skip-validation' remedy cost a fresh 3-6 hour build
    and left nothing to inspect. The artifact survives; the 18GB spill dir does not."""
    src, data = built
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    _gut_source(src)

    assert _run(["--source", str(src), "--data-dir", str(data)]) == 1
    kept = list(data.glob("*.duckdb.building"))
    assert len(kept) == 1, f"the finished build must be preserved, found {kept}"
    assert not list(data.glob("*.building.tmp")), "the spill dir must still be swept"

    # It is a real, openable mart — the point of keeping it is that it can be inspected...
    con = duckdb.connect(str(kept[0]), read_only=True)
    try:
        assert con.execute("SELECT COUNT(*) FROM mart_game").fetchone()[0] == N_GAMES // 10
    finally:
        con.close()

    # ...and the remedy has to name it, and the previous mart it did NOT replace.
    err = capsys.readouterr().err
    assert kept[0].name in err and "KEPT" in err
    assert "REBUILDS from scratch" in err, "the remedy must be honest about what a rerun costs"


def test_a_genuine_build_failure_still_sweeps_everything(built, monkeypatch):
    """The preservation is scoped to validation ONLY: a build that dies mid-flight still
    owns its scratch (disk is the droplet's scarcest resource; the log has the diagnostics)."""
    src, data = built
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})

    boom = RuntimeError("mart SQL blew up")

    def explode(*_a, **_k):
        raise boom

    monkeypatch.setattr(bm, "write_meta", explode)
    with pytest.raises(RuntimeError):
        _run(["--source", str(src), "--data-dir", str(data)])
    assert not list(data.glob("*.building")), "a crashed build must sweep its own scratch"
    assert not list(data.glob("*.building.tmp"))


def test_losing_an_optional_source_passes_the_gate_with_exemptions(tmp_path, monkeypatch,
                                                                   capsys):
    """End to end: build once WITH player_counts/review_histogram, then take them away. The
    player/timing marts go empty exactly as documented — and the gate must let that through
    (exemptions printed), not kill the nightly."""
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    add_optional_tables(src)
    assert _run(["--source", str(src), "--data-dir", str(data)]) == 0

    con = _open_current(data)
    try:
        assert con.execute("SELECT COUNT(*) FROM mart_game_players_daily").fetchone()[0] > 0
        assert con.execute("SELECT COUNT(*) FROM mart_timing_demand").fetchone()[0] > 0
    finally:
        con.close()

    c = sqlite3.connect(str(src))
    c.execute("DROP TABLE player_counts")
    c.execute("DROP TABLE review_histogram")
    c.commit()
    c.close()

    capsys.readouterr()
    assert _run(["--source", str(src), "--data-dir", str(data)]) == 0, (
        "a legitimately-absent OPTIONAL source must not fail the build"
    )
    out = capsys.readouterr().out
    assert "EXEMPT" in out and "player_counts" in out and "review_histogram" in out

    con = _open_current(data)
    try:
        # The swap happened and the guarded families are empty, as documented.
        for tbl in ("mart_game_players_daily", "mart_niche_players", "mart_timing_demand"):
            assert con.execute(f'SELECT COUNT(*) FROM "{tbl}"').fetchone()[0] == 0
        meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        assert "player_counts" in meta["absent_sources"]
    finally:
        con.close()


def test_skip_validation_lets_the_same_gutted_build_through(built, monkeypatch):
    """The escape hatch has to actually work, or an operator facing a deliberate large
    shrink has no way to ship."""
    src, data = built
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})

    c = sqlite3.connect(str(src))
    c.execute(f"DELETE FROM games WHERE appid > {N_GAMES // 10}")
    c.execute(f"DELETE FROM analysis_games WHERE appid > {N_GAMES // 10}")
    c.commit()
    c.close()

    assert _run(["--source", str(src), "--data-dir", str(data), "--skip-validation"]) == 0
    con = _open_current(data)
    try:
        assert con.execute("SELECT COUNT(*) FROM mart_game").fetchone()[0] == N_GAMES // 10
    finally:
        con.close()


def _seed_sentiment_cache(data: Path) -> Path:
    """A populated cross-run sentiment cache, keyed to the CURRENT config hash — i.e. the
    16M-row cache the droplet actually carries, in miniature."""
    cache = data / bm.SENTIMENT_CACHE_DB_NAME
    for p in (cache, Path(str(cache) + ".wal")):
        p.unlink(missing_ok=True)
    con = duckdb.connect(str(cache))
    try:
        con.execute("CREATE TABLE aspect_mention(recommendationid VARCHAR, aspect VARCHAR, "
                    "compound DOUBLE, clf_aspect VARCHAR, clf_sentiment VARCHAR, "
                    "clf_margin DOUBLE)")
        con.execute("INSERT INTO aspect_mention VALUES ('r1','combat',0.5,'combat','praise',2.0)")
        con.execute("CREATE TABLE press_article(article_id BIGINT, compound DOUBLE)")
        con.execute("INSERT INTO press_article VALUES (1, 0.25)")
        con.execute("CREATE TABLE scored_review(recommendationid VARCHAR)")
        con.execute("INSERT INTO scored_review VALUES ('r1')")
        con.execute("CREATE TABLE meta(key VARCHAR, value VARCHAR)")
        con.execute("INSERT INTO meta VALUES ('config_hash', ?)", [bm._sentiment_config_hash()])
    finally:
        con.close()
    return cache


def _cache_state(cache: Path) -> tuple[int, int, int, str]:
    con = duckdb.connect(str(cache), read_only=True)
    try:
        return (
            con.execute("SELECT COUNT(*) FROM aspect_mention").fetchone()[0],
            con.execute("SELECT COUNT(*) FROM press_article").fetchone()[0],
            con.execute("SELECT COUNT(*) FROM scored_review").fetchone()[0],
            con.execute("SELECT value FROM meta WHERE key='config_hash'").fetchone()[0],
        )
    finally:
        con.close()


def test_a_missing_model_aborts_before_the_sentiment_cache_is_touched(tmp_path, monkeypatch):
    """The fatal-missing-classifier check used to be LAZY: by the time it fired,
    create_staging had run and _refresh_sentiment_cache had already wiped the 16M-row cache
    (a missing model changes the config hash, and that change IS the wipe) — so a clean
    abort became a multi-hour rescore on the next run."""
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    monkeypatch.delenv("PROSPECT_ALLOW_NO_CLASSIFIER", raising=False)
    monkeypatch.setattr(bm, "_CLF", None)
    monkeypatch.setattr(bm, "_CLF_ABSENT", False)

    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    cache = _seed_sentiment_cache(data)
    before = _cache_state(cache)

    monkeypatch.setattr(bm.aspect_classifier, "load_default", lambda _d: None)
    assert _run(["--source", str(src), "--data-dir", str(data)]) == 2, (
        "a missing aspect model must abort the build"
    )

    assert _cache_state(cache) == before, (
        "the cache was mutated before the fatal check fired — that is the multi-hour "
        "rescore this abort exists to prevent"
    )
    assert not list(data.glob("*.building*")), (
        "the abort must happen before any scratch is written"
    )


def test_a_light_build_with_no_model_also_aborts_instead_of_wiping_the_cache(tmp_path,
                                                                            monkeypatch):
    """--light is the nastier half: it skips aspect scoring entirely and so never reached
    _get_classifier() at all — it wiped the cache through compute_press_sentiment (whose
    config hash also carries the model fingerprint) and exited 0, leaving the multi-hour
    bill for the NEXT full build."""
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", "on")
    monkeypatch.delenv("PROSPECT_ALLOW_NO_CLASSIFIER", raising=False)
    monkeypatch.setattr(bm, "_CLF", None)
    monkeypatch.setattr(bm, "_CLF_ABSENT", False)

    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    # --light needs a published mart to copy the heavy tables from, so do a real build
    # first; the same-day full build is then renamed away so --light is allowed to run.
    assert _run(["--source", str(src), "--data-dir", str(data)]) == 0
    versioned = (data / "current.duckdb").resolve()
    versioned.rename(data / "prospect_20000101.duckdb")
    (data / "current.duckdb").unlink()
    (data / "current.duckdb").symlink_to("prospect_20000101.duckdb")

    cache = _seed_sentiment_cache(data)
    before = _cache_state(cache)

    monkeypatch.setattr(bm.aspect_classifier, "load_default", lambda _d: None)
    monkeypatch.setattr(bm, "_CLF", None)
    monkeypatch.setattr(bm, "_CLF_ABSENT", False)
    assert _run(["--source", str(src), "--data-dir", str(data), "--light"]) == 2
    assert _cache_state(cache) == before, "the light build wiped the cache on its way out"


def test_the_probe_does_not_hold_the_model_through_the_build(monkeypatch):
    """The probe loads ~150MB; holding it across create_staging on a 2.5GB droplet is a
    memory budget we do not have to spend, and the sentiment phase reloads it anyway."""
    monkeypatch.setattr(bm, "_CLF", None)
    monkeypatch.setattr(bm, "_CLF_ABSENT", False)
    monkeypatch.delenv("PROSPECT_ALLOW_NO_CLASSIFIER", raising=False)

    bm._probe_classifier()            # the real shipped model
    assert bm._CLF is None, "the probe must release the model it loaded"
    assert bm._CLF_ABSENT is False
    assert bm._get_classifier() is not None, "...and the lazy load must still work after it"
    bm._CLF = None


def test_the_probe_keeps_the_degraded_escape_hatch(monkeypatch):
    monkeypatch.setattr(bm, "_CLF", None)
    monkeypatch.setattr(bm, "_CLF_ABSENT", False)
    monkeypatch.setenv("PROSPECT_ALLOW_NO_CLASSIFIER", "1")
    monkeypatch.setattr(bm.aspect_classifier, "load_default", lambda _d: None)

    bm._probe_classifier()            # must not raise
    assert bm._CLF_ABSENT is True, (
        "the degraded marker must survive the probe — write_meta records it as "
        "sentiment_classifier=absent"
    )
    bm._CLF_ABSENT = False


def test_degraded_mode_still_builds_and_stamps_its_provenance(tmp_path, monkeypatch):
    """PROSPECT_ALLOW_NO_CLASSIFIER=1 has to remain a working escape hatch end to end."""
    monkeypatch.setattr(bm, "VALIDATE_MIN_ROWS", {})
    monkeypatch.setenv("PROSPECT_ALLOW_NO_CLASSIFIER", "1")
    monkeypatch.setattr(bm, "_CLF", None)
    monkeypatch.setattr(bm, "_CLF_ABSENT", False)
    monkeypatch.setattr(bm.aspect_classifier, "load_default", lambda _d: None)

    src = tmp_path / "steam_games.db"
    data = tmp_path / "data"
    data.mkdir()
    build_source(src)
    try:
        assert _run(["--source", str(src), "--data-dir", str(data)]) == 0
        con = _open_current(data)
        try:
            meta = dict(con.execute("SELECT key, value FROM mart_meta").fetchall())
        finally:
            con.close()
        assert meta["sentiment_classifier"] == "absent"
    finally:
        bm._CLF, bm._CLF_ABSENT = None, False


def test_light_build_refuses_to_replace_the_full_build(published):
    """--light writes the same prospect_<date>.duckdb filename with STALE copied teardown
    tables; against a same-day full build it must refuse before doing any work. (Safe on the
    shared build: the guard returns before anything is written.)"""
    src, data = published
    before = sorted(p.name for p in data.iterdir())
    assert _run(["--source", str(src), "--data-dir", str(data), "--light"]) == 2
    assert sorted(p.name for p in data.iterdir()) == before, (
        "the light guard must refuse before touching the data dir"
    )
