"""GET /api/niches/export.csv — capability gates + the plain-Response contract, plus the
list surface's solo_only filter, against a mart that DOES carry the v2 score columns.

conftest's shared fixture mart predates the whole v2 family (every list/export request
against it 503s inside _niche_query), so this module builds its own tiny DuckDB carrying
exactly _BASE_COLS — no players/lifetime/p90/demand24m extras, so the per-family gates
have something real to refuse — and swaps analytics_db onto it per test, the same pattern
as test_niches_games_mart.py.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import duckdb
import pytest

from app import analytics_db
from app.config import settings
from app.routers import niches

# Every _BASE_COLS column, in order (the CREATE TABLE below zips against this).
_COLS = niches._BASE_COLS

_DEFAULTS = {
    "win": "24m", "min_reviews": 50, "n_games": 10, "n_recent": 3,
    "median_rev": 50_000.0, "p25_rev": 10_000.0, "p75_rev": 200_000.0,
    "median_reviews": 300.0, "median_price": 14.99, "median_positive_ratio": 0.85,
    "median_owners": 20_000.0, "total_owners": 500_000.0, "total_rev": 2_000_000.0,
    "total_reviews": 40_000, "market_size": 1_000_000.0, "recent_velocity": 100.0,
    "self_pub_share": 0.7, "winner_concentration": 0.5, "hit_rate_200k": 0.2,
    "hit_rate_500k": 0.1, "beatable_share": 0.4, "saturation_yoy": 0.1,
    "n_recent_year": 5, "n_prior_year": 4, "demand": 60.0, "competition": 30.0,
    "quality_gap": 20.0, "opportunity": 55.0, "decline_gate": 1.0, "entrant_ratio": 1.1,
}


def _row(key: str, tier: str, opportunity_v2: float, solo_viability: float | None) -> tuple:
    values = {
        **_DEFAULTS,
        "dimension": "tag",
        "key": key,
        "tier": tier,
        "opportunity_v2": opportunity_v2,
        "solo_viability": solo_viability,
    }
    return tuple(values[c] for c in _COLS)


# opportunity_v2 picks the CSV row order; solo_viability exercises the solo_only filter
# (>= 0.8 in, < 0.8 out, NULL = unknown = out); the umbrella tier is out by default.
ROWS = [
    _row("Deckbuilder", "micro", 80.0, 0.95),
    _row("Farming", "theme", 60.0, 0.5),
    _row("Open World", "umbrella", 90.0, 0.9),
]


def _build(path: Path) -> None:
    con = duckdb.connect(str(path))
    try:
        decls = []
        for c in _COLS:
            if c in ("dimension", "key", "win", "tier"):
                decls.append(f'"{c}" VARCHAR')
            elif c in ("min_reviews", "n_games", "n_recent", "total_reviews",
                       "n_recent_year", "n_prior_year"):
                decls.append(f'"{c}" INTEGER')
            else:
                decls.append(f'"{c}" DOUBLE')
        con.execute(f"CREATE TABLE mart_niche ({', '.join(decls)})")
        con.executemany(
            f"INSERT INTO mart_niche VALUES ({', '.join(['?'] * len(_COLS))})", ROWS
        )
        con.execute("CREATE TABLE mart_meta (key VARCHAR, value VARCHAR)")
        con.execute(
            "INSERT INTO mart_meta VALUES ('mart_version', 'niche-export-fixture'), "
            "('built_at', '2026-01-01T00:00:00+00:00')"
        )
    finally:
        con.close()  # must be closed before analytics_db opens it read_only


_PROBES = (
    niches._has_players, niches._has_players_dist, niches._has_lifetime,
    niches._has_no_floor_cut, niches._has_p90, niches._has_p90_trend,
    niches._has_demand24m, niches._has_solo_evidence, niches._has_niche_games,
    niches._niche_game_cuts,
)


def _clear_probes() -> None:
    for probe in _PROBES:
        probe.cache_clear()


@pytest.fixture(scope="module")
def export_client(client):
    """Swap analytics_db onto the v2 mart, then put the shared fixture mart back. Depends
    on `client` so the app's lifespan has already run its own analytics_db.init()."""
    tmp = Path(tempfile.mkdtemp(prefix="prospect_niche_export_"))
    db = tmp / "niche_export.duckdb"
    _build(db)

    analytics_db.close()
    analytics_db.init(str(db), 2)
    _clear_probes()
    try:
        yield client
    finally:
        analytics_db.close()
        analytics_db.init(settings.analytics_db_path, settings.analytics_pool_size)
        _clear_probes()


# ---- the export itself ------------------------------------------------------------------
def test_export_is_a_plain_csv_response(export_client):
    r = export_client.get("/api/niches/export.csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"] == 'attachment; filename="niches_tag_24m_mr50.csv"'
    # Plain Response (not a streamed one-element iterator): an exact Content-Length.
    assert int(r.headers["content-length"]) == len(r.content)

    lines = r.text.strip().splitlines()
    assert lines[0].startswith("dimension,key,window,min_reviews")  # win -> window rename
    keys = [line.split(",")[1] for line in lines[1:]]
    # opportunity_v2 desc; the umbrella tier is excluded by the default micro,theme filter.
    assert keys == ["Deckbuilder", "Farming"]


def test_export_gates_match_the_list_surface(export_client):
    """The export must refuse a gated sort with the SAME specific 503 the list gives —
    before this fix it skipped the gates and fell through to _niche_query's misleading
    v2-columns 503 (or worse, a BinderException)."""
    cases = {
        "total_players_now": "live-player columns",
        "median_players_now": "players-distribution columns",
        "lifetime_survival_12m": "lifetime columns",
        "p90_rev": "p90_rev column",
        "demand_trend_24m_pct": "24-month demand columns",
    }
    for sort, hint in cases.items():
        for path in ("/api/niches/export.csv", "/api/niches"):
            r = export_client.get(path, params={"sort": sort})
            assert r.status_code == 503, (path, sort)
            assert hint in r.json()["detail"], (path, sort)


def test_export_no_floor_cut_gate(export_client):
    r = export_client.get("/api/niches/export.csv", params={"min_reviews": 0})
    assert r.status_code == 503
    assert "no-floor" in r.json()["detail"]


def test_export_rejects_unknown_sort(export_client):
    r = export_client.get("/api/niches/export.csv", params={"sort": "evil; DROP TABLE--"})
    assert r.status_code == 400


# ---- solo_only on the list (coverage that used to live in test_niches_radar.py) ---------
def test_list_is_unfiltered_by_default_and_solo_only_filters(export_client):
    tiers_all = {"tiers": ""}  # empty = all tiers, so the umbrella row is visible too
    r = export_client.get("/api/niches", params=tiers_all)
    assert {i["key"] for i in r.json()["items"]} == {"Deckbuilder", "Farming", "Open World"}

    r = export_client.get("/api/niches", params={**tiers_all, "solo_only": 1})
    # >= 0.8 stays; 0.5 is out. (All fixture rows carry a real solo_viability, so the
    # NULL-is-excluded contract is asserted at the SQL-semantics level by _apply_solo_only.)
    assert {i["key"] for i in r.json()["items"]} == {"Deckbuilder", "Open World"}
