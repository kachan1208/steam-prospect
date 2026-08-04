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


def test_search_price_band_excludes_free_null_and_out_of_band(client):
    # $10-$20: 1001 (14.99) and 1002 (19.99); excludes 9.99, 24.99, 4.99 and free 1004.
    r = client.get("/api/games/search", params={"price_min": 10, "price_max": 20})
    assert r.status_code == 200
    assert {g["appid"] for g in r.json()["items"]} == {1001, 1002}


def test_search_price_max_alone_keeps_free_games(client):
    # "Under $5" is a budget filter — free titles belong in it (floor unset = 0 allowed).
    r = client.get("/api/games/search", params={"price_max": 5})
    assert r.status_code == 200
    assert {g["appid"] for g in r.json()["items"]} == {1004, 1006}


def test_search_min_positive_floor(client):
    r = client.get("/api/games/search", params={"min_positive": 0.85})
    assert r.status_code == 200
    # 1001 (.88), 1002 (.92), 1005 (.90); excludes .65/.81/.55.
    assert {g["appid"] for g in r.json()["items"]} == {1001, 1002, 1005}


def test_search_min_positive_rejects_out_of_range(client):
    r = client.get("/api/games/search", params={"min_positive": 1.5})
    assert r.status_code == 422


def test_search_min_revenue_floor(client):
    r = client.get("/api/games/search", params={"min_revenue": 100_000})
    assert r.status_code == 200
    # 1001 (150K), 1002 (900K), 1005 (250K); excludes 20K/0/3K.
    assert {g["appid"] for g in r.json()["items"]} == {1001, 1002, 1005}


def test_search_release_year_range(client):
    r = client.get("/api/games/search", params={"released_after": 2023, "released_before": 2024})
    assert r.status_code == 200
    # release_year 2023-2024 inclusive: 1001 (2024), 1002 (2023), 1005 (2024).
    assert {g["appid"] for g in r.json()["items"]} == {1001, 1002, 1005}


def test_search_self_published_both_directions(client):
    r = client.get("/api/games/search", params={"self_published": "true"})
    assert {g["appid"] for g in r.json()["items"]} == {1001, 1003, 1005, 1006}
    r = client.get("/api/games/search", params={"self_published": "false"})
    assert {g["appid"] for g in r.json()["items"]} == {1002, 1004}


def test_search_indie_filter(client):
    r = client.get("/api/games/search", params={"indie": "true"})
    assert {g["appid"] for g in r.json()["items"]} == {1001, 1002, 1003, 1005, 1006}
    r = client.get("/api/games/search", params={"indie": "false"})
    assert {g["appid"] for g in r.json()["items"]} == {1004}


def test_search_research_filters_compose(client):
    # The realistic research query: paid Roguelikes $10+, rated >= 0.8.
    r = client.get(
        "/api/games/search",
        params={"genre": "Roguelike", "price_min": 10, "min_positive": 0.8},
    )
    assert r.status_code == 200
    assert {g["appid"] for g in r.json()["items"]} == {1001, 1002}


def test_tags_suggest_substring_match_is_case_insensitive(client):
    r = client.get("/api/games/tags/suggest", params={"q": "ROGUE"})
    assert r.status_code == 200
    items = r.json()["items"]
    assert items == [{"tag": "Roguelike", "n_games": 3}]


def test_tags_suggest_orders_by_frequency_and_respects_limit(client):
    # Tags containing "a": Farming (2 games) tops the 1-count tags; ties break alphabetically
    # ("Action" first), so limit=2 pins the ordering contract.
    r = client.get("/api/games/tags/suggest", params={"q": "a", "limit": 2})
    assert r.status_code == 200
    assert [i["tag"] for i in r.json()["items"]] == ["Farming", "Action"]


def test_tags_suggest_empty_q_returns_top_tags(client):
    r = client.get("/api/games/tags/suggest", params={"limit": 3})
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 3
    assert items[0] == {"tag": "Roguelike", "n_games": 3}  # most frequent fixture tag


def test_tags_suggest_no_match_is_empty_not_error(client):
    r = client.get("/api/games/tags/suggest", params={"q": "zzz-no-such-tag"})
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_game_profile_happy_path(client):
    r = client.get("/api/games/1001")
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Rogue Cellar"
    assert body["primary_genre"] == "Roguelike"
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
