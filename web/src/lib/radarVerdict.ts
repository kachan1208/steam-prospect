/**
 * Ring verdicts + deterministic layout helpers for the Radar board (the radial
 * "tech-radar" plate on /radar). Pure functions only — no React, no fetch — so every
 * rule is unit-testable and the board component stays geometry-only.
 *
 * RINGS, inner -> outer (inner = strongest "build here" signal):
 *   enter     "Enter now"  — demand rising fast while supply is not flooding.
 *   watch     "Watch"      — demand flat-to-up, or a high v2 score without trend
 *                            evidence (caution). Also the CATCH-ALL: a niche with no
 *                            strong signal in either direction parks here rather than
 *                            being invented into a stronger ring.
 *   crowded   "Crowded"    — supply flooding without demand keeping up, or a
 *                            winner-take-most revenue structure.
 *   declining "Declining"  — demand falling hard.
 *
 * PRECEDENCE (first match wins; every niche gets exactly one ring):
 *   1. enter      — the strongest positive claim, checked first.
 *   2. declining  — a hard demand collapse trumps crowding: a niche can be both
 *                   flooding AND collapsing (entrants still arriving into falling
 *                   demand); "declining" is the outer, stronger warning, so it wins.
 *   3. crowded    — winner-take-most OR supply flooding with flat/negative/unknown
 *                   demand.
 *   4. watch      — demand >= 0 (but not enter), or opportunity_v2 evidence with a
 *                   caution flag, or the no-signal catch-all (also flagged caution).
 *
 * FIELD UNITS (verified against the mart, not assumed):
 *   - demand_trend_90d_pct is PERCENT units (+15 means +15%), from mart_niche's
 *     90-day review-histogram windows. Since 2026-08-26 it rides every NicheRow /
 *     GET /api/niches row (floor-independent in the mart), so the board passes each
 *     niche's own value; this lib degrades when it is null/undefined (mart predates
 *     the column, or no prior-window baseline).
 *   - saturation_yoy is a SIGNED FRACTION centred on 0 — (n_recent_year -
 *     n_prior_year) / n_prior_year in etl/marts/mart_niche.sql — so "release
 *     pipeline grew more than 15% YoY" is saturation_yoy > 0.15, the same cut a
 *     1.15 recent/prior RATIO form would express.
 *   - winner_concentration is a 0..1 share; > 0.85 is the winner-take-most flag the
 *     MCP guidance already uses.
 *   - opportunity_v2 is the 0..100 v2 score; >= 60 is "notable" (NicheFinder bolds
 *     at >= 70 = "strong").
 *
 * DEGRADATION (any field may be null/undefined/NaN — treated identically as "unknown"):
 *   - demand unknown  -> enter/declining are unreachable (both are demand claims);
 *                        crowding can still be read from saturation/concentration;
 *                        otherwise the niche parks in watch with caution=true.
 *   - saturation unknown -> does not block enter (matches the spec: null passes);
 *                        the flooding arm of crowded is unreachable.
 *   - concentration unknown -> the winner-take-most arm of crowded is unreachable.
 *   - opportunity unknown -> the watch score arm is unreachable; catch-all still applies.
 *
 * These thresholds are a starting point, kept as named constants so tuning is a
 * one-line diff with the tests updated alongside.
 *
 * SOLO VIABILITY IS A LENS, NOT A RING — deliberately. mart_niche.solo_viability is the
 * share of the cut's scored games playable single-player (catalog norm ~0.9; below ~0.8
 * leans multiplayer/team-scale — the same reading the MCP guidance uses). It never feeds
 * radarVerdict(): a ring answers "is this market worth entering", which holds regardless
 * of team size, while solo-buildability is a property of the READER, not the market.
 * Folding it into the verdict would move dots between rings when the market itself did
 * not change. The board instead encodes it orthogonally — a filter chip plus dot style
 * (hollow = team-scale) — via soloBucket() below.
 */

// ---- thresholds -------------------------------------------------------------------------

/** 90-day demand trend (percent) at or above which a niche can claim "enter". */
export const DEMAND_ENTER_PCT = 15;
/** 90-day demand trend (percent) at or below which a niche is "declining". */
export const DEMAND_DECLINE_PCT = -15;
/** saturation_yoy (signed fraction) above which the release pipeline counts as
 * flooding — +0.15 == +15% more releases YoY == a 1.15x recent/prior ratio. */
export const SAT_FLOOD_YOY = 0.15;
/** winner_concentration share above which the niche is winner-take-most. */
export const WC_WINNER_TAKE_MOST = 0.85;
/** opportunity_v2 score at or above which a trend-less niche still earns "watch". */
export const OPP_WATCH_SCORE = 60;

// ---- verdict ----------------------------------------------------------------------------

export type RadarRing = "enter" | "watch" | "crowded" | "declining";

/** Ring order, inner -> outer. Also the legend's group order. */
export const RING_ORDER: RadarRing[] = ["enter", "watch", "crowded", "declining"];

export const RING_LABEL: Record<RadarRing, string> = {
  enter: "Enter now",
  watch: "Watch",
  crowded: "Crowded",
  declining: "Declining",
};

export interface RadarVerdictInput {
  /** Percent units (+15 = +15%). On every NicheRow since 2026-08-26 (see module doc). */
  demand_trend_90d_pct?: number | null;
  /** Signed fraction centred on 0 (see module doc). */
  saturation_yoy?: number | null;
  /** 0..1 share of niche revenue held by the top game(s). */
  winner_concentration?: number | null;
  /** 0..100 v2 opportunity score. */
  opportunity_v2?: number | null;
}

export interface RadarVerdict {
  ring: RadarRing;
  /** True when the placement rests on weak/partial evidence (no usable demand trend,
   * or the no-signal catch-all) — the board renders these with a hedged tooltip. */
  caution: boolean;
  /** One short human-readable clause for the tooltip/legend title. */
  reason: string;
}

/** null/undefined/NaN/Infinity all collapse to "unknown". */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function radarVerdict(input: RadarVerdictInput): RadarVerdict {
  const demand = num(input.demand_trend_90d_pct);
  const sat = num(input.saturation_yoy);
  const wc = num(input.winner_concentration);
  const opp = num(input.opportunity_v2);

  // 1. enter — demand rising fast AND supply not flooding (unknown saturation passes:
  //    the demand evidence is the claim; absence of a pipeline count doesn't veto it).
  if (demand !== null && demand >= DEMAND_ENTER_PCT && (sat === null || sat <= SAT_FLOOD_YOY)) {
    return { ring: "enter", caution: false, reason: "demand rising, supply not flooding" };
  }

  // 2. declining — a hard demand collapse, checked BEFORE crowded (see precedence doc).
  if (demand !== null && demand <= DEMAND_DECLINE_PCT) {
    return { ring: "declining", caution: false, reason: "demand falling hard" };
  }

  // 3. crowded — winner-take-most is a structural fact independent of trend...
  if (wc !== null && wc > WC_WINNER_TAKE_MOST) {
    return { ring: "crowded", caution: false, reason: "winner-take-most revenue" };
  }
  //    ...and a flooding pipeline is crowding unless demand is demonstrably keeping up
  //    (demand unknown does NOT rescue a flooding niche — but it is flagged caution).
  if (sat !== null && sat > SAT_FLOOD_YOY && (demand === null || demand <= 0)) {
    return {
      ring: "crowded",
      caution: demand === null,
      reason: demand === null ? "supply flooding, demand unknown" : "supply flooding, demand flat",
    };
  }

  // 4. watch — flat-to-up demand is real evidence; a bare v2 score is not, so it carries
  //    the caution flag; everything else parks here as the honest no-signal default.
  if (demand !== null && demand >= 0) {
    return { ring: "watch", caution: false, reason: "demand holding" };
  }
  if (opp !== null && opp >= OPP_WATCH_SCORE) {
    return { ring: "watch", caution: true, reason: "high v2 score, no demand trend" };
  }
  return { ring: "watch", caution: true, reason: "no strong signal" };
}

// ---- solo-viability lens (NOT part of the verdict — see module doc) ---------------------

/** solo_viability at or above which a niche counts as solo-buildable. The catalog norm is
 * ~0.9; below 0.8 the MCP guidance flags meaningful multiplayer/team-scale dependence. */
export const SOLO_FRIENDLY_MIN = 0.8;

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
