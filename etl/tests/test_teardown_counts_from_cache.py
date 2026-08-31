"""mart_game_review_aspects' vote-split counts must equal a raw 10-regex scan of review text.

THE INVARIANT THIS PINS. mart_game_teardown.sql used to rebuild its per-(appid, aspect,
voted_up) mention counts by running the ten ASPECT_LEXICON regexes over stg_review_text — a
SECOND full-text scan of facts compute_aspect_sentiment had already computed and cached in
cache.aspect_mention. That second scan was the only reason review text had to be materialised
for all 24.8M English reviews (8.45GB, held as a TEMP table for most of the build), and it is
what put eight consecutive nightlies over the box's memory headroom. The counts now come from
the cache via stg_aspect_keyword_votes.

That substitution is only legitimate if the cache reproduces the raw scan EXACTLY, and four
separate properties have to hold at once for it to. Each is a real way this could go wrong,
and each has a case in the fixture below:

  1. ONE ROW PER (review, aspect), not per keyword OCCURRENCE. `regexp_matches` is a boolean:
     a review saying "combat" three times counted 1. A per-occurrence cache would silently
     inflate every bar.                                            -> REPEATED
  2. NONE-classified mentions are still COUNTED. The classifier's verdict lives in clf_aspect
     and the read path that feeds the text-sentiment columns drops clf_aspect='NONE' (~11% of
     all cached rows on the live cache). These are the KEYWORD bars; dropping NONE here would
     shrink them by a tenth against the scan they replace.          -> the NONE-stubbed arm
  3. The stored `aspect` is the KEYWORD ARM, not the classifier's reassignment. The classifier
     routinely moves a window to a different aspect; counting by the reassigned label would
     move mentions between bars.                                    -> the NONE-stubbed arm
  4. Reviews that match NOTHING contribute nothing and break nothing (they produce no cache
     rows at all, only a scored_review record).                     -> SILENT

Plus both voted_up values, since the counts are split by vote and a NULL/absent side must read
as 0 rather than NULL.

The reference side is the OLD expression, re-derived here from the same ASPECT_LEXICON — the
same technique test_mart_aspect_reviews_window_rewrite.py uses to diff its rewrite.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ETL = REPO / "etl"
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import pytest  # noqa: E402
import build_marts as bm  # noqa: E402

# (recommendationid, voted_up, review_text)
FIXTURE = [
    # MULTI: one review, several different aspects, on the positive side.
    ("multi", 1, "The combat is tight, the soundtrack is superb and the story landed."),
    # REPEATED: one aspect named many times in one review — must count ONCE.
    ("repeated", 1, "Combat, combat, combat. The combat is the combat of my dreams; "
                    "did I mention the combat? Bosses, fights, more combat."),
    # NEGATIVE side of two aspects the positive reviews also mention, so pos and neg
    # both have to be right for the same (appid, aspect).
    ("neg1", 0, "The combat is dreadful and the story is worse."),
    ("neg2", 0, "Way too expensive for what you get, not worth the price."),
    # NONE-STUBBED: the classifier below reads this window as NONE. The keyword arm still
    # matched, so the vote bars must still count it.
    ("noneish", 1, "The music zzznone here, whatever that means."),
    # REASSIGNED: the classifier below moves this window off its keyword arm (Map &
    # Navigation, via "grind") onto Difficulty. The vote bars count KEYWORD arms, so it must
    # stay on Map & Navigation.
    ("moved", 0, "Endless grind zzzmove, and that is the whole game."),
    # SILENT: matches no arm at all. Contributes no cache rows, must contribute no counts.
    ("silent", 0, "qqq zzz wibble " * 8),
    # A second game, so the per-appid grouping is exercised rather than assumed.
    ("g2a", 1, "Gorgeous art and a beautiful world to explore."),
    ("g2b", 0, "The map is confusing and backtracking is tedious."),
]
APPID_OF = {rid: (2 if rid.startswith("g2") else 1) for rid, _v, _t in FIXTURE}


class _StubClassifier:
    """Deterministic stand-in for the real aspect model.

    Reads any window containing 'zzznone' as NONE — the class the read path drops — and any
    window containing 'zzzmove' as a DIFFERENT aspect than the keyword arm that produced it,
    which is the other thing the real model routinely does. Everything else is left on its own
    arm. Using a stub rather than the shipped model is deliberate: this test is about how those
    two verdicts are HANDLED, and pinning it to whatever the current model happens to say about
    a hand-written sentence would make the test fail on the next model swap for no real reason.
    """

    n_train = 0

    def classify(self, text: str):
        if "zzznone" in (text or ""):
            return "NONE", "neutral", 1.0
        if "zzzmove" in (text or ""):
            return "Difficulty", "complaint", 0.9
        return None, "praise", 0.5


def _raw_regex_counts(con) -> list[tuple]:
    """The path this change REPLACES, re-derived from ASPECT_LEXICON: mart_game_teardown.sql's
    _review_aspect_flags (ten `regexp_matches(review_text, rx, 'i')` boolean columns) plus its
    SUM(flag::INT) FILTER (WHERE voted_up = ...) aggregate, in long form."""
    arms = " UNION ALL ".join(
        "SELECT appid, voted_up, '{}' AS aspect, "
        "regexp_matches(review_text, '{}', 'i') AS hit FROM src.reviews "
        "WHERE language = 'english'".format(label.replace("'", "''"), rx.replace("'", "''"))
        for label, _ph, rx in bm.ASPECT_LEXICON
    )
    return con.execute(
        f"SELECT appid, aspect, voted_up, sum(hit::INT) AS n FROM ({arms}) "
        "GROUP BY 1,2,3 HAVING sum(hit::INT) > 0 ORDER BY 1,2,3"
    ).fetchall()


def _fixture_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute("CREATE SCHEMA src")
    con.execute(
        "CREATE TABLE src.reviews(appid INTEGER, recommendationid VARCHAR, review_text VARCHAR,"
        " language VARCHAR, voted_up INTEGER)"
    )
    con.executemany(
        "INSERT INTO src.reviews VALUES (?,?,?,?,?)",
        [(APPID_OF[rid], rid, txt, "english", vu) for rid, vu, txt in FIXTURE],
    )
    # Exactly what create_staging() builds: the key set, no review text.
    con.execute(
        "CREATE TEMP TABLE stg_review_key AS "
        "SELECT appid, recommendationid, voted_up FROM src.reviews WHERE language = 'english'"
    )
    return con


@pytest.fixture()
def stub_classifier():
    """Install the stub for the duration of a test and restore whatever was cached before."""
    prev, prev_absent = bm._CLF, bm._CLF_ABSENT
    bm._CLF, bm._CLF_ABSENT = _StubClassifier(), False
    try:
        yield
    finally:
        bm._CLF, bm._CLF_ABSENT = prev, prev_absent


@pytest.fixture()
def small_floor():
    prev = bm.TEARDOWN_MIN_REVIEWS
    bm.TEARDOWN_MIN_REVIEWS = 1  # fixture-sized games
    try:
        yield
    finally:
        bm.TEARDOWN_MIN_REVIEWS = prev


@pytest.mark.parametrize("cache_mode", ["on", "off"])
def test_cache_derived_counts_equal_raw_text_counts(stub_classifier, small_floor, monkeypatch,
                                                    cache_mode):
    """stg_aspect_keyword_votes == the ten-regex scan, per (appid, aspect, voted_up).

    Run under BOTH cache modes. compute_aspect_sentiment builds this table from
    cache.aspect_mention normally and from _sent_raw under PROSPECT_SENTIMENT_CACHE=off, and
    the kill-switch would be worse than useless if flipping it changed the published numbers.
    """
    monkeypatch.setenv("PROSPECT_SENTIMENT_CACHE", cache_mode)
    with tempfile.TemporaryDirectory() as td:
        con = _fixture_con()
        bm.compute_aspect_sentiment(con, Path(td))

        raw = _raw_regex_counts(con)
        cached = con.execute(
            "SELECT appid, aspect, voted_up, n_mentions FROM stg_aspect_keyword_votes "
            "ORDER BY 1,2,3"
        ).fetchall()
        assert raw, "fixture produced no mentions at all — it is not testing anything"
        assert cached == raw, (
            "cache-derived teardown counts diverged from the raw regex scan\n"
            f"  only in raw   : {sorted(set(raw) - set(cached))}\n"
            f"  only in cache : {sorted(set(cached) - set(raw))}"
        )
        con.close()


def test_repeated_keyword_counts_once_and_none_is_still_counted(stub_classifier, small_floor):
    """The two failure modes the equality above would hide if the fixture were thinner.

    A per-window cache would make 'repeated' count >1 for Combat & Bosses; filtering
    clf_aspect='NONE' on the vote side would make 'noneish' count 0 for Music & Audio. Both are
    checked as absolute numbers, not just against each other.
    """
    with tempfile.TemporaryDirectory() as td:
        con = _fixture_con()
        bm.compute_aspect_sentiment(con, Path(td))

        combat_pos = con.execute(
            "SELECT n_mentions FROM stg_aspect_keyword_votes "
            "WHERE appid = 1 AND aspect = 'Combat & Bosses' AND voted_up = 1"
        ).fetchone()
        # 'multi' + 'repeated', once each — NOT once per occurrence.
        assert combat_pos == (2,), f"repeated keywords must count once per review, got {combat_pos}"

        music_pos = con.execute(
            "SELECT n_mentions FROM stg_aspect_keyword_votes "
            "WHERE appid = 1 AND aspect = 'Music & Audio' AND voted_up = 1"
        ).fetchone()
        # 'multi' (soundtrack) + 'noneish' (music, classified NONE) = 2. The NONE one counts.
        assert music_pos == (2,), f"NONE-classified keyword matches must still count, got {music_pos}"

        # ... and the SAME mention is correctly absent from the text-sentiment table, which is
        # where the NONE class IS dropped. If this ever starts including it, the two consumers
        # have been wired to the same filter and one of them is now wrong.
        assert con.execute(
            "SELECT count(*) FROM stg_aspect_mention_sentiment WHERE recommendationid = 'noneish'"
        ).fetchone() == (0,), "NONE mentions must stay out of the text-sentiment table"

        # A review matching nothing produces no counts anywhere but is recorded as scanned.
        assert con.execute(
            "SELECT count(*) FROM stg_aspect_mention_sentiment WHERE recommendationid = 'silent'"
        ).fetchone() == (0,)

        # A reassigned mention stays on the arm whose regex matched it, in the vote bars ...
        assert con.execute(
            "SELECT aspect, n_mentions FROM stg_aspect_keyword_votes "
            "WHERE appid = 1 AND voted_up = 0 AND aspect LIKE 'Map%'"
        ).fetchall() == [("Map & Navigation / Backtracking", 1)], (
            "the vote bars must count the KEYWORD arm, not the classifier's reassignment")
        assert con.execute(
            "SELECT count(*) FROM stg_aspect_keyword_votes "
            "WHERE appid = 1 AND voted_up = 0 AND aspect = 'Difficulty'"
        ).fetchone() == (0,), "a reassigned mention must not appear under its new aspect here"
        # ... while the TEXT-sentiment table, which is about what the window is really about,
        # correctly files it under the reassigned aspect. The two are meant to differ.
        assert con.execute(
            "SELECT aspect FROM stg_aspect_mention_sentiment WHERE recommendationid = 'moved'"
        ).fetchall() == [("Difficulty",)]
        con.close()


def test_mart_game_review_aspects_matches_raw_scan_end_to_end(stub_classifier, small_floor):
    """The same equality through the REAL mart_game_teardown.sql, not just its input table.

    Runs the shipped file (rendered exactly as the ETL renders it) over the fixture with empty
    press/genre staging, and diffs mart_game_review_aspects' n_pos_mentions / n_neg_mentions
    against the ten-regex scan. This is what actually ships to the Game Teardown's aspect bars,
    including the CROSS JOIN that must still emit a zero row for aspects a game never mentions.
    """
    with tempfile.TemporaryDirectory() as td:
        con = _fixture_con()
        bm.compute_aspect_sentiment(con, Path(td))

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

        got = con.execute(
            "SELECT appid, aspect, n_pos_mentions, n_neg_mentions FROM mart_game_review_aspects "
            "WHERE n_pos_mentions + n_neg_mentions > 0 ORDER BY 1,2"
        ).fetchall()

        # Reference: fold the long raw counts into (appid, aspect) -> (pos, neg).
        ref: dict[tuple, list[int]] = {}
        for appid, aspect, voted_up, n in _raw_regex_counts(con):
            slot = ref.setdefault((appid, aspect), [0, 0])
            slot[0 if voted_up == 1 else 1] += n
        expected = sorted((a, s, p, n) for (a, s), (p, n) in ref.items())

        assert got == expected, (
            "mart_game_review_aspects disagreed with the raw ten-regex scan\n"
            f"  got      : {got}\n  expected : {expected}"
        )

        # Every eligible game must still carry a row for all ten aspects, including the ones it
        # never mentions — mart_genre_aspect_baseline's COUNT(DISTINCT appid) depends on it.
        assert con.execute(
            "SELECT count(*) FROM mart_game_review_aspects"
        ).fetchone() == (2 * len(bm.ASPECT_LEXICON),)
        # ... and those rows read as 0/NULL, not NULL counts.
        assert con.execute(
            "SELECT count(*) FROM mart_game_review_aspects "
            "WHERE n_pos_mentions IS NULL OR n_neg_mentions IS NULL OR total_mentions IS NULL"
        ).fetchone() == (0,)
        con.close()
