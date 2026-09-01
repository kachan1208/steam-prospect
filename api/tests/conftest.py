"""Shared pytest fixtures for the API test suite.

Points the app at a SMALL, synthetic, in-repo-built DuckDB (a handful of rows in just the
mart_* tables the tested routers read) instead of the real ~176MB data/current.duckdb — so
the suite runs standalone, with no dependency on `task etl` or any local data/ directory.
Every table/column here was read straight off api/app/analytics_db.py + the router SQL
it's paired with (see the comment above each CREATE TABLE) — not the full ETL schema, just
what's actually queried. It also points PROSPECT_STATIC_DIR at a scratch dir containing an
index.html (plus a sibling file OUTSIDE it as the traversal target), so the app boots in
hosted/SPA mode and the SPA-fallback tests exercise the real registered route.

Ordering matters a lot in this file: api/app/config.py's `Settings` (env_prefix="PROSPECT_")
is instantiated once at import time as a module-level singleton, and
api/app/analytics_db.py (opened in main.py's lifespan) keys off
`settings.analytics_db_path` while main.py's SPA registration keys off
`settings.static_dir`. So the env vars below MUST be set, and the fixture mart + static
files MUST already exist on disk, before `app.main` (or anything importing `app.config`)
is imported anywhere in this process. That's why the env/DB setup happens at module level
in this conftest, ahead of the `from app.main import app` at the bottom.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import duckdb
import pytest

_TMP_DIR = Path(tempfile.mkdtemp(prefix="prospect_api_tests_"))
ANALYTICS_DB_PATH = _TMP_DIR / "fixture_mart.duckdb"

os.environ["PROSPECT_ANALYTICS_DB_PATH"] = str(ANALYTICS_DB_PATH)

# Hosted/SPA mode for the whole suite (see test_spa_fallback.py): a static dir with an
# index.html and one real asset, plus a secret file one level UP that the SPA fallback's
# traversal defense must never serve. The content constants are asserted against, so keep
# them distinctive.
STATIC_DIR = _TMP_DIR / "static"
STATIC_DIR.mkdir()
INDEX_HTML_CONTENT = "<!doctype html><title>Prospect fixture SPA</title>"
SPA_INDEX_FILE = STATIC_DIR / "index.html"
SPA_INDEX_FILE.write_text(INDEX_HTML_CONTENT, encoding="utf-8")
STATIC_FILE_NAME = "robots.txt"
STATIC_FILE_CONTENT = "user-agent: test-bot"
(STATIC_DIR / STATIC_FILE_NAME).write_text(STATIC_FILE_CONTENT, encoding="utf-8")
SPA_SECRET_FILE = _TMP_DIR / "secret.txt"  # OUTSIDE STATIC_DIR — the traversal target
SPA_SECRET_CONTENT = "TOP-SECRET: must never be served by the SPA fallback"
SPA_SECRET_FILE.write_text(SPA_SECRET_CONTENT, encoding="utf-8")
os.environ["PROSPECT_STATIC_DIR"] = str(STATIC_DIR)


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


# Entity marts (api/app/routers/entities.py) — one row per (role, name) with career
# aggregates, plus the (role, name, appid, seq) release map. Single-game entities mirror the
# developers/publishers strings on GAMES above; "Pixel Forge Collective" is a deliberate
# multi-game entity (spanning 1006/1005/1003, out of appid order) so tests can pin ORDER BY
# seq and the mart_game JOIN — the router never cross-checks mart_game's credit strings.
ENTITIES = [
    # role, name, n_games, first_release_year, last_release_year, n_recent_24m, total_rev,
    # median_rev, hit_rate_200k, median_reviews, median_positive_ratio,
    # self_published_share, top_genres, n_partners (contract: NULL for developers)
    ("developer", "Solo Dev A", 1, 2024, 2024, 1, 150000.0, 150000.0, 0.0, 500.0, 0.88, 1.0, ["Roguelike"], None),
    ("developer", "Studio B", 1, 2023, 2023, 0, 900000.0, 900000.0, 1.0, 1200.0, 0.92, 0.0, ["Roguelike"], None),
    ("developer", "Big Studio D", 1, 2022, 2022, 0, 0.0, 0.0, 0.0, 3000.0, 0.81, 0.0, ["Action"], None),
    ("developer", "Pixel Forge Collective", 3, 2021, 2025, 2, 273000.0, 20000.0, 1 / 3, 80.0, 0.65, 1.0, ["Simulation", "Roguelike"], None),
    ("publisher", "Indie Publisher B", 1, 2023, 2023, 0, 900000.0, 900000.0, 1.0, 1200.0, 0.92, 0.0, ["Roguelike"], 1),
    ("publisher", "Big Publisher D", 1, 2022, 2022, 0, 0.0, 0.0, 0.0, 3000.0, 0.81, 0.0, ["Action"], 1),
]

# Launch & Timing marts (api/app/routers/timing.py). Values are hand-picked so the
# window_recommendation arithmetic is checkable on paper:
#   demand_index[m] = share*12; congestion_index[m] = releases/mean(releases)
#   mean(releases) = (100*9 + 160 + 140 + 80)/12 = 106.666...
#   -> best months by score: Dec (1.32-0.9375=0.3825), Nov (1.56-1.3125=0.2475),
#      Jul (1.08-0.9375=0.1425).
# Shares sum to exactly 1.0. "Roguelike" gets demand+decay but NO congestion rows (as a
# genre below the congestion size floor) -> recommendation must be None, series empty.
TIMING_DEMAND_SHARES = [0.06, 0.06, 0.08, 0.07, 0.08, 0.08, 0.09, 0.08, 0.07, 0.09, 0.13, 0.11]
TIMING_CONGESTION_RELEASES = [80.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 160.0, 140.0, 100.0]
# Decay medians deliberately do NOT sum to 1 (0.30+0.15+0.05 + 21*0.02 = 0.92) so tests
# pin the router's renormalization: first_3 = 0.50/0.92, first_6 = 0.56/0.92,
# first_12 = 0.68/0.92.
TIMING_DECAY_SHARES = [0.30, 0.15, 0.05] + [0.02] * 21


# (role, name, appid, seq) — seq 1 = the entity's earliest release (1006 is 2021, 1005 is
# 2024, 1003 is 2025 for the collective).
ENTITY_GAMES = [
    ("developer", "Solo Dev A", 1001, 1),
    ("developer", "Studio B", 1002, 1),
    ("developer", "Big Studio D", 1004, 1),
    ("developer", "Pixel Forge Collective", 1006, 1),
    ("developer", "Pixel Forge Collective", 1005, 2),
    ("developer", "Pixel Forge Collective", 1003, 3),
    ("publisher", "Indie Publisher B", 1002, 1),
    ("publisher", "Big Publisher D", 1004, 1),
]


def _build_fixture_mart(path: Path) -> None:
    con = duckdb.connect(str(path))
    try:
        _create_mart_game(con)
        _create_mart_niche(con)
        _create_mart_market_boxleiter(con)
        _create_mart_market_tiers(con)
        _create_mart_market_distribution(con)
        _create_mart_seasonality(con)
        _create_mart_meta(con)
        _create_mart_entity(con)
        _create_mart_timing(con)
        _create_mart_game_event(con)
        _create_mart_game_trends(con)
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
            playtime_p75 DOUBLE,
            -- Live/streaming columns (CCU + Twitch collectors) and the first-seen crawl date.
            -- Part of _PROFILE_COLS/_SEARCH_COLS, so they must exist here or every games
            -- query fails to bind. `name_lower` is deliberately absent: games.py gates on it
            -- via _has_name_lower() and falls back to ILIKE, and leaving it out keeps that
            -- fallback path covered.
            live_players INTEGER, twitch_viewers INTEGER, twitch_streams INTEGER,
            first_seen VARCHAR
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
            g["total_reviews"] // 100, g["total_reviews"] // 200, g["total_reviews"] // 1000,
            f"{g['release_year']}-01-01",
        ))
    con.executemany(f"INSERT INTO mart_game VALUES ({', '.join(['?'] * 37)})", rows)


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
    """Read by api/app/routers/market.py::market_benchmarks (the boxleiter_by_genre table)
    and by mcp/prospect_mcp.py::estimate_revenue, which reads (genre, slope) and clamps it
    to [20, 55]. Roguelike's slope (40) sits inside that band (clamp is a no-op); Action's
    (70) is deliberately OUTSIDE it, pinning the clamped shape of the fixture data."""
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


def _create_mart_market_tiers(con: duckdb.DuckDBPyConnection) -> None:
    """The dev-tier histogram api/app/routers/market.py::market_benchmarks reads alongside
    mart_market_boxleiter. Counts sum to the 6 fixture games so the row set is checkable."""
    con.execute(
        "CREATE TABLE mart_market_tiers (tier VARCHAR, tier_order INTEGER, count INTEGER,"
        " pct DOUBLE)"
    )
    con.executemany(
        "INSERT INTO mart_market_tiers VALUES (?, ?, ?, ?)",
        [
            ("Below Hobby", 0, 1, 1 / 6),
            ("Hobby", 1, 3, 0.5),
            ("Small", 2, 1, 1 / 6),
            ("Middle", 3, 1, 1 / 6),
        ],
    )


def _create_mart_market_distribution(con: duckdb.DuckDBPyConnection) -> None:
    """mart_market_hist + mart_market_pct per etl/marts/mart_market.sql — what
    api/app/routers/market.py::distribution reads. '__all__' carries both win cuts for
    revenue so the window param is checkable; the other genres deliberately have no rows
    (an empty 200 is the contract for a genre under the mart's floor)."""
    con.execute("""
        CREATE TABLE mart_market_hist (
            metric VARCHAR, genre VARCHAR, win VARCHAR, bucket_index INTEGER,
            x_min DOUBLE, x_max DOUBLE, count INTEGER
        )
    """)
    con.executemany(
        "INSERT INTO mart_market_hist VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            # out of bucket order on purpose — the router must ORDER BY bucket_index
            ("revenue", "__all__", "all", 10, 100000.0, 316227.77, 3),
            ("revenue", "__all__", "all", 8, 10000.0, 31622.78, 2),
            ("revenue", "__all__", "24m", 10, 100000.0, 316227.77, 1),
            ("price", "__all__", "all", 2, 5.0, 7.5, 1),
            ("price", "__all__", "all", 3, 7.5, 10.0, 2),
        ],
    )
    con.execute("""
        CREATE TABLE mart_market_pct (
            metric VARCHAR, genre VARCHAR, win VARCHAR, n INTEGER, pctile VARCHAR, value DOUBLE
        )
    """)
    con.executemany(
        "INSERT INTO mart_market_pct VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("revenue", "__all__", "all", 6, "p99", 900000.0),   # out of value order —
            ("revenue", "__all__", "all", 6, "p10", 3000.0),     # the router must
            ("revenue", "__all__", "all", 6, "p50", 150000.0),   # ORDER BY value
            ("revenue", "__all__", "24m", 2, "p50", 135000.0),
            ("price", "__all__", "all", 4, "p50", 14.99),
        ],
    )


def _create_mart_seasonality(con: duckdb.DuckDBPyConnection) -> None:
    """The two marts api/app/routers/seasonality.py reads. mart_seasonality is one table
    holding four GRAINS (month_weekday / month / weekday / year), each using a different
    subset of the month/weekday/year columns and leaving the rest NULL — the router splits
    on `grain` and sorts each list, so all four are seeded here, deliberately out of order
    on disk. 'Roguelike' carries a month grain only, so a genre with partial coverage is a
    real fixture state."""
    con.execute("""
        CREATE TABLE mart_seasonality (
            grain VARCHAR, genre VARCHAR, month INTEGER, weekday INTEGER, year INTEGER,
            n_releases INTEGER, n_scored INTEGER, median_rev DOUBLE, median_reviews DOUBLE,
            median_positive_ratio DOUBLE
        )
    """)
    rows = []
    for m in (11, 3, 7):  # out of calendar order on purpose
        rows.append(("month", "__all__", m, None, None, m * 10, m * 5, 1000.0 * m, 50.0, 0.8))
    for w in (5, 1):
        rows.append(("weekday", "__all__", None, w, None, w * 20, w * 8, 2000.0, 60.0, 0.82))
    for y in (2025, 2023, 2024):
        rows.append(("year", "__all__", None, None, y, 300, 120, 1500.0, 55.0, 0.79))
    rows.append(("month_weekday", "__all__", 6, 3, None, 40, 18, 900.0, 45.0, 0.77))
    rows.append(("month_weekday", "__all__", 2, 4, None, 35, 15, 850.0, 44.0, 0.76))
    rows.append(("month", "Roguelike", 5, None, None, 12, 6, 700.0, 40.0, 0.85))
    con.executemany(f"INSERT INTO mart_seasonality VALUES ({', '.join(['?'] * 10)})", rows)

    con.execute("""
        CREATE TABLE mart_launch_curve (
            genre VARCHAR, day INTEGER, mean_cum_fraction DOUBLE,
            median_cum_fraction DOUBLE, n_games INTEGER
        )
    """)
    con.executemany(
        "INSERT INTO mart_launch_curve VALUES (?, ?, ?, ?, ?)",
        [("__all__", d, f, f * 0.95, 500) for d, f in ((1, 0.2), (7, 0.5), (30, 0.8), (90, 1.0))],
    )


def _create_mart_entity(con: duckdb.DuckDBPyConnection) -> None:
    """The developer/publisher entity marts, exactly per the ETL schema contract that
    api/app/routers/entities.py reads (mart_entity full row + mart_entity_games map)."""
    con.execute("""
        CREATE TABLE mart_entity (
            role VARCHAR, name VARCHAR, n_games INTEGER, first_release_year INTEGER,
            last_release_year INTEGER, n_recent_24m INTEGER, total_rev DOUBLE,
            median_rev DOUBLE, hit_rate_200k DOUBLE, median_reviews DOUBLE,
            median_positive_ratio DOUBLE, self_published_share DOUBLE,
            top_genres VARCHAR[], n_partners INTEGER
        )
    """)
    con.executemany(f"INSERT INTO mart_entity VALUES ({', '.join(['?'] * 14)})", ENTITIES)

    con.execute("""
        CREATE TABLE mart_entity_games (
            role VARCHAR, name VARCHAR, appid INTEGER, seq INTEGER
        )
    """)
    con.executemany("INSERT INTO mart_entity_games VALUES (?, ?, ?, ?)", ENTITY_GAMES)


def _create_mart_timing(con: duckdb.DuckDBPyConnection) -> None:
    """The three Launch & Timing marts, exactly per etl/marts/mart_timing.sql's schema
    contract that api/app/routers/timing.py reads. '__all__' is complete (12 demand + 12
    congestion + 24 decay rows); 'Roguelike' deliberately lacks congestion rows."""
    con.execute("""
        CREATE TABLE mart_timing_demand (
            genre VARCHAR, month INTEGER, demand_share DOUBLE, month_reviews BIGINT,
            n_games INTEGER, n_games_genre INTEGER
        )
    """)
    demand_rows = []
    for genre in ("__all__", "Roguelike"):
        for m, share in enumerate(TIMING_DEMAND_SHARES, start=1):
            demand_rows.append((genre, m, share, int(share * 100000), 40, 60))
    con.executemany(f"INSERT INTO mart_timing_demand VALUES ({', '.join(['?'] * 6)})", demand_rows)

    con.execute("""
        CREATE TABLE mart_timing_congestion (
            genre VARCHAR, month INTEGER, avg_releases DOUBLE, avg_big_releases DOUBLE,
            n_years INTEGER
        )
    """)
    con.executemany(
        "INSERT INTO mart_timing_congestion VALUES (?, ?, ?, ?, ?)",
        [("__all__", m, rel, 5.0, 3) for m, rel in enumerate(TIMING_CONGESTION_RELEASES, start=1)],
    )

    con.execute("""
        CREATE TABLE mart_timing_decay (
            genre VARCHAR, month_since_release INTEGER, median_share DOUBLE,
            mean_share DOUBLE, n_games INTEGER
        )
    """)
    decay_rows = []
    for genre in ("__all__", "Roguelike"):
        for m, share in enumerate(TIMING_DECAY_SHARES):
            decay_rows.append((genre, m, share, share * 1.1, 40))
    con.executemany("INSERT INTO mart_timing_decay VALUES (?, ?, ?, ?, ?)", decay_rows)


def _create_mart_game_event(con: duckdb.DuckDBPyConnection) -> None:
    """Chart-annotation events for appid 1001 only — 1002+ deliberately have none, so the
    empty-feed case is a real fixture state rather than a mocked one. Shape mirrors
    etl/marts/mart_game_event.sql: release carries url NULL (nothing to link)."""
    con.execute(
        "CREATE TABLE mart_game_event (appid INTEGER, event_date DATE, kind VARCHAR,"
        " title VARCHAR, url VARCHAR)"
    )
    con.executemany(
        "INSERT INTO mart_game_event VALUES (?, ?, ?, ?, ?)",
        [
            (1001, "2024-03-01", "release", "Released", None),
            (1001, "2024-04-10", "update", "Patch 1.1 — balance pass", "https://example.test/p11"),
            (1001, "2024-05-20", "press", "Rogue Cellar review — PC Gamer", "https://example.test/rev"),
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


def _create_mart_game_trends(con: duckdb.DuckDBPyConnection) -> None:
    """Monthly per-game series for api/app/routers/trends.py (period, n_reviews, ccu_avg
    per etl/marts/mart_game_trends.sql). 1001/1002/1003 have rows so /trends and the
    ?comps= overlay (cohort median/band) are testable; 1004+ deliberately have NONE, so
    the eligible=False shape is a real fixture state. Values are picked so the cohort
    math is checkable on paper: over comps 1002+1003, period 2026-03 has reviews 110 and
    30 -> median 70, p25 50, p75 90 exactly, and ccu_avg MEDIAN(42, NULL) = 42.

    mart_game_players_daily / mart_game_players_history are deliberately NOT created:
    /players' available=False degrade path is the other real fixture state."""
    con.execute("""
        CREATE TABLE mart_game_trends (
            appid INTEGER, period VARCHAR, n_reviews INTEGER, ccu_avg DOUBLE
        )
    """)
    con.executemany(
        "INSERT INTO mart_game_trends VALUES (?, ?, ?, ?)",
        [
            (1001, "2026-01", 40, 12.0),
            (1001, "2026-02", 55, None),   # NULL = no snapshot that month (a gap, not 0)
            (1001, "2026-03", 70, 18.0),
            (1002, "2026-02", 90, 30.0),
            (1002, "2026-03", 110, 42.0),
            (1003, "2026-03", 30, None),
        ],
    )


_build_fixture_mart(ANALYTICS_DB_PATH)

# Import the app only AFTER the env vars + fixture DB above are in place (see module
# docstring) — Settings() and the analytics_db module-level state all key off
# settings.analytics_db_path / settings.static_dir at (or shortly after) import time.
from fastapi.testclient import TestClient  # noqa: E402

from app import response_cache  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _cold_response_cache():
    """app/response_cache.py memoizes the mart-pure handlers (benchmarks / seasonality /
    launch-curve / timing overview) for the process lifetime, so one test's cached answer
    would otherwise be served to the next — including to tests that monkeypatch
    analytics_db to simulate a missing mart, which would then silently pass on stale data.
    Every test starts and ends with a cold cache."""
    response_cache.clear()
    yield
    response_cache.clear()
