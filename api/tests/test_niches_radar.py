"""GET /api/niches/radar — the Radar feed (mockup 3a), in BOTH mart states.

demand_trend_90d_pct / reviews_90d / reviews_prev_90d landed in mart_niche on 2026-08-21
(PR #69) — the entire ranking metric behind this feed. The API ships before the nightly
rebuild that materialises those columns, so production runs the OLD mart FIRST, for hours:

  gated-off  conftest's shared fixture mart already predates these columns (it predates the
             whole v2/players/lifetime family), so it stands in for that state with zero setup
             — the same state a fresh deploy of this endpoint genuinely sees first.
  gated-on   a purpose-built DuckDB carrying demand_trend_90d_pct + everything else the feed
             reads (p90_rev, players_trend_7d_pct, mart_niche_trend, mart_niche_players_monthly),
             swapped in per-test like test_niches_games_mart.py / test_games_aspect_reviews.py.

Numbers are hand-picked so hero-pick / movers-ranking / null-baseline-exclusion / tier-
exclusion are all checkable on paper — see the comments on ROWS below.
"""
from __future__ import annotations

import tempfile
from contextlib import contextmanager
from pathlib import Path

import duckdb
import pytest

from app import analytics_db
from app.config import settings
from app.routers import niches

# dimension, key, win, min_reviews, n_games, tier, opportunity_v2, saturation_yoy, p90_rev,
# total_players_now, players_trend_7d_pct, reviews_90d, reviews_prev_90d, demand_trend_90d_pct.
#
# All rows share (win='24m', min_reviews=50) — the radar endpoint's default cut (mirrors
# NicheFinder's own default, and mockup 3a's own caption: "last 24 months · micro + theme
# tags"). Ranked by demand_trend_90d_pct DESC, "Colony Sim" (+24%) is the single biggest
# riser -> the hero. Ranked by |demand_trend_90d_pct| DESC, the "Moving niches" order is:
# Colony Sim (24), Deckbuilder (-16), Boomer Shooter (18)... — i.e. NOT monotonic with the
# signed value, which is exactly the point: this is a feed of what's MOVING, not just rising.
#   |24| Colony Sim, |18| Boomer Shooter, |16| Deckbuilder, |11| Fishing, |9| Base Building
# "No Baseline Tag" has reviews_prev_90d = 0 -> demand_trend_90d_pct NULL in real ETL output
# (see mart_niche.sql); inserted here as an explicit NULL to prove the router excludes it
# rather than treating NULL as 0/flat. "Open World" is tier='umbrella' with the single
# biggest trend of all (+50%) — excluded because the feed is tags-only micro+theme
# ("buildable niches", not genre/mechanic containers). "Roguelike" is dimension='genre' with
# its own trend, used to prove the dimension=genre query path (no tier filter applies there).
ROWS = [
    ("tag", "Colony Sim", "24m", 50, 41, "micro", 87.4, -0.12, 612_000.0, 5000.0, 6.2, 620, 500, 24.0),
    ("tag", "Boomer Shooter", "24m", 50, 78, "micro", 81.9, -0.05, 488_000.0, 3000.0, 3.8, 500, 424, 18.0),
    ("tag", "Fishing", "24m", 50, 129, "theme", 76.2, 0.02, 301_000.0, 2000.0, 9.1, 300, 270, 11.0),
    ("tag", "Souls-like", "24m", 50, 204, "micro", 41.0, -0.02, 944_000.0, 9000.0, -1.4, 200, 208, -4.0),
    ("tag", "Base Building", "24m", 50, 66, "micro", 72.8, 0.01, 520_000.0, 1500.0, 2.0, 150, 138, 9.0),
    ("tag", "Deckbuilder", "24m", 50, 312, "theme", 33.5, -0.08, 702_000.0, 4000.0, -3.1, 400, 476, -16.0),
    ("tag", "No Baseline Tag", "24m", 50, 60, "micro", 50.0, 0.0, 200_000.0, 100.0, 1.0, 100, 0, None),
    ("tag", "Open World", "24m", 50, 900, "umbrella", 90.0, 0.10, 1_200_000.0, 20000.0, 4.0, 900, 600, 50.0),
    ("genre", "Roguelike", "24m", 50, 55, "genre", 60.0, -0.01, 400_000.0, 2500.0, 2.5, 250, 220, 13.6),
]

# Colony Sim's yearly demand-vs-pipeline series (mart_niche_trend) — the hero chart's real
# source (see RadarHero docstring: no mart carries a monthly review/release series).
TREND = [
    ("tag", "Colony Sim", 2023, 10, 8, 150_000.0, 400_000.0),
    ("tag", "Colony Sim", 2024, 8, 7, 180_000.0, 500_000.0),
    ("tag", "Colony Sim", 2025, 6, 6, 220_000.0, 612_000.0),
]

# Real monthly player history — only Colony Sim and Boomer Shooter get any, so the sparkline
# degrade (empty list, not fabricated shape) is observable on the other movers.
PLAYERS_MONTHLY = [
    ("tag", "Colony Sim", "2025-06-01", 1000, 5),
    ("tag", "Colony Sim", "2025-07-01", 1200, 5),
    ("tag", "Colony Sim", "2025-08-01", 1500, 5),
    ("tag", "Boomer Shooter", "2025-08-01", 800, 4),
]


def _build(path: Path, *, with_players_monthly: bool) -> None:
    con = duckdb.connect(str(path))
    try:
        con.execute("""
            CREATE TABLE mart_niche (
                dimension VARCHAR, key VARCHAR, win VARCHAR, min_reviews INTEGER, n_games INTEGER,
                tier VARCHAR, opportunity_v2 DOUBLE, saturation_yoy DOUBLE, p90_rev DOUBLE,
                total_players_now DOUBLE, players_trend_7d_pct DOUBLE,
                reviews_90d BIGINT, reviews_prev_90d BIGINT, demand_trend_90d_pct DOUBLE
            )
        """)
        con.executemany(f"INSERT INTO mart_niche VALUES ({', '.join(['?'] * 14)})", ROWS)

        # The LIST endpoint (`GET /api/niches`) SELECTs every _BASE_COLS entry plus every
        # capability-gated column whose probe answers yes; the radar feed only reads the 14
        # above. Pad the rest as typed NULLs (n_recent defaulted — NicheRow requires it) so
        # this fixture also exercises the list endpoint's demand columns, derived from the
        # router's own list to stay in sync. players_coverage rides along because the
        # narrow table already trips _has_players via total_players_now.
        narrow = {
            "dimension", "key", "win", "min_reviews", "n_games", "tier", "opportunity_v2",
            "saturation_yoy", "p90_rev", "total_players_now", "players_trend_7d_pct",
            "reviews_90d", "reviews_prev_90d", "demand_trend_90d_pct",
        }
        for col in [c for c in [*niches._BASE_COLS, "players_coverage"] if c not in narrow]:
            typ = "INTEGER DEFAULT 0" if col == "n_recent" else "DOUBLE"
            con.execute(f"ALTER TABLE mart_niche ADD COLUMN {col} {typ}")

        con.execute(
            "CREATE TABLE mart_niche_trend (dimension VARCHAR, key VARCHAR, year INTEGER, "
            "n_releases INTEGER, n_scored INTEGER, median_rev DOUBLE, p90_rev DOUBLE)"
        )
        con.executemany(f"INSERT INTO mart_niche_trend VALUES ({', '.join(['?'] * 7)})", TREND)

        if with_players_monthly:
            con.execute(
                "CREATE TABLE mart_niche_players_monthly (dimension VARCHAR, key VARCHAR, "
                "month DATE, avg_players_sum BIGINT, n_games_measured INTEGER)"
            )
            con.executemany(
                f"INSERT INTO mart_niche_players_monthly VALUES ({', '.join(['?'] * 5)})",
                PLAYERS_MONTHLY,
            )

        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.execute(
            "INSERT INTO mart_meta VALUES ('mart_version', ?), ('built_at', '2026-01-01T00:00:00+00:00')",
            ["radar-fixture-" + ("with-sparklines" if with_players_monthly else "no-players-monthly")],
        )
    finally:
        con.close()  # must be closed before analytics_db opens it read_only


@pytest.fixture(scope="module")
def mart_paths() -> dict[str, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="prospect_radar_tests_"))
    paths = {
        "full": tmp / "full_mart.duckdb",
        "no_players_monthly": tmp / "no_players_monthly_mart.duckdb",
    }
    _build(paths["full"], with_players_monthly=True)
    _build(paths["no_players_monthly"], with_players_monthly=False)
    return paths


_GATES = (
    niches._has_demand90,
    niches._has_p90,
    niches._has_p90_trend,
    niches._has_players,
    niches._has_players_dist,
    niches._has_lifetime,
    niches._has_no_floor_cut,
)


@contextmanager
def _swapped(path: Path):
    """Mount `path` as the analytics DB for one test, then restore the shared fixture mart.
    Every capability probe here is lru_cached per process, so each one is cleared on the way
    in AND out — otherwise the first test to run would pin its answer for every test after it."""
    analytics_db.close()
    analytics_db.init(str(path), 2)
    for gate in _GATES:
        gate.cache_clear()
    try:
        yield
    finally:
        analytics_db.close()
        analytics_db.init(settings.analytics_db_path, settings.analytics_pool_size)
        for gate in _GATES:
            gate.cache_clear()


@pytest.fixture
def radar_client(client, mart_paths):
    """The full gated-on mart (demand_trend_90d_pct + p90 + players + trend + sparklines)."""
    with _swapped(mart_paths["full"]):
        yield client


@pytest.fixture
def radar_client_no_sparklines(client, mart_paths):
    """Gated-on for demand_trend_90d_pct, but mart_niche_players_monthly doesn't exist —
    proves the sparkline degrade (empty lists, not a 500) is independent of the main gate."""
    with _swapped(mart_paths["no_players_monthly"]):
        yield client


# =========================================================================================
# Gated-off: conftest's shared fixture mart predates demand_trend_90d_pct entirely — the
# state production is genuinely in for hours after every deploy that adds a mart column.
# =========================================================================================


def test_radar_503_on_mart_that_predates_demand_trend(client):
    r = client.get("/api/niches/radar")
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "demand_trend_90d_pct" in detail
    assert "rebuild the marts" in detail


def test_radar_gated_off_does_not_affect_the_niches_list(client):
    # The radar gate must not leak into the general list endpoint's own (unrelated) gate: the
    # shared fixture mart predates v2 scoring entirely (opportunity_v2/tier/etc. are all
    # absent), so the list endpoint's OWN existing 503 ("niche-score v2 columns") fires here
    # — a different message than radar's, proving the two gates are independent.
    r = client.get("/api/niches", params={"dimension": "genre", "window": "all", "min_reviews": 10})
    assert r.status_code == 503
    assert "v2 columns" in r.json()["detail"]


def test_list_demand_sort_503_on_mart_that_predates_demand90(client):
    # Sorting the LIST by a demand column on a pre-demand mart must hit the explicit gate
    # (same convention as the lifetime/p90 sorts), never a BinderException 500.
    r = client.get("/api/niches", params={"sort": "demand_trend_90d_pct"})
    assert r.status_code == 503
    assert "90-day demand" in r.json()["detail"]


# =========================================================================================
# Gated-on: the full fixture mart.
# =========================================================================================


def test_radar_hero_is_the_biggest_riser(radar_client):
    r = radar_client.get("/api/niches/radar")
    assert r.status_code == 200
    body = r.json()
    hero = body["hero"]
    assert hero["key"] == "Colony Sim"
    assert hero["demand_trend_90d_pct"] == 24.0
    assert hero["n_games"] == 41
    assert hero["tier"] == "micro"
    assert hero["p90_rev"] == 612_000.0
    assert hero["opportunity_v2"] == 87.4
    assert hero["saturation_yoy"] == -0.12
    assert hero["reviews_90d"] == 620
    assert hero["reviews_prev_90d"] == 500


def test_radar_hero_carries_its_yearly_trend(radar_client):
    r = radar_client.get("/api/niches/radar")
    trend = r.json()["hero"]["trend"]
    assert [t["year"] for t in trend] == [2023, 2024, 2025]
    assert trend[-1]["n_releases"] == 6
    assert trend[-1]["median_rev"] == 220_000.0
    assert trend[-1]["p90_rev"] == 612_000.0


def test_radar_movers_ranked_by_absolute_trend_hero_first(radar_client):
    # limit=5 -> hero + 4 more, out of 6 eligible tag rows (micro/theme, non-null trend):
    # deliberately tight enough to prove the limit truncates the SMALLEST mover, not an
    # arbitrary one — "Souls-like" (|4|) is the weakest move and must be the one dropped.
    r = radar_client.get("/api/niches/radar", params={"limit": 5})
    movers = r.json()["movers"]
    # Hero repeats as movers[0] (mirrors mockup 3a, whose hero niche is also grid card 1),
    # then ranked by |demand_trend_90d_pct| DESC: 24, 18, 16, 11, 9.
    assert [m["key"] for m in movers] == [
        "Colony Sim", "Boomer Shooter", "Deckbuilder", "Fishing", "Base Building",
    ]
    assert [m["demand_trend_90d_pct"] for m in movers] == [24.0, 18.0, -16.0, 11.0, 9.0]
    assert "Souls-like" not in [m["key"] for m in movers]


def test_radar_excludes_null_baseline_niche(radar_client):
    # "No Baseline Tag" has reviews_prev_90d = 0 -> demand_trend_90d_pct NULL. NULL means "no
    # baseline to compare against", not "flat" — it must never surface as a 0%/unchanged mover.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    keys = [m["key"] for m in r.json()["movers"]]
    assert "No Baseline Tag" not in keys


def test_radar_excludes_non_buildable_tiers(radar_client):
    # "Open World" (tier=umbrella) has the single biggest trend of all (+50%) but must be
    # excluded: the feed is tags-only micro+theme ("buildable niches"), matching mockup 3a's
    # own caption ("micro + theme tags") and NicheFinder's DEFAULT_TIERS.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    body = r.json()
    assert body["hero"]["key"] != "Open World"
    assert "Open World" not in [m["key"] for m in body["movers"]]


def test_radar_sparkline_is_real_data_and_empty_when_none_exists(radar_client):
    r = radar_client.get("/api/niches/radar", params={"limit": 6})
    movers = {m["key"]: m for m in r.json()["movers"]}
    assert [p["month"] for p in movers["Colony Sim"]["sparkline"]] == [
        "2025-06-01", "2025-07-01", "2025-08-01",
    ]
    assert movers["Colony Sim"]["sparkline"][-1]["players"] == 1500.0
    assert [p["players"] for p in movers["Boomer Shooter"]["sparkline"]] == [800.0]
    # Deckbuilder has no mart_niche_players_monthly rows at all — empty, not invented.
    assert movers["Deckbuilder"]["sparkline"] == []


def test_radar_sparkline_degrades_when_players_monthly_table_absent(radar_client_no_sparklines):
    r = radar_client_no_sparklines.get("/api/niches/radar", params={"limit": 6})
    assert r.status_code == 200
    body = r.json()
    assert body["hero"]["key"] == "Colony Sim"
    assert body["hero"]["sparkline"] == []
    assert all(m["sparkline"] == [] for m in body["movers"])


def test_radar_genre_dimension_no_tier_filter(radar_client):
    # dimension=genre: the tag-tier filter (micro/theme) must not apply — "Roguelike" (tier
    # stamped 'genre' in the real marts) is eligible on its own trend value.
    r = radar_client.get("/api/niches/radar", params={"dimension": "genre", "limit": 6})
    assert r.status_code == 200
    body = r.json()
    assert body["dimension"] == "genre"
    assert body["hero"]["key"] == "Roguelike"
    assert body["hero"]["demand_trend_90d_pct"] == 13.6


def test_radar_limit_one_returns_just_the_hero(radar_client):
    r = radar_client.get("/api/niches/radar", params={"limit": 1})
    body = r.json()
    assert len(body["movers"]) == 1
    assert body["movers"][0]["key"] == body["hero"]["key"]


def test_radar_echoes_the_requested_cut(radar_client):
    r = radar_client.get("/api/niches/radar", params={"window": "24m", "min_reviews": 50})
    body = r.json()
    assert body["window"] == "24m"
    assert body["min_reviews"] == 50


# =========================================================================================
# The LIST endpoint's demand columns (2026-08-26): GET /api/niches carries reviews_90d /
# reviews_prev_90d / demand_trend_90d_pct when the mart does, so the Radar board can ring
# EVERY blip on its own trend instead of joining the feed's 24 top movers.
# =========================================================================================


def test_list_niches_carries_demand90(radar_client):
    r = radar_client.get("/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50})
    assert r.status_code == 200
    rows = {i["key"]: i for i in r.json()["items"]}
    assert rows["Colony Sim"]["demand_trend_90d_pct"] == 24.0
    assert rows["Colony Sim"]["reviews_90d"] == 620
    assert rows["Colony Sim"]["reviews_prev_90d"] == 500
    # NULL baseline stays NULL on the list — "no baseline to compare against" must not
    # collapse into "flat" (the same rule the mart and the feed already follow).
    assert rows["No Baseline Tag"]["demand_trend_90d_pct"] is None
    assert rows["No Baseline Tag"]["reviews_prev_90d"] == 0


def test_list_niches_sorts_by_demand_trend_nulls_last(radar_client):
    r = radar_client.get(
        "/api/niches",
        params={"dimension": "tag", "window": "24m", "min_reviews": 50, "sort": "demand_trend_90d_pct"},
    )
    assert r.status_code == 200
    keys = [i["key"] for i in r.json()["items"]]
    # Default tiers=micro,theme excludes the umbrella "Open World" (+50) — the biggest
    # trend must not smuggle a container tag in. NULL trend sorts last, not as 0.
    assert keys == [
        "Colony Sim", "Boomer Shooter", "Fishing", "Base Building",
        "Souls-like", "Deckbuilder", "No Baseline Tag",
    ]
