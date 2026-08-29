"""GET /api/niches — the 24-month demand columns, the solo lens and the solo-evidence
trio, in BOTH mart states.

(Was test_niches_radar.py, which covered the removed GET /api/niches/radar feed. The feed
is gone — the web board reads the LIST and computes movers client-side, and the MCP never
called the API at all — but everything below tests the LIST surface that outlived it, so
the module and its hand-checkable fixture are kept.)

demand_trend_24m_pct / reviews_24m / reviews_prev_24m REPLACED the 12-month demand columns
(2026-08-26: the radar's pinned membership cut is 24m x min50, so the whole surface speaks
24 months), which had replaced the original 90-day ones. The API ships before the nightly
rebuild that materialises them, so production runs the OLD mart FIRST, for hours:

  gated-off  conftest's shared fixture mart already predates these columns (it predates the
             whole v2/players/lifetime family), so it stands in for that state with zero setup
             — the same state a fresh deploy genuinely sees first.
  gated-on   a purpose-built DuckDB carrying demand_trend_24m_pct + everything else the list
             reads (p90_rev, players columns, the solo-evidence trio), swapped in per-test
             like test_niches_games_mart.py / test_games_aspect_reviews.py.

Numbers are hand-picked so ranking, null-baseline handling, tier exclusion and the solo
population rule are all checkable on paper — see the comments on ROWS below.
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
# All rows share (win='24m', min_reviews=50) — NicheFinder's default cut. Ranked by
# demand_trend_24m_pct DESC among NON-emerging rows, "Colony Sim" (+24%) is the biggest
# solo-friendly riser.
# Non-emerging rows keep reviews_prev_24m >= 1000 and new_share < 0.8 so the explicit
# demand_emerging=FALSE stamped here is consistent with the mart's own two-tell rule
# (etl/tests/test_mart_niche_game.py replays that rule against the real SQL).
# "No Baseline Tag" has reviews_prev_24m = 0 -> demand_trend_24m_pct NULL in real ETL output
# (see mart_niche.sql) AND demand_emerging TRUE (tell 1: no comparable base); the list must
# serve that NULL as NULL, never collapse it to 0/"unchanged".
# "Organizing" is the young-tag shape: the single biggest trend of ALL (+4850%) off a
# sub-floor base with 94% of its reviews from new games — demand_emerging TRUE. The LIST is
# the raw surface: it serves that trend un-suppressed, with the flag alongside, and leaves
# the presentation call to the client.
# "Open World" is tier='umbrella' with a +50% trend — excluded by the default micro,theme
# tier filter (containers are not buildable niches). "Roguelike" is dimension='genre'.
#
# SOLO POPULATION RULE (solo_only — see niches.py's RADAR_SOLO_FRIENDLY_MIN): every original
# row is solo-friendly (>= 0.8). Three rows exist to be EXCLUDED by it:
#   "Extraction Shooter"  solo 0.35 (team-scale) — the cut's biggest riser (+33%), so its
#                         presence/absence is unmissable.
#   "Co-op Heist"         solo NULL — unknown is NOT solo-friendly (the solo population is
#                         an explicit positive claim), so NULL is excluded, not passed.
#   "MMO Sandbox"         solo 0.2 AND demand_emerging — proves the rule reaches emerging
#                         rows too.
# Solo-evidence values: "Souls-like" carries the user's real motivating profile (0.85
# singleplayer here, 50% self-pub, 71% indie, median 5.7h); "Co-op Heist" carries NULL
# evidence — an evidence-bearing mart may still hold NULL rows (an all-NULL-input cut) and
# they must pass through as null, never 0.
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


def _build(path: Path, *, with_evidence: bool = True) -> None:
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

        # The LIST endpoint SELECTs every _BASE_COLS entry plus every capability-gated column
        # whose probe answers yes; the rows above only spell out the ones under test. Pad the
        # rest as typed NULLs (n_recent defaulted — NicheRow requires it), derived from the
        # router's own list to stay in sync. players_coverage rides along because the narrow
        # table already trips _has_players via total_players_now.
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

        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.execute(
            "INSERT INTO mart_meta VALUES ('mart_version', ?), ('built_at', '2026-01-01T00:00:00+00:00')",
            ["demand24m-fixture-" + ("with-evidence" if with_evidence else "no-evidence")],
        )
    finally:
        con.close()  # must be closed before analytics_db opens it read_only


@pytest.fixture(scope="module")
def mart_paths() -> dict[str, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="prospect_niche_demand_tests_"))
    paths = {
        "full": tmp / "full_mart.duckdb",
        "no_evidence": tmp / "no_evidence_mart.duckdb",
    }
    _build(paths["full"])
    # The pre-evidence mart: demand24m and everything else present, but the solo-evidence
    # trio absent — the state production is in for hours after the evidence deploy.
    _build(paths["no_evidence"], with_evidence=False)
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
def demand_client(client, mart_paths):
    """The full gated-on mart (demand_trend_24m_pct + p90 + players + solo evidence)."""
    with _swapped(mart_paths["full"]):
        yield client


@pytest.fixture
def demand_client_no_evidence(client, mart_paths):
    """Everything gated-on EXCEPT the solo-evidence trio — the mart state production runs
    for hours after the evidence deploy. Rows must carry null, never 500."""
    with _swapped(mart_paths["no_evidence"]):
        yield client


# =========================================================================================
# Gated-off: conftest's shared fixture mart predates demand_trend_24m_pct entirely — the
# state production is genuinely in for hours after every deploy that adds a mart column.
# =========================================================================================


def test_list_demand_sort_503_on_mart_that_predates_demand24m(client):
    # Sorting the LIST by a demand column on a pre-demand mart must hit the explicit gate
    # (same convention as the lifetime/p90 sorts), never a BinderException 500.
    r = client.get("/api/niches", params={"sort": "demand_trend_24m_pct"})
    assert r.status_code == 503
    assert "24-month demand" in r.json()["detail"]


def test_radar_feed_endpoint_is_gone(client):
    """Removed 2026-08-28: the web board computes movers from the LIST client-side and the
    MCP reads DuckDB directly (it has no HTTP client at all), so nothing called it.

    With the route gone, `/api/niches/radar` falls to the `/{dimension}/{key:path}`
    catch-all (via Starlette's trailing-slash redirect, as dimension='radar', key='') and
    is rejected by _require_dimension — a 422 naming the real problem, not a feed. That is
    the honest answer for a retired path under a catch-all; what matters is that it never
    reaches the mart and never returns a radar payload."""
    r = client.get("/api/niches/radar", follow_redirects=True)
    assert r.status_code == 422
    assert r.json()["detail"] == "dimension must be tag or genre"


def test_list_v2_gate_is_its_own_503(client):
    # The shared fixture mart predates v2 scoring entirely (opportunity_v2/tier/etc. absent),
    # so the list endpoint's OWN 503 fires — a different message than the demand gate's,
    # proving the two are independent.
    r = client.get("/api/niches", params={"dimension": "genre", "window": "all", "min_reviews": 10})
    assert r.status_code == 503
    assert "v2 columns" in r.json()["detail"]


# =========================================================================================
# Gated-on: the 24-month demand columns on every list row.
# =========================================================================================


def test_list_niches_carries_demand24m(demand_client):
    r = demand_client.get("/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50})
    assert r.status_code == 200
    rows = {i["key"]: i for i in r.json()["items"]}
    assert rows["Colony Sim"]["demand_trend_24m_pct"] == 24.0
    assert rows["Colony Sim"]["reviews_24m"] == 6200
    assert rows["Colony Sim"]["reviews_prev_24m"] == 5000
    assert rows["Colony Sim"]["demand_emerging"] is False
    # The LIST is the raw surface: an emerging niche's trend stays served here, un-suppressed
    # (the flag rides along so clients can render it honestly).
    assert rows["Organizing"]["demand_emerging"] is True
    assert rows["Organizing"]["demand_trend_24m_pct"] == 4850.0
    assert rows["Organizing"]["reviews_24m_new_share"] == 0.94
    # NULL baseline stays NULL on the list — "no baseline to compare against" must not
    # collapse into "flat" (the same rule the mart already follows).
    assert rows["No Baseline Tag"]["demand_trend_24m_pct"] is None
    assert rows["No Baseline Tag"]["reviews_prev_24m"] == 0


def test_list_niches_sorts_by_demand_trend_nulls_last(demand_client):
    r = demand_client.get(
        "/api/niches",
        params={"dimension": "tag", "window": "24m", "min_reviews": 50, "sort": "demand_trend_24m_pct"},
    )
    assert r.status_code == 200
    keys = [i["key"] for i in r.json()["items"]]
    # Default tiers=micro,theme excludes the umbrella "Open World" (+50) — the biggest
    # non-emerging trend must not smuggle a container tag in. The LIST does NOT filter
    # emerging rows ("Organizing" +4850 sorts first — it is the raw surface; presentation
    # honesty is the client's job) and does NOT apply the solo rule (team-scale "Extraction
    # Shooter" and unknown "Co-op Heist" ride along unless solo_only=1 is asked for). NULL
    # trend sorts last, not as 0 (n_games DESC tiebreak: No Baseline Tag 60 before MMO
    # Sandbox 25).
    assert keys == [
        "Organizing", "Extraction Shooter", "Colony Sim", "Co-op Heist", "Boomer Shooter",
        "Fishing", "Base Building", "Souls-like", "Deckbuilder",
        "No Baseline Tag", "MMO Sandbox",
    ]


def test_list_niches_genre_dimension_has_no_tier_filter(demand_client):
    r = demand_client.get(
        "/api/niches", params={"dimension": "genre", "window": "24m", "min_reviews": 50}
    )
    assert r.status_code == 200
    assert [i["key"] for i in r.json()["items"]] == ["Roguelike"]


# =========================================================================================
# solo_only — solo_viability >= RADAR_SOLO_FRIENDLY_MIN, NULL = unknown = excluded. An
# explicit OPT-IN on the shared LIST (NicheFinder and other consumers must see the
# unfiltered population by default).
# =========================================================================================


def test_solo_threshold_locksteps_with_the_web_constant():
    # 0.8 is duplicated by design (server filters, web renders the same bar in the board
    # legend / dossier — see the comments on both constants). Pin the server side so a
    # retune can't silently detach it from web/src/lib/radarVerdict.ts's SOLO_FRIENDLY_MIN.
    assert niches.RADAR_SOLO_FRIENDLY_MIN == 0.8


def test_list_niches_is_unfiltered_by_default(demand_client):
    # The LIST is a shared surface (NicheFinder, exports): the solo population rule must
    # never leak into it globally — team-scale and unknown rows stay unless asked away.
    r = demand_client.get(
        "/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50}
    )
    assert r.status_code == 200
    keys = {i["key"] for i in r.json()["items"]}
    assert {"Extraction Shooter", "Co-op Heist", "MMO Sandbox"} <= keys


def test_list_niches_solo_only_filters_and_excludes_null(demand_client):
    r = demand_client.get(
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


def test_list_rows_carry_solo_viability(demand_client):
    r = demand_client.get(
        "/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50}
    )
    rows = {i["key"]: i for i in r.json()["items"]}
    assert rows["Colony Sim"]["solo_viability"] == 0.97
    assert rows["Co-op Heist"]["solo_viability"] is None  # unknown stays unknown


# =========================================================================================
# Solo-evidence trio (self_published_share / indie_share / med_playtime_h): the member
# profile behind solo_viability (the SINGLEPLAYER SHARE — a no-netcode proxy, not a
# production-scope measure). Column-existence gated, so a pre-evidence mart degrades to
# null rows, never a 500.
# =========================================================================================


def test_list_niches_carries_solo_evidence(demand_client):
    r = demand_client.get("/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50})
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


def test_solo_evidence_degrades_to_null_on_pre_evidence_mart(demand_client_no_evidence):
    # The mart on the server predates the evidence columns for hours after the deploy that
    # adds them: the list answers 200 with the fields present-but-null (the UI omits the
    # evidence line), never a BinderException 500.
    r = demand_client_no_evidence.get(
        "/api/niches", params={"dimension": "tag", "window": "24m", "min_reviews": 50}
    )
    assert r.status_code == 200
    for row in r.json()["items"]:
        assert row["self_published_share"] is None
        assert row["indie_share"] is None
        assert row["med_playtime_h"] is None
