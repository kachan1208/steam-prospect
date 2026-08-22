"""GET /api/games/{appid}/events — the chart-annotation feed, in all three data states.

The contract worth pinning: events are ADDITIVE chart annotations, so the endpoint must
degrade to an empty feed — never a 503 — both for a game with no events and for a mart built
before mart_game_event existed. A chart without markers is complete, just less explained;
turning an old mart into an error would blank the whole trends panel for nothing.
"""
import duckdb


def test_events_for_a_game_that_has_them(client):
    r = client.get("/api/games/1001/events")
    assert r.status_code == 200
    body = r.json()
    assert body["appid"] == 1001

    items = body["items"]
    assert [e["kind"] for e in items] == ["release", "update", "press"], items
    # chronological — the chart buckets by month and must never need to re-sort
    assert [e["event_date"] for e in items] == sorted(e["event_date"] for e in items)

    release = items[0]
    assert release["title"] == "Released"
    assert release["url"] is None, "the release row links nowhere; url must be null, not ''"
    assert items[1]["url"] == "https://example.test/p11"


def test_game_without_events_gets_an_empty_feed(client):
    r = client.get("/api/games/1002/events")
    assert r.status_code == 200
    assert r.json() == {"appid": 1002, "items": []}


def test_mart_predating_the_table_degrades_to_empty(client, monkeypatch):
    """Absent table == CatalogException from DuckDB. Simulated at the query layer because the
    shared fixture mart (rightly) carries the table; what matters is the except clause."""
    from app import analytics_db

    def boom(*_a, **_k):
        raise duckdb.CatalogException("Table with name mart_game_event does not exist!")

    monkeypatch.setattr(analytics_db, "query", boom)
    r = client.get("/api/games/1001/events")
    assert r.status_code == 200
    assert r.json() == {"appid": 1001, "items": []}
