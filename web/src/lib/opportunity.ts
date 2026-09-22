/**
 * THE OPPORTUNITY SCORE, TAKEN APART — the model behind components/OpportunityBreakdown.
 *
 * The owner's rule: never a lone score without its components. /api/niches rows already
 * carry every part (momentum, market_pull, revenue_spread, quality_gap, supply_room,
 * supply_brake) and the raw inputs behind them; this module lays them out as the blend the
 * mart actually computes (etl/marts/mart_niche.sql, `subscores` → `scored_v2`):
 *
 *   core  = Σ weight × part ÷ Σ weight   (over the parts that were scored — renormalised)
 *   score = clamp(core × supply_brake, 0, 100)
 *
 * and, where the row carries the raw inputs, works each part's own formula through the
 * row's numbers ("100 × (1 − 0.912) ÷ 0.30 = 29.3").
 *
 * SELF-CHECKING. Every worked line is recomputed here from the served inputs with the
 * mart's own formula and shown ONLY when it reproduces the served value (to the mart's
 * rounding). A constant that drifted between build_marts.py and this file would therefore
 * hide the arithmetic rather than print a wrong one — and `reproduces` exposes the drift
 * for the final score. The constants mirror etl/build_marts.py (W2_*, SUPPLY_BRAKE_FLOOR,
 * OPP_*); the demand / flood / concentration anchors come from lib/radarVerdict.ts, which
 * the ETL's tests already hold in lockstep with the mart.
 */

import { fmtPct } from "./format";
import { DEMAND_ENTER_PCT, ENTRANT_RATIO_CATALOG_NORM, SAT_FLOOD_YOY, WC_WINNER_TAKE_MOST } from "./radarVerdict";

/** etl/build_marts.py W2_MOMENTUM / W2_MARKET / W2_SPREAD / W2_QUALITY. */
export const OPP_WEIGHTS = { momentum: 0.4, market_pull: 0.22, revenue_spread: 0.2, quality_gap: 0.18 } as const;
/** etl/build_marts.py SUPPLY_BRAKE_FLOOR — a fully supply-pressured niche keeps 35% of its core. */
export const SUPPLY_BRAKE_FLOOR = 0.35;
/** etl/build_marts.py OPP_ENTRANT_FULL — newcomer earnings at or below this: entrant room 0. */
export const OPP_ENTRANT_FULL = 0.5;
/** etl/build_marts.py OPP_MARKET_MEDIAN_W — market_pull = w × typical-game rank + (1 − w) × size rank. */
export const OPP_MARKET_MEDIAN_W = 0.6;
/** A sub-score below this pulls the score down; 50 is each part's neutral point. */
export const PART_NEUTRAL = 50;
/** A brake under this is "holding the score back" in the headline. */
export const BRAKE_BITES_BELOW = 0.8;

export type OpportunityPartKey = keyof typeof OPP_WEIGHTS;

export const PART_ORDER: OpportunityPartKey[] = ["momentum", "market_pull", "revenue_spread", "quality_gap"];

export const PART_LABEL: Record<OpportunityPartKey, string> = {
  momentum: "Momentum",
  market_pull: "Market pull",
  revenue_spread: "Revenue spread",
  quality_gap: "Quality gap",
};

/** The fields the breakdown reads — every one is on NicheRow already, so a row passes
 * straight through: `opportunityBreakdown(row)`. */
export interface OpportunityInputs {
  opportunity_v2?: number | null;
  momentum?: number | null;
  market_pull?: number | null;
  revenue_spread?: number | null;
  quality_gap?: number | null;
  supply_room?: number | null;
  supply_brake?: number | null;
  demand_trend_24m_pct?: number | null;
  demand_emerging?: boolean | null;
  saturation_yoy?: number | null;
  entrant_ratio?: number | null;
  winner_concentration?: number | null;
  /** The API's `demand` column = the Typical-game rank. */
  demand?: number | null;
  market_size?: number | null;
  beatable_share?: number | null;
}

export interface OpportunityPart {
  key: OpportunityPartKey;
  label: string;
  /** The sub-score as served (0–100), null when the mart did not score it. */
  value: number | null;
  /** Nominal blend weight. */
  weight: number;
  /** Weight after renormalising over the scored parts; null when not scored. */
  effectiveWeight: number | null;
  /** effectiveWeight × value — the points this part adds to the core. */
  contribution: number | null;
  /** The part's own formula worked through this row's numbers, when it reproduces. */
  worked: string | null;
  /** Why the value is a sentinel (not scored / capped / floored), else null. */
  sentinel: { tag: string; detail: string } | null;
}

export interface OpportunityBreakdownModel {
  /** False when the row predates the scored parts (mart before the 2026-08-31 rebuild). */
  available: boolean;
  parts: OpportunityPart[];
  /** Σ nominal weights of the scored parts (1 when all four were scored). */
  weightTotal: number;
  renormalised: boolean;
  /** Σ contributions. */
  core: number | null;
  /** The multiplier: the served supply_brake, or 1.00 when supply is unknown. */
  brake: number | null;
  brakeKnown: boolean;
  supplyRoom: number | null;
  /** Recomputed from the raw inputs (null when not computable from this row). */
  floodRoom: number | null;
  entrantRoom: number | null;
  /** Which read set supply_room, when the recomputation reproduces it. */
  binding: "flood" | "entrant" | null;
  brakeWorked: string | null;
  brakeSentinel: { tag: string; detail: string } | null;
  /** The served opportunity_v2. */
  score: number | null;
  /** clamp(core × brake, 0, 100) from the served parts. */
  recomputed: number | null;
  /** Whether the served parts reproduce the served score (null when either is missing). */
  reproduces: boolean | null;
  /** The blend worked through: "(0.40 × 38.9 + …) × 0.35 = 23.8". */
  scoreWorked: string | null;
  /** The bearish-first, plain-language takeaway. */
  headline: string;
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
/** Round to `d` decimals — worked lines compute from the numbers they DISPLAY, so the
 * arithmetic on screen is exact to the digits shown. */
const r = (v: number, d: number) => Number(v.toFixed(d));
/** A multiplier at the mart's 4-decimal precision without trailing noise: ×0.35, ×0.4845. */
export const fmtMultiplier = (v: number) => v.toFixed(4).replace(/0{1,2}$/, "");
/** "1 + 0.741" / "1 − 0.074" — a signed term inside ln(). */
const onePlus = (x: number) => `1 ${x < 0 ? "−" : "+"} ${Math.abs(x).toFixed(3)}`;
/** Does a worked result reproduce the served value? The mart publishes sub-scores to 2
 * decimals, so anything within a couple of hundredths is the same number. */
const agrees = (a: number, b: number, tolerance = 0.02) => Math.abs(a - b) <= tolerance;

/** momentum per mart_niche.sql: 50 + 50·tanh(g / g_enter), the ÷2 annualisation cancelling. */
export function momentumFromTrend(trendPct: number): number {
  return 50 + 50 * Math.tanh(Math.log(Math.max(1 + trendPct / 100, 0.001)) / Math.log(1 + DEMAND_ENTER_PCT / 100));
}

/** revenue_spread per mart_niche.sql. */
export function revenueSpreadFromConcentration(wc: number): number {
  return 100 * clamp01((1 - wc) / (2 * (1 - WC_WINNER_TAKE_MOST)));
}

/** flood_room per mart_niche.sql (demand growth COALESCEd to 0, as the mart does). */
export function floodRoom(saturationYoy: number, trendPct: number | null): number {
  const supplyGrowth = Math.log(Math.max(1 + saturationYoy, 0.001));
  const demandGrowth = trendPct === null ? 0 : Math.log(Math.max(1 + trendPct / 100, 0.001)) / 2;
  return 100 * (1 - clamp01((supplyGrowth - demandGrowth) / (2 * Math.log(1 + SAT_FLOOD_YOY))));
}

/** entrant_room per mart_niche.sql — capped at the catalog norm. */
export function entrantRoom(entrantRatio: number): number {
  return 100 * clamp01((entrantRatio - OPP_ENTRANT_FULL) / (ENTRANT_RATIO_CATALOG_NORM - OPP_ENTRANT_FULL));
}

export function opportunityBreakdown(row: OpportunityInputs): OpportunityBreakdownModel {
  const emerging = row.demand_emerging === true;
  const trend = num(row.demand_trend_24m_pct);
  const sat = num(row.saturation_yoy);
  const er = num(row.entrant_ratio);
  const wc = num(row.winner_concentration);
  const typical = num(row.demand);
  const size = num(row.market_size);
  const beatable = num(row.beatable_share);

  const served: Record<OpportunityPartKey, number | null> = {
    momentum: num(row.momentum),
    market_pull: num(row.market_pull),
    revenue_spread: num(row.revenue_spread),
    quality_gap: num(row.quality_gap),
  };
  // The rebuilt mart always scores market_pull (percentiles never go NULL); a row without it
  // is a row from before the rebuild, which carries no parts to show.
  const available = row.market_pull !== undefined && served.market_pull !== null;

  const scored = PART_ORDER.filter((k) => served[k] !== null);
  const weightTotal = scored.reduce((s, k) => s + OPP_WEIGHTS[k], 0);
  const renormalised = available && scored.length < PART_ORDER.length;

  const parts: OpportunityPart[] = PART_ORDER.map((key) => {
    const value = served[key];
    const weight = OPP_WEIGHTS[key];
    const effectiveWeight = value === null || weightTotal === 0 ? null : weight / weightTotal;
    const contribution = effectiveWeight === null || value === null ? null : effectiveWeight * value;
    let worked: string | null = null;
    let sentinel: OpportunityPart["sentinel"] = null;

    if (key === "momentum") {
      if (value === null) {
        sentinel = emerging
          ? { tag: "not scored", detail: "Not scored: an emerging niche has no comparable demand base, so its trend can't be read — its weight is shared out among the other parts." }
          : { tag: "not scored", detail: "Not scored: no prior 24-month window to compare against — its weight is shared out among the other parts." };
      } else if (trend !== null && !emerging) {
        // The served trend is 1-decimal percent, so its 3-decimal fraction is exact.
        const rec = momentumFromTrend(trend);
        if (agrees(rec, value)) worked = `50 + 50 × tanh( ln(${onePlus(trend / 100)}) ÷ ln 1.40 ) = ${f2(rec)}`;
      }
    } else if (key === "market_pull") {
      if (value !== null && typical !== null && size !== null) {
        const [t, s] = [r(typical, 2), r(size, 2)];
        const rec = OPP_MARKET_MEDIAN_W * t + (1 - OPP_MARKET_MEDIAN_W) * s;
        if (agrees(rec, value)) worked = `0.6 × ${f2(t)} + 0.4 × ${f2(s)} = ${f2(rec)}`;
      }
    } else if (key === "revenue_spread") {
      if (value === null) {
        sentinel = { tag: "not scored", detail: "Not scored: revenue concentration is unknown for this cut — its weight is shared out among the other parts." };
      } else if (wc !== null) {
        const w = r(wc, 4);
        const rec = revenueSpreadFromConcentration(w);
        if (agrees(rec, value)) {
          const span = f2(2 * (1 - WC_WINNER_TAKE_MOST));
          worked =
            rec >= 100 || rec <= 0
              ? `100 × clamp( (1 − ${w.toFixed(4)}) ÷ ${span}, 0, 1 ) = ${f2(rec)}`
              : `100 × (1 − ${w.toFixed(4)}) ÷ ${span} = ${f2(rec)}`;
          if (rec >= 100)
            sentinel = { tag: "capped at 100", detail: `Capped at 100: the top 5% hold ${fmtPct(wc, 0)} of revenue — at or under the 70% where this part maxes out.` };
          else if (rec <= 0) sentinel = { tag: "floored at 0", detail: "Floored at 0: the top 5% hold all of the revenue." };
        }
      }
    } else if (key === "quality_gap") {
      if (value !== null && beatable !== null)
        worked = `rank of a ${fmtPct(beatable, 0)} beatable share among the niches in this cut = ${f2(value)}`;
    }
    return { key, label: PART_LABEL[key], value, weight, effectiveWeight, contribution, worked, sentinel };
  });

  const core = available ? parts.reduce((s, p) => s + (p.contribution ?? 0), 0) : null;

  // ---- the brake ---------------------------------------------------------------------
  const room = num(row.supply_room);
  const servedBrake = num(row.supply_brake);
  const brakeKnown = room !== null;
  const brake = !available ? null : servedBrake ?? (brakeKnown ? SUPPLY_BRAKE_FLOOR + (1 - SUPPLY_BRAKE_FLOOR) * (room / 100) : 1);
  const flood = sat !== null && !emerging ? floodRoom(sat, trend) : null;
  const entrant = er !== null && !emerging ? entrantRoom(er) : null;
  let binding: OpportunityBreakdownModel["binding"] = null;
  if (room !== null) {
    const candidates = [flood !== null ? { k: "flood" as const, v: flood } : null, entrant !== null ? { k: "entrant" as const, v: entrant } : null].filter(
      (c): c is { k: "flood" | "entrant"; v: number } => c !== null,
    );
    if (candidates.length > 0) {
      const weakest = candidates.reduce((a, b) => (b.v < a.v ? b : a));
      if (agrees(weakest.v, room)) binding = weakest.k;
    }
  }
  let brakeWorked: string | null = null;
  let brakeSentinel: OpportunityBreakdownModel["brakeSentinel"] = null;
  if (available && brake !== null) {
    if (!brakeKnown) {
      brakeSentinel = {
        tag: "unknown → ×1.00",
        detail: emerging
          ? "No brake: an emerging niche's release and newcomer reads are artifacts of its youth, and unknown supply is never a penalty."
          : "No brake: neither supply read is available, and unknown supply is never a penalty.",
      };
    } else {
      const rm = r(room, 2);
      const rec = SUPPLY_BRAKE_FLOOR + (1 - SUPPLY_BRAKE_FLOOR) * (rm / 100);
      if (agrees(rec, brake, 0.0002)) brakeWorked = `0.35 + 0.65 × ${f2(rm)} ÷ 100 = ×${fmtMultiplier(rec)}`;
      if (rm <= 0) brakeSentinel = { tag: "full brake", detail: "Supply room is floored at 0, so the brake is at its full ×0.35: the score keeps 35% of its core." };
    }
  }

  // ---- the score -------------------------------------------------------------------------
  // Computed from the parts and the brake AS SERVED (2 and 4 decimals) — exactly the numbers
  // the worked line prints — so the arithmetic on screen checks out to the digit.
  const score = num(row.opportunity_v2);
  const recomputed = core !== null && brake !== null ? Math.min(100, Math.max(0, core * brake)) : null;
  const reproduces = score !== null && recomputed !== null ? Math.abs(score - recomputed) <= 0.05 : null;
  const scoreWorked =
    core !== null && brake !== null && recomputed !== null
      ? `(${parts
          .filter((p) => p.value !== null)
          .map((p) => `${f2(p.weight)} × ${f2(p.value as number)}`)
          .join(" + ")})${renormalised ? ` ÷ ${f2(weightTotal)}` : ""} × ${fmtMultiplier(brake)} = ${f2(recomputed)}`
      : null;

  return {
    available,
    parts,
    weightTotal,
    renormalised,
    core,
    brake,
    brakeKnown,
    supplyRoom: room,
    floodRoom: flood,
    entrantRoom: entrant,
    binding,
    brakeWorked,
    brakeSentinel,
    score,
    recomputed,
    reproduces,
    scoreWorked,
    headline: headlineFor({ available, parts, brake, brakeKnown, binding, er, emerging }),
  };
}

/** The takeaway, bearish reading first: what holds the score back, before what props it up. */
function headlineFor(m: {
  available: boolean;
  parts: OpportunityPart[];
  brake: number | null;
  brakeKnown: boolean;
  binding: "flood" | "entrant" | null;
  er: number | null;
  emerging: boolean;
}): string {
  if (!m.available) return "No breakdown: this data build predates the scored parts of the Opportunity score.";
  const scored = m.parts.filter((p) => p.value !== null);
  const weakest = scored.reduce<OpportunityPart | null>((a, p) => (a === null || (p.value as number) < (a.value as number) ? p : a), null);

  if (m.brakeKnown && m.brake !== null && m.brake < BRAKE_BITES_BELOW) {
    const why =
      m.binding === "flood"
        ? "releases are growing faster than demand"
        : m.binding === "entrant" && m.er !== null
          ? `newcomers earn ${f2(m.er)}× the back catalog's median, under the ${ENTRANT_RATIO_CATALOG_NORM}× norm`
          : "releases are outgrowing demand, or newcomers underearn";
    return `Held back by the supply brake (×${f2(m.brake)}): ${why} — the score keeps ${Math.round(m.brake * 100)}% of its core.`;
  }
  const brakeNote = !m.brakeKnown
    ? "no supply read, so no brake"
    : m.brake !== null && m.brake < 1
      ? `a light supply brake (×${f2(m.brake)})`
      : "no supply brake";
  if (weakest && (weakest.value as number) < PART_NEUTRAL) {
    const below = scored.filter((p) => (p.value as number) < PART_NEUTRAL);
    const list = below.map((p) => `${p.label} ${f1(p.value as number)}`).join(", ");
    return `Weakest: ${list} — below the neutral 50; ${brakeNote}.`;
  }
  if (weakest) {
    return `Every part is at or above neutral (weakest: ${weakest.label} ${f1(weakest.value as number)}); ${brakeNote}.`;
  }
  return `No part could be scored; ${brakeNote}.`;
}
