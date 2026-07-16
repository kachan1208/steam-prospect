"""api/app/routers/estimate.py — reviews/wishlists happy paths, the "exactly one of" input
validation, and the per-genre Boxleiter slope lookup (incl. its 20-55 clamp and its fallback
to '__all__' then the cited default) against the fixture's mart_market_boxleiter rows:
    __all__    slope=30 (cited mid, already in-band)
    Roguelike  slope=40 (in-band — exercises the "no clamp needed" path)
    Action     slope=70 (deliberately OUT of the cited 20-55 band — exercises the clamp)
"""
from __future__ import annotations

import pytest


def test_reviews_basis_with_in_band_genre_slope(client):
    r = client.post("/api/estimate", json={"reviews": 1000, "price": 10.0, "genre": "Roguelike"})
    assert r.status_code == 200
    body = r.json()
    assert body["basis"] == "reviews"
    assert body["genre"] == "Roguelike"
    assert body["owners_per_review_used"]["mid"] == 40.0
    assert body["owners"]["mid"] == pytest.approx(40000.0)
    assert body["revenue_gross_usd"]["mid"] == pytest.approx(400000.0)
    assert body["revenue_net_usd"]["mid"] == pytest.approx(280000.0)
    assert body["dev_tier"] == "Small"


def test_reviews_basis_clamps_out_of_band_genre_slope(client):
    # Action's fixture slope is 70 — outside the cited 20-55 band — so the clamp must kick in.
    r = client.post("/api/estimate", json={"reviews": 1000, "price": 10.0, "genre": "Action"})
    assert r.status_code == 200
    body = r.json()
    assert body["genre"] == "Action"
    assert body["owners_per_review_used"]["mid"] == 55.0  # clamped to BOXLEITER_OWNERS_PER_REVIEW_MAX
    assert body["owners"]["mid"] == pytest.approx(55000.0)


def test_reviews_basis_falls_back_to_all_genre_slope_when_genre_omitted(client):
    r = client.post("/api/estimate", json={"reviews": 1000, "price": 10.0})
    assert r.status_code == 200
    body = r.json()
    assert body["genre"] == "__all__"
    assert body["owners_per_review_used"]["mid"] == 30.0
    assert body["owners"]["mid"] == pytest.approx(30000.0)


def test_reviews_basis_falls_back_to_all_genre_slope_when_genre_unknown(client):
    r = client.post("/api/estimate", json={"reviews": 1000, "price": 10.0, "genre": "Not A Real Genre"})
    assert r.status_code == 200
    body = r.json()
    assert body["genre"] == "__all__"
    assert body["owners_per_review_used"]["mid"] == 30.0


def test_wishlists_basis_happy_path(client):
    r = client.post("/api/estimate", json={"wishlists": 1000, "price": 20.0})
    assert r.status_code == 200
    body = r.json()
    assert body["basis"] == "wishlists"
    assert body["owners"]["low"] == pytest.approx(400.0)
    assert body["owners"]["mid"] == pytest.approx(500.0)
    assert body["owners"]["high"] == pytest.approx(600.0)
    assert body["revenue_gross_usd"]["mid"] == pytest.approx(10000.0)
    assert body["revenue_net_usd"]["mid"] == pytest.approx(7000.0)


def test_rejects_both_reviews_and_wishlists(client):
    r = client.post("/api/estimate", json={"reviews": 100, "wishlists": 100, "price": 10.0})
    assert r.status_code == 400
    assert "exactly one of" in r.json()["detail"]


def test_rejects_neither_reviews_nor_wishlists(client):
    r = client.post("/api/estimate", json={"price": 10.0})
    assert r.status_code == 400
    assert "exactly one of" in r.json()["detail"]


def test_rejects_negative_price(client):
    r = client.post("/api/estimate", json={"reviews": 100, "price": -5.0})
    assert r.status_code == 422
