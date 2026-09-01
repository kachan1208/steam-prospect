"""opportunity_v2 must RANK THE SAME WAY the Radar rings — enforced, not remembered.

Until 2026-08-31 it ranked the opposite way. Measured on 219 live production niches
(tag / win=24m / min_reviews=50 — the cut the Radar board, MCP find_niches and NicheFinder
all default to), median opportunity_v2 by the Radar's own ring was:

    enter 17.6  |  hold 17.8  |  crowded 20.9  |  declining 23.4

The niches the board told you to ENTER scored LOWER than the ones it warned you off, and
corr(opportunity_v2, demand_trend_24m_pct) was -0.047 — the headline score had no
relationship at all to the axis the board grades on. The rebuild (see mart_niche.sql's
"opportunity_v2 REBUILT" header) turned that into 67.6 / 50.2 / 39.1 / 19.5.

This file exists so it cannot silently invert again. It pins four things:

  1. ORDERING          median(enter) > median(hold) > median(crowded) > median(declining),
                       with the ring computed by a port of web/src/lib/radarVerdict.ts.
  2. FORMULA           opportunity_v2 recomputed INDEPENDENTLY in Python from the mart's own
                       published columns must equal the published score. The SQL and this
                       file are two implementations of one documented formula; if either
                       drifts, this fails. It is also what makes the offline calibration
                       runs trustworthy — they used exactly this arithmetic.
  3. ANCHOR EQUIVALENCE  the sub-score anchors ARE the Radar's ring thresholds:
                       momentum >= 88.08 <=> demand_trend >= DEMAND_ENTER_PCT (+40%/24m)
                       momentum <= 10.72 <=> demand_trend <= DEMAND_DECLINE_PCT (-30%/24m)
                       revenue_spread < 50 <=> winner_concentration > WC_WINNER_TAKE_MOST
                       That equivalence is the whole claim that the ring and the number are
                       two views of ONE model rather than two models that disagree.
  4. NULL-HONESTY      an emerging niche (no comparable demand base) gets NULL momentum and
                       NULL supply_room — never 0 — and is still scored, on the sub-scores
                       it does have, via the renormalising blend.
  5. THE SUPPLY SPLIT  the ring and the score read SUPPLY as two different questions, on
                       purpose, and this pins each to its own reading:
                         flood_room < 50 <=> supply_growth - demand_growth > ln(1.15)
                         the ring's veto <=> supply_growth > ln(1.15)   (no demand term)
                       Point 3 only ever asserted the two CONSTANTS are equal
                       (OPP_FLOOD_YOY == SAT_FLOOD_YOY) — never that the two READINGS
                       agree, which is how a real 28.0% divergence (59 of 211 comparable
                       niches on the default cut) went undocumented long enough to be
                       published on /docs as "the board and the score can't disagree".
                       The divergence is CORRECT and stays: absolute is right for a ring
                       (an entrant ships into the whole pipeline) and relative is right for
                       a score (it is what stops a niche everyone abandoned from reading as
                       open). Both alternatives were re-measured and rejected — swapping
                       the ring moves 28/222 rings, swapping the score moves 149/222
                       scores. What this test forbids is a THIRD reading arriving quietly.

Runs on a synthetic staging layer in an in-memory DuckDB and renders the REAL mart_niche.sql
through build_marts.render()/build_params(), so it fails on the file that actually ships.
No source database and no network needed.
"""
from __future__ import annotations

import math
import statistics
import sys
from datetime import date, timedelta
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import duckdb  # noqa: E402
import build_marts as bm  # noqa: E402

TODAY = date.today()
CUR_YEAR = TODAY.year

# ---------------------------------------------------------------------------------------
# The ring rules, ported from web/src/lib/radarVerdict.ts (radarVerdictTrace's decision
# chain). Kept as a straight transcription — the TS side has its own unit tests; this port
# exists so the ETL can assert the score against the same verdicts the board renders.
# `hold` here is radarVerdict's `watch` reached through a DEMAND arm (holding / softening /
# surging-but-flooding); its caution arms would be `watch`, which the fixture never hits.
# ---------------------------------------------------------------------------------------
DEMAND_ENTER_PCT = 40.0
DEMAND_DECLINE_PCT = -30.0
DEMAND_HOLD_PCT = -10.0
SAT_FLOOD_YOY = 0.15
WC_WINNER_TAKE_MOST = 0.85


def radar_ring(trend, sat, wc, emerging) -> str:
    if emerging:
        return "emerging"
    demand_enter = trend is not None and trend >= DEMAND_ENTER_PCT
    demand_decline = trend is not None and trend <= DEMAND_DECLINE_PCT
    demand_holding = trend is not None and trend >= DEMAND_HOLD_PCT
    supply_calm = sat is None or sat <= SAT_FLOOD_YOY
    flooding = sat is not None and sat > SAT_FLOOD_YOY
    winner_take_most = wc is not None and wc > WC_WINNER_TAKE_MOST
    if demand_enter and supply_calm:
        return "enter"
    if demand_decline:
        return "declining"
    if winner_take_most:
        return "crowded"
    if flooding and (trend is None or trend <= 0):
        return "crowded"
    if demand_enter or demand_holding or trend is not None:
        return "hold"
    return "watch"


# ---------------------------------------------------------------------------------------
# The score, reimplemented from mart_niche.sql's documented formula. Deliberately written
# from the DOC, not transliterated from the SQL, so it is a real second opinion.
# ---------------------------------------------------------------------------------------
def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def annualised_growths(trend, sat, emerging) -> tuple[float | None, float | None]:
    """mart_niche.sql's `rates` CTE: the two growth rates, made commensurable.

    Pulled out of expected_score so check 7 can assert the SUPPLY READING itself rather
    than re-deriving it inline (which would make the assertion a tautology).
    """
    dem_g = None if (trend is None or emerging) else math.log(max(1.0 + trend / 100.0, 0.001)) / 2.0
    sup_g = None if (sat is None or emerging) else math.log(max(1.0 + sat, 0.001))
    return dem_g, sup_g


def flood_room_of(dem_g, sup_g) -> float | None:
    """mart_niche.sql's flood_room: supply growth read AGAINST demand growth, one-sided.

    The `or 0.0` mirrors the SQL's defensive COALESCE (never fires in practice — see the
    SQL comment). Section 2 welds this function to the shipping SQL; section 7 pins what
    it MEANS. Both are needed: matching the SQL only proves they agree, not that either
    still implements the intended reading.
    """
    if sup_g is None:
        return None
    g_flood = math.log(1.0 + bm.OPP_FLOOD_YOY)
    return 100.0 * (1.0 - clamp01((sup_g - (dem_g or 0.0)) / (2.0 * g_flood)))


def expected_score(row: dict) -> tuple[float, dict]:
    trend, sat = row["demand_trend_24m_pct"], row["saturation_yoy"]
    er, wc = row["entrant_ratio"], row["winner_concentration"]
    emerging = bool(row["demand_emerging"])

    g_enter = math.log(1.0 + bm.OPP_ENTER_PCT / 100.0) / 2.0

    dem_g, sup_g = annualised_growths(trend, sat, emerging)

    momentum = None if dem_g is None else 50.0 + 50.0 * math.tanh(dem_g / g_enter)
    flood_room = flood_room_of(dem_g, sup_g)
    entrant_room = (
        None if (er is None or emerging)
        else 100.0 * clamp01((er - bm.OPP_ENTRANT_FULL) / (bm.OPP_ENTRANT_NORM - bm.OPP_ENTRANT_FULL))
    )
    if flood_room is None:
        supply_room = entrant_room
    elif entrant_room is None:
        supply_room = flood_room
    else:
        supply_room = min(flood_room, entrant_room)
    revenue_spread = (
        None if wc is None
        else 100.0 * clamp01((1.0 - wc) / (2.0 * (1.0 - bm.OPP_WINNER_TAKE_MOST)))
    )
    market_pull = bm.OPP_MARKET_MEDIAN_W * row["demand"] + (1.0 - bm.OPP_MARKET_MEDIAN_W) * row["market_size"]

    terms = [
        (bm.W2_MOMENTUM, momentum),
        (bm.W2_MARKET, market_pull),
        (bm.W2_SPREAD, revenue_spread),
        (bm.W2_QUALITY, row["quality_gap"]),
    ]
    live = [(w, v) for w, v in terms if v is not None]
    core = sum(w * v for w, v in live) / sum(w for w, _ in live)
    brake = (
        1.0 if supply_room is None
        else bm.SUPPLY_BRAKE_FLOOR + (1.0 - bm.SUPPLY_BRAKE_FLOOR) * supply_room / 100.0
    )
    parts = dict(momentum=momentum, supply_room=supply_room, revenue_spread=revenue_spread,
                 market_pull=market_pull, supply_brake=brake)
    return max(0.0, min(100.0, core * brake)), parts


# ---------------------------------------------------------------------------------------
# Fixture catalog. 44 tags x 48 games, each game in EXACTLY ONE tag so every niche's
# demand trend, saturation and concentration are independently controllable.
#
# Per niche: 34 "recent" games (released 2-20 months ago -> they populate the win='24m'
# cut, comfortably over MIN_NICHE_GAMES) and 14 "legacy" games (released ~40 months ago).
# The legacy games carry 30% of the now-window review mass, which keeps
# reviews_24m_new_share at ~0.70 — under DEMAND_NEW_MASS_SHARE, so these niches are NOT
# flagged emerging and their trend is read normally. Two extra niches are built WITHOUT a
# review history on purpose, to exercise the emerging / NULL-momentum path.
#
# release_date and release_year are driven INDEPENDENTLY here, on purpose: mart_niche reads
# release_date (via _niche_pop) for window membership and release_year (via the `sat` CTE)
# for the saturation counts, so decoupling them is the only way to sweep the two axes
# separately. Both columns are still individually well-formed.
#
# The LEVEL inputs (revenue, owners, review counts, positive ratios) are swept ACROSS the
# profiles by a deterministic index pattern rather than stacked in favour of the growth
# niches — otherwise the ordering assertion would be testing the fixture, not the score.
# ---------------------------------------------------------------------------------------
PROFILES = [
    # (name, demand trend %, n_recent_year, n_prior_year, top-heavy revenue?)
    # saturation_yoy = (n_recent_year - n_prior_year) / n_prior_year, and the two counts
    # are taken from the niche's 48 games by release_year, so they must sum to <= 48.
    ("enter", 80.0, 15, 15, False),          # sat 0.00  -> enter
    ("hold", 5.0, 16, 15, False),            # sat +0.07 -> hold
    ("crowded_flood", -5.0, 24, 12, False),  # sat +1.00, demand <= 0 -> crowded
    ("crowded_wtm", 25.0, 15, 15, True),     # calm supply, wc > 0.85 -> crowded
    ("declining", -50.0, 16, 15, False),     # trend <= -30 -> declining
]
NICHES_PER_PROFILE = 8
RECENT_PER_NICHE = 34
LEGACY_PER_NICHE = 14
PREV_PER_GAME = 100          # every game contributes 100 reviews to the PRIOR window
LEGACY_NOW_SHARE = 0.30      # ...and legacy games carry 30% of the NOW window


def build_fixture():
    games, tag_rows, hist_rows = [], [], []
    appid = 100_000
    niches = []

    for prof_i, (prof, trend, n_recent_year, n_prior_year, top_heavy) in enumerate(PROFILES):
        for k in range(NICHES_PER_PROFILE):
            tag = f"{prof}-{k}"
            niches.append(tag)
            n_games = RECENT_PER_NICHE + LEGACY_PER_NICHE
            total_prev = n_games * PREV_PER_GAME
            total_now = total_prev * (1.0 + trend / 100.0)
            legacy_now = max(1, int(round(total_now * LEGACY_NOW_SHARE / LEGACY_PER_NICHE)))
            recent_now = max(1, int(round(total_now * (1 - LEGACY_NOW_SHARE) / RECENT_PER_NICHE)))

            # Level inputs sweep with (profile, k) so no profile is systematically richer.
            lvl = (prof_i * 3 + k * 5) % 7          # 0..6, decorrelated from the profile
            base_rev = 20_000.0 * (1 + lvl)
            ratio = 0.60 + 0.05 * ((k + prof_i) % 6)
            # Singleplayer share swept so every solo_tier band is exercised: 1.00 / 0.95
            # -> 'solo', 0.85 -> 'mixed', 0.60 -> 'team'. (i*7)%20 walks all 20 residues,
            # so the share holds inside any window/floor cut, not just over all 48.
            solo_n = round([1.0, 0.95, 0.85, 0.60][(prof_i + k) % 4] * 20)

            for i in range(n_games):
                is_recent = i < RECENT_PER_NICHE
                # release_date drives window membership...
                days = 60 + i * 15 if is_recent else 1220 + i * 5
                release_date = TODAY - timedelta(days=days)
                # ...release_year drives the saturation counts, swept independently over
                # the WHOLE niche (the `sat` CTE counts full membership, not the windowed
                # population), so the two axes never constrain each other.
                if i < n_recent_year:
                    release_year = CUR_YEAR - 1
                elif i < n_recent_year + n_prior_year:
                    release_year = CUR_YEAR - 2
                else:
                    release_year = CUR_YEAR - 4
                # Top-heavy niches put nearly all revenue in 2 titles -> wc > 0.85.
                if top_heavy:
                    rev = base_rev * 900.0 if i < 2 else base_rev * 0.02
                else:
                    rev = base_rev * (1.0 + (i % 9) * 0.25)
                games.append(dict(
                    appid=appid, name=f"{tag} #{i}", release_year=release_year,
                    release_date=release_date, release_valid=True,
                    price_initial=9.99 + (i % 4) * 5.0,
                    positive_ratio=min(0.99, ratio + (i % 5) * 0.03),
                    owners_mid=rev / 3.0,
                    total_reviews=60 + (i % 11) * 40 + lvl * 25,
                    est_rev_reviews=rev,
                    self_published=bool(i % 3), is_singleplayer=((i * 7) % 20) < solo_n,
                    is_indie=bool(i % 2), playtime_p50=float(120 + (i % 30) * 20),
                    review_count_source="steamspy",
                ))
                tag_rows.append((appid, tag))
                hist_rows.append((appid, legacy_now if not is_recent else recent_now, PREV_PER_GAME))
                appid += 1

    # Two EMERGING niches: real games, real revenue, but no review history at all, so
    # reviews_prev_24m = 0 -> demand_trend_24m_pct NULL and demand_emerging TRUE.
    for k in range(2):
        tag = f"emerging-{k}"
        niches.append(tag)
        for i in range(RECENT_PER_NICHE):
            games.append(dict(
                appid=appid, name=f"{tag} #{i}", release_year=CUR_YEAR - 1,
                release_date=TODAY - timedelta(days=60 + i * 15), release_valid=True,
                price_initial=14.99, positive_ratio=0.8, owners_mid=30_000.0,
                total_reviews=200 + i * 10, est_rev_reviews=90_000.0 * (1 + (i % 7) * 0.3),
                self_published=True, is_singleplayer=bool(i % 25), is_indie=True,
                playtime_p50=300.0, review_count_source="steamspy",
            ))
            tag_rows.append((appid, tag))
            appid += 1
    return games, tag_rows, hist_rows, niches


def main() -> int:
    games, tag_rows, hist_rows, niches = build_fixture()
    con = duckdb.connect(":memory:")

    con.execute("CREATE SCHEMA src")
    con.execute("CREATE TABLE src.games(appid INTEGER, header_image VARCHAR)")
    con.executemany("INSERT INTO src.games VALUES (?, ?)",
                    [(g["appid"], None) for g in games])

    con.execute("CREATE TEMP TABLE stg_tag_membership(appid INTEGER, tag VARCHAR)")
    con.executemany("INSERT INTO stg_tag_membership VALUES (?, ?)", tag_rows)
    con.execute("CREATE TEMP TABLE stg_genre_membership(appid INTEGER, genre VARCHAR)")
    con.executemany("INSERT INTO stg_genre_membership VALUES (?, ?)",
                    [(g["appid"], "Indie") for g in games])
    con.execute(
        """
        CREATE TEMP TABLE stg_game(
            appid INTEGER, name VARCHAR, release_year INTEGER, release_date DATE,
            release_valid BOOLEAN, price_initial DOUBLE, positive_ratio DOUBLE,
            owners_mid DOUBLE, total_reviews BIGINT, est_rev_reviews DOUBLE,
            self_published BOOLEAN, is_singleplayer BOOLEAN, is_indie BOOLEAN,
            review_count_source VARCHAR)
        """
    )
    con.executemany(
        "INSERT INTO stg_game VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(g["appid"], g["name"], g["release_year"], g["release_date"], g["release_valid"],
          g["price_initial"], g["positive_ratio"], g["owners_mid"], g["total_reviews"],
          g["est_rev_reviews"], g["self_published"], g["is_singleplayer"], g["is_indie"],
          g["review_count_source"]) for g in games],
    )
    con.execute("CREATE TABLE mart_game(appid INTEGER, playtime_p50 DOUBLE)")
    con.executemany("INSERT INTO mart_game VALUES (?, ?)",
                    [(g["appid"], g.get("playtime_p50")) for g in games])
    con.execute("CREATE TEMP TABLE tag_tier(tag VARCHAR, tier VARCHAR)")
    con.execute(
        "CREATE TEMP TABLE _niche_players_now(dimension VARCHAR, key VARCHAR, "
        "total_players_now BIGINT, players_coverage DOUBLE, players_trend_7d_pct DOUBLE, "
        "median_players_now DOUBLE, players_top5_share DOUBLE)"
    )
    con.execute(
        "CREATE TEMP TABLE _niche_lifetime(dimension VARCHAR, key VARCHAR, "
        "lifetime_n_games BIGINT, lifetime_survival_12m DOUBLE, "
        "lifetime_median_dead_months DOUBLE)"
    )

    # Histogram: one month inside each 24-month window (see mart_niche.sql's anchor doc —
    # anchor = max(period_month) - 1 month, so the CURRENT month must also exist and is
    # excluded). base-1 lands in the now window, base-25 in the prior window.
    con.execute(
        "CREATE TEMP TABLE stg_review_histogram("
        "appid INTEGER, period_month DATE, n_reviews BIGINT, n_positive BIGINT)"
    )
    con.executemany(
        "INSERT INTO stg_review_histogram VALUES "
        "(?, date_trunc('month', CURRENT_DATE), 0, 0)", [(a,) for a, _, _ in hist_rows])
    con.executemany(
        "INSERT INTO stg_review_histogram VALUES "
        "(?, date_trunc('month', CURRENT_DATE) - INTERVAL 1 MONTH, ?, 0)",
        [(a, now) for a, now, _ in hist_rows])
    con.executemany(
        "INSERT INTO stg_review_histogram VALUES "
        "(?, date_trunc('month', CURRENT_DATE) - INTERVAL 25 MONTH, ?, 0)",
        [(a, prev) for a, _, prev in hist_rows])

    params = bm.build_params()
    con.execute(bm.render((ETL / "marts" / "mart_niche.sql").read_text(), params))
    print(f"[fixture] {len(games)} games, {len(niches)} tags, "
          f"{con.execute('SELECT COUNT(*) FROM mart_niche').fetchone()[0]} mart rows")

    cols = [
        "key", "win", "min_reviews", "demand_trend_24m_pct", "saturation_yoy",
        "entrant_ratio", "winner_concentration", "demand", "market_size", "quality_gap",
        "demand_emerging", "momentum", "supply_room", "revenue_spread", "market_pull",
        "supply_brake", "opportunity_v2", "solo_viability", "solo_tier",
    ]
    rows = [dict(zip(cols, r)) for r in con.execute(
        f"SELECT {', '.join(cols)} FROM mart_niche WHERE dimension = 'tag'"
    ).fetchall()]
    rows = [{k: (float(v) if isinstance(v, (int,)) and k not in
                 ("min_reviews",) and not isinstance(v, bool) else v)
             for k, v in r.items()} for r in rows]
    assert rows, "fixture produced no tag rows"

    # ---- 1. the ORDERING invariant, on the cut every consumer defaults to --------------
    cut = [r for r in rows if r["win"] == "24m" and r["min_reviews"] == 50]
    assert len(cut) >= 40, f"fixture too thin: {len(cut)} niches on the 24m/min50 cut"
    by_ring: dict[str, list[float]] = {}
    for r in cut:
        ring = radar_ring(r["demand_trend_24m_pct"], r["saturation_yoy"],
                          r["winner_concentration"], r["demand_emerging"])
        r["_ring"] = ring
        by_ring.setdefault(ring, []).append(r["opportunity_v2"])
    med = {k: statistics.median(v) for k, v in by_ring.items()}
    print("\n[rings] median opportunity_v2 (tag / win=24m / min_reviews=50)")
    for ring in ("enter", "hold", "watch", "emerging", "crowded", "declining"):
        if ring in med:
            print(f"          {ring:<10} n={len(by_ring[ring]):>3}  median={med[ring]:6.2f}")
    for ring in ("enter", "hold", "crowded", "declining"):
        assert ring in med, f"fixture never produced a '{ring}' niche — the test has no teeth"
    chain = ["enter", "hold", "crowded", "declining"]
    for a, b in zip(chain, chain[1:]):
        assert med[a] > med[b], (
            f"opportunity_v2 INVERTED against the Radar: median({a})={med[a]:.2f} is not "
            f"above median({b})={med[b]:.2f}. The score and the ring must rank the same way "
            f"— see mart_niche.sql's 'opportunity_v2 REBUILT' header."
        )
    print("[ok] enter > hold > crowded > declining")

    # ...and on every OTHER cut too, so the ordering is not an artifact of one slice.
    for win, floor in [("24m", 0), ("24m", 100), ("all", 50), ("all", 0)]:
        sub = [r for r in rows if r["win"] == win and r["min_reviews"] == floor]
        if not sub:
            continue
        m: dict[str, list[float]] = {}
        for r in sub:
            m.setdefault(radar_ring(r["demand_trend_24m_pct"], r["saturation_yoy"],
                                    r["winner_concentration"], r["demand_emerging"]),
                         []).append(r["opportunity_v2"])
        meds = {k: statistics.median(v) for k, v in m.items()}
        present = [c for c in chain if c in meds]
        for a, b in zip(present, present[1:]):
            assert meds[a] > meds[b], (
                f"ordering broken on win={win}, min_reviews={floor}: "
                f"median({a})={meds[a]:.2f} <= median({b})={meds[b]:.2f}"
            )
        print(f"[ok] ordering holds on win={win}, min_reviews={floor} "
              f"({', '.join(f'{k} {meds[k]:.1f}' for k in present)})")

    # ---- 2. the FORMULA: an independent recompute must reproduce every score -----------
    worst = 0.0
    for r in rows:
        want, parts = expected_score(r)
        worst = max(worst, abs(want - r["opportunity_v2"]))
        for name in ("momentum", "supply_room", "revenue_spread", "market_pull", "supply_brake"):
            got, exp = r[name], parts[name]
            assert (got is None) == (exp is None), (
                f"{r['key']}: {name} nullness disagrees (mart={got}, expected={exp})"
            )
            if exp is not None:
                assert abs(float(got) - exp) < 0.01, (
                    f"{r['key']}: {name} = {got}, independently computed {exp:.4f}"
                )
    assert worst < 0.01, f"opportunity_v2 drifted from its documented formula by {worst:.4f}"
    print(f"[ok] opportunity_v2 + all 5 sub-scores match an independent recompute "
          f"(max delta {worst:.5f} over {len(rows)} rows)")

    # ---- 3. ANCHOR EQUIVALENCE: the sub-scores speak the Radar's thresholds ------------
    m_enter = 50.0 + 50.0 * math.tanh(1.0)                                    # 88.08
    m_decline = 50.0 + 50.0 * math.tanh(
        (math.log(1.0 + DEMAND_DECLINE_PCT / 100.0) / 2.0)
        / (math.log(1.0 + bm.OPP_ENTER_PCT / 100.0) / 2.0))                   # 10.72
    assert abs(bm.OPP_ENTER_PCT - DEMAND_ENTER_PCT) < 1e-9, (
        "OPP_ENTER_PCT drifted from radarVerdict.ts's DEMAND_ENTER_PCT"
    )
    assert abs(bm.OPP_FLOOD_YOY - SAT_FLOOD_YOY) < 1e-9, (
        "OPP_FLOOD_YOY drifted from radarVerdict.ts's SAT_FLOOD_YOY"
    )
    assert abs(bm.OPP_WINNER_TAKE_MOST - WC_WINNER_TAKE_MOST) < 1e-9, (
        "OPP_WINNER_TAKE_MOST drifted from radarVerdict.ts's WC_WINNER_TAKE_MOST"
    )
    checked = 0
    for r in rows:
        t, mo = r["demand_trend_24m_pct"], r["momentum"]
        if mo is not None and t is not None:
            assert (mo >= m_enter - 1e-6) == (t >= DEMAND_ENTER_PCT), (
                f"{r['key']}: momentum {mo} vs enter anchor {m_enter:.2f} disagrees with "
                f"trend {t} vs DEMAND_ENTER_PCT {DEMAND_ENTER_PCT}"
            )
            assert (mo <= m_decline + 1e-6) == (t <= DEMAND_DECLINE_PCT), (
                f"{r['key']}: momentum {mo} vs decline anchor {m_decline:.2f} disagrees with "
                f"trend {t} vs DEMAND_DECLINE_PCT {DEMAND_DECLINE_PCT}"
            )
            checked += 1
        sp, wc = r["revenue_spread"], r["winner_concentration"]
        if sp is not None and wc is not None:
            assert (sp < 50.0) == (wc > WC_WINNER_TAKE_MOST), (
                f"{r['key']}: revenue_spread {sp} vs 50 disagrees with winner_concentration "
                f"{wc} vs WC_WINNER_TAKE_MOST {WC_WINNER_TAKE_MOST}"
            )
    print(f"[ok] sub-score anchors == Radar ring thresholds "
          f"(momentum enter {m_enter:.2f}, decline {m_decline:.2f}; {checked} rows)")

    # ---- 4. NULL-HONESTY on the emerging path -----------------------------------------
    emerging = [r for r in rows if r["demand_emerging"]]
    assert emerging, "fixture never produced an emerging niche"
    for r in emerging:
        assert r["momentum"] is None, f"{r['key']}: emerging niche got momentum {r['momentum']}"
        assert r["supply_room"] is None, f"{r['key']}: emerging niche got supply_room {r['supply_room']}"
        assert float(r["supply_brake"]) == 1.0, (
            f"{r['key']}: unknown supply must leave the brake at 1.0, got {r['supply_brake']}"
        )
        assert r["opportunity_v2"] is not None and r["opportunity_v2"] > 0, (
            f"{r['key']}: a missing input must not zero the score — got {r['opportunity_v2']}"
        )
    print(f"[ok] {len(emerging)} emerging rows: momentum/supply_room NULL (never 0), "
          f"brake 1.0, score still published")

    # ---- 5. supply pressure can sink a score ON ITS OWN --------------------------------
    braked = [r for r in rows if r["supply_room"] is not None]
    assert braked, "fixture never produced a supply reading"
    hardest = min(braked, key=lambda r: float(r["supply_brake"]))
    assert float(hardest["supply_brake"]) <= bm.SUPPLY_BRAKE_FLOOR + 0.15, (
        f"no niche in the fixture is meaningfully supply-braked (min brake "
        f"{hardest['supply_brake']}); the brake cannot be shown to bite"
    )
    print(f"[ok] supply brake bites: {hardest['key']} brake={float(hardest['supply_brake']):.3f} "
          f"(floor {bm.SUPPLY_BRAKE_FLOOR})")

    # ---- 6. solo_tier is a FLAG cut at the documented, measured bars -------------------
    for r in rows:
        sv, st_ = r["solo_viability"], r["solo_tier"]
        if sv is None:
            assert st_ is None, f"{r['key']}: NULL solo_viability must give NULL solo_tier"
            continue
        want = ("team" if sv < bm.SOLO_TIER_TEAM_MAX
                else "solo" if sv >= bm.SOLO_TIER_SOLO_MIN else "mixed")
        assert st_ == want, f"{r['key']}: solo_viability {sv} -> solo_tier {st_}, expected {want}"
    tiers = sorted({r["solo_tier"] for r in rows if r["solo_tier"]})
    assert len(tiers) >= 2, f"fixture only exercised solo_tier values {tiers}"
    print(f"[ok] solo_tier partitions solo_viability at {bm.SOLO_TIER_TEAM_MAX}/"
          f"{bm.SOLO_TIER_SOLO_MIN} (values seen: {tiers})")

    # ---- 7. THE TWO SUPPLY READS are different questions — pinned, so a THIRD can't drift in
    #
    # Check 3 above asserts OPP_FLOOD_YOY == SAT_FLOOD_YOY and stops there: two equal
    # CONSTANTS, never two agreeing READINGS. That gap is exactly how the divergence below
    # sat undocumented long enough to be published as "the board and the score can't
    # disagree" on /docs (corrected 2026-09-01). Measured on the 222-niche default cut,
    # 59 of 211 comparable niches (28.0%) contradict on supply — 9 ring "supply flooding"
    # with no brake at all, 43 ring "pipeline calm" while braked under x0.80.
    #
    # THE DIVERGENCE IS DELIBERATE AND STAYS. The ring reads supply ABSOLUTELY because a new
    # entrant ships into the whole pipeline and because +15%/yr is the line the board draws
    # on its own axis; the score reads it RELATIVE to demand because that is what stops
    # "everyone left, so it looks uncrowded" from scoring well (the Naval/Transportation bug
    # v2 was built to kill). Both were re-measured before this test was written: making the
    # ring relative moves 28/222 rings, making the score absolute changes 149/222 scores.
    # So this section does NOT assert the two agree. It asserts each one still IS what it
    # claims to be, and that the demand term is the entire difference between them.
    g_flood = math.log(1.0 + bm.OPP_FLOOD_YOY)

    # The fixture rows alone are NOT enough to pin this, and that is not a hypothesis: the
    # first draft of this section asserted only over them, and a mutation that rescaled
    # flood_room's denominator (2*ln(1.15) -> ln(1.15), i.e. a third reading that keeps the
    # demand term but moves the bar to +7.2%/yr) sailed through — the fixture's saturations
    # (0.00 / +0.067 / +1.00) all miss the shifted band, the nearest by 0.005 in log space.
    # So the identity is swept on a DESIGNED grid that straddles both bars, and only then
    # re-checked on the real mart rows. Boundary values are included deliberately: the bars
    # are `>` on both sides, so saturation exactly 0.15 must read as NOT flooding on both.
    GRID_SAT = [-0.9, -0.5, -0.2, -0.05, 0.0, 0.05, 0.07, 0.08, 0.10, 0.12, 0.14,
                0.1499, 0.15, 0.1501, 0.18, 0.25, 0.35, 0.5, 1.0, 3.0]
    GRID_TREND = [-95.0, -60.0, -30.0, -15.0, -7.0, -2.0, 0.0, 2.0, 7.0, 15.0, 40.0,
                  80.0, 200.0, 1000.0]

    supply_rows, disagreements = 0, 0
    probes = [(t, s) for s in GRID_SAT for t in GRID_TREND]
    probes += [(r["demand_trend_24m_pct"], r["saturation_yoy"]) for r in rows
               if not r["demand_emerging"]]
    for trend, sat in probes:
        dem_g, sup_g = annualised_growths(trend, sat, False)
        fr = flood_room_of(dem_g, sup_g)
        if fr is None:
            continue
        supply_rows += 1
        sat = float(sat)
        key = f"sat={sat:+.4f}/trend={trend}"

        # (a) THE SCORE'S READ IS RELATIVE. flood_room crosses 50 exactly when supply growth
        #     exceeds DEMAND growth by ln(1 + OPP_FLOOD_YOY) — not before, not after.
        relative = (sup_g - (dem_g or 0.0)) > g_flood
        assert (fr < 50.0) == relative, (
            f"{key}: flood_room {fr:.4f} vs 50 disagrees with the relative test "
            f"(supply_growth {sup_g:.6f} - demand_growth {(dem_g or 0.0):.6f} = "
            f"{sup_g - (dem_g or 0.0):.6f} vs ln(1+{bm.OPP_FLOOD_YOY}) = {g_flood:.6f}). "
            f"flood_room has drifted off the relative reading it is documented as."
        )

        # (b) THE RING'S READ IS ABSOLUTE, on the same constant: radarVerdict.ts tests
        #     saturation_yoy > SAT_FLOOD_YOY with no demand term anywhere in it.
        absolute = sat > SAT_FLOOD_YOY
        assert absolute == (sup_g > g_flood), (
            f"{key}: the ring's absolute read (saturation_yoy {sat} vs "
            f"{SAT_FLOOD_YOY}) no longer matches supply_growth {sup_g:.6f} vs "
            f"{g_flood:.6f} — the two constants have drifted apart as READINGS"
        )

        # (c) THE DEMAND TERM IS THE ONLY DIFFERENCE. Neutralise it and the score's read
        #     collapses onto the ring's, exactly. This is the claim the /docs copy now
        #     makes in prose ("the ring asks how fast the pipeline is growing, the score
        #     asks whether it is outgrowing demand"), asserted rather than asserted-in-a-
        #     comment. It also catches a rescaled denominator, which (a) only catches when
        #     a row happens to land in the shifted band.
        assert (flood_room_of(0.0, sup_g) < 50.0) == absolute, (
            f"{key}: with demand growth zeroed the score's supply read still differs "
            f"from the ring's (saturation_yoy {sat}) — the two now differ by something "
            f"OTHER than the demand term. That is a third reading, not the documented two."
        )

        if absolute != relative:
            disagreements += 1

    # ANTI-VACUITY. Without a probe where the two reads actually part company, everything
    # above would still pass with the demand term deleted outright — the failure mode this
    # project keeps getting bitten by. The grid guarantees such probes (e.g. sat +0.05 with
    # trend -60%: the ring says calm, supply is outgrowing demand by a mile); the fixture
    # supplies them too, via the "declining" profile (sat +6.7%/yr against demand -50%/24m).
    assert supply_rows >= len(GRID_SAT) * len(GRID_TREND), (
        f"only {supply_rows} probes carried a supply reading; the grid alone should give "
        f"{len(GRID_SAT) * len(GRID_TREND)}"
    )
    assert disagreements > 0, (
        "no probe reads differently on the absolute (ring) and relative (score) supply "
        "tests, so this section would pass with the demand term removed entirely"
    )
    print(f"[ok] supply reads pinned as TWO deliberate questions: flood_room is relative, "
          f"the ring is absolute, demand is the only difference "
          f"({disagreements}/{supply_rows} probes disagree — by design)")

    print("\nALL CHECKS PASSED")
    return 0


def test_opportunity_v2_ranks_with_the_radar():
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())
