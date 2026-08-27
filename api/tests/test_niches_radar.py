"""GET /api/niches/radar — the Radar feed (mockup 3a), in BOTH mart states.

demand_trend_24m_pct / reviews_24m / reviews_prev_24m REPLACED the 12-month demand columns
(2026-08-26, user-directed: the radar's pinned membership cut is 24m x min50, so the whole
radar now speaks 24 months), which had replaced the original 90-day ones — the entire
ranking metric behind this feed. The same build added the emerging pair
(reviews_24m_new_share / demand_emerging): young tags whose prior window is near zero BY
CONSTRUCTION must not headline their trend %, so the feed excludes them from the % ranking
and returns them as their own `emerging` group ranked by absolute volume. The API ships
before the nightly rebuild that materialises those columns, so production runs the OLD mart
FIRST, for hours:

  gated-off  conftest's shared fixture mart already predates these columns (it predates the
             whole v2/players/lifetime family), so it stands in for that state with zero setup
             — the same state a fresh deploy of this endpoint genuinely sees first.
  gated-on   a purpose-built DuckDB carrying demand_trend_24m_pct + everything else the feed
             reads (p90_rev, players_trend_7d_pct, mart_niche_trend, mart_niche_players_monthly),
             swapped in per-test like test_niches_games_mart.py / test_games_aspect_reviews.py.

Numbers are hand-picked so hero-pick / movers-ranking / null-baseline-exclusion / tier-
exclusion / emerging-exclusion are all checkable on paper — see the comments on ROWS below.
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
# total_players_now, players_trend_7d_pct, reviews_24m, reviews_prev_24m,
# demand_trend_24m_pct, reviews_24m_new_share, demand_emerging, solo_viability,
# self_published_share, indie_share, med_playtime_h (the solo-evidence trio — stripped
# off entirely by _build(with_evidence=False), the pre-evidence mart state).
#
# All rows share (win='24m', min_reviews=50) — the radar endpoint's default cut (mirrors
# NicheFinder's own default, and mockup 3a's own caption: "last 24 months · micro + theme
# tags"). Ranked by demand_trend_24m_pct DESC among NON-emerging rows, "Colony Sim" (+24%)
# is the single biggest riser -> the hero. Ranked by |demand_trend_24m_pct| DESC, the
# "Moving niches" order is: Colony Sim (24), Deckbuilder (-16), Boomer Shooter (18)... —
# i.e. NOT monotonic with the signed value, which is exactly the point: this is a feed of
# what's MOVING, not just rising.
#   |24| Colony Sim, |18| Boomer Shooter, |16| Deckbuilder, |11| Fishing, |9| Base Building
# Non-emerging rows keep reviews_prev_24m >= 1000 and new_share < 0.8 so the explicit
# demand_emerging=FALSE stamped here is consistent with the mart's own two-tell rule
# (etl/tests/test_mart_niche_game.py replays that rule against the real SQL).
# "No Baseline Tag" has reviews_prev_24m = 0 -> demand_trend_24m_pct NULL in real ETL output
# (see mart_niche.sql) AND demand_emerging TRUE (tell 1: no comparable base); it must never
# surface as a 0%/unchanged mover, but it MUST surface in the `emerging` group.
# "Organizing" is the young-tag shape: the single biggest trend of ALL (+4850%) off a
# sub-floor base with 94% of its reviews from new games — demand_emerging TRUE. It must not
# take the hero slot or a mover slot on that %, but leads `emerging` on raw volume (39600).
# "Open World" is tier='umbrella' with a +50% trend — excluded because the feed is tags-only
# micro+theme ("buildable niches", not genre/mechanic containers). "Roguelike" is
# dimension='genre' with its own trend, used to prove the dimension=genre query path (no
# tier filter applies there).
#
# SOLO POPULATION RULE (solo_only, default ON for the feed — see niches.py's
# RADAR_SOLO_FRIENDLY_MIN): every original row is solo-friendly (>= 0.8) so the pre-solo
# expectations still hold under the new default. Three rows exist to be EXCLUDED by it:
#   "Extraction Shooter"  solo 0.35 (team-scale) — the cut's biggest riser (+33%): under
#                         solo_only=0 it takes the hero slot from Colony Sim; under the
#                         default it must vanish entirely.
#   "Co-op Heist"         solo NULL — unknown is NOT solo-friendly (the radar population
#                         is an explicit positive claim), so NULL is excluded, not passed.
#   "MMO Sandbox"         solo 0.2 AND demand_emerging — proves the rule reaches the
#                         emerging group too (it out-volumes Organizing at 50,000, so
#                         under solo_only=0 it LEADS emerging).
# Solo-evidence values: "Souls-like" carries the user's real motivating profile (0.85
# singleplayer here, 50% self-pub, 71% indie, median 5.7h); "Colony Sim" (the hero) gets a
# med_playtime_h ABOVE the web's 20h heavy-content bar so that path is servable; "Co-op
# Heist" carries NULL evidence — an evidence-bearing mart may still hold NULL rows (an
# all-NULL-input cut) and they must pass through as null, never 0.
ROWS = [
    ("tag", "Colony Sim", "24m", 50, 41, "micro", 87.4, -0.12, 612_000.0, 5000.0, 6.2, 6200, 5000, 24.0, 0.35, False, 0.97, 0.61, 0.83, 24.3),
    ("tag", "Boomer Shooter", "24m", 50, 78, "micro", 81.9, -0.05, 488_000.0, 3000.0, 3.8, 5000, 4240, 18.0, 0.28, False, 0.92, 0.55, 0.8, 6.1),
    ("tag", "Fishing", "24m", 50, 129, "theme", 76.2, 0.02, 301_000.0, 2000.0, 9.1, 3000, 2700, 11.0, 0.31, False, 0.88, 0.47, 0.66, 4.2),
    ("tag", "Souls-like", "24m", 50, 204, "micro", 41.0, -0.02, 944_000.0, 9000.0, -1.4, 2000, 2080, -4.0, 0.22, False, 0.85, 0.5, 0.71, 5.7),
    ("tag", "Base Building", "24m", 50, 66, "micro", 72.8, 0.01, 520_000.0, 1500.0, 2.0, 1500, 1380, 9.0, 0.4, False, 0.9, 0.52, 0.7, 8.0),
    ("tag", "Deckbuilder", "24m", 50, 312, "theme", 33.5, -0.08, 702_000.0, 4000.0, -3.1, 4000, 4760, -16.0, 0.18, False, 0.95, 0.58, 0.77, 9.4),
    ("tag", "No Baseline Tag", "24m", 50, 60, "micro", 50.0, 0.0, 200_000.0, 100.0, 1.0, 1000, 0, None, 1.0, True, 0.9, 0.6, 0.75, 3.3),
    ("tag", "Organizing", "24m", 50, 34, "micro", 82.0, 0.30, 250_000.0, 900.0, 5.0, 39_600, 800, 4850.0, 0.94, True, 0.94, 0.63, 0.81, 2.8),
    ("tag", "Open World", "24m", 50, 900, "umbrella", 90.0, 0.10, 1_200_000.0, 20000.0, 4.0, 9000, 6000, 50.0, 0.3, False, 0.85, 0.3, 0.4, 30.0),
    ("tag", "Extraction Shooter", "24m", 50, 88, "micro", 74.0, 0.05, 800_000.0, 12000.0, 4.4, 8000, 6015, 33.0, 0.3, False, 0.35, 0.2, 0.35, 40.0),
    ("tag", "Co-op Heist", "24m", 50, 47, "micro", 66.0, 0.02, 350_000.0, 2200.0, 1.1, 4200, 3500, 20.0, 0.26, False, None, None, None, None),
    ("tag", "MMO Sandbox", "24m", 50, 25, "micro", 55.0, 0.4, 500_000.0, 3000.0, 2.0, 50_000, 0, None, 0.91, True, 0.2, 0.15, 0.3, 60.0),
    ("genre", "Roguelike", "24m", 50, 55, "genre", 60.0, -0.01, 400_000.0, 2500.0, 2.5, 2500, 2200, 13.6, 0.25, False, 0.88, 0.51, 0.72, 7.7),
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


def _build(path: Path, *, with_players_monthly: bool, with_evidence: bool = True) -> None:
    con = duckdb.connect(str(path))
    try:
        evidence_ddl = (
            ", self_published_share DOUBLE, indie_share DOUBLE, med_playtime_h DOUBLE"
            if with_evidence else ""
        )
        con.execute(f"""
            CREATE TABLE mart_niche (
                dimension VARCHAR, key VARCHAR, win VARCHAR, min_reviews INTEGER, n_games INTEGER,
                tier VARCHAR, opportunity_v2 DOUBLE, saturation_yoy DOUBLE, p90_rev DOUBLE,
                total_players_now DOUBLE, players_trend_7d_pct DOUBLE,
                reviews_24m BIGINT, reviews_prev_24m BIGINT, demand_trend_24m_pct DOUBLE,
                reviews_24m_new_share DOUBLE, demand_emerging BOOLEAN, solo_viability DOUBLE
                {evidence_ddl}
            )
        """)
        n_cols = 20 if with_evidence else 17
        rows = ROWS if with_evidence else [r[:17] for r in ROWS]
        con.executemany(f"INSERT INTO mart_niche VALUES ({', '.join(['?'] * n_cols)})", rows)

        # The LIST endpoint (`GET /api/niches`) SELECTs every _BASE_COLS entry plus every
        # capability-gated column whose probe answers yes; the radar feed only reads the 16
        # above. Pad the rest as typed NULLs (n_recent defaulted — NicheRow requires it) so
        # this fixture also exercises the list endpoint's demand columns, derived from the
        # router's own list to stay in sync. players_coverage rides along because the
        # narrow table already trips _has_players via total_players_now.
        narrow = {
            "dimension", "key", "win", "min_reviews", "n_games", "tier", "opportunity_v2",
            "saturation_yoy", "p90_rev", "total_players_now", "players_trend_7d_pct",
            "reviews_24m", "reviews_prev_24m", "demand_trend_24m_pct",
            "reviews_24m_new_share", "demand_emerging", "solo_viability",
            "self_published_share", "indie_share", "med_playtime_h",
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
        "no_evidence": tmp / "no_evidence_mart.duckdb",
    }
    _build(paths["full"], with_players_monthly=True)
    _build(paths["no_players_monthly"], with_players_monthly=False)
    # The pre-evidence mart: demand24m and everything else present, but the solo-evidence
    # trio absent — the state production is in for hours after the evidence deploy.
    _build(paths["no_evidence"], with_players_monthly=True, with_evidence=False)
    return paths


_GATES = (
    niches._has_demand24m,
    niches._has_p90,
    niches._has_p90_trend,
    niches._has_players,
    niches._has_players_dist,
    niches._has_lifetime,
    niches._has_no_floor_cut,
    niches._has_solo_evidence,
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
    """The full gated-on mart (demand_trend_24m_pct + p90 + players + trend + sparklines)."""
    with _swapped(mart_paths["full"]):
        yield client


@pytest.fixture
def radar_client_no_sparklines(client, mart_paths):
    """Gated-on for demand_trend_24m_pct, but mart_niche_players_monthly doesn't exist —
    proves the sparkline degrade (empty lists, not a 500) is independent of the main gate."""
    with _swapped(mart_paths["no_players_monthly"]):
        yield client


@pytest.fixture
def radar_client_no_evidence(client, mart_paths):
    """Everything gated-on EXCEPT the solo-evidence trio — the mart state production runs
    for hours after the evidence deploy. Rows must carry null, never 500."""
    with _swapped(mart_paths["no_evidence"]):
        yield client


# =========================================================================================
# Gated-off: conftest's shared fixture mart predates demand_trend_24m_pct entirely — the
# state production is genuinely in for hours after every deploy that adds a mart column.
# =========================================================================================


def test_radar_503_on_mart_that_predates_demand_trend(client):
    r = client.get("/api/niches/radar")
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "demand_trend_24m_pct" in detail
    assert "rebuild the marts" in detail


def test_radar_gated_off_does_not_affect_the_niches_list(client):
    # The radar gate must not leak into the general list endpoint's own (unrelated) gate: the
    # shared fixture mart predates v2 scoring entirely (opportunity_v2/tier/etc. are all
    # absent), so the list endpoint's OWN existing 503 ("niche-score v2 columns") fires here
    # — a different message than radar's, proving the two gates are independent.
    r = client.get("/api/niches", params={"dimension": "genre", "window": "all", "min_reviews": 10})
    assert r.status_code == 503
    assert "v2 columns" in r.json()["detail"]


def test_list_demand_sort_503_on_mart_that_predates_demand24m(client):
    # Sorting the LIST by a demand column on a pre-demand mart must hit the explicit gate
    # (same convention as the lifetime/p90 sorts), never a BinderException 500.
    r = client.get("/api/niches", params={"sort": "demand_trend_24m_pct"})
    assert r.status_code == 503
    assert "24-month demand" in r.json()["detail"]


# =========================================================================================
# Gated-on: the full fixture mart.
# =========================================================================================


def test_radar_hero_is_the_biggest_riser(radar_client):
    r = radar_client.get("/api/niches/radar")
    assert r.status_code == 200
    body = r.json()
    hero = body["hero"]
    assert hero["key"] == "Colony Sim"
    assert hero["demand_trend_24m_pct"] == 24.0
    assert hero["n_games"] == 41
    assert hero["tier"] == "micro"
    assert hero["p90_rev"] == 612_000.0
    assert hero["opportunity_v2"] == 87.4
    assert hero["saturation_yoy"] == -0.12
    assert hero["reviews_24m"] == 6200
    assert hero["reviews_prev_24m"] == 5000
    assert hero["demand_emerging"] is False


def test_radar_hero_carries_its_yearly_trend(radar_client):
    r = radar_client.get("/api/niches/radar")
    trend = r.json()["hero"]["trend"]
    assert [t["year"] for t in trend] == [2023, 2024, 2025]
    assert trend[-1]["n_releases"] == 6
    assert trend[-1]["median_rev"] == 220_000.0
    assert trend[-1]["p90_rev"] == 612_000.0


def test_radar_movers_ranked_by_absolute_trend_hero_first(radar_client):
    # limit=5 -> hero + 4 more, out of 6 eligible tag rows (micro/theme, non-null trend,
    # non-emerging): deliberately tight enough to prove the limit truncates the SMALLEST
    # mover, not an arbitrary one — "Souls-like" (|4|) is the weakest move and must be the
    # one dropped.
    r = radar_client.get("/api/niches/radar", params={"limit": 5})
    movers = r.json()["movers"]
    # Hero repeats as movers[0] (mirrors mockup 3a, whose hero niche is also grid card 1),
    # then ranked by |demand_trend_24m_pct| DESC: 24, 18, 16, 11, 9.
    assert [m["key"] for m in movers] == [
        "Colony Sim", "Boomer Shooter", "Deckbuilder", "Fishing", "Base Building",
    ]
    assert [m["demand_trend_24m_pct"] for m in movers] == [24.0, 18.0, -16.0, 11.0, 9.0]
    assert "Souls-like" not in [m["key"] for m in movers]


def test_radar_excludes_null_baseline_niche(radar_client):
    # "No Baseline Tag" has reviews_prev_24m = 0 -> demand_trend_24m_pct NULL. NULL means "no
    # baseline to compare against", not "flat" — it must never surface as a 0%/unchanged mover.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    keys = [m["key"] for m in r.json()["movers"]]
    assert "No Baseline Tag" not in keys


def test_radar_emerging_never_takes_the_hero_or_a_mover_slot(radar_client):
    # "Organizing" carries the single biggest trend of the whole cut (+4850%) — but off a
    # sub-floor prior base with 94% of its reviews from new games (demand_emerging). A young
    # tag's % is a property of the label's age, not of demand: it must not headline the feed
    # or outrank real movers, no matter how large the number is.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    body = r.json()
    assert body["hero"]["key"] == "Colony Sim"
    assert "Organizing" not in [m["key"] for m in body["movers"]]


def test_radar_emerging_group_ranked_by_absolute_volume(radar_client):
    # The emerging group is its own list, ranked by reviews_24m DESC (absolute volume — the
    # only number that means anything there): Organizing (39600) before No Baseline Tag
    # (1000). The raw columns stay served on the cards — including the non-representative
    # trend % (Organizing +4850) and the NULL trend (No Baseline Tag) — the client decides
    # not to headline them; the API never falsifies or hides the data.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    emerging = r.json()["emerging"]
    assert [e["key"] for e in emerging] == ["Organizing", "No Baseline Tag"]
    org = emerging[0]
    assert org["demand_emerging"] is True
    assert org["reviews_24m"] == 39_600
    assert org["reviews_24m_new_share"] == 0.94
    assert org["demand_trend_24m_pct"] == 4850.0  # served raw, never suppressed
    assert emerging[1]["demand_trend_24m_pct"] is None  # NULL baseline stays NULL


def test_radar_excludes_non_buildable_tiers(radar_client):
    # "Open World" (tier=umbrella) has the biggest non-emerging trend (+50%) but must be
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
    assert all(e["sparkline"] == [] for e in body["emerging"])


def test_radar_genre_dimension_no_tier_filter(radar_client):
    # dimension=genre: the tag-tier filter (micro/theme) must not apply — "Roguelike" (tier
    # stamped 'genre' in the real marts) is eligible on its own trend value.
    r = radar_client.get("/api/niches/radar", params={"dimension": "genre", "limit": 6})
    assert r.status_code == 200
    body = r.json()
    assert body["dimension"] == "genre"
    assert body["hero"]["key"] == "Roguelike"
    assert body["hero"]["demand_trend_24m_pct"] == 13.6


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
# The LIST endpoint's demand columns: GET /api/niches carries reviews_24m /
# reviews_prev_24m / demand_trend_24m_pct (+ the emerging pair) when the mart does, so the
# Radar board can ring EVERY blip on its own trend instead of joining the feed's 24 top
# movers — and knows which blips are emerging.
# =========================================================================================


def test_list_niches_carries_demand24m(radar_client):
    r = radar_client.get("/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50})
    assert r.status_code == 200
    rows = {i["key"]: i for i in r.json()["items"]}
    assert rows["Colony Sim"]["demand_trend_24m_pct"] == 24.0
    assert rows["Colony Sim"]["reviews_24m"] == 6200
    assert rows["Colony Sim"]["reviews_prev_24m"] == 5000
    assert rows["Colony Sim"]["demand_emerging"] is False
    # The LIST is the raw surface: an emerging niche's trend stays served here, un-suppressed
    # (the flag rides along so clients can render it honestly) — same rule as the feed cards.
    assert rows["Organizing"]["demand_emerging"] is True
    assert rows["Organizing"]["demand_trend_24m_pct"] == 4850.0
    assert rows["Organizing"]["reviews_24m_new_share"] == 0.94
    # NULL baseline stays NULL on the list — "no baseline to compare against" must not
    # collapse into "flat" (the same rule the mart and the feed already follow).
    assert rows["No Baseline Tag"]["demand_trend_24m_pct"] is None
    assert rows["No Baseline Tag"]["reviews_prev_24m"] == 0


def test_list_niches_sorts_by_demand_trend_nulls_last(radar_client):
    r = radar_client.get(
        "/api/niches",
        params={"dimension": "tag", "window": "24m", "min_reviews": 50, "sort": "demand_trend_24m_pct"},
    )
    assert r.status_code == 200
    keys = [i["key"] for i in r.json()["items"]]
    # Default tiers=micro,theme excludes the umbrella "Open World" (+50) — the biggest
    # non-emerging trend must not smuggle a container tag in. The LIST does NOT filter
    # emerging rows ("Organizing" +4850 sorts first — it is the raw surface; presentation
    # honesty is the feed's and the client's job) and does NOT apply the radar's solo rule
    # (team-scale "Extraction Shooter" and unknown "Co-op Heist" ride along unless
    # solo_only=1 is asked for). NULL trend sorts last, not as 0 (n_games DESC tiebreak:
    # No Baseline Tag 60 before MMO Sandbox 25).
    assert keys == [
        "Organizing", "Extraction Shooter", "Colony Sim", "Co-op Heist", "Boomer Shooter",
        "Fishing", "Base Building", "Souls-like", "Deckbuilder",
        "No Baseline Tag", "MMO Sandbox",
    ]


# =========================================================================================
# solo_only — the radar's population rule (solo_viability >= RADAR_SOLO_FRIENDLY_MIN,
# NULL = unknown = excluded). Default ON for the feed (the radar page is solo-first),
# explicit OPT-IN for the shared LIST (NicheFinder and other non-radar consumers must see
# the unfiltered population).
# =========================================================================================


def test_solo_threshold_locksteps_with_the_web_constant():
    # 0.8 is duplicated by design (server filters, web renders the same bar in the board
    # legend / dossier — see the comments on both constants). Pin the server side so a
    # retune can't silently detach it from web/src/lib/radarVerdict.ts's SOLO_FRIENDLY_MIN.
    assert niches.RADAR_SOLO_FRIENDLY_MIN == 0.8


def test_radar_defaults_to_solo_only(radar_client):
    # Default solo_only=1: "Extraction Shooter" (solo 0.35) is the cut's biggest riser at
    # +33% but is team-scale — the hero must stay Colony Sim and no team/unknown row may
    # take a mover slot. The emerging group obeys the same rule: team-scale "MMO Sandbox"
    # (50,000 reviews — the biggest emerging volume) must not appear.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    assert r.status_code == 200
    body = r.json()
    assert body["hero"]["key"] == "Colony Sim"
    keys = [m["key"] for m in body["movers"]]
    assert "Extraction Shooter" not in keys
    assert "Co-op Heist" not in keys
    assert [e["key"] for e in body["emerging"]] == ["Organizing", "No Baseline Tag"]


def test_radar_null_solo_viability_is_excluded_by_default(radar_client):
    # NULL = unknown, and unknown is NOT solo-friendly: the radar population is an explicit
    # positive claim ("you could build this solo"), so "Co-op Heist" (trend +20, solo NULL)
    # is excluded rather than given the benefit of the doubt.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    assert "Co-op Heist" not in [m["key"] for m in r.json()["movers"]]


def test_radar_solo_only_off_reveals_the_full_population(radar_client):
    r = radar_client.get("/api/niches/radar", params={"limit": 24, "solo_only": "false"})
    assert r.status_code == 200
    body = r.json()
    # +33% now outranks Colony Sim's +24% — the team-scale riser takes the hero slot.
    assert body["hero"]["key"] == "Extraction Shooter"
    assert "Co-op Heist" in [m["key"] for m in body["movers"]]
    # Emerging re-ranks on raw volume with the team-scale row back in: 50,000 > 39,600 > 1,000.
    assert [e["key"] for e in body["emerging"]] == ["MMO Sandbox", "Organizing", "No Baseline Tag"]


def test_radar_cards_carry_solo_viability(radar_client):
    # The population rule's input is served on every card (hero/movers/emerging) so the
    # client can show the score that gated the population — including under solo_only=0,
    # where the web re-draws team-scale dots hollow from this exact field.
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    body = r.json()
    assert body["hero"]["solo_viability"] == 0.97
    movers = {m["key"]: m for m in body["movers"]}
    assert movers["Deckbuilder"]["solo_viability"] == 0.95
    assert {e["key"]: e for e in body["emerging"]}["Organizing"]["solo_viability"] == 0.94


def test_list_niches_is_unfiltered_by_default(radar_client):
    # The LIST is a shared surface (NicheFinder, exports): the radar's population rule must
    # never leak into it globally — team-scale and unknown rows stay unless asked away.
    r = radar_client.get(
        "/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50}
    )
    assert r.status_code == 200
    keys = {i["key"] for i in r.json()["items"]}
    assert {"Extraction Shooter", "Co-op Heist", "MMO Sandbox"} <= keys


def test_list_niches_solo_only_filters_and_excludes_null(radar_client):
    r = radar_client.get(
        "/api/niches",
        params={"dimension": "tag", "window": "24m", "min_reviews": 50, "solo_only": "true"},
    )
    assert r.status_code == 200
    body = r.json()
    keys = {i["key"] for i in body["items"]}
    assert "Extraction Shooter" not in keys  # 0.35 — team-scale
    assert "MMO Sandbox" not in keys  # 0.2 — team-scale (emerging gets no exemption)
    assert "Co-op Heist" not in keys  # NULL — unknown is not solo-friendly
    assert {"Colony Sim", "Boomer Shooter", "Fishing", "Souls-like", "Base Building",
            "Deckbuilder", "No Baseline Tag", "Organizing"} == keys
    # COUNT respects the filter too — paging totals must not promise rows the filter drops.
    assert body["total"] == len(body["items"]) == 8


# =========================================================================================
# Solo-evidence trio (self_published_share / indie_share / med_playtime_h): the member
# profile behind solo_viability (the SINGLEPLAYER SHARE — a no-netcode proxy, not a
# production-scope measure). Served on the LIST rows the board reads and on every radar
# card; column-existence gated so a pre-evidence mart degrades to null rows, never a 500.
# =========================================================================================


def test_list_niches_carries_solo_evidence(radar_client):
    r = radar_client.get("/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50})
    assert r.status_code == 200
    rows = {i["key"]: i for i in r.json()["items"]}
    # The user's motivating profile: Souls-like's 0.85 singleplayer share sits on top of a
    # 50% self-published / 71% indie / median-5.7h member population.
    souls = rows["Souls-like"]
    assert souls["self_published_share"] == 0.5
    assert souls["indie_share"] == 0.71
    assert souls["med_playtime_h"] == 5.7
    # NULL evidence rows pass through as null, never 0 — "unknown" is not a claim.
    heist = rows["Co-op Heist"]
    assert heist["self_published_share"] is None
    assert heist["indie_share"] is None
    assert heist["med_playtime_h"] is None


def test_radar_cards_carry_solo_evidence(radar_client):
    r = radar_client.get("/api/niches/radar", params={"limit": 24})
    body = r.json()
    # Hero (Colony Sim) — including a med_playtime_h above the web's 20h heavy-content bar.
    assert body["hero"]["self_published_share"] == 0.61
    assert body["hero"]["indie_share"] == 0.83
    assert body["hero"]["med_playtime_h"] == 24.3
    movers = {m["key"]: m for m in body["movers"]}
    assert movers["Souls-like"]["med_playtime_h"] == 5.7
    emerging = {e["key"]: e for e in body["emerging"]}
    assert emerging["Organizing"]["self_published_share"] == 0.63


def test_solo_evidence_degrades_to_null_on_pre_evidence_mart(radar_client_no_evidence):
    # The mart on the server predates the evidence columns for hours after the deploy that
    # adds them: every surface answers 200 with the fields present-but-null (the UI omits
    # the evidence line), never a BinderException 500.
    r = radar_client_no_evidence.get(
        "/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50}
    )
    assert r.status_code == 200
    for row in r.json()["items"]:
        assert row["self_published_share"] is None
        assert row["indie_share"] is None
        assert row["med_playtime_h"] is None

    r = radar_client_no_evidence.get("/api/niches/radar", params={"limit": 6})
    assert r.status_code == 200
    body = r.json()
    assert body["hero"]["key"] == "Colony Sim"  # the feed itself is unaffected
    assert body["hero"]["med_playtime_h"] is None
    assert all(m["self_published_share"] is None for m in body["movers"])
