"""The 7-day player trend is published NEXT TO the market's — so a seasonal dip is not read as
218 separate niche declines.

The regression (2026-09-22 review): on the 2026-09-21 mart, 174 of 218 niches showed a negative
7-day player trend (median -4.9%) while the catalog as a whole was -4.3% on the same windows.
Every niche page presented the market's dip as its own decline. mart_players.sql now computes
the catalog-wide SAME-PANEL baseline with the niche statistic's own formula (a sum over every
>= MIN_REVIEWS_DEFAULT-review game measured in both windows) and hands it to mart_niche /
mart_game, which publish players_trend_7d_market_pct and players_trend_7d_rel_pct = niche -
market, in percentage points.

Renders the REAL mart_players.sql over hand-built staging (no source DB, no network).
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
PER_NICHE = 30                       # MIN_NICHE_GAMES scored games per niche
PROFILES = {"Falling": 0.90, "Flat": 1.00, "Rising": 1.20}   # recent / prior players


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect(":memory:")
    c.execute("CREATE TEMP TABLE stg_game(appid INTEGER, name VARCHAR, total_reviews BIGINT)")
    c.execute("CREATE TEMP TABLE stg_tag_membership(appid INTEGER, tag VARCHAR)")
    c.execute("CREATE TEMP TABLE stg_genre_membership(appid INTEGER, genre VARCHAR)")
    c.execute("CREATE TEMP TABLE stg_player_counts_daily(appid INTEGER, cap_date DATE,"
              " players INTEGER, n_captures INTEGER)")
    c.execute("CREATE TEMP TABLE stg_player_count_latest(appid INTEGER, live_players INTEGER,"
              " captured_at TIMESTAMP)")
    c.execute("CREATE TEMP TABLE stg_player_history_external(appid INTEGER, date DATE,"
              " avg_players DOUBLE, peak_players INTEGER, source VARCHAR)")
    appid = 1
    for tag, ratio in PROFILES.items():
        for _ in range(PER_NICHE):
            c.execute("INSERT INTO stg_game VALUES (?, ?, 500)", [appid, f"g{appid}"])
            c.execute("INSERT INTO stg_tag_membership VALUES (?, ?)", [appid, tag])
            c.execute("INSERT INTO stg_genre_membership VALUES (?, 'Indie')", [appid])
            for back in range(14):   # 0..6 = the recent window, 7..13 = the prior one
                players = round(100 * ratio) if back < 7 else 100
                c.execute("INSERT INTO stg_player_counts_daily VALUES (?, ?, ?, 1)",
                          [appid, TODAY - timedelta(days=back), players])
            c.execute("INSERT INTO stg_player_count_latest VALUES (?, ?, ?)",
                      [appid, round(100 * ratio), TODAY])
            appid += 1
    c.execute(bm.render((ETL / "marts" / "mart_players.sql").read_text(), bm.build_params()))
    yield c
    c.close()


def test_market_baseline_is_the_same_statistic_over_the_whole_panel(con):
    # 30 games each at 90 / 100 / 120 recent vs 100 prior: (8,700 - 9,000) ... summed
    want = 100.0 * (PER_NICHE * (90 + 100 + 120) - 3 * PER_NICHE * 100) / (3 * PER_NICHE * 100)
    got = con.execute("SELECT players_trend_7d_market_pct, n_games_trend FROM _pl_market_trend").fetchone()
    assert got[0] == pytest.approx(want) and got[1] == 3 * PER_NICHE, got


def test_every_niche_row_carries_the_market_baseline_beside_its_own_trend(con):
    rows = {k: (t, m) for k, t, m in con.execute(
        "SELECT key, players_trend_7d_pct, players_trend_7d_market_pct FROM _niche_players_now "
        "WHERE dimension = 'tag'").fetchall()}
    market = 100.0 * (90 + 100 + 120 - 300) / 300
    for tag, ratio in PROFILES.items():
        trend, m = rows[tag]
        assert trend == pytest.approx(100.0 * (ratio - 1.0)), (tag, trend)
        assert m == pytest.approx(market), (tag, m)
    # the point of the column: 'Flat' reads -3.3pp against a +3.3% market, i.e. it is the
    # MARKET that moved; 'Falling' is falling 13.3pp faster than it
    rel = {tag: t - m for tag, (t, m) in rows.items()}
    assert rel["Flat"] == pytest.approx(-market) and rel["Falling"] < rel["Flat"] < rel["Rising"]


def test_game_summary_carries_it_too(con):
    vals = {m for (m,) in con.execute(
        "SELECT DISTINCT players_trend_7d_market_pct FROM _game_players_summary").fetchall()}
    assert len(vals) == 1 and next(iter(vals)) == pytest.approx(100.0 * (310 - 300) / 300), vals


def test_no_panel_means_no_baseline():
    """An empty CCU source (the guarded-staging degraded mode) yields NULL, never 0%."""
    c = duckdb.connect(":memory:")
    try:
        c.execute("CREATE TEMP TABLE stg_game(appid INTEGER, name VARCHAR, total_reviews BIGINT)")
        c.execute("CREATE TEMP TABLE stg_tag_membership(appid INTEGER, tag VARCHAR)")
        c.execute("CREATE TEMP TABLE stg_genre_membership(appid INTEGER, genre VARCHAR)")
        c.execute("CREATE TEMP TABLE stg_player_counts_daily(appid INTEGER, cap_date DATE,"
                  " players INTEGER, n_captures INTEGER)")
        c.execute("CREATE TEMP TABLE stg_player_count_latest(appid INTEGER, live_players INTEGER,"
                  " captured_at TIMESTAMP)")
        c.execute("CREATE TEMP TABLE stg_player_history_external(appid INTEGER, date DATE,"
                  " avg_players DOUBLE, peak_players INTEGER, source VARCHAR)")
        c.execute(bm.render((ETL / "marts" / "mart_players.sql").read_text(), bm.build_params()))
        assert c.execute("SELECT players_trend_7d_market_pct FROM _pl_market_trend").fetchone()[0] is None
    finally:
        c.close()
