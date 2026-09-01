/**
 * Ring verdicts + deterministic layout helpers for the Radar board (the radial
 * "tech-radar" plate on /radar). Pure functions only — no React, no fetch — so every
 * rule is unit-testable and the board component stays geometry-only.
 *
 * RINGS, inner -> outer (inner = strongest "build here" signal):
 *   enter     "Enter now"  — demand in structural growth while supply is not flooding.
 *   watch     "Watch"      — demand holding (flat-to-up, or drifting only mildly), or a
 *                            high v2 score without trend evidence (caution). Also the
 *                            CATCH-ALL: a niche with no strong signal in either
 *                            direction parks here rather than being invented into a
 *                            stronger ring.
 *   emerging  "Emerging"   — no comparable demand base (demand_emerging from the mart),
 *                            so NO trend-derived claim is possible in either direction.
 *                            WHICH tell fired matters for the copy (PR #98 review): a
 *                            new-game review mass >= EMERGING_NEW_MASS_SHARE marks a
 *                            genuinely YOUNG LABEL; the low-base floor alone marks a
 *                            small stable niche whose base is just too small for a %
 *                            read — calling that one "new" would be a fabricated claim.
 *   crowded   "Crowded"    — supply flooding without demand keeping up, or a
 *                            winner-take-most revenue structure.
 *   declining "Declining"  — demand in sustained structural decline.
 *
 * PRECEDENCE (first match wins; every niche gets exactly one ring):
 *   0. emerging   — trumps EVERY percentage-based verdict. Young Steam tags crystallize
 *                   around new games only (old genre ancestors never get re-voted into
 *                   the new label), so their prior window is near zero BY CONSTRUCTION:
 *                   a +4,775% trend there is the label's age, not demand growth — and
 *                   the same youth distorts saturation_yoy, so the crowding arms are
 *                   pre-empted too. The niche's real signal is absolute volume, which
 *                   the board/feed surface instead of the %.
 *   1. enter      — the strongest positive claim, checked first among trend verdicts.
 *   2. declining  — a hard demand collapse trumps crowding: a niche can be both
 *                   flooding AND collapsing (entrants still arriving into falling
 *                   demand); "declining" is the outer, stronger warning, so it wins.
 *   3. crowded    — winner-take-most OR supply flooding with flat/negative/unknown
 *                   demand.
 *   4. watch      — demand holding or softening (but not enter/declining), or
 *                   opportunity_v2 evidence with a caution flag, or the no-signal
 *                   catch-all (also flagged caution).
 *
 * FIELD UNITS (verified against the mart, not assumed):
 *   - demand_trend_24m_pct is PERCENT units (+40 means +40%), from mart_niche's
 *     24-month review-histogram windows: the niche's review inflow over the last 24
 *     complete months vs the 24 before them. It REPLACED the 12-month windows outright
 *     (2026-08-26, user-directed: the board's pinned membership cut is 24m x min50, so
 *     the whole radar now speaks 24 months), which had replaced the spike-prone 90-day
 *     trend. It rides every NicheRow / GET /api/niches row, cut-independent in the
 *     mart (one value per niche, identical on every window/floor cut), so the board
 *     passes each niche's own value; this lib degrades when it is null/undefined (mart
 *     predates the column, or no prior-window baseline).
 *   - demand_emerging is the mart's own two-tell flag (see mart_niche.sql: prior-window
 *     base below the floor, OR >= 80% of the window's reviews from games released
 *     within the last 24 months). It rides the same rows as the trend.
 *   - saturation_yoy is a SIGNED FRACTION centred on 0 — (n_recent_year -
 *     n_prior_year) / n_prior_year in etl/marts/mart_niche.sql — so "release
 *     pipeline grew more than 15% YoY" is saturation_yoy > 0.15, the same cut a
 *     1.15 recent/prior RATIO form would express.
 *   - winner_concentration is a 0..1 share; > 0.85 is the winner-take-most flag the
 *     MCP guidance already uses.
 *   - opportunity_v2 is the 0..100 v2 score. REBUILT 2026-08-31 out of this file's own
 *     thresholds — see ONE MODEL, TWO VIEWS below. >= OPP_WATCH_SCORE is "notable".
 *
 * ONE MODEL, TWO VIEWS (2026-08-31). Until this rebuild the board and the score were two
 * gradings that disagreed: measured on 219 live niches (tag / 24m / min50 — this board's
 * pinned cut), median opportunity_v2 by ring ran enter 17.6 < hold 17.8 < crowded 20.9 <
 * declining 23.4. The score ranked BACKWARDS against the rings it sat next to, and
 * corr(score, demand_trend_24m_pct) was -0.047 — no relationship at all to this file's
 * primary axis. The cause was on the mart side (the old score's `competition` term was
 * 60% percentile(n_recent), which on the 24m cut is a pure niche-SIZE penalty), so the
 * fix is there too: etl/marts/mart_niche.sql now blends four 0..100 sub-scores whose
 * anchor points ARE the constants in this file, then multiplies by a supply brake:
 *
 *   BLENDED (weights 0.40 / 0.22 / 0.20 / 0.18):
 *     momentum        50 at flat demand, MOMENTUM_ENTER (88.1) at DEMAND_ENTER_PCT,
 *                     MOMENTUM_DECLINE (10.7) at DEMAND_DECLINE_PCT
 *     market_pull     the money/size percentiles, demoted to a supporting weight
 *     revenue_spread  50 exactly at WC_WINNER_TAKE_MOST
 *     quality_gap     unchanged (percentile of the beatable-incumbent share)
 *   MULTIPLIER (not part of the blend):
 *     supply_brake    driven by supply_room = MIN(flood_room, entrant_room), where
 *                     flood_room hits 50 when supply outgrows DEMAND by exactly
 *                     SAT_FLOOD_YOY, and entrant_room hits 100 at the catalog norm
 *                     ENTRANT_RATIO_CATALOG_NORM. Either signal alone can sink a score.
 *
 * So the DEMAND and CONCENTRATION axes now read the same bars on both sides — the ring
 * says which side of a bar a niche falls on, the score says by how much and blends in the
 * money. After the rebuild the same 219 niches read enter 67.6 > hold 50.2 > crowded 39.1
 * > declining 19.5. The ring rules themselves are unchanged: they encode distinct failure
 * MODES (crowded and declining are different problems, not different amounts of one
 * problem) and a scalar cannot express that. Changing DEMAND_ENTER_PCT / DEMAND_DECLINE_PCT
 * / WC_WINNER_TAKE_MOST therefore moves the score too — keep them in lockstep with
 * build_marts.py's OPP_* constants (etl/tests/test_opportunity_ordering.py asserts that
 * equivalence both ways).
 *
 * ...EXCEPT ON SUPPLY, WHERE THEY ASK DIFFERENT QUESTIONS ON PURPOSE (2026-09-01). "Two
 * views of one model" was over-claimed, and the /docs copy inherited the over-claim as a
 * flat "the board and the score can't disagree". They can, and they do — measured on the
 * 222-niche default Radar cut (tag / 24m / min50):
 *   - This file's ring reads supply ABSOLUTELY and binary: `saturation_yoy > SAT_FLOOD_YOY`
 *     (line ~464). It is the +15%/yr line RadarBoard.tsx literally draws across the plate
 *     as the quadrant divider, so the ring and the picture cannot disagree.
 *   - mart_niche.sql's supply_brake reads supply RELATIVELY and continuously: flood_room
 *     subtracts annualised DEMAND growth from annualised SUPPLY growth, then takes
 *     supply_room = LEAST(flood_room, entrant_room) and brakes by
 *     0.35 + 0.65*supply_room/100 — so entrant_ratio, which never moves a ring, can
 *     nonetheless halve a printed score.
 *   MEASURED DISAGREEMENT: 59 of 211 comparable niches (28.0%) contradict on supply.
 *   9/222 ring "supply flooding — vetoes enter" with NO brake applied at all; 43/222 ring
 *   "pipeline calm" while the score brakes below x0.80, and 15 of those are driven purely
 *   by entrant_ratio. Sharpest case: Metroidvania rings "demand in structural growth,
 *   supply not flooding" and the same dossier prints opp v2 30.1 — cut from an unbraked
 *   56.0 by exactly the entrant_ratio the panel calls context.
 *   PROOF THE DEMAND TERM IS THE WHOLE DIFFERENCE: among the 33 niches with
 *   |demand_trend_24m_pct| < 5% the two reads agree 33/33 (100%); among the 59 that
 *   disagree, median |demand_trend_24m_pct| = 30.9%.
 * BOTH ARE RIGHT FOR THEIR JOB, and swapping either was measured and rejected. Absolute is
 * right for the ring: a new entrant ships into the WHOLE pipeline, not into the pipeline
 * net of demand, and the board's own Y axis is absolute (making the ring relative moves
 * 28/222 rings and promotes 7 winner-take-most niches to "Enter now"). Relative is right
 * for the score: it is what stops "everyone left, so it looks uncrowded" from scoring well
 * — the exact Naval/Transportation failure v2 was built to kill (making the score absolute
 * changes 149/222 printed scores and reintroduces it). What is NOT allowed is a third
 * reading drifting in silently, which is why etl/tests/test_opportunity_ordering.py now
 * pins the relative form as an identity instead of only pinning the two constants equal.
 *
 * DEGRADATION (any field may be null/undefined/NaN — treated identically as "unknown"):
 *   - demand_emerging unknown/absent (older mart) -> the emerging ring is unreachable;
 *                        everything degrades exactly as before the column existed.
 *   - demand unknown  -> enter/declining are unreachable (both are demand claims);
 *                        crowding can still be read from saturation/concentration;
 *                        otherwise the niche parks in watch with caution=true. There is
 *                        NO fallback to any shorter-horizon trend — the 90d columns are
 *                        gone from the mart, and a structural verdict faked from a
 *                        quarterly spike would be worse than an honest "caution".
 *   - saturation unknown -> does not block enter (matches the spec: null passes);
 *                        the flooding arm of crowded is unreachable.
 *   - concentration unknown -> the winner-take-most arm of crowded is unreachable.
 *   - opportunity unknown -> the watch score arm is unreachable; catch-all still applies.
 *
 * The demand thresholds are named constants with their derivations attached — tuning is
 * a one-line diff with the tests updated alongside.
 *
 * SOLO VIABILITY IS A LENS, NOT A RING — deliberately. mart_niche.solo_viability is the
 * niche's SINGLEPLAYER SHARE: the share of the cut's scored games playable single-player.
 *
 * AND IT IS A FLAG, NOT A SCALE (2026-08-31, user-reported: "solo scoring isn't working at
 * all"). MEASURED on the same 219-niche cut this board pins:
 *     min 0.353 | p05 0.853 | p10 0.913 | p25 0.953 | MEDIAN 0.975 | p75 0.990 | max 1.000
 *     below 0.90: 7.8%     below 0.80: 3.2%
 * Three quarters of the catalog sits inside a 0.047-wide band, so the number cannot rank
 * the options a solo dev is choosing between — it can only spot the ~3% that are inherently
 * multiplayer, which it does perfectly: Social Deduction 0.353, MMORPG 0.449, Party Game
 * 0.500, Party 0.636, Battle Royale 0.700, Extraction Shooter 0.705, eSports 0.788. That
 * compression is a true fact about the world (most genres really are solo-buildable), not a
 * defect, so nothing here rescales it and the SOLO_FRIENDLY_MIN pass bar is unchanged — the
 * distribution says 0.80 is already the right cut. What WAS wrong was the documentation:
 * this file and the MCP instructions both called ~0.9 "the catalog norm" when 0.9 is the
 * 10th percentile. The norm is 0.975. Anyone calibrating on the old sentence was reading a
 * bottom-decile value as typical. Corrected here, in the MCP server instructions, and in
 * mart_niche.sql (which now also publishes solo_tier: 'solo' | 'mixed' | 'team').
 *
 * Named honestly everywhere it renders (2026-08-27): it is a NO-NETCODE
 * proxy, not a production-scope measure — "Souls-like 0.98" says its games skip netcode,
 * not that a Souls-like is a small build. It never feeds the ring decision: a ring
 * answers "is this market worth entering", which holds regardless of team size, while
 * solo-buildability is a property of the READER, not the market. Folding it into the
 * verdict would move dots between rings when the market itself did not change. Since
 * 2026-08-26 the radar POPULATION is solo-friendly-by-default — but server-side (the
 * API's solo_only param filters on the same 0.8 bar), never by moving rings: with the
 * board's "Solo-friendly only" toggle off, team-scale dots return, drawn hollow via
 * soloBucket() below, in exactly the ring the market evidence puts them.
 *
 * SOLO EVIDENCE (2026-08-27): because the share alone over-claims, the dossier's solo
 * row renders the member profile behind it when the mart carries the evidence trio
 * (same per-cut population as the share itself — see mart_niche.sql):
 *   self_published_share  AVG(self_published)   -> "50% self-pub"
 *   indie_share           AVG(is_indie)         -> "71% indie"
 *   med_playtime_h        median member playtime_p50, hours -> "median 5.7h content"
 * The pass bar stays on the singleplayer share >= SOLO_FRIENDLY_MIN exactly as before;
 * evidence is display-only and, like the whole row, decides:false. When med_playtime_h
 * exceeds SOLO_HEAVY_CONTENT_H the note gains a NEUTRAL caution — "heavy content scope
 * for a solo build" — which never changes the pass/fail or the ring. Older marts serve
 * the trio as null and the evidence clauses are simply omitted.
 *
 * THE TRACE (radarVerdictTrace) — the dossier's data. The radar must EXPLAIN its verdicts,
 * not just assert them, so the evaluation returns an ordered list of VerdictCheck rows
 * alongside {ring, caution, reason}: each check carries the niche's own number, the bar it
 * was judged against, and pass/fail/unknown. The checks and the ring come from the SAME
 * booleans in the same function body — a threshold can never drift between the verdict and
 * its explanation. Two of the rows are deliberately decides:false: entrant_ratio (a
 * falsification TELL — it can talk you out of a niche, it never moves a ring) and
 * solo_viability (the lens above). Emerging niches get their own trace shape (absolute
 * volume + new-game share + "no comparable base") because no %-check is honest there.
 */

import { fmtCompact, fmtSigned } from "./format";

// ---- thresholds -------------------------------------------------------------------------
//
// RESCALED x2 FOR THE 24-MONTH WINDOW (2026-08-26, with the mart's move from 12m to 24m
// windows). The previous bars were calibrated PER YEAR on the 12m series: enter >= +20%/yr,
// declining <= -15%/yr, holding >= -5%/yr. The 24m trend compares two 24-month windows, so
// the same underlying per-year growth rate roughly doubles the printed percentage (a
// market compounding +20%/yr reads ~+40% across adjacent two-year windows) — the bars
// scale linearly x2 to keep the SAME real-world meaning, not to get stricter:
//   enter      >= +40% per 24m (~+20%/yr) — two years of demand growth strong enough to
//               plausibly still be there when a game started today ships (1-3 years out).
//   declining  <= -30% per 24m (~-15%/yr) — a persistent multi-year contraction; on a
//               two-year read that magnitude already IS structural.
//   holding    >= -10% per 24m (~-5%/yr)  — measurement slack: histogram truncation at
//               the anchor month and coverage churn can move the ratio a few points per
//               year, so twice that over two years still reads "holding", not drift.
// The asymmetry (+40 to enter, -30 to warn) is deliberate and inherited: entering costs
// 1-3 years of dev time, so the growth claim must clear a higher bar; the decline warning
// may fire earlier because its cost — looking elsewhere — is low. Between -30% and -10%
// sits "softening": real evidence of mild decline, not yet the "do not build here" ring,
// so it holds watch WITHOUT a caution flag (the evidence is solid; only the placement is
// intermediate).

/** 24-month demand trend (percent per 24m; ~x2 the old per-year bar) at or above which a
 * niche can claim "enter": sustained growth worth a multi-year build commitment. */
export const DEMAND_ENTER_PCT = 40;
/** 24-month demand trend (percent per 24m) at or below which a niche is "declining": a
 * persistent multi-year contraction. */
export const DEMAND_DECLINE_PCT = -30;
/** 24-month demand trend (percent per 24m) at or above which demand counts as "holding"
 * — within measurement slack of flat on a two-year read. Below it (down to
 * DEMAND_DECLINE_PCT) is "softening". */
export const DEMAND_HOLD_PCT = -10;
/** saturation_yoy (signed fraction) above which the release pipeline counts as
 * flooding — +0.15 == +15% more releases YoY == a 1.15x recent/prior ratio. */
export const SAT_FLOOD_YOY = 0.15;
/** winner_concentration share above which the niche is winner-take-most. Also the exact
 * point where the mart's revenue_spread sub-score crosses 50. */
export const WC_WINNER_TAKE_MOST = 0.85;
/**
 * opportunity_v2 score at or above which a trend-less niche still earns "watch" — and the
 * board's general "this scores like somewhere you'd enter" bar.
 *
 * RECALIBRATED 60 -> 65 (2026-08-31) with the score rebuild. The old bar was unreachable:
 * on the live catalog (219 niches, tag / 24m / min50) only 2 niches — 0.9% — ever reached
 * 60, and the catalog maximum was 63.7, so the ring this constant guards was dead by
 * construction. The rebuilt score spans p50 47.6 / p75 59.6 / p90 68.0 / max 86.7, and 65
 * is the median score of the niches the board actually rings "enter" (67.6, and 64.6 /
 * 66.8 on the win='all' and min_reviews=100 cuts). So the bar now means something
 * checkable — "this scores like a niche the radar would tell you to enter" — and selects
 * 15.5% of the catalog rather than 0.9%.
 *
 * CAVEAT, stated rather than hidden: the fraction it selects is cut-dependent (15.5% on
 * 24m/min50, 17.4% on 24m/min100, 11.6% on all/min50, but only 1.8% on min_reviews=0).
 * That is not miscalibration — with no review floor the median niche's
 * winner_concentration is 0.920 and 75% of niches are winner-take-most, so the board
 * itself rings 64% of that population "crowded". Both gradings collapse together on that
 * cut, which is the coherence working, not failing. This bar is calibrated for the cut
 * the board pins (24m x min50).
 */
export const OPP_WATCH_SCORE = 65;

// ---- sub-score anchors (the bars above, in mart sub-score units) -------------------------
//
// These are DERIVED, not chosen: momentum = 50 + 50*tanh(g / g_enter) where g is the
// niche's annualised continuous demand growth ln(1 + trend/100)/2. Substituting the demand
// bars above gives the two constants below. They exist so a reader can move between the
// board's units (percent per 24 months) and the score's units (0..100 sub-score) without
// re-deriving the algebra, and so a threshold change here is visibly a score change.

/** momentum in sub-score units for a niche whose 24-month demand trend is `trendPct`.
 * The mart's formula (etl/marts/mart_niche.sql's `subscores` CTE) with the /2
 * annualisation cancelling out of the ratio. Exported so the anchors below are DERIVED
 * from the demand bars rather than transcribed — a bar change moves them automatically. */
function momentumAt(trendPct: number): number {
  return 50 + 50 * Math.tanh(Math.log(1 + trendPct / 100) / Math.log(1 + DEMAND_ENTER_PCT / 100));
}

/** momentum at DEMAND_ENTER_PCT — 50 + 50*tanh(1) = 88.08. At or above this, the niche's
 * demand cleared the enter bar. */
export const MOMENTUM_ENTER = momentumAt(DEMAND_ENTER_PCT);
/** momentum at DEMAND_DECLINE_PCT — 10.72. At or below this, demand cleared the decline
 * bar downward. */
export const MOMENTUM_DECLINE = momentumAt(DEMAND_DECLINE_PCT);
/** momentum at flat demand (0%/24m) — 50. The sub-score's neutral point. */
export const MOMENTUM_FLAT = momentumAt(0);
/** entrant_ratio at or above which recent entrants earn at least the niche median. A
 * falsification TELL, not a ring input (below 1.0 = recent entrants underearn — the same
 * check the MCP guidance runs before recommending a niche). Dossier-only. */
export const ENTRANT_RATIO_PAR = 1.0;
/** Catalog-median entrant_ratio (~1.08) — display context for the dossier's tell row. */
export const ENTRANT_RATIO_CATALOG_NORM = 1.08;
/** reviews_24m_new_share at or above which an emerging niche is a genuinely YOUNG LABEL
 * (the mart's tell 2 — MUST stay in lockstep with DEMAND_NEW_MASS_SHARE in
 * etl/build_marts.py). Below it, an emerging flag came from the low-base floor alone: a
 * small stable niche, so the dossier says "base too small for a % read", never "new". */
export const EMERGING_NEW_MASS_SHARE = 0.8;

// ---- verdict ----------------------------------------------------------------------------

export type RadarRing = "enter" | "watch" | "emerging" | "crowded" | "declining";

/** Ring order, inner -> outer. Also the legend's group order. "emerging" sits between
 * watch and crowded: not a recommendation (no trend claim is possible), but not a
 * warning either — real volume with an unproven base. */
export const RING_ORDER: RadarRing[] = ["enter", "watch", "emerging", "crowded", "declining"];

export const RING_LABEL: Record<RadarRing, string> = {
  enter: "Enter now",
  watch: "Watch",
  emerging: "Emerging",
  crowded: "Crowded",
  declining: "Declining",
};

export interface RadarVerdictInput {
  /** Percent units per 24 months (+40 = +40%); see module doc. */
  demand_trend_24m_pct?: number | null;
  /** The mart's young-tag flag (see module doc); true pre-empts every other verdict. */
  demand_emerging?: boolean | null;
  /** Signed fraction centred on 0 (see module doc). */
  saturation_yoy?: number | null;
  /** 0..1 share of niche revenue held by the top game(s). */
  winner_concentration?: number | null;
  /** 0..100 v2 opportunity score. */
  opportunity_v2?: number | null;
  // ---- dossier context — NEVER read by the ring decision (pinned by tests) ----
  /** Recent-entrant median rev / niche median rev; the falsification tell's trace row. */
  entrant_ratio?: number | null;
  /** 0..1 SINGLEPLAYER SHARE (a no-netcode proxy, not scope); the lens' trace row. */
  solo_viability?: number | null;
  /** 0..1 share of the cut's games that are self-published — solo-evidence trio. */
  self_published_share?: number | null;
  /** 0..1 share of the cut's games that are indie — solo-evidence trio. */
  indie_share?: number | null;
  /** Median of member games' median playtime, in HOURS — solo-evidence trio. */
  med_playtime_h?: number | null;
  /** Absolute 24-month review volume — the emerging trace's headline number. */
  reviews_24m?: number | null;
  /** Prior-window review volume — the demand row's base clause ("on a 204.7K base"). */
  reviews_prev_24m?: number | null;
  /** Share of reviews_24m from games released in the last 24 months (emerging tell 2). */
  reviews_24m_new_share?: number | null;
}

export interface RadarVerdict {
  ring: RadarRing;
  /** True when the placement rests on weak/partial evidence (no usable demand trend,
   * or the no-signal catch-all) — the board renders these with a hedged tooltip. */
  caution: boolean;
  /** One short human-readable clause for the tooltip/legend title. */
  reason: string;
}

/** One row of the verdict dossier: the niche's own number, the bar it was judged
 * against, and the outcome. Produced by radarVerdictTrace() from the SAME evaluation
 * that picks the ring — see the module doc's THE TRACE section. */
export interface VerdictCheck {
  /** Stable machine id (tests/keys). "volume"/"new_share" appear on emerging traces only. */
  id: "demand" | "supply" | "concentration" | "entrants" | "solo" | "volume" | "new_share";
  label: string;
  /** The niche's own number, formatted; "unknown" when absent. */
  value: string;
  /** The bar the value is judged against, spelled out. */
  threshold: string;
  /** true = clears the bar, false = fails it, null = unknown / no pass-fail claim. */
  pass: boolean | null;
  /** One short clause of interpretation. */
  note: string;
  /** True when this check can move the ring (demand / supply / concentration, or the
   * mart's youth flag on emerging traces). The falsification tell (entrants) and the
   * solo lens are decides:false BY CONSTRUCTION — the trace is built by the same
   * evaluation that picks the ring, so a tell cannot leak into the decision. */
  decides: boolean;
}

export interface RadarVerdictTrace extends RadarVerdict {
  checks: VerdictCheck[];
}

/** null/undefined/NaN/Infinity all collapse to "unknown". */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Percent-UNITS formatter (demand_trend_24m_pct is already %): "+40.0%", "−16.0%".
 * (fmtSigned takes fractions; this one exists for the columns that arrive as percent.) */
function fmtPctUnits(v: number, digits = 1): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}

/**
 * The full verdict evaluation: ring + caution + reason PLUS the dossier trace. The pass/
 * fail atoms below fill the trace rows AND decide the ring — same booleans, same body —
 * so the explanation can never disagree with the verdict. radarVerdict() is this minus
 * the checks.
 */
export function radarVerdictTrace(input: RadarVerdictInput): RadarVerdictTrace {
  const demand = num(input.demand_trend_24m_pct);
  const sat = num(input.saturation_yoy);
  const wc = num(input.winner_concentration);
  const opp = num(input.opportunity_v2);
  const er = num(input.entrant_ratio);
  const solo = num(input.solo_viability);
  const vol = num(input.reviews_24m);
  const prev = num(input.reviews_prev_24m);
  const newShare = num(input.reviews_24m_new_share);
  const selfPub = num(input.self_published_share);
  const indie = num(input.indie_share);
  const medH = num(input.med_playtime_h);

  // The solo LENS row — shared by both trace shapes. decides:false: see module doc.
  // The pass bar stays on the SINGLEPLAYER SHARE alone; the evidence trio is inlined into
  // the value ("0.98 singleplayer · 50% self-pub · 71% indie · median 5.7h content") so
  // the row SHOWS the member profile instead of asserting a bare share. Missing evidence
  // clauses are omitted (older mart), never invented.
  const soloPass = solo === null ? null : solo >= SOLO_FRIENDLY_MIN;
  const heavyContent = medH !== null && medH > SOLO_HEAVY_CONTENT_H;
  const evidence = [
    selfPub !== null ? `${Math.round(selfPub * 100)}% self-pub` : null,
    indie !== null ? `${Math.round(indie * 100)}% indie` : null,
    medH !== null ? `median ${medH.toFixed(1)}h content` : null,
  ].filter((p): p is string => p !== null);
  // The share is a FLAG, not a scale (module doc): the catalog median is 0.975 and 75% of
  // niches sit inside a 0.047-wide band, so the only honest reads are "unremarkable",
  // "has a real multiplayer minority" and "multiplayer-dependent". The middle band —
  // passes SOLO_FRIENDLY_MIN but sits under SOLO_MIXED_MIN, i.e. the catalog's bottom
  // decile — used to render identically to a 1.00, which flattered it.
  const soloMixed = solo !== null && soloPass === true && solo < SOLO_MIXED_MIN;
  const soloNote =
    soloPass === null
      ? "share unknown — never counted as solo-friendly (lens, not a ring input)"
      : soloPass
        ? soloMixed
          ? "clears the bar, but a real multiplayer minority — bottom decile of the catalog (lens — never moves a ring)"
          : "mostly singleplayer members — a no-netcode proxy, not a scope claim (lens — never moves a ring)"
        : "leans multiplayer/team-scale (lens — never moves a ring)";
  const soloCheck: VerdictCheck = {
    id: "solo",
    label: "Solo evidence",
    value: [solo === null ? "unknown" : `${solo.toFixed(2)} singleplayer`, ...evidence].join(" · "),
    threshold: `≥ ${SOLO_FRIENDLY_MIN} singleplayer share`,
    pass: soloPass,
    // The heavy-content caution is NEUTRAL: it rides the note, never the pass/fail.
    note: heavyContent ? `${soloNote} — heavy content scope for a solo build` : soloNote,
    decides: false,
  };

  // 0. emerging — pre-empts EVERYTHING (see precedence doc): an emerging niche's trend %
  //    AND its saturation read are both artifacts of its base, so neither the demand
  //    verdicts nor the crowding arms may fire. Not a caution: the evidence is solid; the
  //    honest claim is "no comparable base", and the meaningful number is absolute volume
  //    — so the TRACE swaps the %-checks for volume + new-game share. The COPY names the
  //    tell that fired (see EMERGING_NEW_MASS_SHARE): only a new-game review mass at or
  //    above that bar justifies "young label" wording — an emerging flag with LOW (or
  //    unknown) new_share came from the low-base floor, i.e. a small stable niche, and
  //    calling it "new" would be a fabricated claim. Both suppress the headline %.
  if (input.demand_emerging === true) {
    const youngLabel = newShare !== null && newShare >= EMERGING_NEW_MASS_SHARE;
    return {
      ring: "emerging",
      caution: false,
      reason: youngLabel ? "young label — no comparable demand base" : "base too small for a % read",
      checks: [
        {
          id: "volume",
          label: "Review volume",
          value: vol === null ? "unknown" : `${fmtCompact(vol)} reviews / 24m`,
          threshold: "judged on absolute volume",
          pass: null,
          note: youngLabel
            ? "young label — its prior 24-month window is near zero by construction, so no " +
              "trend-% check is honest in either direction"
            : "prior 24-month window under the comparability floor — base too small for a " +
              "% read in either direction",
          decides: true, // the mart's emerging flag IS the ring decision
        },
        {
          id: "new_share",
          label: "New-game share",
          value: newShare === null ? "unknown" : `${Math.round(newShare * 100)}% from games ≤ 24m old`,
          threshold: `≥ ${Math.round(EMERGING_NEW_MASS_SHARE * 100)}% marks a young label`,
          pass: null,
          note: youngLabel
            ? "the review mass IS the newest games — the young-label tell"
            : "below the young-label bar — a small stable niche, not a new label",
          decides: false,
        },
        soloCheck,
      ],
    };
  }

  // The pass/fail atoms — these SAME booleans fill the trace rows and decide the ring.
  const demandEnter = demand !== null && demand >= DEMAND_ENTER_PCT;
  const demandDecline = demand !== null && demand <= DEMAND_DECLINE_PCT;
  const demandHolding = demand !== null && demand >= DEMAND_HOLD_PCT;
  const supplyCalm = sat === null || sat <= SAT_FLOOD_YOY; // unknown does not veto enter
  const flooding = sat !== null && sat > SAT_FLOOD_YOY;
  const winnerTakeMost = wc !== null && wc > WC_WINNER_TAKE_MOST;

  const baseClause = prev !== null ? ` · prior window ${fmtCompact(prev)} reviews` : "";
  const checks: VerdictCheck[] = [
    {
      id: "demand",
      label: "Demand",
      value: demand === null ? "unknown" : `${fmtPctUnits(demand)} / 24m`,
      threshold: `≥ ${fmtPctUnits(DEMAND_ENTER_PCT)} / 24m to enter`,
      pass: demand === null ? null : demandEnter,
      note:
        demand === null
          ? "no prior-window baseline — the enter/declining verdicts are unreachable"
          : demandEnter
            ? `structural growth — clears the enter bar${baseClause}`
            : demandDecline
              ? `sustained decline (≤ ${fmtPctUnits(DEMAND_DECLINE_PCT, 0)} / 24m)${baseClause}`
              : demandHolding
                ? `holding — real demand, below the enter bar${baseClause}`
                : `softening — mild multi-year drift${baseClause}`,
      decides: true,
    },
    {
      id: "supply",
      // "Release pipeline", not "Supply" (2026-09-01). This row and the opp v2 score printed
      // beside it answer two different questions about supply, and the bare word "Supply"
      // implied one answer: readers took the passing row as a promise the score would not
      // brake. This row is the ABSOLUTE read — how fast the pipeline is growing, the same
      // +15%/yr line RadarBoard.tsx draws as the quadrant divider. The score's brake is the
      // RELATIVE read (pipeline growth NET of demand growth) and additionally brakes on
      // entrant_ratio. They contradict on 59 of 211 comparable niches (28.0%) on the default
      // cut — deliberately; see the ONE MODEL, TWO VIEWS block. value/pass/decides are
      // untouched here on purpose: this is a naming fix, and no ring may move.
      label: "Release pipeline",
      value: sat === null ? "unknown" : `${fmtSigned(sat, 1)} releases YoY`,
      threshold: `≤ ${fmtSigned(SAT_FLOOD_YOY, 0)} YoY, absolute — the opp v2 score reads it against demand`,
      pass: sat === null ? null : !flooding,
      note:
        sat === null
          ? "unknown — does not veto enter, but the flooding read is unreachable"
          : flooding
            ? "supply flooding — vetoes enter"
            : "pipeline calm",
      decides: true,
    },
    {
      id: "concentration",
      label: "Concentration",
      value: wc === null ? "unknown" : wc.toFixed(2),
      threshold: `≤ ${WC_WINNER_TAKE_MOST} (winner-take-most above)`,
      pass: wc === null ? null : !winnerTakeMost,
      note:
        wc === null
          ? "unknown — the winner-take-most read is unreachable"
          : winnerTakeMost
            ? "winner-take-most revenue — judge by the median, not the hits"
            : wc > WC_WINNER_TAKE_MOST - 0.05
              ? "a hair under the winner-take-most bar"
              : "revenue spread across the field",
      decides: true,
    },
    {
      id: "entrants",
      label: "Newcomer economics",
      value: er === null ? "unknown" : er.toFixed(2),
      threshold: `≥ ${ENTRANT_RATIO_PAR.toFixed(1)} (catalog norm ~${ENTRANT_RATIO_CATALOG_NORM})`,
      pass: er === null ? null : er >= ENTRANT_RATIO_PAR,
      // "never moves the ring" is still true and still the point — but it was reading as
      // "this number changes nothing", which is false about the OTHER number on the same
      // panel. entrant_ratio feeds mart_niche.sql's entrant_room, and supply_room takes the
      // WEAKER of flood_room / entrant_room, so this row alone can sink a printed score:
      // 15 of the 222 niches on the default cut are braked below x0.80 purely by it, with
      // the ring reading "pipeline calm". Metroidvania is the sharpest — unbraked 56.0,
      // printed 30.1, and nothing else moved.
      note:
        er === null
          ? "unknown — no read on how recent entrants earn"
          : er >= ENTRANT_RATIO_PAR
            ? "recent entrants earn at or above the niche median"
            : `recent entrants earn ${Math.round((1 - er) * 100)}% below the niche median — falsification tell, never moves the ring, but it does brake the opp v2 score shown alongside`,
      decides: false,
    },
    soloCheck,
  ];

  // Ring decision — the same precedence chain as ever (see module doc), expressed over
  // the atoms above so the trace can't drift from it.
  let verdict: RadarVerdict;
  if (demandEnter && supplyCalm) {
    // 1. enter — structural growth AND supply not flooding (unknown saturation passes).
    verdict = { ring: "enter", caution: false, reason: "demand in structural growth, supply not flooding" };
  } else if (demandDecline) {
    // 2. declining — sustained demand decay, checked BEFORE crowded (precedence doc).
    verdict = { ring: "declining", caution: false, reason: "demand in sustained decline" };
  } else if (winnerTakeMost) {
    // 3. crowded — winner-take-most is a structural fact independent of trend...
    verdict = { ring: "crowded", caution: false, reason: "winner-take-most revenue" };
  } else if (flooding && (demand === null || demand <= 0)) {
    //    ...and a flooding pipeline is crowding unless demand is demonstrably keeping up
    //    (demand unknown does NOT rescue a flooding niche — but it is flagged caution).
    verdict = {
      ring: "crowded",
      caution: demand === null,
      reason: demand === null ? "supply flooding, demand unknown" : "supply flooding, demand not keeping up",
    };
  } else if (demandEnter) {
    // Demand cleared the enter bar but supply floods (and positive demand keeps it out
    // of crowded): watch, with the honest reason — the dossier's supply row carries the
    // failing check. Same ring as before the trace existed; only the reason sharpened.
    verdict = { ring: "watch", caution: false, reason: "demand surging, but supply flooding" };
  } else if (demandHolding) {
    // 4. watch — a real demand reading is solid evidence...
    verdict = { ring: "watch", caution: false, reason: "demand holding" };
  } else if (demand !== null) {
    // -30% < demand < -10% per 24m: mild multi-year drift — watch, but honestly labeled.
    verdict = { ring: "watch", caution: false, reason: "demand softening" };
  } else if (opp !== null && opp >= OPP_WATCH_SCORE) {
    // ...a bare v2 score is not, so it carries the caution flag...
    verdict = { ring: "watch", caution: true, reason: "high v2 score, no demand trend" };
  } else {
    // ...and everything else parks here as the honest no-signal default.
    verdict = { ring: "watch", caution: true, reason: "no strong signal" };
  }
  return { ...verdict, checks };
}

/** The ring verdict alone — radarVerdictTrace() minus the checks (same evaluation, by
 * construction: this is a destructure, not a re-implementation). */
export function radarVerdict(input: RadarVerdictInput): RadarVerdict {
  const { ring, caution, reason } = radarVerdictTrace(input);
  return { ring, caution, reason };
}

// ---- solo-viability lens (NOT part of the verdict — see module doc) ---------------------

/** solo_viability at or above which a niche counts as solo-buildable. MEASURED (2026-08-31,
 * 219-niche live cut): the catalog MEDIAN is 0.975 and only 3.2% of niches fall below this
 * bar — which is what makes 0.8 the right cut, not a compromise. (The previous comment here
 * said "the catalog norm is ~0.9"; 0.9 is the 10th percentile, not the norm. See the
 * module doc's SOLO VIABILITY IS A FLAG block.)
 * MUST stay in lockstep with RADAR_SOLO_FRIENDLY_MIN in api/app/routers/niches.py — the
 * server filters the radar population (`solo_only`, the board's default-on toggle) on the
 * SAME bar this module renders in the legend, tooltip and dossier; a drift would make the
 * legend lie about what the server filtered. */
export const SOLO_FRIENDLY_MIN = 0.8;

/** solo_viability at or above which a niche is unremarkably solo-buildable — the catalog's
 * 10th percentile (p10 = 0.913), so ~92% of niches clear it. Between this and
 * SOLO_FRIENDLY_MIN is the 'mixed' band: passes the solo-only filter, but has a real
 * multiplayer minority among its members (Hero Shooter 0.800, Minigames 0.805, Escape Room
 * 0.836, Class-Based 0.851, Football (Soccer) 0.853). DISPLAY ONLY — it sharpens the
 * dossier's note and never changes the row's pass/fail, let alone a ring. Mirrors
 * SOLO_TIER_SOLO_MIN in etl/build_marts.py, which cuts mart_niche.solo_tier at the same
 * two bars. */
export const SOLO_MIXED_MIN = 0.9;

/** med_playtime_h above which the dossier's solo row carries the neutral caution
 * "heavy content scope for a solo build" — a median member offering 20+ hours of
 * content is a scope signal the singleplayer share alone hides. Note-only: it never
 * changes the row's pass/fail, let alone a ring. */
export const SOLO_HEAVY_CONTENT_H = 20;

export type SoloBucket = "solo" | "team" | "unknown";

/**
 * Classify a niche's solo_viability into the board's lens buckets. "unknown" is its own
 * honest bucket (mart predates the column, or the cut wasn't scored) — it is included
 * under the "All" filter only, never counted as solo-friendly or team-scale.
 */
export function soloBucket(soloViability: number | null | undefined): SoloBucket {
  const v = num(soloViability);
  if (v === null) return "unknown";
  return v >= SOLO_FRIENDLY_MIN ? "solo" : "team";
}

// ---- deterministic layout helpers -------------------------------------------------------

/**
 * FNV-1a 32-bit string hash. The board derives EVERY jitter (blip angle, blip radius)
 * from this — never Math.random — so a niche sits at the same spot on every render,
 * every visit, every machine.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic [0, 1) from a string, for angle/radius jitter. */
export function hash01(s: string): number {
  return hashString(s) / 0x1_0000_0000;
}

/** Blip radius bounds (px in the board's viewBox space). */
export const BLIP_R_MIN = 3;
export const BLIP_R_MAX = 9;

/**
 * sqrt-scaled blip radius from p90 revenue, bounded to [BLIP_R_MIN, BLIP_R_MAX].
 * sqrt so AREA tracks revenue (a dot 4x the revenue reads 2x the radius, not 4x).
 * Null/unknown revenue -> the minimum dot, never a hole in the board.
 */
export function blipRadius(p90Rev: number | null | undefined, maxP90: number | null | undefined): number {
  const v = num(p90Rev);
  const max = num(maxP90);
  if (v === null || v <= 0 || max === null || max <= 0) return BLIP_R_MIN;
  const t = Math.sqrt(Math.min(v, max) / max);
  return BLIP_R_MIN + t * (BLIP_R_MAX - BLIP_R_MIN);
}
