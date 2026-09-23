"""Tag aliases (mart_tag_alias) — one niche, several Steam spellings.

Capability-gated: until the ETL publishes mart_tag_alias every key is its own canonical and
nothing changes (the rest of the suite runs on marts without the table). With it:

* every niche endpoint that takes (dimension, key) serves an alias as its CANONICAL niche and
  says so — canonical_key (== key), requested_key, and alias_of (set only when an alias was
  resolved) so the web can replace the URL;
* niche search (the list's q) and tag autocomplete answer with canonical names only, while
  still FINDING a niche by its alias;
* the games tag filter matches a canonical tag through every spelling.

Fixture: the modern mart + aliases "Rogue-like" -> "Roguelike", "Roguelite" -> "Roguelike";
game 1005 is tagged only "Roguelite"; and a stray mart_niche row under the alias key
"Rogue-like" that must never list.
"""
from __future__ import annotations

import duckdb
import pytest

from conftest import build_modern_mart, serving

ALIASES = [("tag", "Rogue-like", "Roguelike"), ("tag", "Roguelite", "Roguelike")]


@pytest.fixture
def alias_client(client, tmp_path):
    path = tmp_path / "aliases.duckdb"
    build_modern_mart(path, aliases=ALIASES)
    with duckdb.connect(str(path)) as con:
        con.execute("UPDATE mart_game SET top_tags = ['Farming', 'Roguelite'] WHERE appid = 1005")
        con.execute(
            "INSERT INTO mart_niche (dimension, key, win, min_reviews, n_games, n_recent, tier, "
            "opportunity_v2) VALUES ('tag', 'Rogue-like', 'all', 50, 3, 1, 'micro', 99.0)"
        )
    with serving(path):
        yield client


def test_detail_serves_an_alias_as_its_canonical_niche(alias_client):
    via_alias = alias_client.get("/api/niches/tag/Rogue-like").json()
    direct = alias_client.get("/api/niches/tag/Roguelike").json()
    assert via_alias["key"] == via_alias["canonical_key"] == "Roguelike"
    assert via_alias["requested_key"] == "Rogue-like"
    assert via_alias["alias_of"] == "Roguelike"
    # ...the SAME niche's data, not the stray alias row's.
    assert via_alias["variants"] == direct["variants"]
    assert direct["alias_of"] is None and direct["requested_key"] == "Roguelike"


def test_drill_down_endpoints_resolve_aliases(alias_client):
    games = alias_client.get("/api/niches/tag/Roguelite/games").json()
    assert (games["canonical_key"], games["requested_key"], games["alias_of"]) == (
        "Roguelike", "Roguelite", "Roguelike",
    )
    assert sorted(g["appid"] for g in games["items"]) == [1001, 1002, 1003, 1004]

    dist = alias_client.get(
        "/api/niches/tag/Rogue-like/distribution", params={"metric": "revenue"}
    ).json()
    assert dist["alias_of"] == "Roguelike" and dist["source"] == "mart"
    assert sum(b["count"] for b in dist["buckets"]) == 4


def test_combined_resolves_and_refuses_an_alias_next_to_its_canonical(alias_client):
    body = alias_client.get(
        "/api/niches/combined", params={"niches": ["tag:Rogue-like", "tag:Deckbuilder"], "min_reviews": 0}
    ).json()
    first = body["inputs"][0]
    assert (first["key"], first["requested_key"], first["alias_of"]) == ("Roguelike", "Rogue-like", "Roguelike")
    assert first["n_games"] == 4

    r = alias_client.get(
        "/api/niches/combined", params={"niches": ["tag:Rogue-like", "tag:Roguelike"]}
    )
    assert r.status_code == 422
    assert "same niche" in r.json()["detail"]


def test_list_search_finds_by_alias_but_lists_canonical_only(alias_client):
    params = {"window": "all", "min_reviews": 50, "tiers": ""}
    keys = [i["key"] for i in alias_client.get("/api/niches", params={**params, "q": "rogue-l"}).json()["items"]]
    assert keys == ["Roguelike"]  # found THROUGH the alias, answered as the canonical
    everything = [i["key"] for i in alias_client.get("/api/niches", params=params).json()["items"]]
    assert "Rogue-like" not in everything  # the stray alias row never lists
    assert "Roguelike" in everything


def test_tag_autocomplete_is_canonical_only_with_distinct_game_counts(alias_client):
    items = alias_client.get("/api/games/tags/suggest", params={"q": "rogue"}).json()["items"]
    # 1001-1003 carry "Roguelike", 1005 only "Roguelite": 4 distinct games, one suggestion.
    assert items == [{"tag": "Roguelike", "n_games": 4}]


def test_games_tag_filter_matches_every_spelling(alias_client):
    for tag in ("Roguelike", "Roguelite", "Rogue-like"):
        body = alias_client.get("/api/games/search", params={"tag": tag, "min_reviews": 0}).json()
        assert sorted(g["appid"] for g in body["items"]) == [1001, 1002, 1003, 1005], tag


def test_without_the_alias_table_nothing_changes(modern_mart):
    body = modern_mart.get("/api/niches/tag/Roguelike").json()
    assert (body["canonical_key"], body["requested_key"], body["alias_of"]) == (
        "Roguelike", "Roguelike", None,
    )
    assert modern_mart.get("/api/niches/tag/Rogue-like").status_code == 404
