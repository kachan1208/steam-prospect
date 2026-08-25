"""mart_game_aspect_reviews' full-review columns — the truncation cap and the permalink shape.

The aspect drill-down shows one sentence around the matched keyword; `review_text` + `steam_url`
are what let a reader open the whole review instead. Both are cheap to get subtly wrong in ways no
one notices until production: an off-by-one cap that emits 2001 characters, a byte-based truncation
that splits a Cyrillic codepoint in half, or a permalink concatenated from a NULL author_steamid
into `.../profiles//recommended/...`, which is a live-looking link that 404s.

Rebuilding the real mart is a 2-3h ETL, so this renders the REAL etl/marts/mart_game_aspect_reviews.
sql through build_marts.render()/build_params() over a hand-built in-memory fixture — the same
approach as test_mart_niche_game.py. It fails on the file that actually ships, not on a copy, and
needs no source database and no network.

The fixture is built so every assertion is checkable on paper: review lengths sit exactly ON the
2000-char boundary (1999 / 2000 / 2001), one review has a NULL author_steamid, and one is pure
multi-byte text whose byte length is triple its character length.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Derived from this file's own location (tests/ lives inside etl/) — a hardcoded absolute
# path here passed locally and failed every CI run with FileNotFoundError.
ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

CAP = 2000  # the cap the mart file hardcodes; see its header for why it is not a placeholder.

APPID = 7001
STEAMID = "76561198000000042"
TS = 1_750_000_000  # 2025-06-15 in epoch seconds


def combat_text(n: int) -> str:
    """An English review of EXACTLY n characters that contains a Combat & Bosses keyword."""
    head = "The combat here is excellent and the bosses hit hard. "
    assert n >= len(head), n
    return head + "x" * (n - len(head))


def art_text(n: int, fill: str = "y") -> str:
    """Same, for the Art & Visuals arm. `fill` lets a caller make the padding multi-byte."""
    head = "The art direction is gorgeous. "
    assert n >= len(head), n
    return head + fill * (n - len(head))


# ---------------------------------------------------------------------------------------------
# Fixture reviews. The first six carry an aspect mention; the rest are filler that exists only to
# push the game over TEARDOWN_MIN_REVIEWS (the mart's eligibility floor counts src.reviews rows,
# not mentions). votes_up is descending inside each (aspect, sentiment) group so the top-K cut
# keeps all of them — there are exactly ASPECT_REVIEWS_TOP_K=4 in Combat and 2 in Art.
#
# key, recommendationid, author_steamid, review_text, votes_up, aspect, sentiment
# ---------------------------------------------------------------------------------------------
MENTIONS = [
    ("under",    "r_under",    STEAMID, combat_text(CAP - 1), 100, "Combat & Bosses", "praise"),
    ("exact",    "r_exact",    STEAMID, combat_text(CAP),      90, "Combat & Bosses", "praise"),
    ("over_one", "r_over_one", STEAMID, combat_text(CAP + 1),  80, "Combat & Bosses", "praise"),
    ("huge",     "r_huge",     STEAMID, combat_text(50_000),   70, "Combat & Bosses", "praise"),
    ("no_sid",   "r_no_sid",   None,    art_text(300),         60, "Art & Visuals",   "praise"),
    # 3000 Cyrillic characters = 6000+ bytes: proves the cap counts characters, not bytes.
    ("unicode",  "r_unicode",  STEAMID, art_text(3000, "ї"),   50, "Art & Visuals",   "praise"),
]

N_FILLER = 25  # TEARDOWN_MIN_REVIEWS is 20; comfortably over, and none of them mention anything.


def build_fixture(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE SCHEMA src")
    con.execute(
        """
        CREATE TABLE src.reviews(
            recommendationid VARCHAR, appid INTEGER, author_steamid VARCHAR,
            playtime_forever INTEGER, playtime_at_review INTEGER, language VARCHAR,
            review_text VARCHAR, timestamp_created BIGINT, votes_up INTEGER)
        """
    )
    rows = [
        (rid, APPID, sid, 1200, 900, "english", text, TS, votes)
        for (_key, rid, sid, text, votes, _aspect, _sent) in MENTIONS
    ]
    rows += [
        (f"r_filler_{i}", APPID, STEAMID, 60, 60, "english",
         "Nothing quoted from this one; it only exists to clear the eligibility floor.",
         TS, 0)
        for i in range(N_FILLER)
    ]
    con.executemany("INSERT INTO src.reviews VALUES (?,?,?,?,?,?,?,?,?)", rows)

    # Exactly as compute_aspect_sentiment() materialises it (appid, recommendationid, aspect,
    # kw_aspect, compound, text_sentiment). kw_aspect == aspect here: the keyword arm that cut
    # each window is the arm the model agreed with.
    con.execute(
        """
        CREATE TEMP TABLE stg_aspect_mention_sentiment(
            appid INTEGER, recommendationid VARCHAR, aspect VARCHAR, kw_aspect VARCHAR,
            compound DOUBLE, text_sentiment VARCHAR)
        """
    )
    con.executemany(
        "INSERT INTO stg_aspect_mention_sentiment VALUES (?,?,?,?,?,?)",
        [(APPID, rid, aspect, aspect, 0.7, sent)
         for (_key, rid, _sid, _text, _votes, aspect, sent) in MENTIONS],
    )


def main() -> int:
    con = duckdb.connect(":memory:")
    build_fixture(con)

    params = bm.build_params()
    sql = bm.render((ETL / "marts" / "mart_game_aspect_reviews.sql").read_text(), params)
    con.execute(sql)
    print("[fixture] executed mart_game_aspect_reviews.sql")
    print(f"[fixture] TEARDOWN_MIN_REVIEWS={bm.TEARDOWN_MIN_REVIEWS}  "
          f"ASPECT_REVIEWS_TOP_K={bm.ASPECT_REVIEWS_TOP_K}  cap={CAP}")

    # ---- 1. contract: the two new columns exist, are VARCHAR, and nothing else moved --------
    schema = con.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = 'mart_game_aspect_reviews' ORDER BY ordinal_position"
    ).fetchall()
    print("\n[schema] mart_game_aspect_reviews")
    for name, dtype in schema:
        print(f"           {name:<17} {dtype}")
    expected = [
        ("appid", "INTEGER"), ("aspect", "VARCHAR"), ("sentiment", "VARCHAR"),
        ("excerpt", "VARCHAR"), ("matched_keywords", "VARCHAR[]"), ("votes_up", "INTEGER"),
        ("playtime_minutes", "INTEGER"), ("date", "VARCHAR"), ("language", "VARCHAR"),
        ("review_text", "VARCHAR"), ("steam_url", "VARCHAR"),
    ]
    assert schema == expected, f"schema mismatch:\n  got      {schema}\n  expected {expected}"
    print("[ok] review_text + steam_url present; the pre-existing 9 columns are unchanged")

    rows = con.execute(
        "SELECT aspect, sentiment, votes_up, excerpt, review_text, steam_url "
        "FROM mart_game_aspect_reviews ORDER BY aspect, votes_up DESC"
    ).fetchall()
    by_votes = {r[2]: r for r in rows}
    got = {key: by_votes[votes]
           for (key, _rid, _sid, _text, votes, _a, _s) in MENTIONS}
    print(f"\n[rows] mart_game_aspect_reviews = {len(rows)} "
          f"(every one of the {len(MENTIONS)} mentions survived the top-K cut)")
    assert len(rows) == len(MENTIONS), rows

    # ---- 2. the truncation boundary --------------------------------------------------------
    print("\n[cap] key        source_len  stored_len  truncated  last_char")
    for key, _rid, _sid, source, _votes, _a, _s in MENTIONS:
        stored = got[key][4]
        truncated = stored.endswith("…")
        print(f"      {key:<10} {len(source):>10} {len(stored):>11}  {str(truncated):<9}  "
              f"{stored[-1]!r}")
        assert len(stored) <= CAP, f"{key}: {len(stored)} chars exceeds the {CAP} cap"

    # Under and exactly AT the cap: stored verbatim, no ellipsis, nothing lost.
    for key in ("under", "exact"):
        source = dict((k, t) for k, _r, _s, t, _v, _a, _sn in MENTIONS)[key]
        assert got[key][4] == source, f"{key} was altered despite fitting under the cap"
        assert not got[key][4].endswith("…"), f"{key} got a spurious ellipsis"
    assert len(got["exact"][4]) == CAP
    print(f"[ok] <= {CAP} chars is stored verbatim (the {CAP}-char review is NOT truncated)")

    # One character over: truncated, and the ellipsis is INSIDE the budget (2000 total, not 2001).
    src_over = combat_text(CAP + 1)
    stored_over = got["over_one"][4]
    assert len(stored_over) == CAP, len(stored_over)
    assert stored_over.endswith("…")
    assert stored_over[:-1] == src_over[: CAP - 1], "truncation did not keep the leading text"
    print(f"[ok] {CAP + 1} chars -> exactly {CAP} stored, ellipsis included in the budget")

    stored_huge = got["huge"][4]
    assert len(stored_huge) == CAP and stored_huge.endswith("…")
    print(f"[ok] a 50,000-char review is bounded to {CAP} (this is the 9.6MB-review case)")

    # Multi-byte: the cap counts CHARACTERS. A byte-based substr would emit ~666 characters here
    # (or a mangled half-codepoint); a character-based one emits exactly CAP.
    stored_uni = got["unicode"][4]
    print(f"[unicode] stored chars={len(stored_uni)}  "
          f"bytes={len(stored_uni.encode('utf-8'))}  last_char={stored_uni[-1]!r}")
    assert len(stored_uni) == CAP, len(stored_uni)
    assert stored_uni.endswith("…")
    assert len(stored_uni.encode("utf-8")) > CAP, "fixture is not actually multi-byte"
    print(f"[ok] the cap is character-based — {CAP} chars / "
          f"{len(stored_uni.encode('utf-8'))} bytes, no split codepoint")

    # ---- 3. the permalink shape ------------------------------------------------------------
    print("\n[url] key        steam_url")
    for key in got:
        print(f"      {key:<10} {got[key][5]!r}")
    want = f"https://steamcommunity.com/profiles/{STEAMID}/recommended/{APPID}/"
    for key in ("under", "exact", "over_one", "huge", "unicode"):
        assert got[key][5] == want, f"{key}: {got[key][5]!r} != {want!r}"
    print(f"[ok] steam_url == {want}")

    # The whole reason to build the URL with NULL-propagating `||`: no author_steamid, no link.
    assert got["no_sid"][5] is None, f"NULL author_steamid produced {got['no_sid'][5]!r}"
    assert got["no_sid"][4] is not None, "a NULL steam_url must not take review_text with it"
    print("[ok] NULL author_steamid -> steam_url IS NULL (not a '/profiles//recommended/' link), "
          "and review_text is still served")

    # ---- 4. review_text is the WHOLE review, not the excerpt --------------------------------
    print("\n[excerpt vs full] key        excerpt_len  review_text_len")
    for key, _rid, _sid, _text, _votes, _a, _s in MENTIONS:
        excerpt, full = got[key][3], got[key][4]
        print(f"                  {key:<10} {len(excerpt):>11} {len(full):>16}")
        assert full is not None and len(full) >= len(excerpt.strip("…")), key
    assert got["under"][3] != got["under"][4], "review_text must not be a copy of the excerpt"
    print("[ok] review_text carries the full review; excerpt still carries the keyword window")

    # ---- 5. the intermediate text tables were released --------------------------------------
    # Only the TEXT-carrying temps matter here — those are the ones that would hold a second and
    # third ~530MB copy of the review corpus alive on a 3.9GB droplet. (_aspectrev_elig is a list
    # of appids and _aspectrev_ranked is ranking meta with no text; the mart file has always left
    # those to the session teardown.)
    text_temps = ["_aspectrev_base", "_aspectrev_meta", "_aspectrev_surv",
                  "_aspectrev_matched", "_aspectrev_windowed"]
    alive = {r[0] for r in con.execute(
        "SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '_aspectrev%'"
    ).fetchall()}
    print(f"\n[temps] surviving _aspectrev* tables: {sorted(alive)}")
    leftover = [t for t in text_temps if t in alive]
    assert not leftover, f"a full-text temp table outlived the mart build: {leftover}"
    print("[ok] every text-carrying _aspectrev* temp is dropped — one full-text structure at a time")

    print("\n[PASS] mart_game_aspect_reviews.review_text / .steam_url satisfy the contract.")
    con.close()
    return 0


def test_mart_aspect_reviews_full_text():
    """pytest entry point; main() asserts internally and returns 0 only when every check passed."""
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())
