"""Solo/indie evidence on mart_niche — the real mart_niche_indie.sql over synthetic inputs.

The owner's ask (2026-09-24): "we need solo/indie friendly niches on the radar". The old lens
(solo_viability >= 0.8, i.e. "can the games be PLAYED alone") passed 323 of 334 niches. This
pins the replacement: a niche is indie-friendly when small indie teams demonstrably succeed in
it — enough of its $100K+ paid games come from an is_indie game whose developer has <= 3
games on Steam — and it is still single-player.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

HIT = 250_000.0      # comfortably over INDIE_HIT_MIN_REV
MISS = 20_000.0      # under it


def _build(niches: dict[str, dict]) -> duckdb.DuckDBPyConnection:
    """niches: key -> {"solo": singleplayer share, "games": [(rev, is_indie, dev_n_games|None)]}.
    dev_n_games None = a developer mart_entity doesn't know."""
    con = duckdb.connect(":memory:")
    con.execute("CREATE TABLE mart_niche(dimension VARCHAR, key VARCHAR, win VARCHAR,"
                " min_reviews INTEGER, solo_viability DOUBLE)")
    con.execute("CREATE TABLE mart_niche_game(dimension VARCHAR, key VARCHAR, win VARCHAR,"
                " min_reviews INTEGER, appid INTEGER)")
    con.execute("CREATE TABLE mart_game(appid INTEGER, est_rev_reviews DOUBLE, is_indie INTEGER)")
    con.execute("CREATE TABLE mart_entity(role VARCHAR, name VARCHAR, n_games INTEGER)")
    con.execute("CREATE TABLE mart_entity_games(role VARCHAR, name VARCHAR, appid INTEGER)")
    appid = 0
    for key, spec in niches.items():
        con.execute("INSERT INTO mart_niche VALUES ('tag', ?, '24m', 50, ?)", [key, spec["solo"]])
        for rev, indie, dev_n in spec["games"]:
            appid += 1
            con.execute("INSERT INTO mart_niche_game VALUES ('tag', ?, '24m', 50, ?)", [key, appid])
            con.execute("INSERT INTO mart_game VALUES (?, ?, ?)", [appid, rev, indie])
            if dev_n is not None:
                dev = f"Dev {appid}"
                con.execute("INSERT INTO mart_entity VALUES ('developer', ?, ?)", [dev, dev_n])
                con.execute("INSERT INTO mart_entity_games VALUES ('developer', ?, ?)", [dev, appid])
    con.execute(bm.render((ETL / "marts" / "mart_niche_indie.sql").read_text(), bm.build_params()))
    return con


def _row(con, key):
    return con.execute(
        "SELECT n_hits_100k, n_small_indie_hits, small_indie_hit_share, indie_friendly "
        "FROM mart_niche WHERE key = ?", [key]).fetchone()


@pytest.fixture(scope="module")
def con():
    small, studio = (HIT, 1, 2), (HIT, 0, 40)
    c = _build({
        # 6 of 10 hits from small indies, single-player: the lens keeps it.
        "Indie Niche": {"solo": 0.95, "games": [small] * 6 + [studio] * 4 + [(MISS, 1, 1)] * 5},
        # 3 of 10: studio-dominated (Action RTS read 13 of 44).
        "Studio Niche": {"solo": 0.98, "games": [small] * 3 + [studio] * 7},
        # 4 of 4 small-indie hits is a great share but not enough evidence (>= 5 needed).
        "Thin Niche": {"solo": 1.0, "games": [small] * 4 + [(MISS, 1, 1)] * 20},
        # Indie hits galore, but multiplayer-dependent: out.
        "Multiplayer Niche": {"solo": 0.5, "games": [small] * 8 + [studio] * 2},
        # Free games (NULL revenue) are never hits; an indie game by a big developer isn't
        # "small"; a hit whose developer is unknown counts as a hit, not a small-indie one.
        "Edge Niche": {"solo": 0.9, "games": [small] * 5 + [(None, 1, 1)] * 10
                       + [(HIT, 1, 12)] * 2 + [(HIT, 1, None)] * 3},
        # No hit at all: share is NULL, the verdict is a plain FALSE.
        "No Hits": {"solo": 1.0, "games": [(MISS, 1, 1)] * 30},
    })
    yield c
    c.close()


def test_small_indie_success_in_a_singleplayer_niche_is_indie_friendly(con):
    assert _row(con, "Indie Niche") == (10, 6, pytest.approx(0.6), True)


def test_a_studio_dominated_niche_is_not(con):
    assert _row(con, "Studio Niche") == (10, 3, pytest.approx(0.3), False)


def test_the_evidence_floor_and_the_singleplayer_bar_both_hold(con):
    assert _row(con, "Thin Niche") == (4, 4, pytest.approx(1.0), False)
    assert _row(con, "Multiplayer Niche")[3] is False


def test_free_games_big_developers_and_unknown_developers(con):
    # 5 small + 2 big-dev indie + 3 unknown-dev = 10 hits; the 10 free games are not hits.
    assert _row(con, "Edge Niche") == (10, 5, pytest.approx(0.5), True)


def test_no_hits_means_no_share_and_a_plain_false(con):
    assert _row(con, "No Hits") == (0, 0, None, False)


def test_constants_are_in_the_build_params():
    params = bm.build_params()
    for k in ("INDIE_HIT_MIN_REV", "SMALL_DEV_MAX_GAMES", "INDIE_FRIENDLY_MIN_SHARE",
              "INDIE_FRIENDLY_MIN_HITS", "INDIE_SINGLEPLAYER_MIN"):
        assert k in params
    assert bm.INDIE_SINGLEPLAYER_MIN == bm.SOLO_TIER_TEAM_MAX
