"""Press "n_articles" counts ARTICLES — one roundup covering five member games is one article.

The regression (2026-09-22 review): mart_niche_press summed the per-game press counts, i.e.
counted (article, game) PAIRS, so a single "10 best roguelikes" feature added 10 to the
Roguelike niche's n_articles. mart_press's outlet x genre and author x genre tables had the same
COUNT(*) over the same pairs — and the author table's >= PRESS_AUTHOR_MIN_ARTICLES floor could be
cleared by ONE roundup. All three now count DISTINCT article ids.

Renders the REAL mart_niche_press.sql and mart_press.sql over hand-built staging (no source DB).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

# (article_id, author, published_at, [appids it mentions]) — all from outlet 'ign'
ARTICLES = [
    (1, "Jane Roundup", "2025-06-03 10:00:00", [1, 2, 3]),   # one roundup, three member games
    (2, "Bob Writer", "2025-06-10 10:00:00", [4]),
    (3, "Bob Writer", "2025-06-17 10:00:00", [5]),
    (4, "Bob Writer", "2025-06-24 10:00:00", [6]),
    (5, "Ann Other", "2025-07-02 10:00:00", [1]),
]
N_GAMES = 6


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect(":memory:")
    c.execute("CREATE SCHEMA src")
    # --- the shared press base (create_staging's stg_press_base shape) ------------------
    c.execute("CREATE TEMP TABLE stg_press_base(appid INTEGER, article_id BIGINT, source VARCHAR,"
              " author VARCHAR, title VARCHAR, url VARCHAR, published_at TIMESTAMP,"
              " match_confidence DOUBLE)")
    for aid, author, ts, appids in ARTICLES:
        for appid in appids:
            c.execute("INSERT INTO stg_press_base VALUES (?, ?, 'ign', ?, ?, ?, ?, 0.9)",
                      [appid, aid, author, f"article {aid}", f"http://ign/{aid}", ts])
    # --- what mart_niche_press reads besides it -----------------------------------------
    c.execute("CREATE TABLE mart_game(appid INTEGER, top_tags VARCHAR[], primary_genre VARCHAR)")
    c.executemany("INSERT INTO mart_game VALUES (?, ['Roguelike'], 'Action')",
                  [(a,) for a in range(1, N_GAMES + 1)])
    # --- what mart_press reads besides it -----------------------------------------------
    c.execute("CREATE TEMP TABLE stg_genre_membership(appid INTEGER, genre VARCHAR)")
    c.executemany("INSERT INTO stg_genre_membership VALUES (?, 'Action')",
                  [(a,) for a in range(1, N_GAMES + 1)])
    c.execute("CREATE TEMP TABLE stg_game(appid INTEGER, est_rev_reviews DOUBLE,"
              " owners_mid DOUBLE, positive_ratio DOUBLE)")
    c.executemany("INSERT INTO stg_game VALUES (?, 100000.0, 20000.0, 0.8)",
                  [(a,) for a in range(1, N_GAMES + 1)])
    c.execute("CREATE TABLE src.articles(id BIGINT, source VARCHAR, title VARCHAR,"
              " published_at VARCHAR)")
    c.execute("CREATE TABLE src.game_genres(appid INTEGER, genre VARCHAR)")
    c.execute("CREATE TEMP TABLE stg_game_tags(appid INTEGER, tag VARCHAR, votes INTEGER,"
              " rank INTEGER)")
    c.execute("CREATE TEMP TABLE stg_niche_alias(dimension VARCHAR, alias VARCHAR,"
              " canonical VARCHAR, reason VARCHAR, n_games BIGINT)")
    for name, col in (("stopword", "word"), ("denylist_buzz_term", "term"),
                      ("denylist_buzz_word", "word"), ("denylist_tag", "tag"),
                      ("denylist_genre", "genre")):
        c.execute(f"CREATE TEMP TABLE {name}({col} VARCHAR)")
    params = bm.build_params()
    for fname in ("mart_press.sql", "mart_niche_press.sql"):
        c.execute(bm.render((ETL / "marts" / fname).read_text(), params))
    yield c
    c.close()


def test_niche_timeline_counts_each_article_once(con):
    rows = con.execute("SELECT month, n_articles, n_games_covered FROM mart_niche_press "
                       "WHERE dimension = 'tag' AND key = 'Roguelike' ORDER BY month").fetchall()
    # June: articles 1-4 (the pair-sum used to read 3 + 1 + 1 + 1 = 6); July: article 5
    assert rows == [("2025-06", 4, 6), ("2025-07", 1, 1)], rows


def test_niche_outlets_count_each_article_once(con):
    row = con.execute("SELECT n_articles, n_games_covered, last_article_at FROM "
                      "mart_niche_press_outlets WHERE dimension = 'tag' AND key = 'Roguelike' "
                      "AND source = 'ign'").fetchone()
    assert row[:2] == (5, 6), f"5 distinct articles over 6 games (the pair-sum read 7): {row}"
    assert row[2].startswith("2025-07-02"), row


def test_outlet_genre_counts_each_article_once(con):
    row = con.execute("SELECT n_articles, n_games_covered FROM mart_press_outlet_genre "
                      "WHERE source = 'ign' AND genre = 'Action'").fetchone()
    assert row == (5, 6), row


def test_one_roundup_does_not_clear_the_author_floor(con):
    authors = dict(con.execute(
        "SELECT author, n_articles FROM mart_press_author WHERE genre = 'Action'").fetchall())
    assert bm.PRESS_AUTHOR_MIN_ARTICLES == 3, "fixture assumes the 3-article floor"
    # Jane wrote ONE article that mentions three games: 3 pairs, 1 article -> below the floor
    assert "Jane Roundup" not in authors, authors
    # Bob wrote three separate articles -> clears it, counted as 3
    assert authors.get("Bob Writer") == 3, authors
