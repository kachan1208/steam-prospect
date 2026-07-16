"""api/app/routers/niches.py — happy paths over the fixture's mart_niche/_top/_hist/_trend
rows (see api/tests/conftest.py for the exact seeded values), plus the `sort` whitelist
rejection (the same SQL-injection-via-identifier shape as explore.py, just a smaller
surface: one ORDER BY column instead of a whole compiled query)."""
from __future__ import annotations


def test_list_niches_default_filters_sorted_by_opportunity_desc(client):
    r = client.get("/api/niches", params={"dimension": "tag", "window": "all", "min_reviews": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert [row["key"] for row in body["items"]] == ["Deckbuilder", "Farming", "Card Battler"]


def test_list_niches_genre_dimension(client):
    r = client.get("/api/niches", params={"dimension": "genre", "window": "all", "min_reviews": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert {row["key"] for row in body["items"]} == {"Roguelike", "Action", "Simulation"}


def test_list_niches_window_24m_scopes_to_recent_cut(client):
    r = client.get("/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["key"] == "Deckbuilder"
    assert body["items"][0]["window"] == "24m"


def test_list_niches_min_reviews_50_cut(client):
    r = client.get("/api/niches", params={"dimension": "tag", "window": "all", "min_reviews": 50})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["key"] == "Deckbuilder"
    assert body["items"][0]["min_reviews"] == 50


def test_list_niches_search_q_filters_by_key_substring(client):
    r = client.get("/api/niches", params={"q": "Deck"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["key"] == "Deckbuilder"


def test_list_niches_null_saturation_yoy_is_preserved_not_errored(client):
    # "Card Battler" was seeded with saturation_yoy=None to exercise NULLS LAST sort handling.
    r = client.get("/api/niches", params={"q": "Card Battler"})
    assert r.status_code == 200
    assert r.json()["items"][0]["saturation_yoy"] is None


def test_list_niches_rejects_unknown_sort_column(client):
    r = client.get("/api/niches", params={"sort": "appid; DROP TABLE mart_niche--"})
    assert r.status_code == 400
    assert "sort must be one of" in r.json()["detail"]


def test_list_niches_rejects_unknown_dimension(client):
    r = client.get("/api/niches", params={"dimension": "not_a_real_dimension"})
    assert r.status_code == 422  # FastAPI Query(pattern=...) rejects it at the request-shape level


def test_niche_detail_happy_path(client):
    r = client.get("/api/niches/tag/Deckbuilder")
    assert r.status_code == 200
    body = r.json()
    assert body["dimension"] == "tag"
    assert body["key"] == "Deckbuilder"
    assert len(body["variants"]) == 3  # (all,10) / (all,50) / (24m,10) seeded for this key
    assert len(body["saturation_trend"]) == 2
    assert len(body["revenue_histogram"]) == 2
    assert [g["appid"] for g in body["representative_games"]] == [1002, 1001]  # rank_in_niche order
    assert body["hit_rates"]["n_games"] == 2  # from the (all, min_reviews=10) headline variant


def test_niche_detail_unknown_key_is_404(client):
    r = client.get("/api/niches/tag/Not-A-Real-Niche")
    assert r.status_code == 404


def test_niche_detail_rejects_invalid_dimension(client):
    r = client.get("/api/niches/not_a_dimension/Deckbuilder")
    assert r.status_code == 400


def test_export_csv_happy_path(client):
    r = client.get("/api/export/niches.csv", params={"dimension": "tag", "window": "all", "min_reviews": 10})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    header = r.text.splitlines()[0]
    assert "key" in header and "window" in header  # `win` renamed to `window` for the CSV too
