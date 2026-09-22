"""Hot reload of a newly published mart (analytics_db generations).

The nightly ETL publishes by repointing data/current.duckdb (a relative symlink) at a new
prospect_YYYYMMDD.duckdb, and a same-day rebuild os.replace()s a new file over the SAME
name. The API used to open current.duckdb once per process and never look again, so a
worker served the old file until something restarted it — and with two uvicorn workers a
respawned one served the new file while its sibling served the old, so responses
alternated between marts.

Every test builds its own tiny marts in a temp dir, points a symlink at one, serves THAT
link through analytics_db.init() and restores the shared fixture mart afterwards.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import duckdb
import pytest

from app import analytics_db, response_cache
from app.config import settings
from app.routers import games
from conftest import ANALYTICS_DB_PATH, _create_mart_game, _create_mart_seasonality

A_VERSION, B_VERSION = "20260101", "20260102"


def _build(path: Path, version: str, *, rich: bool = False) -> None:
    """A servable mart. `rich` = the "newer ETL" variant: a different game name, an extra
    tag, a different launch curve, and the name_lower column the older one lacks — so
    every kind of mart-derived state (rows, memo, response cache, schema probe) differs."""
    con = duckdb.connect(str(path))
    try:
        _create_mart_game(con)
        _create_mart_seasonality(con)
        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.execute(
            "INSERT INTO mart_meta VALUES ('mart_version', ?), ('built_at', ?)",
            [version, f"{version[:4]}-{version[4:6]}-{version[6:]}T22:00:00+00:00"],
        )
        con.execute("UPDATE mart_game SET name = ? WHERE appid = 1001", [f"Rogue Cellar {version}"])
        if rich:
            con.execute("ALTER TABLE mart_game ADD COLUMN name_lower VARCHAR")
            con.execute("UPDATE mart_game SET name_lower = lower(name)")
            con.execute(
                "UPDATE mart_game SET top_tags = list_append(top_tags, 'Newly Minted') "
                "WHERE appid = 1001"
            )
            con.execute("UPDATE mart_launch_curve SET mean_cum_fraction = mean_cum_fraction / 2")
    finally:
        con.close()


def _point(link: Path, target_name: str) -> None:
    """Atomically repoint `link` at `target_name` — exactly what build_marts.py does."""
    tmp = link.parent / ".current.tmp"
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    os.symlink(target_name, tmp)
    os.replace(tmp, link)


@pytest.fixture
def published(client, tmp_path):
    """data dir with A and B built and current.duckdb -> A, served with a short check
    interval. Yields (link, dir). Restores the shared fixture mart afterwards."""
    _build(tmp_path / f"prospect_{A_VERSION}.duckdb", A_VERSION)
    _build(tmp_path / f"prospect_{B_VERSION}.duckdb", B_VERSION, rich=True)
    link = tmp_path / "current.duckdb"
    _point(link, f"prospect_{A_VERSION}.duckdb")
    analytics_db.init(str(link), 2, reload_interval_s=0.05)
    try:
        yield link, tmp_path
    finally:
        analytics_db.close()
        analytics_db.init(str(ANALYTICS_DB_PATH), settings.analytics_pool_size)


def _game_name(c) -> str:
    r = c.get("/api/games/1001")
    assert r.status_code == 200, r.text
    return r.json()["name"]


def test_repointed_link_is_served_after_the_check_interval(client, published):
    link, _ = published
    assert _game_name(client) == f"Rogue Cellar {A_VERSION}"
    health = client.get("/api/health").json()
    assert health["mart_version"] == A_VERSION
    assert health["loaded_file"] == f"prospect_{A_VERSION}.duckdb"
    assert health["link_target_version"] == A_VERSION
    assert health["target_differs"] is False

    # Prime every kind of mart-derived state on A.
    assert games._has_name_lower() is False  # schema snapshot
    tags_a = [t["tag"] for t in client.get("/api/games/tags/suggest", params={"limit": 50}).json()["items"]]
    assert "Newly Minted" not in tags_a  # memo
    curve_a = client.get("/api/launch-curve").json()["points"]  # response cache
    assert response_cache.size() == 1

    _point(link, f"prospect_{B_VERSION}.duckdb")  # the nightly publishes B

    # Within the check interval the process may still serve A — and health says so.
    health = client.get("/api/health").json()
    if health["mart_version"] == A_VERSION:
        assert health["target_differs"] is True
        assert health["link_target_version"] == B_VERSION

    time.sleep(0.06)  # past the check interval: the next request serves B
    assert _game_name(client) == f"Rogue Cellar {B_VERSION}"
    health = client.get("/api/health").json()
    assert health["mart_version"] == B_VERSION
    assert health["loaded_file"] == f"prospect_{B_VERSION}.duckdb"
    assert health["target_differs"] is False
    assert health["reload_error"] is None

    # ...and NOTHING derived from A survived the swap.
    assert games._has_name_lower() is True
    tags_b = [t["tag"] for t in client.get("/api/games/tags/suggest", params={"limit": 50}).json()["items"]]
    assert "Newly Minted" in tags_b
    curve_b = client.get("/api/launch-curve").json()["points"]
    assert curve_b[0]["mean_cum_fraction"] == pytest.approx(curve_a[0]["mean_cum_fraction"] / 2)


def test_same_day_rebuild_over_the_same_name_is_picked_up(client, published):
    """A same-day rerun os.replace()s a new file over prospect_<same date>.duckdb, so the
    link target's NAME does not change — only the inode does. DuckDB's per-process instance
    cache would hand back the OLD file for a plain duckdb.connect(path) while anything still
    holds it; the reload must serve the new bytes regardless."""
    link, tmp = published
    assert _game_name(client) == f"Rogue Cellar {A_VERSION}"
    old_gen = analytics_db._current

    scratch = tmp / f"prospect_{A_VERSION}.duckdb.building"
    _build(scratch, A_VERSION, rich=True)
    with duckdb.connect(str(scratch)) as con:
        con.execute("UPDATE mart_game SET name = 'Rebuilt same day' WHERE appid = 1001")
    # Hold a cursor on the old generation across the swap, like an in-flight request would.
    with analytics_db._cursor() as held:
        os.replace(scratch, tmp / f"prospect_{A_VERSION}.duckdb")
        assert analytics_db.maybe_reload(force=True) is True
        assert held.execute("SELECT name FROM mart_game WHERE appid = 1001").fetchone() == (
            f"Rogue Cellar {A_VERSION}",
        )
    assert _game_name(client) == "Rebuilt same day"
    assert old_gen.closed is True  # retired once its last cursor came back


def test_a_request_keeps_one_mart_across_a_swap(client, published):
    """A handler issues many queries; a swap between two of them must not make the second
    one read a different mart. The request pins its generation on first use, and the old
    generation is only closed once that request is done."""
    link, _ = published
    with analytics_db.request_budget():
        first = analytics_db.scalar("SELECT name FROM mart_game WHERE appid = 1001")
        pinned = analytics_db._current
        _point(link, f"prospect_{B_VERSION}.duckdb")
        assert analytics_db.maybe_reload(force=True) is True
        assert analytics_db._current is not pinned  # the process moved on...
        second = analytics_db.scalar("SELECT name FROM mart_game WHERE appid = 1001")
        assert analytics_db.mart_version() == A_VERSION  # ...this request did not
        assert pinned.closed is False
    assert first == second == f"Rogue Cellar {A_VERSION}"
    assert pinned.closed is True  # released with the request
    assert _game_name(client) == f"Rogue Cellar {B_VERSION}"


def test_concurrent_requests_survive_repeated_swaps(client, published):
    """Readers hammering the pool while the link flips back and forth: no errors, and every
    request sees exactly one mart for all of its queries."""
    link, _ = published
    names = {f"prospect_{A_VERSION}.duckdb": f"Rogue Cellar {A_VERSION}",
             f"prospect_{B_VERSION}.duckdb": f"Rogue Cellar {B_VERSION}"}
    errors: list[BaseException] = []
    mixed: list[tuple] = []
    stop = threading.Event()

    def reader() -> None:
        while not stop.is_set():
            try:
                with analytics_db.request_budget():
                    seen = {
                        analytics_db.scalar("SELECT name FROM mart_game WHERE appid = 1001")
                        for _ in range(3)
                    }
                if len(seen) != 1:
                    mixed.append(tuple(seen))
            except BaseException as exc:  # noqa: BLE001 — surfaced below
                errors.append(exc)

    threads = [threading.Thread(target=reader) for _ in range(4)]
    for t in threads:
        t.start()
    try:
        for i in range(12):
            _point(link, list(names)[i % 2])
            analytics_db.maybe_reload(force=True)
            time.sleep(0.01)
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=10)
    assert not errors, errors[:3]
    assert not mixed, mixed[:3]


def test_a_broken_new_mart_keeps_the_old_one_serving(client, published):
    link, tmp = published
    broken = tmp / "prospect_20260103.duckdb"
    broken.write_bytes(b"half a download" * 100)
    _point(link, broken.name)

    assert analytics_db.maybe_reload(force=True) is False
    assert _game_name(client) == f"Rogue Cellar {A_VERSION}"  # still serving A
    health = client.get("/api/health").json()
    assert health["status"] == "ok"
    assert health["mart_version"] == A_VERSION
    assert health["target_differs"] is True
    assert health["link_target_version"] == "20260103"
    assert "unusable" in health["reload_error"]

    # The same broken file is not re-opened every interval — only a change retries.
    calls = []
    real_open = analytics_db._open
    try:
        analytics_db._open = lambda *a, **k: calls.append(a) or real_open(*a, **k)
        assert analytics_db.maybe_reload(force=True) is False
        assert calls == []
    finally:
        analytics_db._open = real_open

    _point(link, f"prospect_{B_VERSION}.duckdb")  # the fix lands
    assert analytics_db.maybe_reload(force=True) is True
    health = client.get("/api/health").json()
    assert health["mart_version"] == B_VERSION
    assert health["reload_error"] is None


def test_a_degraded_boot_heals_when_the_mart_appears(client, tmp_path):
    """No mart at boot (the ETL hasn't produced one yet) used to mean 503s until someone
    restarted the app. The watch stays armed, so publishing the mart is enough."""
    link = tmp_path / "current.duckdb"
    try:
        with pytest.raises(analytics_db.MartUnavailable):
            analytics_db.init(str(link), 2, reload_interval_s=0.05)
        assert client.get("/api/games/1001").status_code == 503
        assert client.get("/api/health").json()["status"] == "degraded"

        _build(tmp_path / f"prospect_{A_VERSION}.duckdb", A_VERSION)
        _point(link, f"prospect_{A_VERSION}.duckdb")
        time.sleep(0.06)
        assert _game_name(client) == f"Rogue Cellar {A_VERSION}"
        assert client.get("/api/health").json()["status"] == "ok"
    finally:
        analytics_db.close()
        analytics_db.init(str(ANALYTICS_DB_PATH), settings.analytics_pool_size)


def test_zero_interval_disables_hot_reload(client, tmp_path):
    _build(tmp_path / f"prospect_{A_VERSION}.duckdb", A_VERSION)
    _build(tmp_path / f"prospect_{B_VERSION}.duckdb", B_VERSION)
    link = tmp_path / "current.duckdb"
    _point(link, f"prospect_{A_VERSION}.duckdb")
    try:
        analytics_db.init(str(link), 2, reload_interval_s=0)
        _point(link, f"prospect_{B_VERSION}.duckdb")
        time.sleep(0.02)
        assert _game_name(client) == f"Rogue Cellar {A_VERSION}"
        health = client.get("/api/health").json()
        assert health["target_differs"] is True  # honest about serving a stale mart
        assert health["reload_interval_s"] == 0
    finally:
        analytics_db.close()
        analytics_db.init(str(ANALYTICS_DB_PATH), settings.analytics_pool_size)


def test_closed_on_purpose_is_not_reopened_by_the_watch(client, published):
    """close() (shutdown, or a test simulating 'no mart') disarms the watch: a request must
    get the 503, not a silently re-opened mart."""
    analytics_db.close()
    time.sleep(0.06)
    r = client.get("/api/games/1001")
    assert r.status_code == 503
    assert r.json()["detail"].startswith("analytics database not available")
