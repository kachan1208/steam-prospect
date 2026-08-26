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
 *   emerging  "Emerging"   — a young market (demand_emerging from the mart): real
 *                            volume arriving, but no comparable demand base, so NO
 *                            trend-derived claim is possible in either direction.
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
 *   - opportunity_v2 is the 0..100 v2 score; >= 60 is "notable" (NicheFinder bolds
 *     at >= 70 = "strong").
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
 * share of the cut's scored games playable single-player (catalog norm ~0.9; below ~0.8
 * leans multiplayer/team-scale — the same reading the MCP guidance uses). It never feeds
 * the ring decision: a ring answers "is this market worth entering", which holds regardless
 * of team size, while solo-buildability is a property of the READER, not the market.
 * Folding it into the verdict would move dots between rings when the market itself did
 * not change. Since 2026-08-26 the radar POPULATION is solo-friendly-by-default — but
 * server-side (the API's solo_only param filters on the same 0.8 bar), never by moving
 * rings: with the board's "Solo-friendly only" toggle off, team-scale dots return, drawn
 * hollow via soloBucket() below, in exactly the ring the market evidence puts them.
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
/** winner_concentration share above which the niche is winner-take-most. */
export const WC_WINNER_TAKE_MOST = 0.85;
/** opportunity_v2 score at or above which a trend-less niche still earns "watch". */
export const OPP_WATCH_SCORE = 60;
/** entrant_ratio at or above which recent entrants earn at least the niche median. A
 * falsification TELL, not a ring input (below 1.0 = recent entrants underearn — the same
 * check the MCP guidance runs before recommending a niche). Dossier-only. */
export const ENTRANT_RATIO_PAR = 1.0;
/** Catalog-median entrant_ratio (~1.08) — display context for the dossier's tell row. */
export const ENTRANT_RATIO_CATALOG_NORM = 1.08;

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
  /** 0..1 solo-buildable share; the lens' trace row. */
  solo_viability?: number | null;
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

  // The solo LENS row — shared by both trace shapes. decides:false: see module doc.
  const soloPass = solo === null ? null : solo >= SOLO_FRIENDLY_MIN;
  const soloCheck: VerdictCheck = {
    id: "solo",
    label: "Solo viability",
    value: solo === null ? "unknown" : solo.toFixed(2),
    threshold: `≥ ${SOLO_FRIENDLY_MIN} solo-friendly`,
    pass: soloPass,
    note:
      soloPass === null
        ? "unknown — never counted as solo-friendly (lens, not a ring input)"
        : soloPass
          ? "solo-buildable share of the cut's games (lens — never moves a ring)"
          : "leans multiplayer/team-scale (lens — never moves a ring)",
    decides: false,
  };

  // 0. emerging — pre-empts EVERYTHING (see precedence doc): a young tag's trend % AND
  //    its saturation read are both artifacts of the label's age, so neither the demand
  //    verdicts nor the crowding arms may fire. Not a caution: the evidence (youth) is
  //    solid; the honest claim is "no comparable base", and the meaningful number is
  //    absolute volume — so the TRACE swaps the %-checks for volume + new-game share.
  if (input.demand_emerging === true) {
    return {
      ring: "emerging",
      caution: false,
      reason: "young market — no comparable demand base",
      checks: [
        {
          id: "volume",
          label: "Review volume",
          value: vol === null ? "unknown" : `${fmtCompact(vol)} reviews / 24m`,
          threshold: "judged on absolute volume",
          pass: null,
          note:
            "young tag — its prior 24-month window is near zero by construction, so no " +
            "trend-% check is honest in either direction",
          decides: true, // the mart's youth flag IS the ring decision
        },
        {
          id: "new_share",
          label: "New-game share",
          value: newShare === null ? "unknown" : `${Math.round(newShare * 100)}% from games ≤ 24m old`,
          threshold: "≥ 80% marks a young label",
          pass: null,
          note: "how much of the volume comes from newly released games — the mart's second youth tell",
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
      label: "Supply",
      value: sat === null ? "unknown" : `${fmtSigned(sat, 1)} releases YoY`,
      threshold: `≤ ${fmtSigned(SAT_FLOOD_YOY, 0)} YoY`,
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
      note:
        er === null
          ? "unknown — no read on how recent entrants earn"
          : er >= ENTRANT_RATIO_PAR
            ? "recent entrants earn at or above the niche median"
            : `recent entrants earn ${Math.round((1 - er) * 100)}% below the niche median — falsification tell, never moves the ring`,
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

/** solo_viability at or above which a niche counts as solo-buildable. The catalog norm is
 * ~0.9; below 0.8 the MCP guidance flags meaningful multiplayer/team-scale dependence.
 * MUST stay in lockstep with RADAR_SOLO_FRIENDLY_MIN in api/app/routers/niches.py — the
 * server filters the radar population (`solo_only`, the board's default-on toggle) on the
 * SAME bar this module renders in the legend, tooltip and dossier; a drift would make the
 * legend lie about what the server filtered. */
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
