"""GET /games/{appid}/followers and /price-history — live signals, all degrade states.

The contract worth pinning: these read signals.db (a live collector SQLite, not the mart),
and every absence — no file, no table, no rows for the game — is an EMPTY series, never an
error: "no signals yet" is data (a fresh deploy or a game the rotating collector hasn't
reached), and a 500 here would take down a page section over an optional enrichment.
"""
import sqlite3


def _make_signals(path):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE game_followers(appid INTEGER, captured_on TEXT, member_count INTEGER)")
    con.executemany("INSERT INTO game_followers VALUES (?,?,?)",
                    [(1001, "2026-08-24", 480), (1001, "2026-08-25", 495)])
    con.execute("CREATE TABLE price_snapshots(appid INTEGER, captured_on TEXT, final_cents INTEGER,"
                " original_cents INTEGER, discount_pct INTEGER, is_free INTEGER, country TEXT)")
    con.execute("INSERT INTO price_snapshots VALUES (1001, '2026-08-24', 1499, 2499, 40, 0, 'US')")
    con.commit()
    con.close()


def test_followers_and_prices_served_live(client, tmp_path, monkeypatch):
    from app import signals_db
    db = tmp_path / "signals.db"
    _make_signals(db)
    monkeypatch.setattr(signals_db, "SIGNALS_DB_PATH", str(db))

    r = client.get("/api/games/1001/followers")
    assert r.status_code == 200
    assert [p["member_count"] for p in r.json()["items"]] == [480, 495]

    r = client.get("/api/games/1001/price-history")
    assert r.status_code == 200
    (p,) = r.json()["items"]
    assert (p["final_cents"], p["discount_pct"], p["is_free"]) == (1499, 40, False)

    # a game the collector never reached: empty, not an error
    assert client.get("/api/games/1002/followers").json() == {"appid": 1002, "items": []}


def test_absent_signals_file_degrades_to_empty(client, monkeypatch):
    from app import signals_db
    monkeypatch.setattr(signals_db, "SIGNALS_DB_PATH", "/nonexistent/signals.db")
    assert client.get("/api/games/1001/followers").json()["items"] == []
    assert client.get("/api/games/1001/price-history").json()["items"] == []
