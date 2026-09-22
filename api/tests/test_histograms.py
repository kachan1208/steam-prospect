"""The floored bucket of every LOG histogram (app/histograms.py).

The marts bin with floor(log10(GREATEST(v, 1)) * 2), so bucket 0 is stored as [1, 3.16) while
holding every value below 1 — $0 revenue (free games), 0 reviews, 0 players. The niche
page's revenue chart served mart_niche_hist raw and drew "$1–$3.16" over the free games;
only /distribution rewrote the edge, and only on its mart path. Every log histogram now
takes one helper: bucket 0 gets x_min 0.0 and floored=True, everything else floored=False —
and when the ETL stops flooring (free-game revenue becomes NULL) there is simply no bucket 0.
"""
from __future__ import annotations

import duckdb
import pytest

from conftest import build_modern_mart, serving


def _floored(buckets: list[dict]) -> list[int]:
    return [b["bucket_index"] for b in buckets if b["floored"]]


def test_niche_detail_revenue_histogram_marks_the_floor_bucket(modern_mart):
    body = modern_mart.get("/api/niches/tag/Roguelike").json()
    hist = body["revenue_histogram"]
    assert [b["bucket_index"] for b in hist] == [0, 8, 10, 11]
    b0 = hist[0]
    # Was served raw as x_min=1.0 — "$1–$3.16" over a bar holding the free game.
    assert b0["x_min"] == 0.0 and b0["floored"] is True
    assert b0["x_max"] == pytest.approx(3.1622776601683795)
    assert _floored(hist) == [0]


def test_niche_detail_players_histogram_marks_the_floor_bucket(modern_mart):
    dist = modern_mart.get("/api/niches/tag/Roguelike").json()["players"]["distribution"]
    assert _floored(dist["histogram"]) == [0]
    assert dist["histogram"][0]["x_min"] == 0.0


def test_distribution_mart_and_detail_paths_agree(modern_mart):
    """The two surfaces used to disagree about the SAME mart rows (the /distribution mart
    path rewrote the edge, niche_detail did not). One helper, one answer."""
    detail = modern_mart.get("/api/niches/tag/Roguelike").json()["revenue_histogram"]
    dist = modern_mart.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "revenue"}
    ).json()
    assert dist["source"] == "mart"
    assert dist["buckets"] == detail


def test_distribution_computed_revenue_marks_the_floor_bucket(modern_mart):
    """all/0 is not mart_niche_hist's cut, so it is aggregated live — the free member
    (1004, $0) lands in bucket 0, which must come back floored exactly like the mart's."""
    dist = modern_mart.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "revenue", "min_reviews": 0}
    ).json()
    assert dist["source"] == "computed"
    assert _floored(dist["buckets"]) == [0]
    assert dist["buckets"][0]["x_min"] == 0.0
    # ...and the floored bucket still round-trips into the cross-filter: [0, 3.16) is 1004.
    games = modern_mart.get(
        "/api/niches/tag/Roguelike/games",
        params={"min_reviews": 0, "rev_min": 0.0, "rev_max": dist["buckets"][0]["x_max"]},
    ).json()
    assert [g["appid"] for g in games["items"]] == [1004]


def test_no_floor_bucket_means_nothing_is_marked(modern_mart):
    """24m has no $0 member, so no bucket 0 — nothing floored, edges untouched."""
    dist = modern_mart.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "revenue", "win": "24m"}
    ).json()
    assert [b["bucket_index"] for b in dist["buckets"]] == [8, 10]
    assert _floored(dist["buckets"]) == []
    assert dist["buckets"][0]["x_min"] == pytest.approx(10_000.0)


def test_price_histogram_is_never_floored(modern_mart):
    dist = modern_mart.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "price"}
    ).json()
    assert dist["buckets"] and _floored(dist["buckets"]) == []


def test_once_free_revenue_is_null_there_is_no_floored_bucket(client, tmp_path):
    """The ETL is switching free / unknown-price revenue from 0 to NULL: those games drop
    out of the revenue histogram entirely (NULL, not a $0 bar) and bucket 0 disappears."""
    path = tmp_path / "null_free.duckdb"
    build_modern_mart(path)
    with duckdb.connect(str(path)) as con:
        con.execute("UPDATE mart_game SET est_rev_reviews = NULL WHERE is_free = 1")
        con.execute("DELETE FROM mart_niche_hist WHERE bucket_index = 0")
    with serving(path):
        detail = client.get("/api/niches/tag/Roguelike").json()["revenue_histogram"]
        computed = client.get(
            "/api/niches/tag/Roguelike/distribution",
            params={"metric": "revenue", "min_reviews": 0},
        ).json()
    assert _floored(detail) == [] and [b["bucket_index"] for b in detail] == [8, 10, 11]
    assert _floored(computed["buckets"]) == []
    assert computed["n_games"] == 3  # the free game is NOT counted as a $0 game any more


def test_market_distribution_marks_the_floor_bucket_on_log_metrics(client, tmp_path):
    """mart_market_hist's reviews histogram holds every 0-review game in bucket 0 under a
    [1, 3.16) label — same sentinel, same helper. Price is linear and never floored."""
    path = tmp_path / "market.duckdb"
    con = duckdb.connect(str(path))
    try:
        con.execute(
            "CREATE TABLE mart_market_hist (metric VARCHAR, genre VARCHAR, win VARCHAR, "
            "bucket_index INTEGER, x_min DOUBLE, x_max DOUBLE, count INTEGER)"
        )
        con.executemany(
            "INSERT INTO mart_market_hist VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("reviews", "__all__", "all", 0, 1.0, 3.1622776601683795, 19044),
                ("reviews", "__all__", "all", 1, 3.1622776601683795, 10.0, 20006),
                ("price", "__all__", "all", 0, 0.0, 2.5, 50),
            ],
        )
        con.execute(
            "CREATE TABLE mart_market_pct (metric VARCHAR, genre VARCHAR, win VARCHAR, "
            "n INTEGER, pctile VARCHAR, value DOUBLE)"
        )
        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
    finally:
        con.close()
    with serving(path):
        reviews = client.get("/api/market/distribution", params={"metric": "reviews"}).json()
        price = client.get("/api/market/distribution", params={"metric": "price"}).json()
    assert _floored(reviews["buckets"]) == [0]
    assert reviews["buckets"][0]["x_min"] == 0.0
    assert reviews["buckets"][1]["floored"] is False
    assert _floored(price["buckets"]) == []
