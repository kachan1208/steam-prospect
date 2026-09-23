"""The sentiment window is cut a different way now; every window must still come out the same.

_aspect_window_sql cuts the text each (review, aspect) mention is scored on. Until 2026-09-22 it
ran the sentence regex over a ~520-char slice of the review,

    [^.!?;\\n]{0,160}(?:<keyword alternation>)[^.!?;\\n]{0,160}

which RE2 can only answer through its NFA (~1ms a window, measured on real reviews, against ~70us
for VADER + the classifier on the same window). It now cuts the window with the anchored-run
algebra mart_game_aspect_reviews.sql uses for its excerpts (see _aspect_window_sql's docstring).

Byte-identical output is the WHOLE claim, not a nicety: cache.aspect_mention holds ~20M scores
computed from windows cut the old way, and _sentiment_config_hash does not cover this code, so a
window that came out different would silently mix two definitions of "the text we scored" in one
cache. Two ways of breaking it are tried here:

  * test_window_sql_matches_the_old_regex — a differential fuzz over whole REVIEWS (not slices:
    the slice arithmetic and its `^\\S+` strip are part of what is being compared), re-deriving
    the OLD _aspect_window_sql from the same ASPECT_LEXICON so a lexicon edit moves both sides.
    The generator reuses the excerpt fuzz's adversarial cores (keyword at the clause edges, at
    159/160/161 characters from a boundary, repeated, multi-word, no keyword at all...) and adds
    what that fuzz never produced: Windows line endings in text that also contains non-ASCII
    characters, a boundary character carrying a combining mark, ZWJ emoji sequences, lone CRs,
    and keywords more than ASPECT_WINDOW_SLICE_BEFORE characters in behind a long unbroken run.
    The CRLF case is not hypothetical — see test_crlf_in_non_ascii_text_keeps_its_boundary.

  * test_crlf_in_non_ascii_text_keeps_its_boundary — the concrete defect the real-data check
    found in the first cut of this rewrite: DuckDB's reverse() reverses grapheme CLUSTERS when a
    string has any non-ASCII character, and CR LF is one cluster, so the reverse-anchored left
    clause picked up the '\\r' in front of the '\\n' boundary. 214 of 29,676 real windows (0.7%).
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_marts as bm  # noqa: E402
from test_mart_aspect_reviews_window_rewrite import (  # noqa: E402  (one adversarial generator)
    ARMS, KEYWORDS, WORDS, adversarial, old_sentence_regex)

SB = bm.ASPECT_WINDOW_SLICE_BEFORE
SL = bm.ASPECT_WINDOW_SLICE_CHARS

NON_ASCII = "’“”—–éüßжїщ漢字テスト"
COMBINING = "́̈⃣"          # acute, diaeresis, enclosing keycap
ZWJ_EMOJI = ["👨‍👩‍👧", "❤️", "👍🏽", "🏳️‍🌈"]


def old_aspect_window_sql(pool: str) -> str:
    """The pre-2026-09-22 _aspect_window_sql, re-derived from the lexicon: the slice, then the
    sentence regex over it."""
    arms = []
    for label, rx in ARMS:
        rxe = rx.replace("'", "''")
        arms.append(f"""
        SELECT appid, recommendationid, '{label.replace("'", "''")}' AS aspect,
            regexp_extract(
                CASE WHEN kw_pos - {SB} > 1
                     THEN regexp_replace(substr(review_text, kw_pos - {SB}, {SL}), '^\\S+', '')
                     ELSE substr(review_text, 1, {SL})
                END,
                '{old_sentence_regex(rx).replace("'", "''")}', 0, 'i') AS window_text
        FROM (SELECT appid, recommendationid, review_text,
                     length(regexp_extract(review_text, '^([\\s\\S]*?)(?:{rxe})', 1, 'i')) + 1 AS kw_pos
              FROM {pool} WHERE regexp_matches(review_text, '{rxe}', 'i'))""")
    return "\nUNION ALL\n".join(arms)


def _filler(rng: random.Random, n: int, style: int) -> str:
    """~n characters of review-shaped text: words and clause boundaries, decorated per style.
    The decoration is drawn INDEPENDENTLY of the token, so a style never crowds out the
    boundaries — and non-ASCII lands everywhere, including inside the ~200 characters before a
    keyword, which is the only place the CRLF defect can see it (DuckDB takes an ASCII fast path
    through reverse() for a pure-ASCII string)."""
    out: list[str] = []
    size = 0
    while size < n:
        tok = (rng.choice([". ", "! ", "? ", "; ", "\n", "\n\n", "...", " - "])
               if rng.random() < 0.12 else rng.choice(WORDS))
        d = rng.random()
        if style in (1, 2, 5) and d < 0.15:
            tok += rng.choice(NON_ASCII)
        elif style == 3 and d < 0.1:
            tok = rng.choice(".!?;") + rng.choice(COMBINING)
        elif style == 4 and d < 0.1:
            tok = rng.choice(ZWJ_EMOJI)
        elif style == 6 and d < 0.2:
            tok += "\r"
        elif style == 7 and d < 0.2:
            tok = rng.choice(["\t", "   ", "x" * rng.randrange(20, 260)])
        out.append(tok)
        out.append(" " if rng.random() < 0.8 else "")
        size += len(tok) + 1
    return "".join(out)[:n]


def adversarial_review(rng: random.Random, kws: list[str], i: int) -> str:
    style = i % 8
    core = adversarial(rng, kws, i % 12)
    prefix_len = rng.choice([0, 1, 7, SB - 9, SB - 1, SB, SB + 1, SB + 2, SB + 40, 400, 900])
    lead = _filler(rng, prefix_len, style)
    if style in (1, 5) and rng.random() < 0.5:
        lead += rng.choice(NON_ASCII) + "\n"             # a line break right before the clause
    text = lead + core + _filler(rng, rng.randrange(0, 400), style)
    if style == 7 and rng.random() < 0.5:
        # the first keyword far in, behind an unbroken run: the `^\S+` strip can eat into it
        text = "y" * (SB + rng.randrange(1, 60)) + rng.choice(kws) + " " + text
    if style in (1, 5):
        text = text.replace("\n", "\r\n")                # Windows line endings, non-ASCII around
    return text


def _pool(con, rows) -> None:
    con.execute("CREATE OR REPLACE TABLE pool(appid INTEGER, recommendationid VARCHAR, "
                "review_text VARCHAR)")
    con.executemany("INSERT INTO pool VALUES (?, ?, ?)", rows)


def _diff(con) -> list[tuple]:
    con.execute(f"CREATE OR REPLACE TABLE w_old AS {old_aspect_window_sql('pool')}")
    con.execute(f"CREATE OR REPLACE TABLE w_new AS {bm._aspect_window_sql('pool')}")
    return con.execute("""
        SELECT o.recommendationid, o.aspect, o.window_text, n.window_text, p.review_text
        FROM w_old o
        FULL OUTER JOIN w_new n USING (recommendationid, aspect)
        LEFT JOIN pool p ON p.recommendationid = COALESCE(o.recommendationid, n.recommendationid)
        WHERE o.window_text IS DISTINCT FROM n.window_text
        LIMIT 5""").fetchall()


PER_ARM = 300   # x 10 arms; the OLD regex costs ~1ms per window, so this is a few seconds


def test_window_sql_matches_the_old_regex():
    rng = random.Random(20260922)
    con = bm._connect()
    rows = []
    for a, (label, _rx) in enumerate(ARMS):
        for i in range(PER_ARM):
            rows.append((a, f"{a}-{i}", adversarial_review(rng, KEYWORDS[label], i)))
    _pool(con, rows)
    bad = _diff(con)
    assert not bad, ("the rewritten _aspect_window_sql disagrees with the old sentence regex:\n"
                     + "\n".join(f"  {rid} {asp}\n    old={o!r}\n    new={n!r}\n    text={t!r}"
                                 for rid, asp, o, n, t in bad))
    n_old, n_new, n_crlf = con.execute(
        "SELECT (SELECT count(*) FROM w_old), (SELECT count(*) FROM w_new), "
        "(SELECT count(*) FROM w_new JOIN pool USING (recommendationid) "
        " WHERE strpos(review_text, chr(13) || chr(10)) > 0)").fetchone()
    # Several adversarial cores carry no keyword on purpose (or only a \b-less substring), so a
    # bit over half the reviews produce a window; far fewer means the generator broke.
    assert n_old == n_new and n_new > len(rows) // 2, (n_old, n_new, len(rows))
    assert n_crlf > 50, "the fixture stopped exercising Windows line endings"
    print(f"[fuzz] {len(rows):,} adversarial reviews -> {n_new:,} windows "
          f"({n_crlf:,} from CRLF text), 0 differences")


def test_crlf_in_non_ascii_text_keeps_its_boundary():
    """The real review shape that broke the first cut (and still breaks a reverse()-based cut):
    a non-ASCII character anywhere, Windows line endings, keyword in the line after a break."""
    con = bm._connect()
    texts = [
        "Great remaster — and I think it gives 50+ hours of gameplay.\r\n\r\n"
        "I've also tried the Brutal Doom mod, but it changes the core mechanics too much.\r\n",
        "café\r\nWill there be a conquest mode or story (maybe)?\r\n\r\nPlease add it.",
        "~ GRAPHICS ~\r\n✅ Good\r\n\r\n~ PRICE ~\r\n🔲 Free\r\n✅ Perfect Price\r\n",
        "Straße.́ The combat is tight and the boss fights are fair.",
    ]
    _pool(con, [(1, f"t{i}", t) for i, t in enumerate(texts)])
    assert not _diff(con)
    windows = [w for (w,) in con.execute("SELECT window_text FROM w_new").fetchall()]
    assert windows and not any(w.startswith("\r") for w in windows), windows


def test_shipped_excerpts_keep_their_boundary_on_crlf_reviews_too():
    """The excerpt arms rendered into mart_game_aspect_reviews.sql (_ASPECT_EXCERPT_ARM) had the
    same reverse() defect: on a CRLF review with any non-ASCII character the excerpt started
    with a stray '\\r', was therefore not a substring of the review, and lost its '…' markers.
    End to end over the REAL .sql, against the old pipeline the excerpt fuzz recomputes."""
    import duckdb
    import test_mart_aspect_reviews_window_rewrite as ex

    con = duckdb.connect()
    con.execute("CREATE SCHEMA src")
    con.execute("""CREATE TABLE src.reviews(recommendationid VARCHAR, appid INTEGER,
        author_steamid VARCHAR, playtime_forever INTEGER, playtime_at_review INTEGER,
        language VARCHAR, review_text VARCHAR, timestamp_created BIGINT, votes_up INTEGER)""")
    con.execute("""CREATE TEMP TABLE stg_aspect_mention_sentiment(appid INTEGER,
        recommendationid VARCHAR, aspect VARCHAR, kw_aspect VARCHAR, compound DOUBLE,
        text_sentiment VARCHAR)""")
    cases = [
        ("Combat & Bosses", "Great remaster — and 50+ hours.\r\n\r\nI've also tried the Brutal "
                            "Doom mod, but it changes the core mechanics too much.\r\n"),
        ("Story & Writing", "café\r\nWill there be a conquest mode or story (maybe)?\r\n\r\nok"),
        ("Price & Value", "~ GRAPHICS ~\r\n✅ Good\r\n\r\n~ PRICE ~\r\n🔲 Free\r\n✅ Perfect Price\r\n"),
    ]
    rows = [(f"r{i}", 9000, "765", 1, 1, "english", text, ex.TS, 100 - i)
            for i, (_a, text) in enumerate(cases)]
    rows += [(f"f{i}", 9000, "765", 1, 1, "english", "filler mentions nothing", ex.TS, -1 - i)
             for i in range(bm.TEARDOWN_MIN_REVIEWS)]
    con.executemany("INSERT INTO src.reviews VALUES (?,?,?,?,?,?,?,?,?)", rows)
    con.executemany("INSERT INTO stg_aspect_mention_sentiment VALUES (?,?,?,?,?,?)",
                    [(9000, f"r{i}", a, a, 0.7, "praise") for i, (a, _t) in enumerate(cases)])
    con.execute(bm.render((ETL / "marts" / "mart_game_aspect_reviews.sql").read_text(),
                          bm.build_params()))
    con.execute(ex._expected_sql())
    got = con.execute("""SELECT a.excerpt, e.excerpt FROM mart_game_aspect_reviews a
        JOIN expected e ON e.appid = a.appid AND e.votes_up = a.votes_up AND e.aspect = a.aspect
        ORDER BY a.votes_up DESC""").fetchall()
    assert len(got) == len(cases)
    for shipped, expected in got:
        assert shipped == expected and not shipped.startswith("\r"), (shipped, expected)
        assert shipped.startswith("…"), "every case starts mid-review, so it must say so"
