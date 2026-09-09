"""api/app/routers/entities.py — search/profile over the fixture's entity marts (see
api/tests/conftest.py's ENTITIES/ENTITY_GAMES constants). The pre-ETL missing-table 503 is
covered by monkeypatching the query layer to raise duckdb.CatalogException — the shared
session fixture DB always carries the tables, and it's opened read-only so they can't be
dropped per-test."""
from __future__ import annotations

import duckdb
import pytest

from app import analytics_db
from app.routers import entities as entities_router


# ---- /api/entities/search ---------------------------------------------------------------

def test_search_substring_is_case_insensitive(client):
    r = client.get("/api/entities/search", params={"q": "solo dev"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["items"][0]["name"] == "Solo Dev A"
    assert body["items"][0]["role"] == "developer"


def test_search_orders_by_total_rev_desc(client):
    r = client.get("/api/entities/search", params={"q": "o", "role": "developer"})
    assert r.status_code == 200
    names = [e["name"] for e in r.json()["items"]]
    # Every fixture developer matches "o"; order is total_rev DESC:
    # Studio B (900K) > Pixel Forge Collective (273K) > Solo Dev A (150K) > Big Studio D (0).
    assert names == ["Studio B", "Pixel Forge Collective", "Solo Dev A", "Big Studio D"]


def test_search_role_filter(client):
    r = client.get("/api/entities/search", params={"q": "b", "role": "publisher"})
    assert r.status_code == 200
    body = r.json()
    assert {e["name"] for e in body["items"]} == {"Indie Publisher B", "Big Publisher D"}
    assert all(e["role"] == "publisher" for e in body["items"])


def test_search_limit_caps_items_not_total(client):
    r = client.get("/api/entities/search", params={"q": "o", "role": "developer", "limit": 2})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 4
    assert len(body["items"]) == 2


def test_search_rejects_unknown_role(client):
    r = client.get("/api/entities/search", params={"q": "o", "role": "porter"})
    assert r.status_code == 422  # Literal["developer","publisher"] validation


def test_search_rows_carry_n_recent_24m(client):
    # The Studios browse table renders an Active badge off this without a profile fetch.
    r = client.get("/api/entities/search", params={"q": "solo dev"})
    assert r.status_code == 200
    assert r.json()["items"][0]["n_recent_24m"] == 1


def test_search_without_q_browses_by_total_rev(client):
    # BROWSE mode: no q at all — the full role roster, best career revenue first.
    r = client.get("/api/entities/search", params={"role": "developer"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 4
    names = [e["name"] for e in body["items"]]
    assert names == ["Studio B", "Pixel Forge Collective", "Solo Dev A", "Big Studio D"]


def test_search_min_games_floor(client):
    # min_games=3 keeps single-release entities out of the browse ranking; the floor
    # also constrains `total`, so the count stays honest about what's listable.
    r = client.get("/api/entities/search", params={"role": "developer", "min_games": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert [e["name"] for e in body["items"]] == ["Pixel Forge Collective"]


def test_search_min_games_applies_with_q_too(client):
    r = client.get("/api/entities/search", params={"q": "o", "role": "developer", "min_games": 2})
    assert r.status_code == 200
    assert [e["name"] for e in r.json()["items"]] == ["Pixel Forge Collective"]


# ---- sort / order / offset — the games-search contract shape ----------------------------
# The four fixture developers, per conftest.ENTITIES:
#   Solo Dev A              n_games 1, 2024-2024, recent 1, total 150K, median 150K, hit 0
#   Studio B                n_games 1, 2023-2023, recent 0, total 900K, median 900K, hit 1.0
#   Big Studio D            n_games 1, 2022-2022, recent 0, total 0,    median 0,    hit 0
#   Pixel Forge Collective  n_games 3, 2021-2025, recent 2, total 273K, median 20K,  hit 1/3
# Ties break by total_rev DESC, then n_games DESC, then name ASC.

def _dev_names(client, **params) -> list[str]:
    r = client.get("/api/entities/search", params={"role": "developer", **params})
    assert r.status_code == 200, r.text
    return [e["name"] for e in r.json()["items"]]


@pytest.mark.parametrize(
    "sort", ["total_rev", "median_rev", "n_games", "n_recent_24m", "hit_rate_200k", "last_release_year", "name"]
)
def test_search_every_allow_listed_sort_serves_the_whole_set(client, sort):
    r = client.get("/api/entities/search", params={"role": "developer", "sort": sort})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 4
    assert len(body["items"]) == 4
    assert body["offset"] == 0


def test_search_sort_n_games_ties_break_by_total_rev(client):
    assert _dev_names(client, sort="n_games") == [
        "Pixel Forge Collective", "Studio B", "Solo Dev A", "Big Studio D",
    ]


def test_search_sort_name_both_directions(client):
    assert _dev_names(client, sort="name", order="asc") == [
        "Big Studio D", "Pixel Forge Collective", "Solo Dev A", "Studio B",
    ]
    assert _dev_names(client, sort="name", order="desc") == [
        "Studio B", "Solo Dev A", "Pixel Forge Collective", "Big Studio D",
    ]


def test_search_order_asc_flips_the_default_ranking(client):
    assert _dev_names(client, sort="total_rev", order="asc") == [
        "Big Studio D", "Solo Dev A", "Pixel Forge Collective", "Studio B",
    ]


def test_search_sort_hit_rate_and_median_rev(client):
    assert _dev_names(client, sort="hit_rate_200k") == [
        "Studio B", "Pixel Forge Collective", "Solo Dev A", "Big Studio D",
    ]
    assert _dev_names(client, sort="median_rev") == [
        "Studio B", "Solo Dev A", "Pixel Forge Collective", "Big Studio D",
    ]


def test_search_sort_last_release_year_and_recent(client):
    assert _dev_names(client, sort="last_release_year") == [
        "Pixel Forge Collective", "Solo Dev A", "Studio B", "Big Studio D",
    ]
    # n_recent_24m: 2, 1, then two zeros broken by total_rev (900K before 0).
    assert _dev_names(client, sort="n_recent_24m") == [
        "Pixel Forge Collective", "Solo Dev A", "Studio B", "Big Studio D",
    ]


def test_search_offset_pages_while_total_counts_the_whole_set(client):
    first = client.get("/api/entities/search", params={"role": "developer", "limit": 2}).json()
    second = client.get(
        "/api/entities/search", params={"role": "developer", "limit": 2, "offset": 2}
    ).json()
    assert [e["name"] for e in first["items"]] == ["Studio B", "Pixel Forge Collective"]
    assert [e["name"] for e in second["items"]] == ["Solo Dev A", "Big Studio D"]
    # The count is the match set, not the page — on both pages — and the response echoes
    # the paging it served (the web footer's "26–50 of N" reads these back).
    assert (first["total"], first["offset"], first["limit"]) == (4, 0, 2)
    assert (second["total"], second["offset"], second["limit"]) == (4, 2, 2)


def test_search_total_is_the_filtered_count_with_q_and_offset(client):
    r = client.get(
        "/api/entities/search", params={"q": "o", "role": "developer", "limit": 1, "offset": 1}
    )
    assert r.status_code == 200
    body = r.json()
    assert [e["name"] for e in body["items"]] == ["Pixel Forge Collective"]
    assert body["total"] == 4


def test_search_offset_past_the_end_still_reports_total(client):
    # The window count needs a row to ride on; an empty page must not report total=0.
    r = client.get("/api/entities/search", params={"role": "developer", "offset": 10})
    assert r.status_code == 200
    assert r.json()["items"] == []
    assert r.json()["total"] == 4


def test_search_offset_is_capped_like_games(client):
    assert client.get("/api/entities/search", params={"offset": entities_router.MAX_OFFSET}).status_code == 200
    assert client.get("/api/entities/search", params={"offset": entities_router.MAX_OFFSET + 1}).status_code == 422
    assert client.get("/api/entities/search", params={"offset": -1}).status_code == 422


def test_search_unknown_sort_is_422(client):
    r = client.get("/api/entities/search", params={"sort": "owners"})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["query", "sort"]
    # Nothing that isn't in the Literal reaches the ORDER BY — a would-be identifier included.
    assert client.get("/api/entities/search", params={"sort": "total_rev; DROP TABLE x"}).status_code == 422


def test_search_bad_order_is_422(client):
    assert client.get("/api/entities/search", params={"order": "sideways"}).status_code == 422


def test_search_p90_sort_needs_the_column(client):
    # The fixture mart predates p90_rev, so sorting on it is a mart capability gap (503,
    # as games.py answers a lifetime sort on a pre-lifetime mart), not a bad request.
    entities_router._reset_capability_cache()
    r = client.get("/api/entities/search", params={"sort": "p90_rev"})
    assert r.status_code == 503
    assert "p90_rev" in r.json()["detail"]


# ---- /api/entities/profile --------------------------------------------------------------

def test_profile_joins_games_in_seq_order(client):
    r = client.get(
        "/api/entities/profile", params={"role": "developer", "name": "Pixel Forge Collective"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["entity"]["n_games"] == 3
    assert body["entity"]["n_partners"] is None  # NULL for developers, per contract
    assert body["entity"]["top_genres"] == ["Simulation", "Roguelike"]
    # seq ASC (release order), NOT appid order: 1006 (2021) -> 1005 (2024) -> 1003 (2025),
    # with mart_game display fields joined in.
    assert [(g["appid"], g["seq"]) for g in body["games"]] == [(1006, 1), (1005, 2), (1003, 3)]
    assert body["games"][0]["name"] == "Zen Garden"
    assert body["games"][0]["release_year"] == 2021
    assert body["games"][2]["est_rev_reviews"] == 20000.0


def test_profile_publisher_carries_n_partners(client):
    r = client.get(
        "/api/entities/profile", params={"role": "publisher", "name": "Indie Publisher B"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["entity"]["n_partners"] == 1
    assert [g["appid"] for g in body["games"]] == [1002]


def test_profile_is_role_scoped(client):
    # "Studio B" exists as a developer only — asking for the publisher of that name 404s.
    r = client.get("/api/entities/profile", params={"role": "publisher", "name": "Studio B"})
    assert r.status_code == 404


def test_profile_unknown_name_404_carries_suggestions(client):
    # Exact match fails but the ILIKE net catches near-misses, best-revenue first.
    r = client.get("/api/entities/profile", params={"role": "developer", "name": "Studio"})
    assert r.status_code == 404
    detail = r.json()["detail"]
    assert detail["error"] == "developer not found: Studio"
    assert detail["suggestions"] == ["Studio B", "Big Studio D"]


def test_profile_unknown_name_no_matches_has_empty_suggestions(client):
    r = client.get("/api/entities/profile", params={"role": "developer", "name": "zzz-nobody"})
    assert r.status_code == 404
    assert r.json()["detail"]["suggestions"] == []


# ---- pre-ETL missing marts --------------------------------------------------------------

def test_missing_entity_marts_surface_as_503(client, monkeypatch):
    def _raise(sql, params=None):
        raise duckdb.CatalogException("Table with name mart_entity does not exist!")

    monkeypatch.setattr(analytics_db, "query", _raise)
    r = client.get("/api/entities/search", params={"q": "capcom"})
    assert r.status_code == 503
    assert "refreshing" in r.json()["detail"]
    assert entities_router._MARTS_MISSING_DETAIL == r.json()["detail"]


def test_capability_probe_not_poisoned_by_pre_init_call(client, monkeypatch):
    """_has_p90/_has_x_handle used to be lru_cached: one call while the DB was still down
    froze False for the process lifetime, hiding the columns even after init. A pre-ready
    call must answer False WITHOUT caching; the first post-ready call must really probe."""
    from app.routers import entities

    entities._reset_capability_cache()
    try:
        monkeypatch.setattr(entities.analytics_db, "is_ready", lambda: False)
        assert entities._has_p90() is False
        assert entities._has_x_handle() is False

        # DB comes up carrying both columns: the probe must see them (no stale False).
        monkeypatch.setattr(entities.analytics_db, "is_ready", lambda: True)
        monkeypatch.setattr(entities.analytics_db, "query", lambda sql, params=None: [{"1": 1}])
        assert entities._has_p90() is True
        assert entities._has_x_handle() is True
    finally:
        entities._reset_capability_cache()  # the fixture mart has neither column
