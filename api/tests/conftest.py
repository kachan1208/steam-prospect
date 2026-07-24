"""Shared pytest fixtures for the API test suite.

Points the app at a SMALL, synthetic, in-repo-built DuckDB (a handful of rows in just the
mart_* tables the tested routers read) instead of the real ~176MB data/current.duckdb, and
at a scratch SQLite file for the control plane — so the suite runs standalone, with no
dependency on `task etl` or any local data/ directory. Every table/column here was read
straight off api/app/analytics_db.py + the router SQL it's paired with (see the comment
above each CREATE TABLE) — not the full ETL schema, just what's actually queried.

Ordering matters a lot in this file: api/app/config.py's `Settings` (env_prefix="PROSPECT_")
is instantiated once at import time as a module-level singleton, and
api/app/analytics_db.py (opened in main.py's lifespan) keys off
`settings.analytics_db_path`. So the env vars below MUST be set, and the fixture mart file
MUST already exist on disk, before `app.main` (or anything importing `app.config`) is
imported anywhere in this process. That's why the env/DB setup happens at module level in
this conftest, ahead of the `from app.main import app` at the bottom.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import duckdb
import pytest

_TMP_DIR = Path(tempfile.mkdtemp(prefix="prospect_api_tests_"))
ANALYTICS_DB_PATH = _TMP_DIR / "fixture_mart.duckdb"
CONTROL_DB_PATH = _TMP_DIR / "fixture_control.db"

os.environ["PROSPECT_ANALYTICS_DB_PATH"] = str(ANALYTICS_DB_PATH)
os.environ["PROSPECT_CONTROL_DSN"] = f"sqlite:///{CONTROL_DB_PATH}"
os.environ.setdefault("PROSPECT_SOLO_MODE", "true")  # already the default; explicit for CI clarity


# =============================================================================================
# Fixture data — kept as module-level constants so test files can assert against the exact
# values they seeded, instead of guessing at what conftest put in the DB.
# =============================================================================================

# One synthetic catalog of 6 games backing mart_game. Columns: appid, name, primary_genre,
# primary_tag, release_year, release_date,
# price_initial, is_free, is_indie, self_published, developers, publishers, owners_mid,
# total_reviews, positive_ratio, est_rev_reviews, est_rev_owners, metacritic_score,
# achievements_count, avg_playtime_forever, top_tags, header_image.
GAMES = [
    dict(
        appid=1001, name="Rogue Cellar", primary_genre="Roguelike", primary_tag="Deckbuilder",
        release_year=2024, release_date="2024-03-01", is_recent=False, price_initial=14.99,
        is_free=0, is_indie=1, self_published=1, developers="Solo Dev A", publishers="Solo Dev A",
        owners_mid=50000.0, total_reviews=500, positive_ratio=0.88, est_rev_reviews=150000.0,
        est_rev_owners=160000.0, metacritic_score=78, achievements_count=20,
        avg_playtime_forever=600, top_tags=["Deckbuilder", "Roguelike", "Indie"],
        header_image="https://example.test/1001.jpg",
    ),
    dict(
        appid=1002, name="Dungeon Spire", primary_genre="Roguelike", primary_tag="Deckbuilder",
        release_year=2023, release_date="2023-06-15", is_recent=False, price_initial=19.99,
        is_free=0, is_indie=1, self_published=0, developers="Studio B", publishers="Indie Publisher B",
        owners_mid=150000.0, total_reviews=1200, positive_ratio=0.92, est_rev_reviews=900000.0,
        est_rev_owners=950000.0, metacritic_score=85, achievements_count=35,
        avg_playtime_forever=1200, top_tags=["Deckbuilder", "Roguelike", "Strategy"],
        header_image="https://example.test/1002.jpg",
    ),
    dict(
        appid=1003, name="Card Crawl Deluxe", primary_genre="Roguelike", primary_tag="Card Battler",
        release_year=2025, release_date="2025-01-10", is_recent=True, price_initial=9.99,
        is_free=0, is_indie=1, self_published=1, developers="Solo Dev C", publishers="Solo Dev C",
        owners_mid=4000.0, total_reviews=80, positive_ratio=0.65, est_rev_reviews=20000.0,
        est_rev_owners=18000.0, metacritic_score=None, achievements_count=8,
        avg_playtime_forever=180, top_tags=["Card Battler", "Roguelike"],
        header_image="https://example.test/1003.jpg",
    ),
    dict(
        appid=1004, name="Mecha Arena", primary_genre="Action", primary_tag="Multiplayer",
        release_year=2022, release_date="2022-11-20", is_recent=False, price_initial=0.0,
        is_free=1, is_indie=0, self_published=0, developers="Big Studio D", publishers="Big Publisher D",
        owners_mid=900000.0, total_reviews=3000, positive_ratio=0.81, est_rev_reviews=0.0,
        est_rev_owners=0.0, metacritic_score=72, achievements_count=50,
        avg_playtime_forever=2400, top_tags=["Multiplayer", "Action", "Free to Play"],
        header_image="https://example.test/1004.jpg",
    ),
    dict(
        appid=1005, name="Farm Together Now", primary_genre="Simulation", primary_tag="Farming",
        release_year=2024, release_date="2024-08-05", is_recent=True, price_initial=24.99,
        is_free=0, is_indie=1, self_published=1, developers="Solo Dev E", publishers="Solo Dev E",
        owners_mid=30000.0, total_reviews=200, positive_ratio=0.90, est_rev_reviews=250000.0,
        est_rev_owners=260000.0, metacritic_score=80, achievements_count=40,
        avg_playtime_forever=3000, top_tags=["Farming", "Simulation", "Relaxing"],
        header_image="https://example.test/1005.jpg",
    ),
    dict(
        appid=1006, name="Zen Garden", primary_genre="Simulation", primary_tag="Farming",
        release_year=2021, release_date="2021-04-12", is_recent=False, price_initial=4.99,
        is_free=0, is_indie=1, self_published=1, developers="Solo Dev F", publishers="Solo Dev F",
        owners_mid=2000.0, total_reviews=15, positive_ratio=0.55, est_rev_reviews=3000.0,
        est_rev_owners=2800.0, metacritic_score=None, achievements_count=5,
        avg_playtime_forever=90, top_tags=["Farming", "Casual"],
        header_image="https://example.test/1006.jpg",
    ),
]


def _build_fixture_mart(path: Path) -> None:
    con = duckdb.connect(str(path))
    try:
        _create_mart_game(con)
        _create_mart_niche(con)
        _create_mart_market_boxleiter(con)
        _create_mart_meta(con)
    finally:
        con.close()  # MUST close before analytics_db opens its own read_only connection


def _create_mart_game(con: duckdb.DuckDBPyConnection) -> None:
    """Columns = the union of api/app/routers/games.py's _SEARCH_COLS + _PROFILE_COLS."""
    con.execute("""
        CREATE TABLE mart_game (
            appid INTEGER, name VARCHAR, primary_genre VARCHAR, release_year INTEGER,
            release_date VARCHAR, price_initial DOUBLE, is_free INTEGER, developers VARCHAR,
            publishers VARCHAR, self_published INTEGER, is_indie INTEGER, owners_mid DOUBLE,
            total_reviews INTEGER, positive_ratio DOUBLE, est_rev_reviews DOUBLE,
            est_rev_owners DOUBLE, metacritic_score INTEGER, achievements_count INTEGER,
            avg_playtime_forever INTEGER, header_image VARCHAR, short_description VARCHAR,
            rev_pct_in_genre DOUBLE, reviews_pct_in_genre DOUBLE, owners_pct_in_genre DOUBLE,
            top_tags VARCHAR[], n_reviews_sampled INTEGER, n_reviews_first_30d INTEGER,
            n_reviews_first_90d INTEGER, n_reviews_first_365d INTEGER,
            n_reviews_trailing_30d INTEGER, playtime_p25 DOUBLE, playtime_p50 DOUBLE,
            playtime_p75 DOUBLE
        )
    """)
    rows = []
    for g in GAMES:
        rows.append((
            g["appid"], g["name"], g["primary_genre"], g["release_year"], g["release_date"],
            g["price_initial"], g["is_free"], g["developers"], g["publishers"],
            g["self_published"], g["is_indie"], g["owners_mid"], g["total_reviews"],
            g["positive_ratio"], g["est_rev_reviews"], g["est_rev_owners"], g["metacritic_score"],
            g["achievements_count"], g["avg_playtime_forever"], g["header_image"],
            f"{g['name']} — a synthetic fixture game.", 65.0, 60.0, 55.0, g["top_tags"],
            g["total_reviews"], g["total_reviews"] // 5, g["total_reviews"] // 3,
            g["total_reviews"], g["total_reviews"] // 10, 120.0, 300.0, 600.0,
        ))
    con.executemany(f"INSERT INTO mart_game VALUES ({', '.join(['?'] * 33)})", rows)


def _create_mart_niche(con: duckdb.DuckDBPyConnection) -> None:
    """Columns = api/app/routers/niches.py's _COLS, plus mart_niche_top/hist/trend per that
    router's niche_detail() query. NULL saturation_yoy on the 'Card Battler' row on purpose
    (tests NULLS LAST sort handling)."""
    con.execute("""
        CREATE TABLE mart_niche (
            dimension VARCHAR, key VARCHAR, win VARCHAR, min_reviews INTEGER, n_games INTEGER,
            n_recent INTEGER, median_rev DOUBLE, p25_rev DOUBLE, p75_rev DOUBLE,
            median_reviews DOUBLE, median_price DOUBLE, median_positive_ratio DOUBLE,
            median_owners DOUBLE, recent_velocity DOUBLE, self_pub_share DOUBLE,
            winner_concentration DOUBLE, hit_rate_200k DOUBLE, hit_rate_500k DOUBLE,
            beatable_share DOUBLE, saturation_yoy DOUBLE, demand DOUBLE, competition DOUBLE,
            quality_gap DOUBLE, opportunity DOUBLE
        )
    """)
    niche_rows = [
        # dimension, key, win, min_reviews, n_games, n_recent, median_rev, p25_rev, p75_rev,
        # median_reviews, median_price, median_positive_ratio, median_owners, recent_velocity,
        # self_pub_share, winner_concentration, hit_rate_200k, hit_rate_500k, beatable_share,
        # saturation_yoy, demand, competition, quality_gap, opportunity
        ("tag", "Deckbuilder", "all", 10, 2, 1, 525000.0, 150000.0, 900000.0, 850.0, 17.49,
         0.90, 100000.0, 500.0, 0.5, 0.6, 0.5, 0.5, 0.0, 0.1, 80.0, 30.0, 20.0, 72.5),
        ("tag", "Deckbuilder", "all", 50, 1, 0, 900000.0, 900000.0, 900000.0, 1200.0, 19.99,
         0.92, 150000.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, None, 90.0, 20.0, 10.0, 60.0),
        ("tag", "Deckbuilder", "24m", 10, 1, 1, 150000.0, 150000.0, 150000.0, 500.0, 14.99,
         0.88, 50000.0, 500.0, 1.0, 1.0, 0.0, 0.0, 0.0, None, 40.0, 15.0, 30.0, 44.0),
        ("tag", "Card Battler", "all", 10, 1, 1, 20000.0, 20000.0, 20000.0, 80.0, 9.99,
         0.65, 4000.0, 80.0, 1.0, 1.0, 0.0, 0.0, 1.0, None, 30.0, 10.0, 50.0, 40.0),
        ("tag", "Farming", "all", 10, 2, 1, 126500.0, 3000.0, 250000.0, 107.5, 14.99,
         0.725, 16000.0, 200.0, 1.0, 0.9, 0.5, 0.0, 0.5, -0.2, 40.0, 20.0, 60.0, 55.0),
        ("genre", "Roguelike", "all", 10, 3, 1, 150000.0, 20000.0, 900000.0, 500.0, 14.99,
         0.88, 50000.0, 500.0, 0.67, 0.7, 0.33, 0.33, 0.33, 0.2, 70.0, 35.0, 25.0, 68.0),
        ("genre", "Action", "all", 10, 1, 0, 0.0, 0.0, 0.0, 3000.0, 0.0,
         0.81, 900000.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 50.0, 90.0, 0.0, 35.0),
        ("genre", "Simulation", "all", 10, 2, 1, 126500.0, 3000.0, 250000.0, 107.5, 14.99,
         0.725, 16000.0, 200.0, 1.0, 0.9, 0.5, 0.0, 0.5, -0.2, 45.0, 25.0, 55.0, 50.0),
    ]
    con.executemany(f"INSERT INTO mart_niche VALUES ({', '.join(['?'] * 24)})", niche_rows)

    con.execute("""
        CREATE TABLE mart_niche_top (
            dimension VARCHAR, key VARCHAR, rank_in_niche INTEGER, appid INTEGER, name VARCHAR,
            release_year INTEGER, price_initial DOUBLE, owners_mid DOUBLE, total_reviews INTEGER,
            positive_ratio DOUBLE, est_rev_reviews DOUBLE, self_published INTEGER,
            header_image VARCHAR
        )
    """)
    con.executemany(
        f"INSERT INTO mart_niche_top VALUES ({', '.join(['?'] * 13)})",
        [
            ("tag", "Deckbuilder", 1, 1002, "Dungeon Spire", 2023, 19.99, 150000.0, 1200, 0.92, 900000.0, 0, "https://example.test/1002.jpg"),
            ("tag", "Deckbuilder", 2, 1001, "Rogue Cellar", 2024, 14.99, 50000.0, 500, 0.88, 150000.0, 1, "https://example.test/1001.jpg"),
        ],
    )

    con.execute("""
        CREATE TABLE mart_niche_hist (
            dimension VARCHAR, key VARCHAR, bucket_index INTEGER, x_min DOUBLE, x_max DOUBLE,
            count INTEGER
        )
    """)
    con.executemany(
        f"INSERT INTO mart_niche_hist VALUES ({', '.join(['?'] * 6)})",
        [
            ("tag", "Deckbuilder", 10, 100000.0, 316228.0, 1),
            ("tag", "Deckbuilder", 11, 316228.0, 1000000.0, 1),
        ],
    )

    con.execute("""
        CREATE TABLE mart_niche_trend (
            dimension VARCHAR, key VARCHAR, year INTEGER, n_releases INTEGER, n_scored INTEGER,
            median_rev DOUBLE
        )
    """)
    con.executemany(
        f"INSERT INTO mart_niche_trend VALUES ({', '.join(['?'] * 6)})",
        [
            ("tag", "Deckbuilder", 2023, 1, 1, 900000.0),
            ("tag", "Deckbuilder", 2024, 1, 1, 150000.0),
        ],
    )


def _create_mart_market_boxleiter(con: duckdb.DuckDBPyConnection) -> None:
    """api/app/routers/estimate.py's _genre_owners_per_review() reads (genre, slope) and
    clamps it to [20, 55]. Roguelike's slope (40) is deliberately already inside that band
    (clamp is a no-op); Action's (70) is deliberately OUTSIDE it, so a test can confirm the
    clamp actually clamps down to 55 rather than passing 70 through."""
    con.execute("""
        CREATE TABLE mart_market_boxleiter (
            genre VARCHAR, n INTEGER, owners_per_review_median DOUBLE,
            owners_per_review_p25 DOUBLE, owners_per_review_p75 DOUBLE, slope DOUBLE,
            intercept DOUBLE
        )
    """)
    con.executemany(
        f"INSERT INTO mart_market_boxleiter VALUES ({', '.join(['?'] * 7)})",
        [
            ("__all__", 6, 30.0, 22.0, 45.0, 30.0, 0.0),
            ("Roguelike", 3, 40.0, 32.0, 48.0, 40.0, 0.0),
            ("Action", 1, 70.0, 70.0, 70.0, 70.0, 0.0),  # deliberately outside the cited 20-55 band
        ],
    )


def _create_mart_meta(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
    con.executemany(
        "INSERT INTO mart_meta VALUES (?, ?)",
        [
            ("mart_version", "test-fixture"),
            ("built_at", "2026-01-01T00:00:00+00:00"),
            ("source_db", "fixture"),
            ("global_median_revenue", "7701.30"),
            ("n_games_total", "6"),
            ("n_games_scored", "6"),
        ],
    )


_build_fixture_mart(ANALYTICS_DB_PATH)

# Import the app only AFTER the env vars + fixture DB above are in place (see module
# docstring) — Settings() and the analytics_db/explore module-level connections all key off
# settings.analytics_db_path/control_dsn at (or shortly after) import time.
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c
