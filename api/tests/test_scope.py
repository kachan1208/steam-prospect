"""`scope=indie` (app/scope.py) and the niche list's member-profile filters.

The defaults a solo developer lands on were AAA: a niche's top games led with Monster Hunter
Wilds ($695M), /games opened on CS:GO and Dota 2, /studios on EA / Bandai / Ubisoft.
scope=indie narrows games to Steam's Indie flag (is_indie = 1) and entities to those whose
flagged games are at least half indie; unknown flags are excluded AND counted
(n_scope_unknown). The API default stays scope=all.

Fixture: the modern mart, with 1006 (Zen Garden) given an UNKNOWN indie flag, 1004 (Mecha
Arena, not indie) made self-published — the Valve/Capcom shape the definition must still
exclude — and a studio whose only game is 1006.
"""
from __future__ import annotations

import duckdb
import pytest

from conftest import build_modern_mart, serving


@pytest.fixture
def scoped(client, tmp_path):
    path = tmp_path / "scope.duckdb"
    build_modern_mart(path)
    with duckdb.connect(str(path)) as con:
        con.execute("UPDATE mart_game SET is_indie = NULL WHERE appid = 1006")
        con.execute("UPDATE mart_game SET self_published = 1 WHERE appid = 1004")
        con.execute(
            "INSERT INTO mart_entity (role, name, n_games, total_rev, top_genres) "
            "VALUES ('developer', 'Fresh Studio', 1, 3000.0, ['Simulation'])"
        )
        con.execute("INSERT INTO mart_entity_games VALUES ('developer', 'Fresh Studio', 1006, 1)")
    with serving(path):
        yield client


def _ids(body) -> list[int]:
    return sorted(g["appid"] for g in body["items"])


# ---- games -------------------------------------------------------------------------------
def test_games_search_scope_indie(scoped):
    body = scoped.get("/api/games/search", params={"scope": "indie", "min_reviews": 0}).json()
    # 1004 is self-published but NOT indie-flagged (the Valve/Capcom shape): out.
    # 1006's flag is unknown: out, and counted.
    assert _ids(body) == [1001, 1002, 1003, 1005]
    assert body["total"] == 4
    assert body["scope"] == "indie"
    assert body["n_scope_unknown"] == 1


def test_games_search_default_scope_is_all(scoped):
    body = scoped.get("/api/games/search", params={"min_reviews": 0}).json()
    assert body["total"] == 6
    assert body["scope"] == "all" and body["n_scope_unknown"] is None


def test_scope_indie_contradicting_indie_false_is_422(scoped):
    r = scoped.get("/api/games/search", params={"scope": "indie", "indie": "false"})
    assert r.status_code == 422


def test_unknown_scope_value_is_422(scoped):
    assert scoped.get("/api/games/search", params={"scope": "aaa"}).status_code == 422


# ---- niche drill-down ---------------------------------------------------------------------
def test_niche_games_scope_indie(scoped):
    rogue = scoped.get("/api/niches/tag/Roguelike/games", params={"scope": "indie"}).json()
    assert _ids(rogue) == [1001, 1002, 1003]  # Mecha Arena ($0, publisher-backed) is out
    assert (rogue["total"], rogue["scope"], rogue["n_scope_unknown"]) == (3, "indie", 0)

    sim = scoped.get("/api/niches/genre/Simulation/games", params={"scope": "indie"}).json()
    assert _ids(sim) == [1005]
    assert sim["n_scope_unknown"] == 1  # Zen Garden, flag unknown


def test_distribution_scope_indie_round_trips_into_games(scoped):
    """Scoped histograms are always computed (the mart histogram is all-games) and every
    bucket's (x_min, x_max) returns exactly its count from /games?scope=indie."""
    for metric, lo, hi in (("revenue", "rev_min", "rev_max"), ("price", "price_min", "price_max")):
        dist = scoped.get(
            "/api/niches/tag/Roguelike/distribution", params={"metric": metric, "scope": "indie"}
        ).json()
        assert dist["source"] == "computed" and dist["scope"] == "indie"
        assert dist["n_games"] == 3
        for b in dist["buckets"]:
            got = scoped.get(
                "/api/niches/tag/Roguelike/games",
                params={lo: b["x_min"], hi: b["x_max"], "scope": "indie"},
            ).json()
            assert got["total"] == b["count"], (metric, b)
    # ...and with the free, non-indie member gone, there is no floored $0 bucket left.
    rev = scoped.get(
        "/api/niches/tag/Roguelike/distribution", params={"metric": "revenue", "scope": "indie"}
    ).json()
    assert all(not b["floored"] for b in rev["buckets"])


def test_combined_scope_indie_scopes_every_number(scoped):
    body = scoped.get(
        "/api/niches/combined",
        params={"niches": ["tag:Roguelike", "genre:Simulation"], "mode": "union",
                "scope": "indie", "limit": 100},
    ).json()
    assert _ids(body) == [1001, 1002, 1003, 1005]
    assert body["n_games"] == body["total"] == 4
    assert [i["n_games"] for i in body["inputs"]] == [3, 1]
    assert (body["scope"], body["n_scope_unknown"]) == ("indie", 1)


# ---- entities ---------------------------------------------------------------------------------
def test_entities_scope_indie(scoped):
    devs = scoped.get("/api/entities/search", params={"role": "developer", "scope": "indie"}).json()
    names = [e["name"] for e in devs["items"]]
    assert "Big Studio D" not in names  # its one game is not indie-flagged
    assert "Fresh Studio" not in names  # its one game's flag is unknown...
    assert devs["n_scope_unknown"] == 1  # ...and it is counted, not silently dropped
    assert set(names) == {"Studio B", "Pixel Forge Collective", "Solo Dev A"}
    assert all(e["indie_share"] == 1.0 for e in devs["items"])
    assert devs["scope"] == "indie"

    pubs = scoped.get("/api/entities/search", params={"role": "publisher", "scope": "indie"}).json()
    assert [e["name"] for e in pubs["items"]] == ["Indie Publisher B"]


def test_entities_default_scope_is_unchanged(scoped):
    body = scoped.get("/api/entities/search", params={"role": "developer"}).json()
    assert body["scope"] == "all" and body["n_scope_unknown"] is None
    assert all(e["indie_share"] is None for e in body["items"])
    assert "Big Studio D" in {e["name"] for e in body["items"]}


# ---- niche list member-profile filters ------------------------------------------------------
# all/0 tag cut in the modern fixture: Roguelike (indie .75, self-pub .5, $14.99, 6.0h) and
# Deckbuilder (indie 1.0, self-pub .5, $17.49, 15.0h).
@pytest.mark.parametrize(
    "params,expected",
    [
        ({"min_indie_share": 0.9}, ["Deckbuilder"]),
        ({"max_median_price": 15}, ["Roguelike"]),
        ({"min_median_price": 15}, ["Deckbuilder"]),
        ({"min_med_playtime_h": 10}, ["Deckbuilder"]),
        ({"max_med_playtime_h": 10}, ["Roguelike"]),
        ({"min_self_pub_share": 0.6}, []),
        ({"min_self_pub_share": 0.5, "min_indie_share": 0.7}, ["Deckbuilder", "Roguelike"]),
    ],
)
def test_niche_list_profile_filters(modern_mart, params, expected):
    base = {"window": "all", "min_reviews": 0, "tiers": "", "sort": "key", "order": "asc"}
    body = modern_mart.get("/api/niches", params={**base, **params}).json()
    assert [i["key"] for i in body["items"]] == expected
    assert body["total"] == len(expected)


def test_niche_list_inverted_range_is_422(modern_mart):
    r = modern_mart.get(
        "/api/niches",
        params={"window": "all", "min_reviews": 0, "min_median_price": 20, "max_median_price": 10},
    )
    assert r.status_code == 422


def test_export_takes_the_same_profile_filters(modern_mart):
    r = modern_mart.get(
        "/api/niches/export.csv",
        params={"window": "all", "min_reviews": 0, "tiers": "", "min_indie_share": 0.9},
    )
    assert r.status_code == 200
    keys = [line.split(",")[1] for line in r.text.strip().splitlines()[1:]]
    assert keys == ["Deckbuilder"]


def test_evidence_filters_need_the_evidence_columns(client, tmp_path):
    """indie_share / med_playtime_h ship with the solo-evidence columns: on a mart without
    them, filtering by them is the rebuild 503 — self_pub_share / median_price still work."""
    path = tmp_path / "no_evidence.duckdb"
    build_modern_mart(path)
    with duckdb.connect(str(path)) as con:
        for col in ("self_published_share", "indie_share", "med_playtime_h"):
            con.execute(f"ALTER TABLE mart_niche DROP COLUMN {col}")
    base = {"window": "all", "min_reviews": 0, "tiers": ""}
    with serving(path):
        for p in ({"min_indie_share": 0.5}, {"max_med_playtime_h": 20}):
            r = client.get("/api/niches", params={**base, **p})
            assert r.status_code == 503, p
            assert "rebuild" in r.json()["detail"]
        ok = client.get("/api/niches", params={**base, "min_self_pub_share": 0.5, "max_median_price": 20})
        assert ok.status_code == 200
        assert ok.json()["total"] == 2
