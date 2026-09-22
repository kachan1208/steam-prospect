"""Inputs the API used to accept and answer with a plausible-looking wrong result.

* GET /api/niches and /api/niches/export.csv took ANY min_reviews: only the materialised
  cuts (0 / 50 / 100 in the real mart) exist, so min_reviews=25 or -3 returned `total: 0`
  and a header-only CSV — read by a user as "no niche clears this bar". They now 422 with
  the cuts that exist, exactly like the drill-down endpoints always did.
* GET /api/market/distribution silently rewrote an unknown metric to revenue: a typo'd
  metric=review got a REVENUE chart back under the reviews label. Now a 422.
"""
from __future__ import annotations

import pytest


@pytest.mark.parametrize("min_reviews", [25, -3, 51])
def test_list_rejects_a_cut_that_does_not_exist(modern_mart, min_reviews):
    r = modern_mart.get("/api/niches", params={"window": "all", "min_reviews": min_reviews})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "not materialised in mart_niche" in detail
    # ...and it names what DOES exist, so the caller can fix the request.
    assert "(all, 0)" in detail and "(all, 50)" in detail and "(24m, 50)" in detail


def test_list_rejects_a_window_the_floor_does_not_exist_for(modern_mart):
    """24m has only the 50 cut in the modern fixture: (24m, 0) is a real level on a real
    window, just not materialised here — same 422, not an empty 200."""
    r = modern_mart.get("/api/niches", params={"window": "24m", "min_reviews": 0})
    assert r.status_code == 422


def test_list_still_serves_a_real_cut(modern_mart):
    r = modern_mart.get("/api/niches", params={"window": "all", "min_reviews": 50})
    assert r.status_code == 200
    assert r.json()["total"] >= 1


def test_export_rejects_a_cut_that_does_not_exist(modern_mart):
    """Was a 200 with a header-only CSV attachment."""
    r = modern_mart.get("/api/niches/export.csv", params={"window": "all", "min_reviews": 25})
    assert r.status_code == 422
    assert "not materialised" in r.json()["detail"]


def test_known_level_on_an_older_mart_is_still_the_rebuild_503(client):
    """min_reviews=0 is a real level an OLDER mart may predate: that stays the specific
    503 + rebuild hint (a capability of the mart, not a bad request)."""
    r = client.get("/api/niches", params={"min_reviews": 0})
    assert r.status_code == 503
    assert "no-floor" in r.json()["detail"]


def test_market_distribution_rejects_an_unknown_metric(client):
    r = client.get("/api/market/distribution", params={"metric": "review"})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["query", "metric"]


@pytest.mark.parametrize("metric", ["revenue", "reviews", "owners", "price"])
def test_market_distribution_accepts_every_real_metric(client, metric):
    r = client.get("/api/market/distribution", params={"metric": metric})
    assert r.status_code == 200
    assert r.json()["metric"] == metric
