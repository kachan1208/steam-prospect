"""A mart that EXISTS but cannot be opened must degrade the API, never kill it.

main.py's lifespan used to catch only FileNotFoundError. Every other way the open can fail —
a 0-byte file (an interrupted copy), a truncated one (a half-finished download), plain
garbage — raises duckdb.IOException, which escaped the lifespan: the worker died with
STARTUP_FAILURE and the container exited, i.e. one bad file took the site down instead of
producing the documented degraded mode ("endpoints will 503, health says why").

Each case boots a FRESH lifespan against the bad file (a second TestClient on the same app)
and then restores the shared fixture mart for the rest of the suite.
"""
from __future__ import annotations

import duckdb
import pytest
from fastapi.testclient import TestClient

from app import analytics_db
from app.config import settings
from app.main import app


def _valid_mart_bytes(tmp_path) -> bytes:
    """A real DuckDB mart file, so the truncation case is a TRUNCATED MART, not noise."""
    src = tmp_path / "valid.duckdb"
    con = duckdb.connect(str(src))
    con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
    con.execute("INSERT INTO mart_meta VALUES ('mart_version', 'about-to-be-truncated')")
    con.execute("CREATE TABLE mart_game AS SELECT range AS appid FROM range(50000)")
    con.close()
    return src.read_bytes()


def _cases(tmp_path) -> dict[str, bytes]:
    valid = _valid_mart_bytes(tmp_path)
    return {
        "zero_bytes": b"",
        "garbage": b"definitely not a duckdb file\n" * 500,
        "truncated": valid[: len(valid) // 2],
    }


@pytest.fixture
def restore_fixture_mart(client):
    """Depends on `client` so the session lifespan has already opened the fixture mart;
    whatever the test does to analytics_db, the shared mart is back afterwards. The path is
    captured up front: this teardown runs BEFORE monkeypatch undoes the settings patch."""
    original = settings.analytics_db_path
    yield
    analytics_db.close()
    analytics_db.init(original, settings.analytics_pool_size)


@pytest.mark.parametrize("case", ["zero_bytes", "garbage", "truncated"])
def test_unopenable_mart_boots_degraded_instead_of_crashing(
    case, tmp_path, monkeypatch, restore_fixture_mart
):
    bad = tmp_path / f"{case}.duckdb"
    bad.write_bytes(_cases(tmp_path)[case])
    monkeypatch.setattr(settings, "analytics_db_path", str(bad))

    # Entering the TestClient runs the lifespan. Before the fix this raised
    # duckdb.IOException out of startup (the container-exit bug).
    with TestClient(app) as c:
        health = c.get("/api/health")
        assert health.status_code == 200  # liveness stays up
        body = health.json()
        assert body["status"] == "degraded"
        # ...and says WHY, not the generic "the ETL hasn't run" line.
        assert "unusable" in body["detail"], body
        assert str(bad) in body["detail"]

        ready = c.get("/api/health/ready")
        assert ready.status_code == 503
        assert "unusable" in ready.json()["detail"]

        # Data endpoints shed with the same reason, across routers that check on their own
        # (entities) and ones that rely on analytics_db's central check (games).
        for path in ("/api/games/1001", "/api/entities/search", "/api/market/benchmarks"):
            r = c.get(path)
            assert r.status_code == 503, path
            assert r.json()["detail"].startswith("analytics database not available"), path
            assert "unusable" in r.json()["detail"], path


def test_empty_duckdb_database_is_refused(tmp_path, monkeypatch, restore_fixture_mart):
    """A VALID DuckDB file with no tables is not a mart: every query would 500/503 one at a
    time. Refuse it at open, with a reason that says exactly that."""
    empty = tmp_path / "empty.duckdb"
    duckdb.connect(str(empty)).close()
    monkeypatch.setattr(settings, "analytics_db_path", str(empty))
    with TestClient(app) as c:
        body = c.get("/api/health").json()
        assert body["status"] == "degraded"
        assert "no tables" in body["detail"]


def test_missing_mart_reason_is_reported(tmp_path, monkeypatch, restore_fixture_mart):
    monkeypatch.setattr(settings, "analytics_db_path", str(tmp_path / "nope.duckdb"))
    with TestClient(app) as c:
        body = c.get("/api/health").json()
        assert body["status"] == "degraded"
        assert "no analytics database" in body["detail"]


def test_healthy_boot_has_no_degraded_detail(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["detail"] is None


def test_io_error_while_serving_is_a_503_not_a_500(client, monkeypatch):
    """A file that goes bad UNDER an open connection (a data block past EOF, a failing
    disk) raises duckdb.IOException mid-query. That is an unavailable mart, not a handler
    bug — shed it as a 503 and put a working cursor back in the pool."""

    class _BrokenCursor:
        def execute(self, *a, **k):
            raise duckdb.IOException("Could not read enough bytes from file")

        def close(self):
            pass

    pool = analytics_db._pool
    assert pool is not None
    held = []
    while True:
        try:
            held.append(pool.get_nowait())
        except Exception:
            break
    broken = _BrokenCursor()
    pool.put(broken)
    try:
        r = client.get("/api/games/1001")
        assert r.status_code == 503
        assert "unreadable" in r.json()["detail"]
        # The broken cursor was replaced by a fresh one, not returned to the pool.
        replacement = pool.get_nowait()
        assert replacement is not broken
        replacement.close()
    finally:
        for cur in held:
            pool.put(cur)
    assert client.get("/api/games/1001").status_code == 200
