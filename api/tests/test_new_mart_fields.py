"""The ETL's in-flight mart columns, served the moment they exist and never before.

The API ships ahead of the mart that carries these (the same deploy-before-rebuild gap
every additive column has had), so each is CAPABILITY-GATED on its own column: absent -> the
field is null (never a BinderException 500, never a 503 unless you SORT by it), present -> it
flows through. Both states are exercised on the modern fixture mart (conftest).

  games     first_public_date / release_date_1_0 / is_ea_graduate (EA lifecycle) on search
            rows + the profile; players_trend_7d_market_pct / _rel_pct on the profile and
            the /players summary.
  niches    n_free / n_price_unknown / players_trend_7d_market_pct / _rel_pct on list and
            detail rows (and the detail's players block); sortable once present.
  owners_as_of (mart_meta) on the lists and details that show an owners estimate.

Plus the invariant the web relies on to tell "Free" from "price unknown": every game row
carries is_free next to its price (price 0 with is_free 0 = unknown, not free).
"""
from __future__ import annotations

import pytest

from conftest import build_modern_mart, serving


@pytest.fixture
def new_cols_client(client, tmp_path):
    path = tmp_path / "new_cols.duckdb"
    build_modern_mart(
        path, new_niche_cols=True, new_game_cols=True, meta={"owners_as_of": "2024-06-01"}
    )
    with serving(path):
        yield client


# ---- absent: null, never an error ---------------------------------------------------------
def test_absent_columns_are_null_not_errors(modern_mart):
    game = modern_mart.get("/api/games/1001").json()
    for field in ("first_public_date", "release_date_1_0", "is_ea_graduate",
                  "players_trend_7d_market_pct", "players_trend_7d_rel_pct", "owners_as_of"):
        assert game[field] is None, field
    row = modern_mart.get("/api/games/search", params={"q": "rogue"}).json()["items"][0]
    assert row["first_public_date"] is None and row["is_ea_graduate"] is None

    niches = modern_mart.get("/api/niches", params={"window": "all", "min_reviews": 50}).json()
    assert niches["owners_as_of"] is None
    for item in niches["items"]:
        for field in ("n_free", "n_price_unknown", "players_trend_7d_market_pct",
                      "players_trend_7d_rel_pct"):
            assert item[field] is None, field
    players = modern_mart.get("/api/niches/tag/Roguelike").json()["players"]
    assert players["players_trend_7d_market_pct"] is None


@pytest.mark.parametrize(
    "sort", ["n_free", "n_price_unknown", "players_trend_7d_market_pct", "players_trend_7d_rel_pct"]
)
def test_sorting_by_an_absent_column_is_the_rebuild_503(modern_mart, sort):
    r = modern_mart.get("/api/niches", params={"sort": sort, "window": "all", "min_reviews": 50})
    assert r.status_code == 503
    assert sort in r.json()["detail"]


# ---- present: they flow through --------------------------------------------------------------
def test_ea_lifecycle_on_profile_and_search(new_cols_client):
    game = new_cols_client.get("/api/games/1001").json()
    assert game["first_public_date"] == "2023-05-10"
    assert game["release_date_1_0"] == "2024-03-01"
    assert game["is_ea_graduate"] is True
    rows = {g["appid"]: g for g in new_cols_client.get(
        "/api/games/search", params={"min_reviews": 0, "limit": 50}).json()["items"]}
    assert rows[1001]["is_ea_graduate"] is True
    assert rows[1002]["is_ea_graduate"] is False
    assert rows[1002]["first_public_date"] == rows[1002]["release_date_1_0"] == "2023-06-15"


def test_market_relative_player_trend_on_the_game(new_cols_client):
    game = new_cols_client.get("/api/games/1001").json()
    assert (game["players_trend_7d_pct"], game["players_trend_7d_market_pct"],
            game["players_trend_7d_rel_pct"]) == (5.0, 2.0, 2.94)
    summary = new_cols_client.get("/api/games/1001/players").json()["summary"]
    assert summary["players_trend_7d_market_pct"] == 2.0
    assert summary["players_trend_7d_rel_pct"] == 2.94


def test_niche_rows_and_detail_carry_the_new_columns(new_cols_client):
    body = new_cols_client.get("/api/niches", params={"window": "all", "min_reviews": 50}).json()
    assert body["owners_as_of"] == "2024-06-01"
    row = next(i for i in body["items"] if i["key"] == "Roguelike")
    assert (row["n_free"], row["n_price_unknown"]) == (1, 0)
    assert row["players_trend_7d_market_pct"] == -1.0
    assert row["players_trend_7d_rel_pct"] == -2.02

    detail = new_cols_client.get("/api/niches/tag/Roguelike").json()
    assert detail["owners_as_of"] == "2024-06-01"
    assert detail["players"]["players_trend_7d_rel_pct"] == -2.02
    assert all(v["n_free"] == 1 for v in detail["variants"])


def test_new_niche_columns_are_sortable_once_present(new_cols_client):
    r = new_cols_client.get(
        "/api/niches", params={"sort": "players_trend_7d_rel_pct", "window": "all", "min_reviews": 50}
    )
    assert r.status_code == 200


def test_export_header_carries_the_new_columns(new_cols_client):
    r = new_cols_client.get("/api/niches/export.csv", params={"window": "all", "min_reviews": 50, "tiers": ""})
    header = r.text.splitlines()[0].split(",")
    for col in ("n_free", "n_price_unknown", "players_trend_7d_market_pct", "players_trend_7d_rel_pct"):
        assert col in header


def test_owners_as_of_on_game_surfaces(new_cols_client):
    assert new_cols_client.get("/api/games/1001").json()["owners_as_of"] == "2024-06-01"
    assert new_cols_client.get("/api/games/search").json()["owners_as_of"] == "2024-06-01"
    games = new_cols_client.get("/api/niches/tag/Roguelike/games").json()
    assert games["owners_as_of"] == "2024-06-01"


# ---- is_free always travels with the price ---------------------------------------------------
def test_every_game_row_carries_is_free_next_to_price(modern_mart):
    """The UI tells "Free" (is_free=1) from "price unknown" (price 0/null with is_free=0)
    ONLY through is_free, so every surface that shows a price must carry it."""
    c = modern_mart
    surfaces = {
        "search": c.get("/api/games/search", params={"min_reviews": 0}).json()["items"],
        "profile": [c.get("/api/games/1004").json()],
        "niche games": c.get("/api/niches/tag/Roguelike/games").json()["items"],
        "niche top": c.get("/api/niches/tag/Roguelike").json()["representative_games"],
        "entity games": c.get(
            "/api/entities/profile", params={"role": "developer", "name": "Big Studio D"}
        ).json()["games"],
    }
    for name, rows in surfaces.items():
        assert rows, name
        for r in rows:
            assert "price_initial" in r and "is_free" in r, (name, r)
    free = next(r for r in surfaces["niche games"] if r["appid"] == 1004)
    assert (free["price_initial"], free["is_free"]) == (0.0, 1)
    comps = c.get("/api/games/1002/comparables").json()["items"]
    assert all("is_free" in r for r in comps)


def test_the_etl_shipped_shape_maps_onto_the_ea_contract(client, tmp_path):
    # The ETL shipped the lifecycle as release_date (= first public, marked by
    # release_date_source) + store_release_date, not as first_public_date/release_date_1_0.
    # The API maps it so the web's contract lights up on the real mart.
    path = tmp_path / "etl_shape.duckdb"
    build_modern_mart(path, etl_game_cols=True)
    with serving(path):
        game = client.get("/api/games/1001").json()
        assert game["first_public_date"] == "2023-05-10"
        assert game["release_date_1_0"] == "2024-03-01"
        assert game["is_ea_graduate"] is True
        assert game["release_date_source"] == "first_review"
        assert game["price_status"] == "paid"
        rows = {g["appid"]: g for g in client.get(
            "/api/games/search", params={"min_reviews": 0, "limit": 50}).json()["items"]}
        assert rows[1001]["first_public_date"] == "2023-05-10"
        assert rows[1001]["release_date_1_0"] == "2024-03-01"
        assert rows[1002]["release_date_source"] == "store"
        assert rows[1002]["first_public_date"] == rows[1002]["release_date_1_0"]
