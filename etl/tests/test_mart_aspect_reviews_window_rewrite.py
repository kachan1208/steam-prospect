"""The excerpt window is computed a different way now; it must still come out the same.

mart_game_aspect_reviews.sql used to cut each excerpt with one unanchored regex over a ~520-char
slice of the review:

    [^.!?;\\n]{0,160}(?:<keyword alternation>)[^.!?;\\n]{0,160}

RE2 compiles a bounded repeat by unrolling it, so that pattern is 320 copies of a negated
(multi-range, in UTF-8 mode) character class. Its lazy DFA thrashes and `regexp_extract` — which
needs match BOUNDARIES, not a yes/no — drops to RE2's NFA simulation: 767us per row, times ~1.77M
surviving rows, which is where the 4-hour build step went. The file now restricts the search to
the boundary-free clause holding the first keyword and cuts the window with a single ANCHORED
pattern over `[\\s\\S]` (see the PERFORMANCE (2026-08-28) note in the .sql for the two facts that
make that exact).

"Exact" is the whole claim, so this file tries to break it two ways:

  * test_window_expression_matches_the_old_regex — a differential fuzz. The OLD expression is
    re-derived here from the SAME ASPECT_LEXICON / ASPECT_SENTENCE_CHARS the mart renders from
    (so a lexicon edit moves both sides, and this stays a real comparison), and run against the
    new expression over adversarial slices for every one of the 10 arms: keyword at the string
    edges, hugged by clause boundaries, at exactly 159/160/161 characters from one, repeated
    inside a clause, multi-word keywords, multi-byte text, clauses with no boundary at all, and
    slices with no keyword at all.

  * test_shipped_mart_excerpts_match_the_old_pipeline — end-to-end over the REAL .sql file: build
    a fixture of adversarial reviews, run etl/marts/mart_game_aspect_reviews.sql through
    build_marts.render(), and check every published excerpt / matched_keywords / review_text /
    steam_url against the OLD pipeline recomputed independently from src.reviews. This is what
    catches "the expression is fine but the file wires it up wrong".
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

SC = bm.ASPECT_SENTENCE_CHARS
SB = bm.ASPECT_WINDOW_SLICE_BEFORE
SL = bm.ASPECT_WINDOW_SLICE_CHARS
ARMS = [(label, rx) for (label, _ph, rx) in bm.ASPECT_LEXICON]

# One or more literal keywords per arm, all matching that arm's regex. Multi-word entries are
# deliberate: "hours of playtime" / "open world" / "tight controls" are the longest alternatives
# and the ones where a mis-sized window would show up first.
KEYWORDS = {
    "Combat & Bosses": ["combat", "fight", "boss", "bosses", "dodging", "parry", "mechanics"],
    "World & Exploration": ["world", "exploration", "level design", "open world", "metroidvania"],
    "Art & Visuals": ["art", "graphics", "animation", "hand-drawn", "hand drawn", "art style"],
    "Music & Audio": ["music", "soundtrack", "ost", "audio", "sound design"],
    "Story & Writing": ["story", "writing", "lore", "characters", "narrative", "dialogue"],
    "Difficulty": ["difficult", "challenging", "brutal", "easy", "unfair", "hardest"],
    "Controls & Performance": ["controls", "tight controls", "clunky", "buggy", "fps", "crashes"],
    "Map & Navigation / Backtracking": ["map", "navigation", "backtracking", "tedious", "grindy"],
    "Content & Length": ["content", "hours of playtime", "too short", "replay value", "replayability"],
    "Price & Value": ["price", "worth", "cheap", "overpriced", "bargain"],
}
WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike "
         "november oscar papa quebec romeo sierra tango uniform victor whiskey xray").split()
MULTIBYTE = "їжакищоáéîöüßЖпривітмир漢字テスト"
BOUNDARY = ".!?;\n"


# ---------------------------------------------------------------------------------------------
# The OLD expressions, re-derived from the lexicon rather than copy-pasted from an old file.
# ---------------------------------------------------------------------------------------------
def old_sentence_regex(rx: str) -> str:
    """The pre-2026-08-28 excerpt window pattern (== _aspect_sentence_regex in build_marts.py)."""
    return f"[^.!?;\\n]{{0,{SC}}}(?:{rx})[^.!?;\\n]{{0,{SC}}}"


def old_slice_sql(col: str, kw_pos: str) -> str:
    """The generously-bounded slice of `col` around `kw_pos`. Unchanged by the rewrite."""
    return (f"CASE WHEN {kw_pos} - {SB} > 1 "
            f"THEN regexp_replace(substr({col}, {kw_pos} - {SB}, {SL}), '^\\S+', '') "
            f"ELSE substr({col}, 1, {SL}) END")


def kw_pos_sql(col: str, rx: str) -> str:
    """1-based position of the first keyword match (== _aspect_keyword_position_regex)."""
    return f"length(regexp_extract({col}, '^([\\s\\S]*?)(?:{rx})', 1, 'i')) + 1"


def old_window_sql(slice_expr: str, rx: str) -> str:
    return f"regexp_extract({slice_expr}, '{old_sentence_regex(rx)}', 0, 'i')"


def new_window_sql(slice_col: str, rx: str) -> str:
    """The shipped expression, spelled exactly as the ten arms of the .sql spell it."""
    kw_off = f"length(regexp_extract({slice_col}, '^([\\s\\S]*?)(?:{rx})', 1, 'i')) + 1"
    lft = (f"reverse(regexp_extract(reverse(substr({slice_col}, 1, ({kw_off}) - 1)), "
           f"'^[^.!?;\\n]*', 0))")
    rgt = f"regexp_extract(substr({slice_col}, {kw_off}), '^[^.!?;\\n]*', 0)"
    anchored = (f"'^[\\s\\S][\\s\\S]{{0,{SC}}}(?:{rx})[\\s\\S]{{0,{SC}}}'")
    return (f"""CASE WHEN regexp_matches({slice_col}, '{rx}', 'i')
                 THEN substr(regexp_extract(
                          CASE WHEN length({lft}) > {SC}
                               THEN substr({lft} || {rgt}, length({lft}) - {SC})
                               ELSE ' ' || {lft} || {rgt}
                          END, {anchored}, 0, 'i'), 2)
                 ELSE '' END""")


# ---------------------------------------------------------------------------------------------
# Adversarial slice generator
# ---------------------------------------------------------------------------------------------
def adversarial(rng: random.Random, kws: list[str], kind: int) -> str:
    kw = rng.choice(kws)
    if kind == 0:                                     # keyword first
        return kw + " " + " ".join(rng.choice(WORDS) for _ in range(rng.randrange(0, 80)))
    if kind == 1:                                     # keyword last
        return " ".join(rng.choice(WORDS) for _ in range(rng.randrange(0, 80))) + " " + kw
    if kind == 2:                                     # keyword hugged by clause boundaries
        return (" ".join(rng.choice(WORDS) for _ in range(rng.randrange(0, 40)))
                + rng.choice(BOUNDARY) + kw + rng.choice(BOUNDARY)
                + " ".join(rng.choice(WORDS) for _ in range(rng.randrange(0, 40))))
    if kind == 3:                                     # boundary exactly N chars before the keyword
        n = rng.choice([0, 1, SC - 2, SC - 1, SC, SC + 1, SC + 2, SC + 40])
        return ("xx" + rng.choice(BOUNDARY) + "a" * n + " " + kw + " "
                + " ".join(rng.choice(WORDS) for _ in range(rng.randrange(0, 60))))
    if kind == 4:                                     # several keywords inside one clause
        parts: list[str] = []
        for _ in range(rng.randrange(2, 10)):
            parts += [rng.choice(WORDS) for _ in range(rng.randrange(0, 12))]
            parts.append(rng.choice(kws))
        return " ".join(parts)
    if kind == 5:                                     # one very long clause, no boundaries at all
        return (" ".join(rng.choice(WORDS) for _ in range(150)) + " " + kw + " "
                + " ".join(rng.choice(WORDS) for _ in range(150)))
    if kind == 6:                                     # multi-byte around the keyword
        body = "".join(rng.choice(MULTIBYTE) for _ in range(rng.randrange(0, 300)))
        return body[:rng.randrange(0, 200)] + " " + kw + " " + body
    if kind == 7:                                     # boundary soup
        s = list(" ".join(rng.choice(WORDS) for _ in range(60)) + " " + kw + " "
                 + " ".join(rng.choice(WORDS) for _ in range(60)))
        for _ in range(rng.randrange(1, 30)):
            s[rng.randrange(len(s))] = rng.choice(BOUNDARY)
        return "".join(s)
    if kind == 8:                                     # no keyword at all
        return " ".join(rng.choice(WORDS) for _ in range(rng.randrange(0, 80)))
    if kind == 9:                                     # degenerate
        return rng.choice(["", " ", ".", "...", "\n", kw, " " + kw, kw + ".", "?" * 30,
                           kw + kw, kw + "ting", "un" + kw])
    if kind == 10:                                    # keyword only as a substring (must not match)
        return (" ".join(rng.choice(WORDS) for _ in range(20)) + " x" + kw + "y "
                + " ".join(rng.choice(WORDS) for _ in range(20)) + " " + kw)
    return ("".join(rng.choice(WORDS) for _ in range(rng.randrange(1, 40))) + kw
            + "".join(rng.choice(WORDS) for _ in range(rng.randrange(1, 40))))


PER_ARM = 360   # x 10 arms; the OLD regex costs ~0.8ms/row, so this is a couple of seconds


def test_window_expression_matches_the_old_regex():
    rng = random.Random(20260828)
    con = duckdb.connect(":memory:")
    total = 0
    for label, rx in ARMS:
        rows = [(adversarial(rng, KEYWORDS[label], i % 12)[:SL],) for i in range(PER_ARM)]
        con.execute("CREATE OR REPLACE TABLE f(slice VARCHAR)")
        con.executemany("INSERT INTO f VALUES (?)", rows)
        con.execute("CREATE OR REPLACE TABLE f AS SELECT slice, row_number() OVER () AS id FROM f")
        con.execute(f"""CREATE OR REPLACE TABLE cmp AS SELECT id, slice,
            regexp_extract(slice, '{old_sentence_regex(rx)}', 0, 'i') AS old_w,
            {new_window_sql('slice', rx)} AS new_w FROM f""")
        bad = con.execute(
            "SELECT slice, old_w, new_w FROM cmp WHERE old_w IS DISTINCT FROM new_w LIMIT 3"
        ).fetchall()
        assert not bad, (
            f"{label}: the rewritten window disagrees with the old regex\n"
            + "\n".join(f"  slice={s!r}\n    old={o!r}\n    new={n!r}" for s, o, n in bad))
        total += len(rows)
        print(f"[fuzz] {label:34s} {len(rows):5d} adversarial slices, 0 differences")
    print(f"[ok] {total:,} slices x the real ASPECT_LEXICON: the rewritten excerpt window is "
          f"byte-identical to the pre-2026-08-28 regex")


# ---------------------------------------------------------------------------------------------
# End-to-end: the shipped .sql vs the OLD pipeline recomputed from src.reviews
# ---------------------------------------------------------------------------------------------
N_APPIDS = 6
TS = 1_750_000_000
STEAMID = "76561198000000042"


def _fixture(con: duckdb.DuckDBPyConnection) -> None:
    """Adversarial reviews, <= ASPECT_REVIEWS_TOP_K per (appid, aspect, sentiment) so the top-K
    cut keeps every one of them, plus filler to clear TEARDOWN_MIN_REVIEWS. votes_up is unique
    per (appid, review) so the published rows can be joined back to their source review."""
    rng = random.Random(4242)
    con.execute("CREATE SCHEMA src")
    con.execute("""CREATE TABLE src.reviews(
        recommendationid VARCHAR, appid INTEGER, author_steamid VARCHAR,
        playtime_forever INTEGER, playtime_at_review INTEGER, language VARCHAR,
        review_text VARCHAR, timestamp_created BIGINT, votes_up INTEGER)""")
    con.execute("""CREATE TEMP TABLE stg_aspect_mention_sentiment(
        appid INTEGER, recommendationid VARCHAR, aspect VARCHAR, kw_aspect VARCHAR,
        compound DOUBLE, text_sentiment VARCHAR)""")
    reviews, mentions = [], []
    rid = 0
    for a in range(N_APPIDS):
        appid = 9000 + a
        votes = 10_000
        for label, _rx in ARMS:
            for sentiment in ("praise", "complaint"):
                for k in range(bm.ASPECT_REVIEWS_TOP_K):
                    rid += 1
                    votes -= 1
                    r = f"r{rid}"
                    text = adversarial(rng, KEYWORDS[label], (rid + k) % 12)
                    # one review in twelve gets a NULL steamid, and one a >2000-char body
                    sid = None if rid % 12 == 0 else STEAMID
                    if rid % 9 == 0:
                        text = text + " " + " ".join(rng.choice(WORDS) for _ in range(500))
                    # the mart's own pool filter drops blank bodies; keep the fixture inside it so
                    # the expected-side recompute (which has no such filter) stays row-for-row.
                    if not text.strip():
                        text = "x"
                    reviews.append((r, appid, sid, 1200, 900, "english", text, TS, votes))
                    mentions.append((appid, r, label, label, 0.7, sentiment))
        for i in range(bm.TEARDOWN_MIN_REVIEWS):
            rid += 1
            reviews.append((f"f{rid}", appid, STEAMID, 60, 60, "english",
                            "filler that clears the eligibility floor and mentions nothing",
                            TS, -1 - i))
    con.executemany("INSERT INTO src.reviews VALUES (?,?,?,?,?,?,?,?,?)", reviews)
    con.executemany("INSERT INTO stg_aspect_mention_sentiment VALUES (?,?,?,?,?,?)", mentions)


def _expected_sql() -> str:
    """The OLD pipeline, per arm, straight off src.reviews: slice -> unanchored sentence regex ->
    excerpt_body -> the same ellipsis assembly the mart's final SELECT does."""
    arms = []
    for label, rx in ARMS:
        kp = kw_pos_sql("review_text", rx)
        sl = old_slice_sql("review_text", "kw_pos")
        arms.append(f"""
        SELECT r.appid, r.votes_up, '{label.replace("'", "''")}' AS aspect,
            (CASE WHEN win_start > 1 THEN '…' ELSE '' END)
                || trim(excerpt_body)
                || (CASE WHEN win_start > 0 AND win_start + length(excerpt_body) - 1 < text_len
                         THEN '…' ELSE '' END) AS excerpt,
            list_distinct(list_transform(
                regexp_extract_all(excerpt_body, '{rx}', 1, 'i'), x -> lower(x))) AS matched_keywords,
            CASE WHEN length(r.review_text) > 2000
                 THEN substr(r.review_text, 1, 1999) || '…' ELSE r.review_text END AS review_text,
            'https://steamcommunity.com/profiles/' || r.author_steamid
                || '/recommended/' || r.appid || '/' AS steam_url
        FROM (SELECT *,
                {old_window_sql(sl, rx)} AS window_text,
                COALESCE({old_window_sql(sl, rx)}, substr(review_text, 1, {2 * SC})) AS excerpt_body,
                strpos(review_text, {old_window_sql(sl, rx)}) AS win_start,
                length(review_text) AS text_len
              FROM (SELECT *, {kp} AS kw_pos FROM src.reviews)
              WHERE recommendationid LIKE 'r%') r
        JOIN stg_aspect_mention_sentiment m
          ON m.appid = r.appid AND m.recommendationid = r.recommendationid
         AND m.aspect = '{label.replace("'", "''")}'""")
    return "CREATE TABLE expected AS " + "\nUNION ALL".join(arms)


def test_shipped_mart_excerpts_match_the_old_pipeline():
    con = duckdb.connect(":memory:")
    _fixture(con)
    con.execute(bm.render((ETL / "marts" / "mart_game_aspect_reviews.sql").read_text(),
                          bm.build_params()))
    con.execute(_expected_sql())

    n_mart = con.execute("SELECT count(*) FROM mart_game_aspect_reviews").fetchone()[0]
    n_exp = con.execute("SELECT count(*) FROM expected").fetchone()[0]
    print(f"\n[e2e] mart rows={n_mart}  expected rows={n_exp}")
    assert n_mart == n_exp, (n_mart, n_exp)

    cols = ["excerpt", "matched_keywords", "review_text", "steam_url"]
    pred = " OR ".join(f"a.{c} IS DISTINCT FROM e.{c}" for c in cols)
    bad = con.execute(f"""
        SELECT a.appid, a.aspect, a.votes_up, a.excerpt, e.excerpt, a.matched_keywords,
               e.matched_keywords, a.review_text, e.review_text, a.steam_url, e.steam_url
        FROM mart_game_aspect_reviews a
        JOIN expected e ON e.appid = a.appid AND e.votes_up = a.votes_up AND e.aspect = a.aspect
        WHERE {pred} LIMIT 5""").fetchall()
    assert not bad, "shipped mart disagrees with the old pipeline:\n" + "\n".join(map(repr, bad))

    # Every published row must have found its partner (guards against a silently dropped join).
    orphan = con.execute("""
        SELECT count(*) FROM mart_game_aspect_reviews a
        LEFT JOIN expected e ON e.appid = a.appid AND e.votes_up = a.votes_up AND e.aspect = a.aspect
        WHERE e.appid IS NULL""").fetchone()[0]
    assert orphan == 0, orphan

    n_null = con.execute(
        "SELECT count(*) FROM mart_game_aspect_reviews WHERE steam_url IS NULL").fetchone()[0]
    n_trunc = con.execute(
        "SELECT count(*) FROM mart_game_aspect_reviews WHERE review_text LIKE '%…'").fetchone()[0]
    assert n_null > 0, "fixture no longer exercises the NULL author_steamid permalink rule"
    assert n_trunc > 0, "fixture no longer exercises the 2000-char truncation"
    print(f"[ok] {n_mart} published rows match the pre-2026-08-28 pipeline exactly "
          f"(incl. {n_null} NULL-steamid rows and {n_trunc} truncated review_text rows)")


if __name__ == "__main__":
    test_window_expression_matches_the_old_regex()
    test_shipped_mart_excerpts_match_the_old_pipeline()
    print("\n[PASS]")
