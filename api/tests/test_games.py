"""api/app/routers/games.py — search/profile/comparables happy paths over the fixture's 6
synthetic mart_game rows (see api/tests/conftest.py). reviews-summary/teardown/aspect-reviews
aren't covered here: they read mart_game_reviews_*/mart_game_review_aspects/mart_game_press_*,
which this small fixture deliberately doesn't build (out of this task's prioritized scope —
see the final report)."""
from __future__ import annotations


def test_search_by_name_substring(client):
    r = client.get("/api/games/search", params={"q": "rogue"})  # ILIKE — case-insensitive
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["appid"] == 1001


def test_search_by_genre(client):
    r = client.get("/api/games/search", params={"genre": "Roguelike"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert {g["appid"] for g in body["items"]} == {1001, 1002, 1003}


def test_search_by_tag_requires_exact_top_tag_match(client):
    r = client.get("/api/games/search", params={"tag": "Strategy"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["appid"] == 1002


def test_search_min_reviews_floor(client):
    r = client.get("/api/games/search", params={"min_reviews": 100})
    assert r.status_code == 200
    body = r.json()
    # Excludes 1003 (80 reviews) and 1006 (15 reviews).
    assert {g["appid"] for g in body["items"]} == {1001, 1002, 1004, 1005}


def test_search_sort_and_order(client):
    r = client.get("/api/games/search", params={"sort": "price_initial", "order": "asc", "min_reviews": 0})
    assert r.status_code == 200
    prices = [g["price_initial"] for g in r.json()["items"]]
    assert prices == sorted(prices)


def test_search_rejects_unknown_sort_column(client):
    r = client.get("/api/games/search", params={"sort": "appid; DROP TABLE mart_game--"})
    assert r.status_code == 400
    assert "sort must be one of" in r.json()["detail"]


def test_search_pagination(client):
    # Default sort is total_reviews desc: 1004(3000), 1002(1200), 1001(500), 1005(200),
    # 1003(80), 1006(15) — "appid" itself isn't in games.py's SORTABLE whitelist.
    r = client.get("/api/games/search", params={"min_reviews": 0, "limit": 2, "offset": 0})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 6
    assert body["limit"] == 2
    assert [g["appid"] for g in body["items"]] == [1004, 1002]

    r2 = client.get("/api/games/search", params={"min_reviews": 0, "limit": 2, "offset": 2})
    assert [g["appid"] for g in r2.json()["items"]] == [1001, 1005]


def test_game_profile_happy_path(client):
    r = client.get("/api/games/1001")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Rogue Cellar"
    assert body["primary_genre"] == "Roguelike"
    assert body["in_watchlist"] is False
    assert body["top_tags"] == ["Deckbuilder", "Roguelike", "Indie"]


def test_game_profile_unknown_appid_is_404(client):
    r = client.get("/api/games/404404404")
    assert r.status_code == 404


def test_game_comparables_ranks_by_jaccard_similarity(client):
    r = client.get("/api/games/1001/comparables")
    assert r.status_code == 200
    body = r.json()
    assert body["primary_genre"] == "Roguelike"
    appids = [item["appid"] for item in body["items"]]
    # 1002 shares {Deckbuilder, Roguelike} with 1001 (jaccard .5); 1003 shares only
    # {Roguelike} (jaccard .25) — both clear the price band and genre match, 1004/1005/1006
    # don't (wrong genre / free / out of price band).
    assert appids == [1002, 1003]
    assert body["items"][0]["jaccard"] > body["items"][1]["jaccard"]


def test_game_comparables_unknown_appid_is_404(client):
    r = client.get("/api/games/404404404/comparables")
    assert r.status_code == 404
