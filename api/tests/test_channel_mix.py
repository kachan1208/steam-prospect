"""api/app/routers/games.py — /games/{appid}/channel-mix over the conftest fixture.

The fixture deliberately does NOT build mart_channel_mix (same scoping call as
mart_game_press_* — see test_games.py's docstring), which makes it the perfect stand-in
for a mart that predates the channel-mix ETL: these tests pin the endpoint's degrade
contract (200 + empty `channels`, never a 500 CatalogException) and the 404 for unknown
appids. The happy path over real mart_channel_mix rows is covered by the sandbox
verification against a production mart copy, not this synthetic fixture.
"""
from __future__ import annotations


def test_channel_mix_unknown_appid_404(client):
    r = client.get("/api/games/999999999/channel-mix")
    assert r.status_code == 404
    assert "game not found" in r.json()["detail"]


def test_channel_mix_degrades_to_empty_when_mart_absent(client):
    r = client.get("/api/games/1001/channel-mix")
    assert r.status_code == 200
    body = r.json()
    assert body["appid"] == 1001
    assert body["genre"] == "Roguelike"  # the game's primary_genre is still echoed
    assert body["channels"] == []
