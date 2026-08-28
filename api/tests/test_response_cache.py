"""The mart-pure handlers: schema contract, in-process caching and Cache-Control.

/api/market/benchmarks, /api/seasonality, /api/launch-curve and /api/timing/overview read
precomputed marts and do arithmetic — within one process (the DB is swapped + the app
restarted on each ETL) their answers are constants. These tests pin that the caching is
keyed by the MART VERSION (never serving one mart's numbers for another), that failures
are not cached, and that the responses advertise an hour of public caching.
"""
from __future__ import annotations

import pytest

from app import analytics_db, response_cache

_CACHED_PATHS = [
    "/api/market/benchmarks",
    "/api/seasonality",
    "/api/launch-curve",
    "/api/timing/overview",
]


@pytest.mark.parametrize("path", _CACHED_PATHS)
def test_cache_control_is_an_hour_of_public_caching(client, path):
    r = client.get(path)
    assert r.status_code == 200, path
    assert r.headers["Cache-Control"] == "public, max-age=3600", path


@pytest.mark.parametrize("path", _CACHED_PATHS)
def test_second_call_is_served_from_cache(client, path, monkeypatch):
    """After the first call, the handler must not touch the DB again — asserted by making
    every query raise once the value is warm."""
    first = client.get(path)
    assert first.status_code == 200

    def _boom(sql, params=None):
        raise AssertionError(f"{path} re-queried the mart on a cache hit")

    monkeypatch.setattr(analytics_db, "query", _boom)
    second = client.get(path)
    assert second.status_code == 200
    assert second.json() == first.json()


def test_cache_is_keyed_by_the_genre_parameter(client):
    """Same handler, different param = different entry. '__all__' and 'Roguelike' have
    genuinely different fixture data, so a shared key would be visible immediately."""
    all_genres = client.get("/api/seasonality").json()
    roguelike = client.get("/api/seasonality", params={"genre": "Roguelike"}).json()
    assert all_genres["genre"] == "__all__"
    assert roguelike["genre"] == "Roguelike"
    assert response_cache.size() == 2


def test_cache_is_keyed_by_the_mart_version(client, monkeypatch):
    """A cached answer must never be served for a different mart. The key carries
    mart_version, so faking a new version misses and recomputes."""
    client.get("/api/market/benchmarks")
    warm = response_cache.size()
    assert warm == 1

    monkeypatch.setattr(analytics_db, "mart_version", lambda: "a-different-mart")
    r = client.get("/api/market/benchmarks")
    assert r.status_code == 200
    assert response_cache.size() == warm + 1  # recomputed under the new key, not reused


def test_unversioned_mart_is_never_cached(client, monkeypatch):
    """No mart_version (pre-mart_meta build, or the DB isn't open) = nothing safe to key
    on, so the handler computes every time and stores nothing."""
    monkeypatch.setattr(analytics_db, "mart_version", lambda: None)
    assert client.get("/api/launch-curve").status_code == 200
    assert client.get("/api/launch-curve").status_code == 200
    assert response_cache.size() == 0


def test_errors_are_not_cached(client):
    """timing/overview 404s on a genre with no rows. If that were cached, a genre whose
    marts land in the next rebuild would 404 for the rest of the process lifetime."""
    r = client.get("/api/timing/overview", params={"genre": "Sports"})
    assert r.status_code == 404
    assert response_cache.size() == 0


# ---- schema contract (both endpoints previously returned bare dicts) --------------------
def test_benchmarks_is_a_typed_response(client):
    body = client.get("/api/market/benchmarks").json()
    assert set(body) == {"cited", "computed", "boxleiter_by_genre", "tiers"}
    assert body["cited"]["median_indie_gross_usd"] == 249
    assert body["cited"]["boxleiter_owners_per_review"] == {"min": 20, "mid": 30, "max": 55}
    assert body["computed"]["median_revenue_scored"] == 7701.30
    assert body["computed"]["median_revenue_paid"] is None  # absent from the fixture meta
    assert "Boxleiter gross" in body["computed"]["population_note"]
    assert [g["genre"] for g in body["boxleiter_by_genre"]] == ["__all__", "Roguelike", "Action"]
    assert [t["tier"] for t in body["tiers"]] == ["Below Hobby", "Hobby", "Small", "Middle"]


def test_benchmarks_is_in_the_openapi_schema(client):
    """The point of the response_model: the endpoint stops being a shapeless dict in the
    generated docs that the web client and MCP both read."""
    schema = client.get("/openapi.json").json()
    ref = schema["paths"]["/api/market/benchmarks"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    assert ref.endswith("MarketBenchmarks")
    assert "MarketBenchmarks" in schema["components"]["schemas"]
