"""GET /api/refresh/history — the run log's envelope, and the `limit` param actually
limiting.

`limit` was accepted and silently ignored: every call returned the newest 60 runs
regardless (verified against production, where ?limit=2 came back with 40 runs). It is
honoured now, and the response carries the envelope (total/limit) the pagination needs.
"""
from __future__ import annotations

import json

import pytest

from app.config import settings

# finished_at deliberately out of order on disk — the router sorts newest-first.
RUNS = [
    {"finished_at": "2026-08-24T04:10:00+00:00", "games_added": 12},
    {"finished_at": "2026-08-26T04:10:00+00:00", "games_added": 30},
    {"finished_at": "2026-08-25T04:10:00+00:00", "games_added": 21},
]


@pytest.fixture
def history_file(tmp_path, monkeypatch):
    path = tmp_path / "refresh_history.json"
    path.write_text("\n".join(json.dumps(r) for r in RUNS) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    return path


def test_returns_runs_newest_first_with_the_envelope(client, history_file):
    body = client.get("/api/refresh/history").json()
    assert [r["games_added"] for r in body["runs"]] == [30, 21, 12]
    assert body["total"] == 3
    assert body["limit"] == 60  # the default, unchanged


def test_limit_actually_limits(client, history_file):
    body = client.get("/api/refresh/history", params={"limit": 2}).json()
    assert [r["games_added"] for r in body["runs"]] == [30, 21]
    assert body["limit"] == 2
    assert body["total"] == 3  # total is what's on disk, not what was returned


def test_limit_is_validated(client, history_file):
    assert client.get("/api/refresh/history", params={"limit": 0}).status_code == 422
    assert client.get("/api/refresh/history", params={"limit": 501}).status_code == 422


def test_missing_file_is_an_empty_log_not_an_error(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "refresh_history_path", str(tmp_path / "nope.json"))
    body = client.get("/api/refresh/history").json()
    assert body == {"runs": [], "total": 0, "limit": 60}


def test_corrupt_file_degrades_to_empty(client, tmp_path, monkeypatch):
    path = tmp_path / "broken.json"
    path.write_text("{not json at all\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    assert client.get("/api/refresh/history").json()["runs"] == []


def test_one_corrupt_line_mid_file_does_not_wipe_the_history(client, tmp_path, monkeypatch):
    """A torn append (crash mid-write) corrupts ONE line; parsing is per-line (like the
    mcp-log viewer), so the valid runs before and after it survive."""
    path = tmp_path / "history.json"
    lines = [
        json.dumps(RUNS[0]),
        "{torn append — not json",
        json.dumps(RUNS[1]),
        json.dumps(RUNS[2]),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    body = client.get("/api/refresh/history").json()
    assert [r["games_added"] for r in body["runs"]] == [30, 21, 12]  # still newest-first
    assert body["total"] == 3  # the corrupt line counts for nothing, wipes nothing


def test_free_form_run_keys_survive_the_response_model(client, tmp_path, monkeypatch):
    """The cron grows new delta keys without an API deploy, so run records stay dicts —
    a typed row model would silently drop tomorrow's fields."""
    path = tmp_path / "history.json"
    path.write_text(
        json.dumps({"finished_at": "2026-08-27T04:00:00+00:00", "brand_new_metric": 7}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    (run,) = client.get("/api/refresh/history").json()["runs"]
    assert run["brand_new_metric"] == 7


# ---- the record contract since 2026-09 (deploy/prospect-refresh.sh) -----------------------
# One record per `result` kind the nightly writes. OK and FAILED ran the pipeline and carry
# counts / deltas / freshness; HELD (a build hold was on) and SKIPPED (the refresh lock was
# already held) never started it — duration 0, a `reason`, and NO counts/deltas/freshness
# keys at all. The page is the consumer of the new fields; the API's whole job is to not
# touch them.
_COUNTS = {"games": 120_000, "reviews": 16_000_000, "articles": 1_128_930, "players": 900_000}
_FRESHNESS = {"reviews": 1.5, "articles": 2.0, "players": 0.5, "games": 3.0}
# The writer caps `error` at 300 chars; every one of them must come back.
_ETL_ERROR = (
    "duckdb.duckdb.OutOfMemoryException: Out of Memory Error: failed to allocate data of size "
    + "x" * 300
)[:300]

KINDS = [
    {
        "finished_at": "2026-09-01T02:41:10Z", "result": "OK", "duration_s": 20_470, "step": "done",
        "mart_version": "20260901", "serving_version": "20260901",
        "etl_rc": 0, "etl_duration_s": 9_800, "error": None,
        "counts": _COUNTS,
        "deltas": {"games": 12, "reviews": 5_000, "articles": 300, "players": 4_000},
        "freshness_hours": _FRESHNESS,
    },
    {
        "finished_at": "2026-09-02T03:12:00Z", "result": "FAILED", "duration_s": 15_300, "step": "etl",
        "mart_version": "20260901", "serving_version": "20260901",
        "etl_rc": 137, "etl_duration_s": 7_200, "error": _ETL_ERROR,
        "counts": _COUNTS,
        "deltas": {"games": 0, "reviews": 0, "articles": 0, "players": 0},
        "freshness_hours": _FRESHNESS,
    },
    {
        "finished_at": "2026-09-03T21:00:05Z", "result": "HELD", "duration_s": 0, "step": "hold",
        "reason": "rescore in progress — do not rebuild the marts until it lands",
        "mart_version": "20260901", "serving_version": "20260901",
        "etl_rc": None, "etl_duration_s": None, "error": None,
    },
    {
        "finished_at": "2026-09-04T21:00:02Z", "result": "SKIPPED", "duration_s": 0, "step": "lock",
        "reason": "lock held: /root/.prospect-refresh.lock",
        "mart_version": "20260901", "serving_version": "20260901",
        "etl_rc": None, "etl_duration_s": None, "error": None,
    },
]


@pytest.fixture
def kinds_file(tmp_path, monkeypatch):
    path = tmp_path / "refresh_history.json"
    path.write_text("\n".join(json.dumps(r) for r in KINDS) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    return path


def test_all_four_result_kinds_come_back_unchanged_newest_first(client, kinds_file):
    res = client.get("/api/refresh/history")
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 4
    assert [r["result"] for r in body["runs"]] == ["SKIPPED", "HELD", "FAILED", "OK"]
    # Dict-for-dict equality: no coercion, no defaults filled in, no key dropped, nulls
    # round-tripped as nulls.
    assert body["runs"] == sorted(KINDS, key=lambda r: r["finished_at"], reverse=True)


def test_held_and_skipped_rows_are_served_without_counts_not_with_nulls(client, kinds_file):
    by_result = {r["result"]: r for r in client.get("/api/refresh/history").json()["runs"]}
    for kind in ("HELD", "SKIPPED"):
        row = by_result[kind]
        assert row["duration_s"] == 0
        assert row["reason"]
        assert row["etl_rc"] is None and row["etl_duration_s"] is None and row["error"] is None
        # Absent stays absent: a null `deltas` would read as "baseline snapshot" on the page.
        assert not ({"counts", "deltas", "freshness_hours"} & row.keys())
    assert by_result["HELD"]["step"] == "hold"
    assert by_result["SKIPPED"]["step"] == "lock"
    assert by_result["SKIPPED"]["reason"] == "lock held: /root/.prospect-refresh.lock"


def test_failed_row_keeps_the_whole_error_and_the_etl_exit_code(client, kinds_file):
    (failed,) = [r for r in client.get("/api/refresh/history").json()["runs"] if r["result"] == "FAILED"]
    assert failed["error"] == _ETL_ERROR
    assert len(failed["error"]) == 300
    assert failed["etl_rc"] == 137
    assert failed["etl_duration_s"] == 7_200
    assert failed["serving_version"] == "20260901"


def test_a_record_without_finished_at_sorts_oldest_instead_of_crashing(client, tmp_path, monkeypatch):
    """A record whose writer never set finished_at (or nulled it) must not turn the whole
    log into a 500 — `None < str` in the sort key did exactly that. Stable sort: the two
    dateless rows keep their on-disk order behind every dated one."""
    path = tmp_path / "history.json"
    lines = [
        json.dumps(KINDS[0]),
        json.dumps({"result": "HELD", "finished_at": None, "reason": "hold note"}),
        json.dumps({"result": "SKIPPED", "reason": "lock held: /root/.prospect-refresh.lock"}),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    res = client.get("/api/refresh/history")
    assert res.status_code == 200
    assert [r["result"] for r in res.json()["runs"]] == ["OK", "HELD", "SKIPPED"]
    assert res.json()["total"] == 3


def test_a_json_line_that_is_not_an_object_is_skipped_like_a_corrupt_one(client, tmp_path, monkeypatch):
    path = tmp_path / "history.json"
    path.write_text("\n".join([json.dumps(KINDS[0]), "7", "[]", json.dumps(KINDS[3])]) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "refresh_history_path", str(path))
    res = client.get("/api/refresh/history")
    assert res.status_code == 200
    assert [r["result"] for r in res.json()["runs"]] == ["SKIPPED", "OK"]
    assert res.json()["total"] == 2
