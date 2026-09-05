"""The per-game cap on the sentiment scoring pool: SENTIMENT_POOL_CAP_PER_GAME.

WHY THIS FILE EXISTS. The pool compute_aspect_sentiment scores used to be every English review
with text for every game over the TEARDOWN_MIN_REVIEWS floor, with no per-game cap. The daytime
keeper deepens review text toward 20,000 per game across ~5,600 games, and every review it fetches
is new text the nightly must score once, at ~131 reviews/s — 1-4M never-scored reviews on a heavy
day, which is why the nightlies whose delta went past ~1.2M failed. A share computed from a few
thousand mentions is already precise to about ±2 points and the UI hides anything under 10 rated
mentions, so the pool is now, per eligible game, the newest SENTIMENT_POOL_CAP_PER_GAME reviews
(highest recommendationid: Steam ids are monotonic in time and unique, so the selection is
deterministic and does not churn the way a helpfulness ranking would).

WHAT IS PINNED, against the REAL compute_aspect_sentiment and a real on-disk cache file:

  * the pool is exactly the cap-many HIGHEST ids per game, compared as NUMBERS — the ids are
    digit strings of unequal length, so a string sort would keep 2015's reviews over 2024's;
  * a game under the cap keeps everything; a game under the floor is out; cap 0 = uncapped;
    PROSPECT_SENTIMENT_POOL_CAP overrides the constant and is validated up front;
  * every consumer derives from that ONE pool, identically with the cache on and off: what gets
    scored (cache.scored_review), the mention table the marts read, the keyword votes, the
    rescore_status progress row, and the sampled count the teardown publishes (the
    stg_review_key hand-off -> mart_game_review_aspects.n_reviews_sampled);
  * deepening a game's back-catalogue creates NO scoring work; a genuinely newer review does,
    and the review it pushes out keeps its cache rows — ignored, not deleted;
  * the cap is NOT part of _sentiment_config_hash: moving it must never wipe and refill the
    ~24M-row cache. Pinned on the hash directly AND end to end through the cache file.
"""
from __future__ import annotations

import io
import re
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

CAP = 5000   # the shipped default, asserted below so a silent change to the constant is caught
FLOOR = 20   # the production floor; set explicitly, because other files lower it to 1

# BIG: 6,000 eligible reviews, ids 7000..12999. The ids straddle the 4-to-5-digit boundary ON
# PURPOSE: as strings '7000'..'9999' sort ABOVE '10000'..'12999', so a string-ordered cap would
# keep 7000-9999 plus 11000-12999 and drop 10000-10999. The correct (numeric, newest-first) pool
# is 8000..12999.
BIG = 1
BIG_IDS = list(range(7000, 13000))
BIG_POOL = set(range(8000, 13000))           # the 5,000 highest, numerically
# SMALL: 30 reviews, over the floor and under the cap — keeps all of them.
# TINY: 10 reviews, under the floor — contributes nothing.
SMALL, SMALL_IDS = 2, list(range(20000, 20030))
TINY, TINY_IDS = 3, list(range(30000, 30010))

SILENT = "qqq zzz wibble " * 6                          # matches no aspect arm at all
COMBAT = "The combat is excellent and the bosses are brutal."
# Mention-bearing reviews on BOTH sides of BIG's cap boundary (8000), so the mention table and
# the vote counts can be checked for pool scoping rather than just the scored-id set.
MENTIONING = {7001: COMBAT, 7999: COMBAT, 8000: COMBAT, 12998: COMBAT, 20015: COMBAT}


def _rows() -> list[tuple]:
    rows = [(BIG, str(r), MENTIONING.get(r, SILENT), "english", 1) for r in BIG_IDS]
    rows += [(SMALL, str(r), MENTIONING.get(r, SILENT), "english", 1) for r in SMALL_IDS]
    rows += [(TINY, str(r), SILENT, "english", 1) for r in TINY_IDS]
    return rows


def _rebuild_staging(con: duckdb.DuckDBPyConnection) -> None:
    """Exactly what create_staging() builds for the sentiment phase: the lean key set, no text.
    Staging is rebuilt every nightly, so a test that adds reviews rebuilds it too."""
    con.execute("DROP TABLE IF EXISTS stg_review_key")
    con.execute(
        "CREATE TEMP TABLE stg_review_key AS "
        "SELECT appid, recommendationid, voted_up FROM src.reviews WHERE language = 'english'"
    )


def _fresh_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute("SET threads=3")
    con.execute("SET memory_limit='1GB'")
    con.execute("CREATE SCHEMA src")
    con.execute(
        "CREATE TABLE src.reviews(appid INTEGER, recommendationid VARCHAR, review_text VARCHAR,"
        " language VARCHAR, voted_up INTEGER)"
    )
    con.executemany("INSERT INTO src.reviews VALUES (?,?,?,?,?)", _rows())
    _rebuild_staging(con)
    return con


class _StubClassifier:
    """Keeps every keyword match on its own arm, as praise. This file is about WHICH reviews are
    in scope, not what the model says about them; pinning it to the shipped model's verdict on a
    hand-written sentence would make it fail on the next model swap for no reason."""

    n_train = 0

    def classify(self, text: str):
        return None, "praise", 0.5


@pytest.fixture()
def stub_classifier():
    prev, prev_absent = bm._CLF, bm._CLF_ABSENT
    bm._CLF, bm._CLF_ABSENT = _StubClassifier(), False
    try:
        yield
    finally:
        bm._CLF, bm._CLF_ABSENT = prev, prev_absent


@pytest.fixture()
def production_knobs(monkeypatch):
    """The real floor and the shipped cap, with none of the sentiment env knobs set. Other test
    modules lower TEARDOWN_MIN_REVIEWS to 1 and do not all restore it; monkeypatch restores
    everything here, so this file leaks nothing either way."""
    monkeypatch.setattr(bm, "TEARDOWN_MIN_REVIEWS", FLOOR)
    for knob in ("PROSPECT_SENTIMENT_POOL_CAP", "PROSPECT_SENTIMENT_CACHE",
                 "PROSPECT_RESCORE_BUCKET_REVIEWS", "PROSPECT_SENTIMENT_DEADLINE_SECONDS"):
        monkeypatch.delenv(knob, raising=False)
    assert bm.SENTIMENT_POOL_CAP_PER_GAME == CAP, "this file's fixture is sized to the shipped cap"


def _score(con: duckdb.DuckDBPyConnection, data_dir: Path) -> str:
    """One run of the real function; returns its log so callers can read the figures the nightly
    log shows."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        bm.compute_aspect_sentiment(con, data_dir)
    return buf.getvalue()


def _new_reviews(log: str) -> int:
    m = re.search(r"([\d,]+) new review\(s\) scored", log)
    assert m, f"no cache log line in: {log!r}"
    return int(m.group(1).replace(",", ""))


def _pool_in_staging(con: duckdb.DuckDBPyConnection) -> dict[int, set[int]]:
    """stg_review_key AFTER the run — the pool as handed to the marts — as {appid: ids}."""
    out: dict[int, set[int]] = {}
    for appid, rid in con.execute("SELECT appid, recommendationid FROM stg_review_key").fetchall():
        out.setdefault(appid, set()).add(int(rid))
    return out


def _mention_ids(con: duckdb.DuckDBPyConnection) -> set[int]:
    return {int(r[0]) for r in con.execute(
        "SELECT DISTINCT recommendationid FROM stg_aspect_mention_sentiment").fetchall()}


def _votes(con: duckdb.DuckDBPyConnection) -> list[tuple]:
    return con.execute(
        "SELECT appid, aspect, voted_up, n_mentions FROM stg_aspect_keyword_votes ORDER BY 1,2,3"
    ).fetchall()


def _raw_votes_over(con: duckdb.DuckDBPyConnection, pool: dict[int, set[int]]) -> list[tuple]:
    """What a raw ten-regex scan yields over exactly `pool` — the reference
    test_teardown_counts_from_cache.py diffs against, restricted to a chosen population."""
    con.execute("DROP TABLE IF EXISTS _ref_ids")
    con.execute("CREATE TEMP TABLE _ref_ids(recommendationid VARCHAR)")
    con.executemany("INSERT INTO _ref_ids VALUES (?)",
                    [(str(r),) for ids in pool.values() for r in ids])
    arms = " UNION ALL ".join(
        "SELECT r.appid, r.voted_up, '{}' AS aspect, regexp_matches(r.review_text, '{}', 'i') AS hit "
        "FROM src.reviews r JOIN _ref_ids i ON i.recommendationid = r.recommendationid"
        .format(label.replace("'", "''"), rx.replace("'", "''"))
        for label, _ph, rx in bm.ASPECT_LEXICON
    )
    try:
        return con.execute(
            f"SELECT appid, aspect, voted_up, sum(hit::INT) AS n FROM ({arms}) "
            "GROUP BY 1,2,3 HAVING sum(hit::INT) > 0 ORDER BY 1,2,3"
        ).fetchall()
    finally:
        con.execute("DROP TABLE _ref_ids")


def _scored_ids(data_dir: Path) -> set[int]:
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
    try:
        return {int(r[0]) for r in c.execute("SELECT recommendationid FROM scored_review").fetchall()}
    finally:
        c.close()


def _cached_mention_rows(data_dir: Path, rid: int) -> int:
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
    try:
        return c.execute("SELECT count(*) FROM aspect_mention WHERE recommendationid = ?",
                         [str(rid)]).fetchone()[0]
    finally:
        c.close()


def _status(data_dir: Path) -> dict:
    c = duckdb.connect(str(data_dir / bm.SENTIMENT_CACHE_DB_NAME))
    try:
        cols = [r[1] for r in c.execute("PRAGMA table_info('rescore_status')").fetchall()]
        rows = c.execute("SELECT * FROM rescore_status").fetchall()
        assert len(rows) == 1, f"rescore_status must hold exactly one row, has {len(rows)}"
        return dict(zip(cols, rows[0]))
    finally:
        c.close()


# ------------------------------------------------------------------------------------------
# What the pool IS.
# ------------------------------------------------------------------------------------------

@pytest.mark.parametrize("cache_mode", ["on", "off"])
def test_pool_is_the_newest_cap_reviews_per_game(production_knobs, stub_classifier, monkeypatch,
                                                 cache_mode):
    """6,000 eligible -> exactly 5,000, the 5,000 HIGHEST ids (numerically); 30 -> 30; 10, under
    the floor -> nothing. Under BOTH cache modes: the PROSPECT_SENTIMENT_CACHE=off path selects
    from the same _sent_pool_meta, and the kill-switch must not change the published numbers."""
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", cache_mode)
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        con = _fresh_con()
        _score(con, data_dir)

        pool = _pool_in_staging(con)
        assert set(pool) == {BIG, SMALL}, f"pool games {sorted(pool)}; TINY is under the floor"
        assert len(pool[BIG]) == CAP, f"6,000 eligible must cap to {CAP}, got {len(pool[BIG])}"
        assert pool[BIG] == BIG_POOL, (
            "the cap must keep the NUMERICALLY highest ids — a string sort keeps 7000-9999 over "
            f"10000-10999 (kept {min(pool[BIG])}..{max(pool[BIG])}, "
            f"{len(pool[BIG] - BIG_POOL)} wrong id(s))"
        )
        assert pool[SMALL] == set(SMALL_IDS), "a game under the cap keeps every review"

        # The mention table is pool-scoped: the same sentence on the wrong side of the boundary
        # contributes nothing to the marts.
        mentioned = _mention_ids(con)
        assert {8000, 12998, 20015} <= mentioned
        assert not ({7001, 7999} & mentioned), "mentions outside the cap must not reach the marts"

        # So are the keyword votes: equal to a raw regex scan over the POOL, and provably
        # different from one over the whole corpus (the two out-of-cap mentions would show).
        assert _votes(con) == _raw_votes_over(con, {BIG: BIG_POOL, SMALL: set(SMALL_IDS)})
        combat = con.execute(
            "SELECT n_mentions FROM stg_aspect_keyword_votes "
            "WHERE appid = ? AND aspect = 'Combat & Bosses' AND voted_up = 1", [BIG]
        ).fetchone()
        assert combat == (2,), f"two in-pool combat mentions, not the corpus's four: {combat}"
        assert _raw_votes_over(con, {BIG: set(BIG_IDS)}) != _raw_votes_over(con, {BIG: BIG_POOL})

        if cache_mode == "on":
            # ...and so is what got SCORED: only pool ids are ever regexed and recorded, and the
            # progress row describes the pool, not the cache.
            assert _scored_ids(data_dir) == BIG_POOL | set(SMALL_IDS)
            st = _status(data_dir)
            assert (st["reviews_in_pool"], st["reviews_scored"]) == (CAP + len(SMALL_IDS),) * 2
        con.close()


@pytest.mark.parametrize("raw_cap, big_pool", [
    ("0", set(BIG_IDS)),                 # 0 = uncapped: every eligible review, as before
    ("100", set(range(12900, 13000))),   # the override reaches the pool, newest first
])
def test_env_cap_zero_is_uncapped_and_a_smaller_cap_is_honoured(production_knobs, stub_classifier,
                                                                monkeypatch, raw_cap, big_pool):
    monkeypatch.setenv("PROSPECT_SENTIMENT_POOL_CAP", raw_cap)
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        con = _fresh_con()
        log = _score(con, data_dir)
        assert _pool_in_staging(con) == {BIG: big_pool, SMALL: set(SMALL_IDS)}
        assert _new_reviews(log) == len(big_pool) + len(SMALL_IDS)
        assert _scored_ids(data_dir) == big_pool | set(SMALL_IDS)
        assert _mention_ids(con) == {r for r in MENTIONING if r in big_pool or r in SMALL_IDS}
        con.close()


def test_env_knob_is_parsed_leniently_at_use_and_refused_up_front(production_knobs, monkeypatch):
    """The contract every sentiment knob follows: a bad value is refused by _env_config_errors
    at startup (seconds in), and the point-of-use reader never crashes the build over it (hours
    in) — it falls back to the constant. A cap under the floor is bad on purpose: the pool is
    handed to the teardown as its floored population, so such a cap would drop every capped
    game from the teardown."""
    assert bm._sentiment_pool_cap() == CAP
    for raw, want in (("0", 0), (str(FLOOR), FLOOR), ("250", 250), (" 5000 ", 5000)):
        monkeypatch.setenv("PROSPECT_SENTIMENT_POOL_CAP", raw)
        assert bm._sentiment_pool_cap() == want, raw
        assert not [e for e in bm._env_config_errors() if "PROSPECT_SENTIMENT_POOL_CAP" in e], raw
    for raw in ("abc", "-1", "1", str(FLOOR - 1), "1.5"):
        monkeypatch.setenv("PROSPECT_SENTIMENT_POOL_CAP", raw)
        assert bm._sentiment_pool_cap() == CAP, f"{raw!r} must fall back, never crash"
        errs = [e for e in bm._env_config_errors() if "PROSPECT_SENTIMENT_POOL_CAP" in e]
        assert len(errs) == 1, (raw, bm._env_config_errors())


# ------------------------------------------------------------------------------------------
# Stability night to night — the operational point of the cap.
# ------------------------------------------------------------------------------------------

def test_deepening_creates_no_work_but_a_newer_review_does(production_knobs, stub_classifier):
    """NIGHT 1 scores the pool. NIGHT 2: the keeper deepened BIG's back-catalogue by 2,000 OLDER
    reviews — nothing to score, the pool does not move. NIGHT 3: three genuinely NEW reviews
    arrive — exactly three are scored, they enter the pool, the three they push out keep their
    cache rows (ignored, not deleted) and vanish from the marts, and the progress row still
    describes the pool even though the cache now holds more scored ids than the pool has."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        con = _fresh_con()
        assert _new_reviews(_score(con, data_dir)) == CAP + len(SMALL_IDS)

        con.executemany("INSERT INTO src.reviews VALUES (?,?,?,?,?)",
                        [(BIG, str(r), COMBAT, "english", 1) for r in range(5000, 7000)])
        _rebuild_staging(con)
        assert _new_reviews(_score(con, data_dir)) == 0, "older text must create no scoring work"
        assert _pool_in_staging(con)[BIG] == BIG_POOL, "the pool must not move for older text"

        newest = [13000, 13001, 13002]
        con.executemany("INSERT INTO src.reviews VALUES (?,?,?,?,?)",
                        [(BIG, str(r), COMBAT, "english", 1) for r in newest])
        _rebuild_staging(con)
        assert _new_reviews(_score(con, data_dir)) == len(newest), (
            "exactly the newer reviews are scored — nothing else in the pool is touched")
        pool = _pool_in_staging(con)[BIG]
        assert pool == (BIG_POOL - {8000, 8001, 8002}) | set(newest)
        assert len(pool) == CAP

        # The pushed-out reviews keep everything they had in the cache...
        assert {8000, 8001, 8002} <= _scored_ids(data_dir)
        assert _cached_mention_rows(data_dir, 8000) > 0, "capped-out rows are ignored, not deleted"
        # ...and are simply absent from what the marts read.
        mentioned = _mention_ids(con)
        assert 8000 not in mentioned
        assert set(newest) <= mentioned

        # scored_review now holds 5,033 ids against a 5,030-review pool; the report must say
        # 5,030 of 5,030, not 100.06%.
        assert len(_scored_ids(data_dir)) == CAP + len(SMALL_IDS) + len(newest)
        st = _status(data_dir)
        assert (st["reviews_in_pool"], st["reviews_scored"]) == (CAP + len(SMALL_IDS),) * 2
        con.close()


# ------------------------------------------------------------------------------------------
# The cap is a SCOPE knob, not a VALUE knob: it must never wipe the cache.
# ------------------------------------------------------------------------------------------

def test_the_cap_is_not_part_of_the_config_hash(production_knobs, monkeypatch):
    """_sentiment_config_hash wipes and refills the whole ~24M-row cache when it moves. Which
    reviews are IN SCOPE does not change what any scored mention's value IS, so the cap must
    leave the hash exactly where it was — from the constant and from the env override alike."""
    before = bm._sentiment_config_hash()
    for cap in (0, 1, CAP * 3 + 1):
        monkeypatch.setattr(bm, "SENTIMENT_POOL_CAP_PER_GAME", cap)
        assert bm._sentiment_config_hash() == before, f"constant={cap} moved the hash"
    for raw in ("0", "250", "999999"):
        monkeypatch.setenv("PROSPECT_SENTIMENT_POOL_CAP", raw)
        assert bm._sentiment_config_hash() == before, f"env={raw} moved the hash"
    # Not vacuous: a VALUE knob still moves it.
    monkeypatch.setattr(bm, "SENTIMENT_CACHE_VERSION", bm.SENTIMENT_CACHE_VERSION + 1)
    assert bm._sentiment_config_hash() != before


def test_moving_the_cap_keeps_the_cache_end_to_end(production_knobs, stub_classifier, monkeypatch):
    """The same guarantee through the real cache file: score under one cap, run again under
    another, and the second run must be a plain delta against the kept cache — no wipe, no
    refill — with the smaller pool read back out of rows scored under the larger one."""
    with tempfile.TemporaryDirectory() as td:
        data_dir = Path(td)
        con = _fresh_con()
        _score(con, data_dir)
        con.close()
        scored_before = _scored_ids(data_dir)
        assert scored_before == BIG_POOL | set(SMALL_IDS)

        monkeypatch.setenv("PROSPECT_SENTIMENT_POOL_CAP", "100")
        con = _fresh_con()
        log = _score(con, data_dir)
        assert "config/version changed" not in log, "a cap change must never wipe the cache"
        assert _new_reviews(log) == 0, "everything the smaller pool needs was already scored"
        assert _scored_ids(data_dir) == scored_before, "nothing deleted, nothing added"
        assert _pool_in_staging(con)[BIG] == set(range(12900, 13000))
        assert _mention_ids(con) == {12998, 20015}
        con.close()


# ------------------------------------------------------------------------------------------
# The number the UI shows next to the bars.
# ------------------------------------------------------------------------------------------

def test_teardown_publishes_the_capped_count_as_n_reviews_sampled(production_knobs, stub_classifier):
    """Through the REAL mart_game_teardown.sql: 'N sampled English reviews' must be the N
    reviews the bars were computed from — 5,000 for BIG, not the 6,000 staging started with —
    and the bars themselves must count in-pool mentions only."""
    with tempfile.TemporaryDirectory() as td:
        con = _fresh_con()
        _score(con, Path(td))

        # The rest of the file's inputs: press + genre, empty but correctly typed.
        con.execute("CREATE TEMP TABLE stg_primary_genre(appid INTEGER, primary_genre VARCHAR)")
        con.execute(
            "CREATE TEMP TABLE stg_press_base(appid INTEGER, article_id BIGINT, source VARCHAR,"
            " author VARCHAR, title VARCHAR, url VARCHAR, published_at TIMESTAMP,"
            " match_confidence DOUBLE)"
        )
        con.execute(
            "CREATE TEMP TABLE stg_press_article_sentiment(article_id BIGINT, compound DOUBLE)")
        sql = bm.render((ETL / "marts" / "mart_game_teardown.sql").read_text(), bm.build_params())
        con.execute(sql)

        sampled = con.execute(
            "SELECT DISTINCT appid, n_reviews_sampled FROM mart_game_review_aspects ORDER BY 1"
        ).fetchall()
        assert sampled == [(BIG, CAP), (SMALL, len(SMALL_IDS))], sampled
        assert con.execute(
            "SELECT n_pos_mentions, n_neg_mentions FROM mart_game_review_aspects "
            "WHERE appid = ? AND aspect = 'Combat & Bosses'", [BIG]
        ).fetchone() == (2, 0), "the bar counts the two in-pool mentions, not the corpus's four"
        # Every eligible game still carries all ten aspect rows, and the teardown's own DROP
        # cleaned up the handed-off pool exactly as it cleaned up staging's table before.
        assert con.execute("SELECT count(*) FROM mart_game_review_aspects").fetchone() == (
            2 * len(bm.ASPECT_LEXICON),)
        assert con.execute(
            "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'stg_review_key'"
        ).fetchone() == (0,)
        con.close()
