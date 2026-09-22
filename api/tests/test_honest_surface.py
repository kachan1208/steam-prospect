"""Dead or misleading API surface, made honest (the owner's rule: a number never travels
without saying what it is).

* NicheDetail.hit_rates silently fell back to whatever cut sorted first when the niche has
  no all/50 cut (26 of the 40 smallest tags on the real mart) — usually all/0, a population
  that counts unreviewed games. hit_rates_cut now names the cut and flags the fallback.
* /api/market/benchmarks served the RETIRED v1 `opportunity` weights under
  cited.opportunity_weights; it now carries opportunity_v2's composition, the formula, and
  the served mart's own statement of the model.
* The entity 404's "did you mean" ILIKE didn't escape % and _, so a name containing them
  matched as a wildcard.
"""
from __future__ import annotations

import duckdb
import pytest

from conftest import build_modern_mart, serving


def test_hit_rates_name_their_cut(modern_mart):
    body = modern_mart.get("/api/niches/tag/Roguelike").json()
    assert body["hit_rates_cut"] == {"window": "all", "min_reviews": 50, "fallback": False}
    assert body["hit_rates"]["hit_rate_200k"] == 0.5  # the all/50 row's value


def test_hit_rates_fallback_is_flagged_not_silent(modern_mart):
    """Deckbuilder has only the all/0 cut in the modern fixture."""
    body = modern_mart.get("/api/niches/tag/Deckbuilder").json()
    assert body["hit_rates_cut"] == {"window": "all", "min_reviews": 0, "fallback": True}
    assert body["hit_rates"]["n_games"] == 2


def test_fallback_prefers_an_all_time_cut_over_a_24m_one(client, tmp_path):
    """Sorted by (win, min_reviews), a 24m cut used to come FIRST ('24m' < 'all'), so a niche
    without all/50 could headline a recent-window population as its all-time hit rate."""
    path = tmp_path / "fallback.duckdb"
    build_modern_mart(path)
    with duckdb.connect(str(path)) as con:
        con.execute(
            "DELETE FROM mart_niche WHERE key = 'Roguelike' AND win = 'all' AND min_reviews = 50"
        )
    with serving(path):
        body = client.get("/api/niches/tag/Roguelike").json()
    assert body["hit_rates_cut"] == {"window": "all", "min_reviews": 0, "fallback": True}


def test_benchmarks_carry_the_live_score_composition(client):
    cited = client.get("/api/market/benchmarks").json()["cited"]
    weights = cited["opportunity_weights"]
    assert weights == {"momentum": 0.40, "market_pull": 0.22, "revenue_spread": 0.20, "quality_gap": 0.18}
    assert sum(weights.values()) == pytest.approx(1.0)
    assert "demand" not in weights and "competition" not in weights  # the v1 recipe is gone
    formula = cited["opportunity_formula"]
    assert "supply_brake" in formula and "NON-NULL" in formula


def test_benchmarks_echo_the_marts_own_model_statement(client, tmp_path):
    model = "core=mean(momentum=0.4,market_pull=0.22,revenue_spread=0.2,quality_gap=0.18)"
    path = tmp_path / "model.duckdb"
    build_modern_mart(path, meta={"opportunity_v2_model": model})
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE TABLE mart_market_boxleiter (genre VARCHAR, n INTEGER, owners_per_review_median DOUBLE, owners_per_review_p25 DOUBLE, owners_per_review_p75 DOUBLE, slope DOUBLE, intercept DOUBLE)")
        con.execute("CREATE TABLE mart_market_tiers (tier VARCHAR, tier_order INTEGER, count INTEGER, pct DOUBLE)")
    with serving(path):
        computed = client.get("/api/market/benchmarks").json()["computed"]
    assert computed["opportunity_v2_model"] == model
    # ...and the shared fixture mart, which predates the key, says so with null.
    assert client.get("/api/market/benchmarks").json()["computed"]["opportunity_v2_model"] is None


@pytest.mark.parametrize("name", ["%", "_", "Studio%", "S_udio"])
def test_did_you_mean_treats_wildcards_literally(client, name):
    r = client.get("/api/entities/profile", params={"role": "developer", "name": name})
    assert r.status_code == 404
    # No fixture developer has a literal % or _ in its name: nothing may "match".
    assert r.json()["detail"]["suggestions"] == []


def test_did_you_mean_still_suggests_real_near_misses(client):
    r = client.get("/api/entities/profile", params={"role": "developer", "name": "Studio"})
    assert r.json()["detail"]["suggestions"] == ["Studio B", "Big Studio D"]


def test_unused_range_schema_is_gone():
    from app import schemas

    assert not hasattr(schemas, "Range")
