"""Date windows are anchored on the MART's as-of date, never on the wall clock.

The catalog is a snapshot and the mart can be days old (a held build, a failed nightly), so
`released_within_days` (games search) and the `days` window of /games/{appid}/players used
to be anchored on CURRENT_DATE — against a stale mart that silently shrank every window by
the mart's age (and a test suite run a year later saw empty windows). Each window now ends
on the mart's own as-of date and echoes it back as `data_as_of`.

The modern fixture mart is built_at 2026-09-20; its daily players series ends 2026-09-20.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import duckdb

from conftest import build_modern_mart, serving


def test_new_releases_window_ends_on_the_mart_as_of_date(client, tmp_path):
    path = tmp_path / "releases.duckdb"
    build_modern_mart(path)
    with duckdb.connect(str(path)) as con:
        # 10 days before the as-of date: in a 30-day window. 5 days AFTER it: an announced
        # date the snapshot could not have seen released — out, whatever today is.
        con.execute("UPDATE mart_game SET release_date = '2026-09-10' WHERE appid = 1005")
        con.execute("UPDATE mart_game SET release_date = '2026-09-25' WHERE appid = 1006")
    with serving(path):
        body = client.get(
            "/api/games/search", params={"released_within_days": 30, "min_reviews": 0}
        ).json()
        plain = client.get("/api/games/search", params={"min_reviews": 0}).json()
    assert [g["appid"] for g in body["items"]] == [1005]
    assert body["data_as_of"] == "2026-09-20"
    assert plain["data_as_of"] is None  # no window, nothing to anchor


def test_players_window_ends_on_the_last_capture_day(modern_mart):
    """Captures run 2026-09-01..20 (+ one on 06-01). days=7 is the 8 days 09-13..09-20
    relative to the DATA — a wall-clock window would drift empty as the mart ages."""
    body = modern_mart.get("/api/games/1001/players", params={"days": 7}).json()
    assert body["available"] is True
    assert body["data_as_of"] == "2026-09-20"
    assert [p["date"] for p in body["points"]] == [f"2026-09-{d:02d}" for d in range(13, 21)]


def test_health_reports_mart_age_and_owners_as_of(client, tmp_path):
    built = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat(timespec="seconds")
    path = tmp_path / "aged.duckdb"
    build_modern_mart(path, meta={"built_at": built, "owners_as_of": "2024-06-01"})
    with serving(path):
        body = client.get("/api/health").json()
    assert body["built_at"] == built
    assert 29.9 <= body["age_hours"] <= 30.2
    assert body["owners_as_of"] == "2024-06-01"


def test_health_owners_as_of_is_absent_until_the_mart_carries_it(client):
    body = client.get("/api/health").json()
    assert body["owners_as_of"] is None
    assert body["age_hours"] is not None  # the shared fixture mart does carry built_at
