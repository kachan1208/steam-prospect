"""api/app/routers/entities.py — search/profile over the fixture's entity marts (see
api/tests/conftest.py's ENTITIES/ENTITY_GAMES constants). The pre-ETL missing-table 503 is
covered by monkeypatching the query layer to raise duckdb.CatalogException — the shared
session fixture DB always carries the tables, and it's opened read-only so they can't be
dropped per-test."""
from __future__ import annotations

import duckdb

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
