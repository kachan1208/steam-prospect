"""api/app/routers/timing.py — /api/timing/overview over the fixture's mart_timing_*
tables (see api/tests/conftest.py's TIMING_* constants, hand-picked so the recommendation
arithmetic is checkable on paper). The pre-ETL missing-table 503 is covered by
monkeypatching the query layer, same idiom as test_entities.py."""
from __future__ import annotations

import duckdb
import pytest

from app import analytics_db
from app.routers import timing as timing_router
from conftest import TIMING_CONGESTION_RELEASES, TIMING_DEMAND_SHARES


# ---- series ------------------------------------------------------------------------------

def test_overview_returns_all_three_series_in_order(client):
    r = client.get("/api/timing/overview", params={"genre": "__all__"})
    assert r.status_code == 200
    body = r.json()
    assert body["genre"] == "__all__"
    assert [p["month"] for p in body["demand"]] == list(range(1, 13))
    assert [p["month"] for p in body["congestion"]] == list(range(1, 13))
    assert [p["month_since_release"] for p in body["decay"]] == list(range(24))
    assert body["demand"][10]["demand_share"] == pytest.approx(0.13)  # November
    assert body["congestion"][9]["avg_releases"] == pytest.approx(160.0)  # October
    assert body["notes"], "honest caveats must ride along"


def test_overview_defaults_to_all_genres(client):
    r = client.get("/api/timing/overview")
    assert r.status_code == 200
    assert r.json()["genre"] == "__all__"


# ---- window_recommendation ---------------------------------------------------------------

def test_recommendation_scores_match_the_documented_formula(client):
    r = client.get("/api/timing/overview", params={"genre": "__all__"})
    rec = r.json()["window_recommendation"]
    assert rec is not None
    # score = share*12 - releases/mean(releases); mean = 1280/12 (see conftest).
    mean_rel = sum(TIMING_CONGESTION_RELEASES) / 12
    months = {w["month"]: w for w in rec["months"]}
    assert len(months) == 12
    for m in range(1, 13):
        expected = TIMING_DEMAND_SHARES[m - 1] * 12 - TIMING_CONGESTION_RELEASES[m - 1] / mean_rel
        assert months[m]["score"] == pytest.approx(expected, abs=1e-3)
    # Hand-computed ranking: Dec 0.3825 > Nov 0.2475 > Jul 0.1425.
    assert rec["best_months"] == [12, 11, 7]
    assert rec["best_month_names"] == ["Dec", "Nov", "Jul"]
    assert "Dec" in rec["rationale"]
    assert "demand_share" in rec["method"]  # formula is spelled out, not a black box


def test_recommendation_components_are_returned(client):
    r = client.get("/api/timing/overview", params={"genre": "__all__"})
    w = r.json()["window_recommendation"]["months"][10]  # November
    assert w["month_name"] == "Nov"
    assert w["demand_index"] == pytest.approx(0.13 * 12, abs=1e-3)
    assert w["congestion_index"] == pytest.approx(140.0 / (sum(TIMING_CONGESTION_RELEASES) / 12), abs=1e-3)
    assert w["avg_big_releases"] == pytest.approx(5.0)


def test_incomplete_congestion_yields_no_recommendation(client):
    # Roguelike has demand + decay but no congestion rows (below the ETL's size floor):
    # the endpoint still serves the series it has, with recommendation honestly absent.
    r = client.get("/api/timing/overview", params={"genre": "Roguelike"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["demand"]) == 12
    assert body["congestion"] == []
    assert body["window_recommendation"] is None
    assert body["decay_summary"] is not None  # decay doesn't need congestion


# ---- decay_summary -----------------------------------------------------------------------

def test_decay_summary_renormalizes_the_median_curve(client):
    # Fixture medians sum to 0.92 (not 1) — the summary must renormalize:
    # first_3 = 0.50/0.92, first_6 = 0.56/0.92, first_12 = 0.68/0.92.
    r = client.get("/api/timing/overview", params={"genre": "__all__"})
    s = r.json()["decay_summary"]
    assert s["first_3_months_share"] == pytest.approx(0.50 / 0.92, abs=1e-3)
    assert s["first_6_months_share"] == pytest.approx(0.56 / 0.92, abs=1e-3)
    assert s["first_12_months_share"] == pytest.approx(0.68 / 0.92, abs=1e-3)
    assert s["n_games"] == 40


# ---- failure modes -----------------------------------------------------------------------

def test_unknown_genre_404s_with_guidance(client):
    r = client.get("/api/timing/overview", params={"genre": "Sports"})
    assert r.status_code == 404
    assert "__all__" in r.json()["detail"]


def test_missing_timing_marts_surface_as_503(client, monkeypatch):
    def _raise(sql, params=None):
        raise duckdb.CatalogException("Table with name mart_timing_demand does not exist!")

    monkeypatch.setattr(analytics_db, "query", _raise)
    r = client.get("/api/timing/overview")
    assert r.status_code == 503
    assert r.json()["detail"] == timing_router._MARTS_MISSING_DETAIL
