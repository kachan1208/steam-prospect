"""The niche drill-down surface against a mart that DOES carry mart_niche_game.

conftest's shared fixture mart deliberately predates that table (test_niches_games.py
covers that state), so this module builds its own tiny DuckDB and swaps analytics_db onto
it for the duration, then restores. The swap is why every test here takes the
`niche_games_client` fixture rather than the session `client` directly.

Numbers are hand-picked so every assertion is checkable on paper — see the comments on
GAMES/MEMBERSHIP below.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import duckdb
import pytest

from app import analytics_db
from app.config import settings
from app.routers import niches

# appid, name, release_year, price_initial, est_rev_reviews, total_reviews, owners_mid.
# Prices are spread one per $2.50 bin, and TWO games are free ($0) so the free-vs-paid
# bucket split is observable; revenues are spread across half-decade log bins.
GAMES = [
    (1, "Alpha", 2020, 0.00, 0.0, 1000, 500_000.0),
    (2, "Bravo", 2021, 1.99, 500.0, 120, 9_000.0),
    (3, "Charlie", 2022, 4.99, 5_000.0, 300, 40_000.0),
    (4, "Delta", 2023, 9.99, 50_000.0, 800, 120_000.0),
    (5, "Echo", 2024, 14.99, 200_000.0, 2_000, 400_000.0),
    (6, "Foxtrot", 2025, 19.99, 900_000.0, 5_000, 900_000.0),
    (7, "Golf", 2019, 24.99, 1_500.0, 150, 12_000.0),
    (8, "Hotel", 2026, 29.99, 3_000_000.0, 12_000, 2_000_000.0),
    (9, "India", 2018, 0.00, 0.0, 90, 30_000.0),
    (10, "Juliett", 2022, 7.49, 12_000.0, 400, 60_000.0),
]

# (dimension, key, win, min_reviews) -> appids. 'Indie/Adventure' carries a slash on purpose:
# it is the {key:path} case the real marts hit (tag/genre keys contain slashes and spaces).
MEMBERSHIP = {
    ("tag", "Roguelike", "all", 50): [1, 2, 3, 4, 5, 6, 7, 8],
    ("tag", "Roguelike", "24m", 50): [5, 6, 8],
    ("tag", "Roguelike", "all", 100): [6, 8],
    ("tag", "Deckbuilding", "all", 50): [4, 5, 6, 9, 10],
    ("genre", "Indie/Adventure", "all", 50): [2, 3],
}

# Deliberately NOT derivable from GAMES: a count of 42 in bucket 4 can only have come from
# reading mart_niche_hist, which is how the "prefer the precomputed mart" path is proven.
# Bucket 0's x_min is stored as the mart stores it (1.0, from its GREATEST(v,1) floor); the
# router must report 0.0 so the cross-filter doesn't drop free games.
HIST = [
    ("tag", "Roguelike", 0, 1.0, 3.1622776601683795, 2),
    ("tag", "Roguelike", 4, 100.0, 316.22776601683796, 42),
]


def _build(path: Path) -> None:
    con = duckdb.connect(str(path))
    try:
        con.execute(
            "CREATE TABLE mart_game (appid INTEGER, name VARCHAR, release_year INTEGER, "
            "price_initial DOUBLE, est_rev_reviews DOUBLE, total_reviews INTEGER, "
            "owners_mid DOUBLE)"
        )
        con.executemany("INSERT INTO mart_game VALUES (?, ?, ?, ?, ?, ?, ?)", GAMES)

        # The contract: keys only. Every attribute comes from the mart_game join.
        con.execute(
            "CREATE TABLE mart_niche_game (dimension VARCHAR, key VARCHAR, win VARCHAR, "
            "min_reviews INTEGER, appid INTEGER)"
        )
        con.executemany(
            "INSERT INTO mart_niche_game VALUES (?, ?, ?, ?, ?)",
            [(d, k, w, m, a) for (d, k, w, m), ids in MEMBERSHIP.items() for a in ids],
        )

        con.execute(
            "CREATE TABLE mart_niche_hist (dimension VARCHAR, key VARCHAR, "
            "bucket_index INTEGER, x_min DOUBLE, x_max DOUBLE, count INTEGER)"
        )
        con.executemany("INSERT INTO mart_niche_hist VALUES (?, ?, ?, ?, ?, ?)", HIST)

        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.executemany(
            "INSERT INTO mart_meta VALUES (?, ?)",
            [("mart_version", "niche-games-fixture"), ("built_at", "2026-01-01T00:00:00+00:00")],
        )
    finally:
        con.close()  # must be closed before analytics_db opens it read_only


_PROBES = (niches._has_niche_games, niches._niche_game_cuts)


@pytest.fixture(scope="module")
def niche_games_client(client):
    """Swap analytics_db onto a mart that has mart_niche_game, then put the shared fixture
    mart back. Depends on `client` so the app's lifespan has already run its own
    analytics_db.init() before we swap — otherwise it would overwrite the swap."""
    tmp = Path(tempfile.mkdtemp(prefix="prospect_niche_games_"))
    db = tmp / "niche_games.duckdb"
    _build(db)

    analytics_db.close()
    analytics_db.init(str(db), 2)
    for probe in _PROBES:
        probe.cache_clear()  # the capability answers are per-process; this DB has new ones
    try:
        yield client
    finally:
        analytics_db.close()
        analytics_db.init(settings.analytics_db_path, settings.analytics_pool_size)
        for probe in _PROBES:
            probe.cache_clear()


def _appids(body) -> list[int]:
    return [i["appid"] for i in body["items"]]


# ---- /games: paging, total, sorting -----------------------------------------------------
def test_games_total_is_the_count_before_paging(niche_games_client):
    """`total` must be the full match count so the UI can page honestly — not len(items)."""
    r = niche_games_client.get(
        "/api/niches/tag/Roguelike/games", params={"sort": "revenue", "order": "desc", "limit": 3}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 8
    assert body["limit"] == 3 and body["offset"] == 0
    # revenues desc: 3M(8), 900k(6), 200k(5), 50k(4), 5k(3), 1.5k(7), 500(2), 0(1)
    assert _appids(body) == [8, 6, 5]


def test_games_paging_walks_the_set_without_moving_total(niche_games_client):
    page2 = niche_games_client.get(
        "/api/niches/tag/Roguelike/games",
        params={"sort": "revenue", "order": "desc", "limit": 3, "offset": 3},
    ).json()
    assert page2["total"] == 8
    assert _appids(page2) == [4, 3, 7]

    tail = niche_games_client.get(
        "/api/niches/tag/Roguelike/games",
        params={"sort": "revenue", "order": "desc", "limit": 3, "offset": 6},
    ).json()
    assert tail["total"] == 8
    assert _appids(tail) == [2, 1]  # short last page, total unchanged


def test_games_offset_past_the_end_is_empty_not_an_error(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/games", params={"offset": 500}
    ).json()
    assert body["total"] == 8
    assert body["items"] == []


def test_games_sort_by_name_and_release_year(niche_games_client):
    by_name = niche_games_client.get(
        "/api/niches/tag/Roguelike/games", params={"sort": "name", "order": "asc", "limit": 100}
    ).json()
    assert _appids(by_name) == [1, 2, 3, 4, 5, 6, 7, 8]  # Alpha..Hotel

    by_year = niche_games_client.get(
        "/api/niches/tag/Roguelike/games",
        params={"sort": "release_year", "order": "asc", "limit": 100},
    ).json()
    assert _appids(by_year) == [7, 1, 2, 3, 4, 5, 6, 8]  # 2019..2026


def test_games_row_shape_maps_the_mart_columns_onto_the_contract(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/games", params={"sort": "revenue", "order": "desc", "limit": 1}
    ).json()
    assert body["items"][0] == {
        "appid": 8,
        "name": "Hotel",
        "release_year": 2026,
        "price_initial": 29.99,
        "est_revenue": 3_000_000.0,
        "total_reviews": 12_000,
        "owners_est": 2_000_000.0,
    }


def test_games_honours_the_requested_cut(niche_games_client):
    recent = niche_games_client.get(
        "/api/niches/tag/Roguelike/games", params={"win": "24m", "limit": 100}
    ).json()
    assert recent["total"] == 3
    assert sorted(_appids(recent)) == [5, 6, 8]

    strict = niche_games_client.get(
        "/api/niches/tag/Roguelike/games", params={"min_reviews": 100, "limit": 100}
    ).json()
    assert strict["total"] == 2
    assert sorted(_appids(strict)) == [6, 8]


def test_games_key_with_a_slash_survives_the_path_converter(niche_games_client):
    body = niche_games_client.get("/api/niches/genre/Indie/Adventure/games", params={"limit": 100}).json()
    assert body["total"] == 2
    assert sorted(_appids(body)) == [2, 3]


def test_games_unknown_niche_is_an_honest_empty_page(niche_games_client):
    body = niche_games_client.get("/api/niches/tag/Nonexistent/games").json()
    assert body["total"] == 0 and body["items"] == []


def test_games_rejects_an_unmaterialised_cut(niche_games_client):
    """min_reviews=0 was never built into this mart — a loud 422 listing what exists beats a
    `total: 0` the UI would render as "this niche has no games"."""
    r = niche_games_client.get("/api/niches/tag/Roguelike/games", params={"min_reviews": 0})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "not materialised" in detail
    assert "(all, 50)" in detail and "(24m, 50)" in detail and "(all, 100)" in detail


# ---- /games: the chart cross-filter -----------------------------------------------------
def test_games_revenue_cross_filter_is_half_open(niche_games_client):
    """[rev_min, rev_max) — exactly one revenue log bucket's worth."""
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/games",
        params={"rev_min": 100_000, "rev_max": 316_227.766, "limit": 100},
    ).json()
    assert body["total"] == 1
    assert _appids(body) == [5]  # 200k in, 900k excluded by the open upper edge


def test_games_cross_filter_changes_total_not_just_items(niche_games_client):
    """The cross-filtered `total` must be the filtered count, or the pager lies."""
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/games", params={"rev_min": 0, "rev_max": 10_000, "limit": 1}
    ).json()
    assert body["total"] == 4  # appids 1 (0), 2 (500), 7 (1500), 3 (5000)
    assert len(body["items"]) == 1


def test_games_free_bucket_filter_isolates_free_to_play(niche_games_client):
    """The free bucket's [0.0, 0.01) window must return $0 games and nothing else."""
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/games",
        params={"price_min": 0.0, "price_max": 0.01, "limit": 100},
    ).json()
    assert body["total"] == 1
    assert _appids(body) == [1]


def test_games_first_paid_bucket_filter_excludes_free(niche_games_client):
    """...and the first PAID bucket [0.01, 2.50) must not pick the free game back up. This
    is the whole reason paid bucket 0 starts at a cent instead of at zero."""
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/games",
        params={"price_min": 0.01, "price_max": 2.5, "limit": 100},
    ).json()
    assert body["total"] == 1
    assert _appids(body) == [2]  # $1.99


def test_games_price_and_revenue_filters_compose(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/games",
        params={"price_min": 7.5, "price_max": 20.0, "rev_min": 100_000, "limit": 100},
    ).json()
    assert sorted(_appids(body)) == [5, 6]  # $14.99/200k and $19.99/900k; $9.99/50k is out
    assert body["total"] == 2


# ---- /distribution ----------------------------------------------------------------------
def test_distribution_revenue_prefers_the_precomputed_mart_on_its_cut(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "revenue"}
    ).json()
    assert body["source"] == "mart"
    # 42 is not derivable from the 8 fixture games — it can only have come from mart_niche_hist.
    assert [(b["bucket_index"], b["count"]) for b in body["buckets"]] == [(0, 2), (4, 42)]
    assert body["n_games"] == 44


def test_distribution_normalises_the_mart_bucket_zero_lower_edge(niche_games_client):
    """mart_niche_hist stores bucket 0 as x_min=1.0 (its GREATEST(v,1) floor) even though the
    bucket holds the $0 games. Reporting 1.0 would make the UI's cross-filter drop them."""
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "revenue"}
    ).json()
    assert body["buckets"][0]["x_min"] == 0.0
    assert body["buckets"][0]["x_max"] == pytest.approx(3.1622776601683795)


def test_distribution_revenue_computes_off_cut(niche_games_client):
    """24m is not mart_niche_hist's cut, so it must be aggregated live — same binning."""
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "revenue", "win": "24m"}
    ).json()
    assert body["source"] == "computed"
    # 200k -> bucket 10, 900k -> 11, 3M -> 12 (floor(log10(v)*2))
    assert [(b["bucket_index"], b["count"]) for b in body["buckets"]] == [(10, 1), (11, 1), (12, 1)]
    assert body["n_games"] == 3
    b10 = body["buckets"][0]
    assert b10["x_min"] == pytest.approx(100_000.0)
    assert b10["x_max"] == pytest.approx(316_227.766, rel=1e-6)


def test_distribution_computed_buckets_round_trip_into_the_games_filter(niche_games_client):
    """Every bucket's (x_min, x_max) handed back to /games must return exactly its count.
    This is the contract the cross-filtering charts are built on."""
    dist = niche_games_client.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "price"}
    ).json()
    assert dist["source"] == "computed"
    for b in dist["buckets"]:
        got = niche_games_client.get(
            "/api/niches/tag/Roguelike/games",
            params={"price_min": b["x_min"], "price_max": b["x_max"], "limit": 100},
        ).json()
        assert got["total"] == b["count"], b


def test_distribution_price_gives_free_to_play_its_own_bucket(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "price"}
    ).json()
    buckets = {b["bucket_index"]: b for b in body["buckets"]}
    free = buckets[-1]
    assert (free["x_min"], free["x_max"], free["count"]) == (0.0, 0.01, 1)
    # ...and the $1.99 game sits in its own paid bucket starting at a cent, not with it.
    assert (buckets[0]["x_min"], buckets[0]["x_max"], buckets[0]["count"]) == (0.01, 2.5, 1)
    # $2.50 linear bins across the rest: 4.99->1, 9.99->3, 14.99->5, 19.99->7, 24.99->9, 29.99->11
    assert sorted(buckets) == [-1, 0, 1, 3, 5, 7, 9, 11]
    assert body["n_games"] == 8


def test_distribution_price_on_a_niche_with_two_free_games(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/tag/Deckbuilding/distribution", params={"metric": "price"}
    ).json()
    buckets = {b["bucket_index"]: b["count"] for b in body["buckets"]}
    assert buckets[-1] == 1  # only appid 9 is free in Deckbuilding
    assert body["n_games"] == 5


# ---- /combined --------------------------------------------------------------------------
def test_combined_intersect_is_the_default(niche_games_client):
    r = niche_games_client.get(
        "/api/niches/combined", params={"niches": ["tag:Roguelike", "tag:Deckbuilding"]}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "intersect"
    assert body["win"] == "all" and body["min_reviews"] == 50
    # Roguelike = 1..8, Deckbuilding = 4,5,6,9,10 -> intersect = 4,5,6
    assert body["n_games"] == 3
    assert body["total"] == 3
    assert _appids(body) == [6, 5, 4]  # revenue desc


def test_combined_reports_each_input_niches_own_size(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/combined", params={"niches": ["tag:Roguelike", "tag:Deckbuilding"]}
    ).json()
    assert body["inputs"] == [
        {"dimension": "tag", "key": "Roguelike", "n_games": 8},
        {"dimension": "tag", "key": "Deckbuilding", "n_games": 5},
    ]


def test_combined_stats_are_recomputed_over_the_combined_set(niche_games_client):
    """quantile_cont over [50k, 200k, 900k] and median over [9.99, 14.99, 19.99] — NOT an
    average of the two input niches' precomputed percentiles."""
    body = niche_games_client.get(
        "/api/niches/combined", params={"niches": ["tag:Roguelike", "tag:Deckbuilding"]}
    ).json()
    assert body["median_rev"] == pytest.approx(200_000.0)
    assert body["p25_rev"] == pytest.approx(125_000.0)
    assert body["p75_rev"] == pytest.approx(550_000.0)
    assert body["p90_rev"] == pytest.approx(760_000.0)
    assert body["median_price"] == pytest.approx(14.99)


def test_combined_union_is_wider_than_intersect(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/combined",
        params={"niches": ["tag:Roguelike", "tag:Deckbuilding"], "mode": "union", "limit": 100},
    ).json()
    assert body["mode"] == "union"
    assert body["n_games"] == 10  # 1..8 plus 9 and 10
    assert body["total"] == 10
    assert sorted(_appids(body)) == list(range(1, 11))


def test_combined_intersect_of_three_narrows_further(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/combined",
        params={
            "niches": ["tag:Roguelike", "tag:Deckbuilding", "genre:Indie/Adventure"],
            "limit": 100,
        },
    ).json()
    # Indie/Adventure = {2,3}; nothing is in all three.
    assert body["n_games"] == 0
    assert body["items"] == []
    assert [i["n_games"] for i in body["inputs"]] == [8, 5, 2]
    assert body["median_rev"] is None


def test_combined_pages_and_sorts_like_the_games_endpoint(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/combined",
        params={
            "niches": ["tag:Roguelike", "tag:Deckbuilding"],
            "mode": "union",
            "sort": "price",
            "order": "asc",
            "limit": 2,
            "offset": 1,
        },
    ).json()
    assert body["total"] == 10  # unchanged by paging
    assert body["limit"] == 2 and body["offset"] == 1
    # prices asc: 0.00(1), 0.00(9), 1.99(2), 4.99(3), ... -> appid tiebreak puts 1 before 9
    assert _appids(body) == [9, 2]


def test_combined_honours_the_cut(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/combined",
        params={"niches": ["tag:Roguelike", "tag:Deckbuilding"], "win": "24m"},
    ).json()
    # Deckbuilding has no 24m rows in this mart -> intersect is empty, and it says so.
    assert body["inputs"] == [
        {"dimension": "tag", "key": "Roguelike", "n_games": 3},
        {"dimension": "tag", "key": "Deckbuilding", "n_games": 0},
    ]
    assert body["n_games"] == 0


def test_combined_key_may_contain_a_slash(niche_games_client):
    body = niche_games_client.get(
        "/api/niches/combined",
        params={"niches": ["tag:Roguelike", "genre:Indie/Adventure"], "limit": 100},
    ).json()
    assert body["n_games"] == 2
    assert sorted(_appids(body)) == [2, 3]


def test_combined_rejects_an_unmaterialised_cut(niche_games_client):
    r = niche_games_client.get(
        "/api/niches/combined",
        params={"niches": ["tag:Roguelike", "tag:Deckbuilding"], "min_reviews": 0},
    )
    assert r.status_code == 422
    assert "not materialised" in r.json()["detail"]
