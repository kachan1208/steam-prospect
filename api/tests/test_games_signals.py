"""GET /games/{appid}/price-history — live signals, all degrade states.

The contract worth pinning: this reads signals.db (a live collector SQLite, not the mart),
and every absence — no file, no table, no rows for the game — is an EMPTY series, never an
error: "no signals yet" is data (a fresh deploy or a game the rotating collector hasn't
reached), and a 500 here would take down a page section over an optional enrichment.

(The sibling /followers endpoint was removed 2026-08-28 — nothing called it. signals_db.py
stays: it is what backs this endpoint.)
"""
import sqlite3


def _make_signals(path):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE price_snapshots(appid INTEGER, captured_on TEXT, final_cents INTEGER,"
                " original_cents INTEGER, discount_pct INTEGER, is_free INTEGER, country TEXT)")
    con.executemany("INSERT INTO price_snapshots VALUES (?,?,?,?,?,?,?)",
                    [(1001, "2026-08-24", 1499, 2499, 40, 0, "US"),
                     (1001, "2026-08-25", 2499, 2499, 0, 0, "US")])
    con.commit()
    con.close()


def test_prices_served_live(client, tmp_path, monkeypatch):
    from app import signals_db
    db = tmp_path / "signals.db"
    _make_signals(db)
    monkeypatch.setattr(signals_db, "SIGNALS_DB_PATH", str(db))

    r = client.get("/api/games/1001/price-history")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [p["final_cents"] for p in items] == [1499, 2499]  # ordered by captured_on
    assert (items[0]["discount_pct"], items[0]["is_free"]) == (40, False)

    # a game the collector never reached: empty, not an error
    assert client.get("/api/games/1002/price-history").json() == {"appid": 1002, "items": []}


def test_absent_signals_file_degrades_to_empty(client, monkeypatch):
    from app import signals_db
    monkeypatch.setattr(signals_db, "SIGNALS_DB_PATH", "/nonexistent/signals.db")
    assert client.get("/api/games/1001/price-history").json()["items"] == []


def test_missing_table_degrades_to_empty(client, tmp_path, monkeypatch):
    """A signals.db that exists but predates the price collector (no price_snapshots table)
    is the same contract as a missing file: an empty series."""
    from app import signals_db
    db = tmp_path / "empty.db"
    sqlite3.connect(db).close()
    monkeypatch.setattr(signals_db, "SIGNALS_DB_PATH", str(db))
    assert client.get("/api/games/1001/price-history").json()["items"] == []


def test_followers_endpoint_is_gone(client):
    """Removed 2026-08-28 (no web or MCP caller ever fetched it)."""
    assert client.get("/api/games/1001/followers").status_code == 404
