"""Tag/genre spelling twins publish as ONE niche — enforced through the real staging.

The regression (2026-09-22 review): Steam respelled tags (Rogue-like -> Roguelike, Base-Building
-> Base Building, Mouse only -> Mouse Only, Vampire -> Vampires ...), and the catalog holds tag
sets scraped before and after. staging normalised only '&amp;' and trailing spaces, so each tag
published as two niches with opposite FAKE trends — the new spelling sits on the recent games
(Roguelike +1,610.9% demand, sat_yoy +3.88), the old one on the back catalog (Rogue-like -0.6%,
Base-Building sat_yoy -0.38): a boom and a collapse, neither real.

This runs the REAL build_marts.create_staging() over a synthetic src schema, then the real
mart_niche.sql and mart_tag_alias.sql on top, and pins:
  1. one canonical niche per twin key, with the UNION of both spellings' games;
  2. the canonical name is the spelling the most recent games carry (Steam's current one),
     then most votes, then alphabetical — deterministic;
  3. a game carrying both spellings keeps one (appid, tag) row at MAX(votes);
  4. every retired spelling resolves through mart_tag_alias (spelling vs rename reason);
  5. the curated tier map and the denylist apply to EVERY spelling of a tag;
  6. the 'Singleplayer' fallback matches any spelling;
  7. NICHE_TWIN_EXCEPTIONS keeps a listed spelling apart, and a TAG_TIER that gives two
     spellings of one tag different tiers fails the build.
No source database and no network needed.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

TODAY = date.today()
OLD = range(1, 61)        # back catalog: first public 2016-2019
RECENT = range(61, 101)   # released within the last few months


def _src(con: duckdb.DuckDBPyConnection, tag_rows: list[tuple[int, str, int]],
         genre_rows: list[tuple[int, str]] | None = None) -> None:
    """The src tables create_staging() reads, for 100 games (no optional tables)."""
    con.execute("CREATE SCHEMA src")
    con.execute(
        "CREATE TABLE src.games(appid INTEGER, name VARCHAR, type VARCHAR, release_date VARCHAR,"
        " price_initial INTEGER, is_free INTEGER, developers VARCHAR, publishers VARCHAR,"
        " metacritic_score INTEGER, achievements_count INTEGER, categories VARCHAR,"
        " header_image VARCHAR)")
    rows = []
    for a in list(OLD) + list(RECENT):
        d = (date(2016 + a % 4, 1 + a % 12, 1 + a % 28) if a in OLD
             else TODAY - timedelta(days=30 + (a - 61) * 3))
        # game 7 has no Steam categories, so its is_singleplayer comes from the tag fallback
        rows.append((a, f"Game {a}", "game", d.strftime("%b %d, %Y"), 999, 0, "Dev", "Pub",
                     None, None, "" if a == 7 else "Multi-player", None))
    con.executemany("INSERT INTO src.games VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute(
        "CREATE TABLE src.analysis_games(appid INTEGER, name VARCHAR, release_year INTEGER,"
        " release_date_iso VARCHAR, price_initial DOUBLE, is_free INTEGER, developers VARCHAR,"
        " publishers VARCHAR, self_published INTEGER, dev_game_count INTEGER, is_indie INTEGER,"
        " metacritic_score INTEGER, achievements_count INTEGER, owners_mid DOUBLE,"
        " est_rev_owners DOUBLE, avg_playtime_forever DOUBLE, ccu INTEGER, tag_count INTEGER,"
        " total_reviews INTEGER, positive_reviews INTEGER, negative_reviews INTEGER,"
        " positive_ratio DOUBLE)")
    con.execute("CREATE TABLE src.game_genres(appid INTEGER, genre VARCHAR)")
    con.executemany("INSERT INTO src.game_genres VALUES (?, ?)",
                    genre_rows if genre_rows is not None
                    else [(a, "Indie") for a in list(OLD) + list(RECENT)])
    con.execute("CREATE TABLE src.game_tags(appid INTEGER, tag VARCHAR, votes INTEGER)")
    if tag_rows:
        con.executemany("INSERT INTO src.game_tags VALUES (?, ?, ?)", tag_rows)
    con.execute(
        "CREATE TABLE src.reviews(appid INTEGER, recommendationid VARCHAR, voted_up INTEGER,"
        " timestamp_created BIGINT, language VARCHAR, playtime_at_review INTEGER,"
        " playtime_forever INTEGER, review_text VARCHAR)")
    con.execute("CREATE TABLE src.review_summary(appid INTEGER, total_reviews INTEGER,"
                " total_positive INTEGER, total_negative INTEGER)")
    con.executemany("INSERT INTO src.review_summary VALUES (?, 200, 150, 50)",
                    [(a,) for a in list(OLD) + list(RECENT)])
    con.execute("CREATE TABLE src.articles(id BIGINT, source VARCHAR, author VARCHAR,"
                " title VARCHAR, url VARCHAR, summary VARCHAR, published_at VARCHAR)")
    con.execute("CREATE TABLE src.article_game_mentions(article_id BIGINT, appid INTEGER,"
                " match_confidence DOUBLE)")


def _twin_tags() -> list[tuple[int, str, int]]:
    """Old spellings on the back catalog with REAL (large) votes, new spellings on the recent
    games with synthetic N..1 votes — the exact shape of the SteamSpy vs store-page split."""
    t: list[tuple[int, str, int]] = []
    for a in OLD:
        t.append((a, "Rogue-like", 150))
        if a <= 40:
            t.append((a, "Base-Building", 120))
        if a <= 35:
            t += [(a, "Mouse only", 30), (a, "Vampire", 90), (a, "Point &amp; Click", 40),
                  (a, "Dystopian ", 25), (a, "L-E-G-O", 60)]
        # a twin pair with NO recent carrier at all: the tiebreak falls to votes
        t.append((a, "Hand-drawn" if a <= 45 else "Hand drawn", 50 if a <= 45 else 5))
    for a in RECENT:
        t += [(a, "Roguelike", 15), (a, "Vampires", 14), (a, "Base Building", 13)]
        if a <= 70:
            t.append((a, "Mouse Only", 12))
        t.append((a, "Point & Click", 11))
    # game 5 carries BOTH roguelike spellings (a merge must keep ONE row, at MAX votes)
    t.append((5, "Roguelike", 20))
    # the Singleplayer fallback must match any spelling
    t.append((7, "singleplayer", 9))
    return t


def _mart_niche(con: duckdb.DuckDBPyConnection, params: dict) -> None:
    """Stand-ins for what earlier MART_FILES provide, then the real mart_niche.sql and
    mart_tag_alias.sql (same pattern as test_genre_denylist.py)."""
    bm.create_timing_staging(con)
    con.execute("CREATE TABLE mart_game(appid INTEGER, playtime_p50 DOUBLE)")
    con.execute("INSERT INTO mart_game SELECT appid, 120.0 FROM stg_game")
    con.execute(
        "CREATE TEMP TABLE _niche_players_now(dimension VARCHAR, key VARCHAR,"
        " total_players_now BIGINT, players_coverage DOUBLE, players_trend_7d_pct DOUBLE,"
        " median_players_now DOUBLE, players_top5_share DOUBLE,"
        " players_trend_7d_market_pct DOUBLE)")
    con.execute(
        "CREATE TEMP TABLE _niche_lifetime(dimension VARCHAR, key VARCHAR,"
        " lifetime_n_games BIGINT, lifetime_survival_12m DOUBLE,"
        " lifetime_median_dead_months DOUBLE)")
    for fname in ("mart_niche.sql", "mart_tag_alias.sql"):
        con.execute(bm.render((ETL / "marts" / fname).read_text(), params))


@pytest.fixture(scope="module")
def built():
    con = duckdb.connect(":memory:")
    _src(con, _twin_tags())
    params = bm.build_params()
    bm.create_staging(con, params)
    _mart_niche(con, params)
    yield con
    con.close()


def _niche(con, key, win="all", min_reviews=0):
    row = con.execute(
        "SELECT n_games, tier FROM mart_niche WHERE dimension = 'tag' AND key = ? "
        "AND win = ? AND min_reviews = ?", [key, win, min_reviews]).fetchone()
    return row


def test_twins_publish_as_one_niche_under_the_current_spelling(built):
    con = built
    keys = {k for (k,) in con.execute(
        "SELECT DISTINCT key FROM mart_niche WHERE dimension = 'tag'").fetchall()}
    # canonical = the spelling the RECENT games carry (Steam's current vocabulary)
    for canonical, retired in [("Roguelike", "Rogue-like"), ("Base Building", "Base-Building"),
                               ("Mouse Only", "Mouse only"), ("Vampires", "Vampire"),
                               ("Point & Click", "Point &amp; Click")]:
        assert canonical in keys, f"{canonical} not published: {sorted(keys)}"
        assert retired not in keys, f"retired twin {retired!r} still publishes as its own niche"
    # no recent carrier on either side -> most votes wins
    assert "Hand-drawn" in keys and "Hand drawn" not in keys, sorted(keys)
    # trailing space: one niche, trimmed
    assert "Dystopian" in keys and "Dystopian " not in keys

    # the merged niche holds the UNION of both spellings' games — 60 old + 40 recent
    assert _niche(con, "Roguelike")[0] == 100
    assert _niche(con, "Base Building")[0] == 40 + 40
    assert _niche(con, "Mouse Only")[0] == 35 + 10
    assert _niche(con, "Vampires")[0] == 35 + 40
    # ...and the 24m cut sees the old spelling's games only if they are recent (none are)
    assert _niche(con, "Roguelike", "24m")[0] == 40


def test_a_game_carrying_both_spellings_keeps_one_row_at_max_votes(built):
    rows = built.execute(
        "SELECT tag, votes FROM stg_game_tags WHERE appid = 5 AND tag ILIKE 'rogue%'").fetchall()
    assert rows == [("Roguelike", 150)], rows
    ranks = built.execute(
        "SELECT COUNT(*), COUNT(DISTINCT rank) FROM stg_game_tags WHERE appid = 5").fetchone()
    assert ranks[0] == ranks[1], "rank must be recomputed densely after the merge"


def test_every_retired_spelling_resolves_through_mart_tag_alias(built):
    alias = {(a, c, r) for a, c, r in built.execute(
        "SELECT alias, canonical, reason FROM mart_tag_alias WHERE dimension = 'tag'").fetchall()}
    assert ("Rogue-like", "Roguelike", "spelling") in alias
    assert ("Base-Building", "Base Building", "spelling") in alias
    assert ("Mouse only", "Mouse Only", "spelling") in alias
    assert ("Hand drawn", "Hand-drawn", "spelling") in alias
    assert ("Vampire", "Vampires", "rename") in alias, "a curated rename must say so"
    # the HTML-entity / trailing-space forms are cleaned BEFORE keying, so they are not
    # "spellings" of anything — no alias rows for them
    assert not [a for a in alias if "&amp;" in a[0] or a[0].endswith(" ")], alias
    # an alias never points at a key that does not exist, and never at itself
    dangling = built.execute(
        "SELECT COUNT(*) FROM mart_tag_alias a WHERE a.alias = a.canonical OR NOT EXISTS ("
        "SELECT 1 FROM stg_game_tags t WHERE t.tag = a.canonical)").fetchone()[0]
    assert dangling == 0
    n = built.execute(
        "SELECT n_games FROM mart_tag_alias WHERE alias = 'Rogue-like'").fetchone()[0]
    assert n == 60, f"n_games must count the alias spelling's own carriers, got {n}"


def test_tier_map_and_denylist_apply_to_every_spelling(built):
    # TAG_TIER curates 'Vampire' (theme) and 'Mouse only' (meta) — spellings the canonical
    # names do not use. Before the re-keying, 'Vampires' fell to the size heuristic (micro).
    assert _niche(built, "Vampires")[1] == "theme"
    assert _niche(built, "Mouse Only")[1] == "meta"
    assert _niche(built, "Roguelike")[1] == "umbrella"
    # DENYLIST_TAG has 'LEGO'; 'L-E-G-O' folds onto the same key and must be denied too
    leaked = built.execute(
        "SELECT COUNT(*) FROM stg_tag_membership WHERE tag IN ('L-E-G-O', 'LEGO')").fetchone()[0]
    assert leaked == 0, "a respelled denylisted tag leaked into niche membership"


def test_singleplayer_fallback_matches_any_spelling(built):
    assert built.execute(
        "SELECT is_singleplayer FROM stg_game WHERE appid = 7").fetchone()[0] is True


def test_exceptions_keep_a_listed_spelling_apart(monkeypatch):
    monkeypatch.setattr(bm, "NICHE_TWIN_EXCEPTIONS", [("tag", "Coop")])
    tags = [(a, "Co-op", 40) for a in range(1, 36)] + [(a, "Coop", 40) for a in range(36, 71)]
    con = duckdb.connect(":memory:")
    _src(con, tags)
    params = bm.build_params()
    bm.create_staging(con, params)
    _mart_niche(con, params)
    keys = {k for (k,) in con.execute(
        "SELECT DISTINCT key FROM mart_niche WHERE dimension = 'tag'").fetchall()}
    assert {"Co-op", "Coop"} <= keys, f"the exception did not keep 'Coop' apart: {sorted(keys)}"
    assert con.execute("SELECT COUNT(*) FROM mart_tag_alias").fetchone()[0] == 0
    con.close()

    # ...and without the exception the same two spellings merge (the control)
    monkeypatch.setattr(bm, "NICHE_TWIN_EXCEPTIONS", [])
    con = duckdb.connect(":memory:")
    _src(con, tags)
    bm.create_staging(con, params)
    merged = {k for (k,) in con.execute("SELECT DISTINCT tag FROM stg_game_tags").fetchall()}
    assert len(merged) == 1, merged
    con.close()


def test_a_tier_conflict_between_spellings_fails_the_build(monkeypatch):
    monkeypatch.setattr(bm, "TAG_TIER", {**bm.TAG_TIER, "Rogue-like": "micro",
                                         "Roguelike": "umbrella"})
    con = duckdb.connect(":memory:")
    _src(con, _twin_tags())
    with pytest.raises(ValueError, match="conflicting tiers"):
        bm.create_staging(con, bm.build_params())
    con.close()


def test_genres_fold_the_same_way_and_the_denylist_still_holds():
    # 'strategy ' (case + trailing space) on 20 back-catalog games; 'Strategy' on the rest,
    # recent ones included -> one genre, under the spelling the recent games carry
    genres = ([(a, "Strategy") for a in list(range(1, 21)) + list(range(41, 81))]
              + [(a, "strategy ") for a in range(21, 41)]
              + [(a, "Early-Access") for a in range(1, 81)] + [(a, "Indie") for a in range(1, 101)])
    con = duckdb.connect(":memory:")
    _src(con, [], genre_rows=genres)
    bm.create_staging(con, bm.build_params())
    got = dict(con.execute(
        "SELECT genre, COUNT(*) FROM stg_genre_membership GROUP BY 1").fetchall())
    assert got.get("Strategy") == 80 and "strategy " not in got and "strategy" not in got, got
    assert not [g for g in got if g.lower().replace("-", " ") == "early access"], (
        f"'Early-Access' folds onto the denylisted 'Early Access' key and must be dropped: {got}")
    con.close()
