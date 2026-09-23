"""GET /games/{appid}/price-history — live signals, all degrade states.

The contract worth pinning: this reads signals.db (a live collector SQLite, not the mart),
and every absence — no file, no table, no rows for the game — is an EMPTY series, never an
error: "no signals yet" is data (a fresh deploy or a game the rotating collector hasn't
reached), and a 500 here would take down a page section over an optional enrichment.

(The sibling /followers endpoint was removed 2026-08-28 — nothing called it. signals_db.py
stays: it is what backs this endpoint.)
"""
import sqlite3

import pytest


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
    from app.config import settings
    db = tmp_path / "signals.db"
    _make_signals(db)
    monkeypatch.setattr(settings, "signals_db", str(db))

    r = client.get("/api/games/1001/price-history")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [p["final_cents"] for p in items] == [1499, 2499]  # ordered by captured_on
    assert (items[0]["discount_pct"], items[0]["is_free"]) == (40, False)
    assert r.json()["status"] == "ok"

    # a game the collector never reached: empty, not an error — and the store WAS read
    assert client.get("/api/games/1002/price-history").json() == {
        "appid": 1002, "items": [], "status": "ok",
    }


def test_absent_signals_file_degrades_to_empty(client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "signals_db", "/nonexistent/signals.db")
    body = client.get("/api/games/1001/price-history").json()
    assert body["items"] == []
    assert body["status"] == "missing"


def test_missing_table_degrades_to_empty(client, tmp_path, monkeypatch):
    """A signals.db that exists but predates the price collector (no price_snapshots table)
    is the same contract as a missing file: an empty series."""
    from app.config import settings
    db = tmp_path / "empty.db"
    sqlite3.connect(db).close()
    monkeypatch.setattr(settings, "signals_db", str(db))
    body = client.get("/api/games/1001/price-history").json()
    assert body["items"] == []
    assert body["status"] == "missing"


def test_operational_error_degrades_but_is_logged(client, tmp_path, monkeypatch, caplog):
    """Graceful degradation must not be SILENT: a failed read (here: no such table, an
    sqlite3.OperationalError — the same class a LOCKED database raises) logs a warning via
    the module logger so it is diagnosable, while still serving an empty series.

    (This docstring used to say "the same code path as a locked/corrupt DB". Half true: a
    CORRUPT file raises the base sqlite3.DatabaseError, not OperationalError, and escaped
    the handler as a 500 — see the corrupt-file tests below.)"""
    import logging

    from app.config import settings
    db = tmp_path / "empty.db"
    sqlite3.connect(db).close()
    monkeypatch.setattr(settings, "signals_db", str(db))
    with caplog.at_level(logging.WARNING, logger="app.signals_db"):
        assert client.get("/api/games/1001/price-history").json()["items"] == []
    assert any("signals.db query failed" in m for m in caplog.messages)


def _corrupt_bytes(tmp_path) -> dict[str, bytes]:
    """Two realistic corruptions of a real signals.db: garbage over the whole file, and a
    valid file with its page data scribbled over (header intact, b-tree pages broken)."""
    good = tmp_path / "good.db"
    _make_signals(good)
    raw = bytearray(good.read_bytes())
    scribbled = bytes(raw[:100]) + b"\xff" * (len(raw) - 100)
    return {"garbage": b"not an sqlite file at all\n" * 200, "scribbled": scribbled}


@pytest.mark.parametrize("kind", ["garbage", "scribbled"])
def test_corrupt_signals_file_degrades_flagged_not_500(client, tmp_path, monkeypatch, caplog, kind):
    """A corrupt file raises sqlite3.DatabaseError ("file is not a database" / "database
    disk image is malformed") — the BASE class, which the old `except OperationalError`
    did not catch, so the endpoint 500'd. It must degrade like "no data" — but FLAGGED
    (status=unavailable) and logged, so the UI can say "price history unavailable" rather
    than pass a broken store off as "no price history yet"."""
    import logging

    from app.config import settings
    db = tmp_path / f"{kind}.db"
    db.write_bytes(_corrupt_bytes(tmp_path)[kind])
    monkeypatch.setattr(settings, "signals_db", str(db))
    with caplog.at_level(logging.WARNING, logger="app.signals_db"):
        r = client.get("/api/games/1001/price-history")
    assert r.status_code == 200
    assert r.json() == {"appid": 1001, "items": [], "status": "unavailable"}
    assert any("signals.db query failed" in m for m in caplog.messages)


def test_signals_fetch_distinguishes_the_three_empties(tmp_path, monkeypatch):
    """Unit-level: signals_db.fetch() returns WHICH empty it is; query() keeps its old
    rows-only contract for any caller that doesn't care."""
    from app import signals_db
    from app.config import settings
    sql = "SELECT * FROM price_snapshots WHERE appid = ?"

    good = tmp_path / "signals.db"
    _make_signals(good)
    monkeypatch.setattr(settings, "signals_db", str(good))
    assert signals_db.fetch(sql, (999,)) == signals_db.SignalsResult([], "ok")

    monkeypatch.setattr(settings, "signals_db", str(tmp_path / "absent.db"))
    assert signals_db.fetch(sql, (1001,)).status == "missing"

    bad = tmp_path / "bad.db"
    bad.write_bytes(b"garbage" * 100)
    monkeypatch.setattr(settings, "signals_db", str(bad))
    assert signals_db.fetch(sql, (1001,)).status == "unavailable"
    assert signals_db.query(sql, (1001,)) == []


def test_followers_endpoint_is_gone(client):
    """Removed 2026-08-28 (no web or MCP caller ever fetched it)."""
    assert client.get("/api/games/1001/followers").status_code == 404
