"""First-public release dates and price status — through the real staging.

Two 2026-09-22 regressions, each pinned on the rows that exposed it:

  1. EARLY ACCESS GRADUATES COUNTED AS NEW RELEASES. Steam's store date is the 1.0 date for a
     graduate, so SCUM (reviewed since 2018-08, 1.0 in 2025-06), My Summer Car (2016 -> 2025)
     and Hades II sat in every "released in the last 24 months" cut: 1,113 of the 9,711 games
     with >= 50 reviews in the 24m window, median revenue $137K vs $56K for real newcomers.
     release_date is now FIRST PUBLIC — the earlier of the store date and the first review,
     when the review provably precedes the store date by EA_PUBLIC_MIN_DAYS — with the store
     date kept as store_release_date, a precision-carrying release_date_source, and
     is_ea_graduate. Games with no usable store date but real reviews are dated from them.
  2. FREE GAMES COUNTED AS $0 REVENUE. price_status 'free' | 'paid' | 'unknown'; only 'paid'
     carries est_rev_reviews / est_rev_owners.

Runs the REAL build_marts.create_staging() over a synthetic src schema. No network needed.
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

TODAY = date.today()


def _steam(d: date) -> str:
    """Steam appdetails' date format ("Jun 17, 2025")."""
    return d.strftime("%b %d, %Y")


def _ts(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, 12, tzinfo=timezone.utc).timestamp())


def _month(d: date) -> str:
    return d.strftime("%Y-%m")


# appid -> (store date string on the live games row, analysis_games ISO date,
#           histogram months [(YYYY-MM, n_reviews)], sampled review dates)
SCUM, MSC, HEADSTART, MONTH_ONLY, RESCUED, FUTURE_REVIEWED, FUTURE_BARE, NO_DATE, \
    CORRUPT_TS, STILL_EA, LIVE_WINS = range(1, 12)
EA_LAUNCH = TODAY - timedelta(days=400)
CASES = {
    # public (reviewed) since 2018-08, the sample only reaches 2025: month precision
    SCUM: ("Jun 17, 2025", "2025-06-17", [("2018-07", 0), ("2018-08", 900), ("2025-06", 5000)],
           [date(2025, 6, 20)]),
    # the sample reaches the histogram's first month: day precision
    MSC: ("Jan 8, 2025", "2025-01-08", [("2016-10", 400)], [date(2016, 10, 24), date(2025, 1, 9)]),
    # a deluxe-edition head start (3 days) is not an Early Access period
    HEADSTART: ("Mar 2, 2025", "2025-03-02", [("2025-02", 50), ("2025-03", 900)],
                [date(2025, 2, 27)]),
    # month-only evidence one month early: could be Feb 28 — NOT provably >= 30 days early
    MONTH_ONLY: ("Mar 2, 2025", "2025-03-02", [("2025-02", 50)], []),
    # "Coming soon" on the store, yet reviewed: dated from the first review
    RESCUED: ("Coming soon", None, [], [TODAY - timedelta(days=200), TODAY - timedelta(days=100)]),
    # a store date still ahead, but already public (advance access / EA with a 1.0 date set)
    FUTURE_REVIEWED: (_steam(TODAY + timedelta(days=20)), None, [],
                      [TODAY - timedelta(days=5)]),
    # announced, not out
    FUTURE_BARE: (_steam(TODAY + timedelta(days=20)), None, [], []),
    # a year-only announcement ("2027"): no date, the announced year stays
    NO_DATE: ("2027", None, [], []),
    # a corrupt 1970 timestamp in the sample must not date the game
    CORRUPT_TS: ("Jan 5, 2020", "2020-01-05", [], [date(1970, 1, 1), date(2020, 1, 6)]),
    # still IN Early Access: the store date IS the EA launch — not a graduate
    STILL_EA: (_steam(EA_LAUNCH), EA_LAUNCH.isoformat(), [(_month(EA_LAUNCH), 300)],
               [EA_LAUNCH + timedelta(days=1)]),
    # the live store row beats the frozen July snapshot (a slipped / 1.0-moved date)
    LIVE_WINS: ("Aug 14, 2025", "2025-07-31", [], []),
}
# price_status fixture: appid -> (games.price_initial cents, games.is_free, ag price, ag is_free)
FREE, FREE_PRICED, ZERO_NOT_FREE, NO_PRICE, PAID, FLOORED = range(20, 26)
PRICES = {
    FREE: (0, 1, 0.0, 1),
    FREE_PRICED: (999, 1, 9.99, 1),       # Steam's free flag wins over a stale price
    ZERO_NOT_FREE: (0, 0, 0.0, 0),        # $0 without the flag: unknown, NOT free
    NO_PRICE: (None, 0, None, 0),
    PAID: (999, 0, 9.99, 0),
    FLOORED: (1999, 0, 19.99, 0),
}


def build() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute("CREATE SCHEMA src")
    con.execute(
        "CREATE TABLE src.games(appid INTEGER, name VARCHAR, type VARCHAR, release_date VARCHAR,"
        " price_initial INTEGER, is_free INTEGER, developers VARCHAR, publishers VARCHAR,"
        " metacritic_score INTEGER, achievements_count INTEGER, categories VARCHAR,"
        " header_image VARCHAR)")
    con.execute(
        "CREATE TABLE src.analysis_games(appid INTEGER, name VARCHAR, release_year INTEGER,"
        " release_date_iso VARCHAR, price_initial DOUBLE, is_free INTEGER, developers VARCHAR,"
        " publishers VARCHAR, self_published INTEGER, dev_game_count INTEGER, is_indie INTEGER,"
        " metacritic_score INTEGER, achievements_count INTEGER, owners_mid DOUBLE,"
        " est_rev_owners DOUBLE, avg_playtime_forever DOUBLE, ccu INTEGER, tag_count INTEGER,"
        " total_reviews INTEGER, positive_reviews INTEGER, negative_reviews INTEGER,"
        " positive_ratio DOUBLE)")
    con.execute("CREATE TABLE src.review_histogram(appid INTEGER, period VARCHAR,"
                " recommendations_up INTEGER, recommendations_down INTEGER)")
    con.execute("CREATE TABLE src.reviews(appid INTEGER, recommendationid VARCHAR,"
                " voted_up INTEGER, timestamp_created BIGINT, language VARCHAR,"
                " playtime_at_review INTEGER, playtime_forever INTEGER, review_text VARCHAR)")
    con.execute("CREATE TABLE src.game_snapshots(appid INTEGER, run_at VARCHAR,"
                " owners_min INTEGER, owners_max INTEGER, average_playtime_forever INTEGER,"
                " ccu INTEGER)")
    for appid, (live, iso, hist, sample) in CASES.items():
        con.execute("INSERT INTO src.games VALUES (?, ?, 'game', ?, 999, 0, 'D', 'P', NULL, NULL,"
                    " 'Single-player', NULL)", [appid, f"Game {appid}", live])
        year = 2027 if appid == NO_DATE else (int(iso[:4]) if iso else None)
        con.execute("INSERT INTO src.analysis_games VALUES (?, ?, ?, ?, 9.99, 0, 'D', 'P', 1, 1,"
                    " 1, NULL, NULL, 50000.0, 499500.0, 60.0, 5, 3, 0, 0, 0, NULL)",
                    [appid, f"Game {appid}", year, iso])
        for period, n in hist:
            con.execute("INSERT INTO src.review_histogram VALUES (?, ?, ?, 0)", [appid, period, n])
        for i, d in enumerate(sample):
            con.execute("INSERT INTO src.reviews VALUES (?, ?, 1, ?, 'english', 10, 20, 'ok')",
                        [appid, f"r{appid}_{i}", 0 if d.year == 1970 else _ts(d)])
    for appid, (cents, free, ag_price, ag_free) in PRICES.items():
        con.execute("INSERT INTO src.games VALUES (?, ?, 'game', 'Jan 5, 2020', ?, ?, 'D', 'P',"
                    " NULL, NULL, 'Single-player', NULL)", [appid, f"Game {appid}", cents, free])
        owners = 10000.0 if appid == FLOORED else 50000.0   # 10k = SteamSpy's 0-20k bucket
        con.execute("INSERT INTO src.analysis_games VALUES (?, ?, 2020, '2020-01-05', ?, ?, 'D',"
                    " 'P', 1, 1, 1, NULL, NULL, ?, ?, 60.0, 7, 3, 300, 250, 50, 0.83)",
                    [appid, f"Game {appid}", ag_price, ag_free, owners, owners * (ag_price or 0)])
        # SteamSpy snapshots: the fingerprint (owners bucket + playtime + ccu) of the rows
        # analysis_games was built from, 2026-07-05/07; a later snapshot has moved on (ccu).
        run = "2026-07-07T07:00:00+00:00" if appid % 2 else "2026-07-05T20:30:00+00:00"
        con.execute("INSERT INTO src.game_snapshots VALUES (?, ?, ?, ?, 60, 7)",
                    [appid, run, 0 if owners == 10000.0 else 20000, 20000 if owners == 10000.0 else 80000])
        con.execute("INSERT INTO src.game_snapshots VALUES (?, '2026-09-20T21:00:00+00:00', ?, ?,"
                    " 60, 99)", [appid, 0, 20000])
    for t in ("game_genres(appid INTEGER, genre VARCHAR)",
              "game_tags(appid INTEGER, tag VARCHAR, votes INTEGER)",
              "review_summary(appid INTEGER, total_reviews INTEGER, total_positive INTEGER,"
              " total_negative INTEGER)",
              "articles(id BIGINT, source VARCHAR, author VARCHAR, title VARCHAR, url VARCHAR,"
              " summary VARCHAR, published_at VARCHAR)",
              "article_game_mentions(article_id BIGINT, appid INTEGER, match_confidence DOUBLE)"):
        con.execute(f"CREATE TABLE src.{t}")
    con.executemany("INSERT INTO src.game_genres VALUES (?, 'Indie')",
                    [(a,) for a in list(CASES) + list(PRICES)])
    bm.create_staging(con, bm.build_params())
    return con


@pytest.fixture(scope="module")
def con():
    c = build()
    yield c
    c.close()


def _row(con, appid):
    r = con.execute(
        "SELECT CAST(release_date AS VARCHAR), CAST(store_release_date AS VARCHAR), "
        "release_date_source, is_ea_graduate, release_valid, is_recent, release_year "
        "FROM stg_game WHERE appid = ?", [appid]).fetchone()
    assert r is not None, f"appid {appid} missing from stg_game"
    return dict(zip(("release_date", "store", "source", "grad", "valid", "recent", "year"), r))


def test_ea_graduate_is_dated_from_its_first_review_month(con):
    r = _row(con, SCUM)
    assert (r["release_date"], r["store"], r["source"], r["grad"]) == (
        "2018-08-01", "2025-06-17", "first_review_month", True), r
    assert r["year"] == 2018 and r["recent"] is False, (
        "a game public since 2018 is not a recent release, whatever its 1.0 date")


def test_ea_graduate_gets_day_precision_when_the_sample_reaches_its_first_month(con):
    r = _row(con, MSC)
    assert (r["release_date"], r["store"], r["source"], r["grad"]) == (
        "2016-10-24", "2025-01-08", "first_review", True), r


def test_a_short_head_start_keeps_the_exact_store_date(con):
    for appid in (HEADSTART, MONTH_ONLY):
        r = _row(con, appid)
        assert (r["release_date"], r["source"], r["grad"]) == ("2025-03-02", "store", False), (
            appid, r)


def test_a_reviewed_game_without_a_usable_store_date_is_rescued(con):
    r = _row(con, RESCUED)
    assert r["release_date"] == (TODAY - timedelta(days=200)).isoformat(), r
    assert (r["source"], r["grad"], r["valid"], r["recent"]) == ("first_review", False, True, True), r
    f = _row(con, FUTURE_REVIEWED)
    assert f["release_date"] == (TODAY - timedelta(days=5)).isoformat(), f
    assert f["store"] == (TODAY + timedelta(days=20)).isoformat() and f["grad"] is False, f
    assert f["valid"] is True, "public today: it belongs in the windows already"


def test_unreleased_and_undated_games_stay_out_of_every_window(con):
    b = _row(con, FUTURE_BARE)
    assert b["release_date"] == (TODAY + timedelta(days=20)).isoformat() and b["valid"] is False, b
    assert b["source"] == "store", b
    n = _row(con, NO_DATE)
    assert (n["release_date"], n["source"], n["valid"], n["year"]) == (None, None, False, 2027), n


def test_corrupt_review_timestamps_and_still_in_ea_games(con):
    c = _row(con, CORRUPT_TS)
    assert (c["release_date"], c["source"], c["grad"]) == ("2020-01-05", "store", False), c
    e = _row(con, STILL_EA)
    assert (e["release_date"], e["source"], e["grad"]) == (EA_LAUNCH.isoformat(), "store", False), e


def test_the_live_store_date_beats_the_frozen_snapshot(con):
    r = _row(con, LIVE_WINS)
    assert r["store"] == "2025-08-14" and r["release_date"] == "2025-08-14", r


def test_only_paid_games_carry_revenue(con):
    got = {a: (s, rev, rev_o) for a, s, rev, rev_o in con.execute(
        "SELECT appid, price_status, est_rev_reviews, est_rev_owners FROM stg_game "
        "WHERE appid BETWEEN 20 AND 25").fetchall()}
    assert got[FREE][0] == "free" and got[FREE_PRICED][0] == "free", got
    assert got[ZERO_NOT_FREE][0] == "unknown" and got[NO_PRICE][0] == "unknown", got
    assert got[PAID][0] == "paid" and got[FLOORED][0] == "paid", got
    for appid in (FREE, FREE_PRICED, ZERO_NOT_FREE, NO_PRICE):
        assert got[appid][1] is None and got[appid][2] is None, (
            f"appid {appid} ({got[appid][0]}) must have NO revenue estimate, not $0: {got[appid]}")
    assert got[PAID][1] == pytest.approx(300 * 30 * 9.99), got[PAID]
    assert got[PAID][2] == pytest.approx(50000 * 9.99), "SteamSpy owners x price for a paid game"


def _meta_fixture(with_new_staging: bool) -> duckdb.DuckDBPyConnection:
    c = duckdb.connect(":memory:")
    cols = "appid INTEGER, total_reviews INTEGER, est_rev_reviews DOUBLE, price_initial DOUBLE"
    if with_new_staging:
        cols += ", price_status VARCHAR"
    c.execute(f"CREATE TABLE stg_game({cols})")
    if with_new_staging:
        c.execute("INSERT INTO stg_game VALUES (1, 100, 5000.0, 9.99, 'paid'), "
                  "(2, 100, NULL, 0.0, 'free'), (3, 80, NULL, NULL, 'unknown'), "
                  "(4, 10, NULL, 0.0, 'free')")
    else:
        c.execute("INSERT INTO stg_game VALUES (1, 100, 5000.0, 9.99)")
    c.execute("CREATE TABLE stg_genre_boxleiter(genre VARCHAR, slope DOUBLE)")
    c.execute("INSERT INTO stg_genre_boxleiter VALUES ('__all__', 31.5)")
    c.execute("CREATE TABLE _pl_panel(appid INTEGER)")
    c.execute("CREATE TABLE mart_game_players_daily(appid INTEGER, date DATE)")
    return c


def test_write_meta_publishes_the_revenue_exclusions():
    c = _meta_fixture(with_new_staging=True)
    try:
        bm.write_meta(c, "src.db", "20260922")
        meta = dict(c.execute("SELECT key, value FROM mart_meta").fetchall())
    finally:
        c.close()
    # the free/unknown games at the floor are what global_median_revenue now EXCLUDES
    assert (meta["n_games_scored"], meta["n_games_scored_free"],
            meta["n_games_scored_price_unknown"]) == ("1", "1", "1"), meta
    assert meta["global_median_revenue"] == "5000.00", "the median is over the paid game only"


def test_write_meta_leaves_the_new_keys_blank_on_an_older_staging_layer():
    """Provenance must never be what fails a finished build: a staging layer without the new
    tables/columns (or a minimal caller) gets blank values, not an exception."""
    c = _meta_fixture(with_new_staging=False)
    try:
        bm.write_meta(c, "src.db", "20260922")
        meta = dict(c.execute("SELECT key, value FROM mart_meta").fetchall())
    finally:
        c.close()
    for k in ("n_games_scored_free", "n_games_scored_price_unknown"):
        assert meta[k] == "", (k, meta[k])
