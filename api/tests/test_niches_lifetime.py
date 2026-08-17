"""Lifetime-column gating on the niches list — the fixture mart_niche predates the
lifetime ETL (no lifetime_survival_12m column), so a lifetime sort must fail with the
gate's explicit 503, checked BEFORE any SQL runs (never a BinderException 500)."""


def test_niches_lifetime_sort_503_on_old_mart(client):
    for sort in ("lifetime_survival_12m", "lifetime_median_dead_months"):
        r = client.get("/api/niches", params={"sort": sort})
        assert r.status_code == 503
        assert "lifetime columns" in r.json()["detail"]


def test_niches_rejects_unknown_sort_still(client):
    r = client.get("/api/niches", params={"sort": "lifetime_x; DROP TABLE mart_niche--"})
    assert r.status_code == 400
