import { describe, expect, it } from "vitest";

import {
  OPP_WEIGHTS,
  SUPPLY_BRAKE_FLOOR,
  entrantRoom,
  floodRoom,
  fmtMultiplier,
  momentumFromTrend,
  opportunityBreakdown,
  revenueSpreadFromConcentration,
} from "./opportunity";

/**
 * A niche row built the way etl/marts/mart_niche.sql builds it — transcribed from the
 * `rates` / `subscores` / `supply` / `scored_v2` CTEs and the final SELECT's rounding —
 * INDEPENDENTLY of lib/opportunity.ts, so the breakdown is checked against the SQL rather
 * than against itself.
 */
function martRow(i: {
  trend: number | null;
  emerging?: boolean;
  sat: number | null;
  er: number | null;
  wc: number | null;
  typical: number;
  size: number;
  quality: number;
  beatable?: number;
}) {
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const round = (v: number | null, d: number) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const emerging = i.emerging ?? false;
  const trend = round(i.trend, 1);
  const dg = trend === null || emerging ? null : Math.log(Math.max(1 + trend / 100, 0.001)) / 2;
  const sg = i.sat === null || emerging ? null : Math.log(Math.max(1 + i.sat, 0.001));
  const momentum = dg === null ? null : 50 + 50 * Math.tanh(dg / (Math.log(1 + 40 / 100) / 2));
  const flood = sg === null ? null : 100 * (1 - clamp01((sg - (dg ?? 0)) / (2 * Math.log(1 + 0.15))));
  const entrant = i.er === null || emerging ? null : 100 * clamp01((i.er - 0.5) / (1.08 - 0.5));
  const spread = i.wc === null ? null : 100 * clamp01((1 - i.wc) / (2 * (1 - 0.85)));
  const pull = 0.6 * i.typical + 0.4 * i.size;
  const room = flood === null ? entrant : entrant === null ? flood : Math.min(flood, entrant);
  const core =
    (0.4 * (momentum ?? 0) + 0.22 * pull + 0.2 * (spread ?? 0) + 0.18 * i.quality) /
    ((momentum === null ? 0 : 0.4) + 0.22 + (spread === null ? 0 : 0.2) + 0.18);
  const brake = room === null ? 1 : 0.35 + (0.65 * room) / 100;
  return {
    demand_trend_24m_pct: trend,
    demand_emerging: emerging,
    saturation_yoy: i.sat,
    entrant_ratio: i.er,
    winner_concentration: i.wc,
    demand: round(i.typical, 2),
    market_size: round(i.size, 2),
    beatable_share: i.beatable ?? null,
    momentum: round(momentum, 2),
    market_pull: round(pull, 2),
    revenue_spread: round(spread, 2),
    quality_gap: round(i.quality, 2),
    supply_room: round(room, 2),
    supply_brake: round(brake, 4),
    opportunity_v2: round(Math.min(100, Math.max(0, core * brake)), 2),
  };
}

describe("the part formulas agree with mart_niche.sql's anchors", () => {
  it("momentum: 50 at flat demand, 88.1 at the +40% enter bar, 10.7 at the −30% decline bar", () => {
    expect(momentumFromTrend(0)).toBeCloseTo(50, 5);
    expect(momentumFromTrend(40)).toBeCloseTo(88.08, 2);
    expect(momentumFromTrend(-30)).toBeCloseTo(10.72, 2);
  });

  it("revenue spread: 50 on the winner-take-most bar, capped at 100, floored at 0", () => {
    expect(revenueSpreadFromConcentration(0.85)).toBeCloseTo(50, 9);
    expect(revenueSpreadFromConcentration(0.6)).toBe(100);
    expect(revenueSpreadFromConcentration(1)).toBe(0);
  });

  it("flood room: 50 when supply outgrows demand by exactly 15%/yr, 0 at twice that", () => {
    expect(floodRoom(0.15, 0)).toBeCloseTo(50, 9);
    expect(floodRoom(1.15 ** 2 - 1, 0)).toBeCloseTo(0, 9);
    expect(floodRoom(-0.3, 0)).toBe(100); // a shrinking pipeline earns no bonus above "calm"
  });

  it("entrant room: 0 at half the back catalog, 100 at the 1.08× norm and capped there", () => {
    expect(entrantRoom(0.5)).toBe(0);
    expect(entrantRoom(1.08)).toBeCloseTo(100, 9);
    expect(entrantRoom(3.3)).toBe(100);
  });

  it("the weights sum to 1 and the brake floor is 0.35", () => {
    expect(Object.values(OPP_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(SUPPLY_BRAKE_FLOOR).toBe(0.35);
  });
});

describe("opportunityBreakdown — bearish reading first, every number worked", () => {
  it("releases outgrowing demand: the flood read binds, the brake is full, the headline leads with it", () => {
    const row = martRow({ trend: -7.4, sat: 0.37, er: 1.1, wc: 0.62, typical: 70.25, size: 80.5, quality: 89.25, beatable: 0.41 });
    const m = opportunityBreakdown(row);
    expect(m.available).toBe(true);
    expect(m.binding).toBe("flood");
    expect(m.brake).toBe(0.35);
    expect(m.brakeSentinel?.tag).toBe("full brake");
    expect(m.headline).toBe(
      "Held back by the supply brake (×0.35): releases are growing faster than demand — the score keeps 35% of its core.",
    );
    expect(m.reproduces).toBe(true);
    expect(m.scoreWorked).toMatch(new RegExp(`= ${row.opportunity_v2!.toFixed(2)}$`));
    const [momentum, pull, spread, quality] = m.parts;
    expect(momentum.worked).toBe(`50 + 50 × tanh( ln(1 − 0.074) ÷ ln 1.40 ) = ${row.momentum!.toFixed(2)}`);
    expect(pull.worked).toBe(`0.6 × 70.25 + 0.4 × 80.50 = ${row.market_pull!.toFixed(2)}`);
    expect(spread.sentinel?.tag).toBe("capped at 100");
    expect(spread.worked).toBe("100 × clamp( (1 − 0.6200) ÷ 0.30, 0, 1 ) = 100.00");
    expect(quality.worked).toBe("rank of a 41% beatable share among the niches in this cut = 89.25");
  });

  it("newcomers underearning: the entrant read binds and the headline says so", () => {
    const row = martRow({ trend: 65, sat: 0.1, er: 0.62, wc: 0.8, typical: 55, size: 60, quality: 70 });
    const m = opportunityBreakdown(row);
    expect(m.binding).toBe("entrant");
    expect(m.brakeWorked).toBe(`0.35 + 0.65 × ${row.supply_room!.toFixed(2)} ÷ 100 = ×${fmtMultiplier(row.supply_brake!)}`);
    expect(m.headline).toMatch(/^Held back by the supply brake \(×0\.48\): newcomers earn 0\.62× the back catalog's median, under the 1\.08× norm/);
    expect(m.reproduces).toBe(true);
  });

  it("the contributions sum to the core, and core × brake is the served score", () => {
    const row = martRow({ trend: 22, sat: 0.05, er: 1.05, wc: 0.88, typical: 45.5, size: 30.25, quality: 66.6 });
    const m = opportunityBreakdown(row);
    const sum = m.parts.reduce((s, p) => s + (p.contribution ?? 0), 0);
    expect(sum).toBeCloseTo(m.core!, 9);
    expect(m.core! * m.brake!).toBeCloseTo(row.opportunity_v2!, 1);
    expect(m.parts.map((p) => p.effectiveWeight)).toEqual([0.4, 0.22, 0.2, 0.18]);
  });

  it("an emerging niche: momentum and both supply reads unscored, the weights renormalise, no brake", () => {
    const row = martRow({ trend: 4775, emerging: true, sat: 2, er: 1, wc: 0.9, typical: 40, size: 20, quality: 60 });
    expect(row.momentum).toBeNull();
    expect(row.supply_room).toBeNull();
    const m = opportunityBreakdown(row);
    expect(m.parts[0].value).toBeNull();
    expect(m.parts[0].sentinel?.tag).toBe("not scored");
    expect(m.parts[0].sentinel?.detail).toMatch(/emerging/);
    expect(m.renormalised).toBe(true);
    expect(m.weightTotal).toBeCloseTo(0.6, 12);
    expect(m.parts[1].effectiveWeight).toBeCloseTo(0.22 / 0.6, 12);
    expect(m.brake).toBe(1);
    expect(m.brakeSentinel?.tag).toBe("unknown → ×1.00");
    expect(m.scoreWorked).toContain("÷ 0.60");
    expect(m.reproduces).toBe(true);
    expect(m.headline).toMatch(/no supply read, so no brake/);
  });

  it("no brake worth the name: the weak parts lead the headline", () => {
    const row = martRow({ trend: -20, sat: -0.05, er: 1.2, wc: 0.8, typical: 60, size: 50, quality: 40 });
    const m = opportunityBreakdown(row);
    expect(m.brake!).toBeGreaterThan(0.8);
    expect(m.headline).toMatch(/^Weakest: Momentum \d+\.\d, Quality gap 40\.0 — below the neutral 50; a light supply brake \(×0\.\d\d\)\.$/);
  });

  it("the docs' worked examples reproduce from the parts alone", () => {
    const colony = opportunityBreakdown({
      opportunity_v2: 23.75,
      momentum: 38.92,
      market_pull: 73.7,
      revenue_spread: 100,
      quality_gap: 89.25,
      supply_room: 0,
      supply_brake: 0.35,
    });
    expect(colony.reproduces).toBe(true);
    expect(colony.scoreWorked).toBe("(0.40 × 38.92 + 0.22 × 73.70 + 0.20 × 100.00 + 0.18 × 89.25) × 0.35 = 23.75");
    const rts = opportunityBreakdown({
      opportunity_v2: 87.12,
      momentum: 96.36,
      market_pull: 58.6,
      revenue_spread: 100,
      quality_gap: 87.16,
      supply_room: 100,
      supply_brake: 1,
    });
    expect(rts.reproduces).toBe(true);
    expect(rts.headline).toBe("Every part is at or above neutral (weakest: Market pull 58.6); no supply brake.");
  });

  it("a row from before the rebuild has nothing to break down — and says so", () => {
    const m = opportunityBreakdown({ opportunity_v2: 41.2, quality_gap: 50 });
    expect(m.available).toBe(false);
    expect(m.core).toBeNull();
    expect(m.scoreWorked).toBeNull();
    expect(m.headline).toMatch(/^No breakdown/);
  });

  it("a part that doesn't reproduce shows no arithmetic, and a score that doesn't is flagged", () => {
    const row = martRow({ trend: 12, sat: 0.02, er: 1.1, wc: 0.75, typical: 50, size: 50, quality: 50 });
    const m = opportunityBreakdown({ ...row, momentum: row.momentum! + 1, opportunity_v2: row.opportunity_v2! + 3 });
    expect(m.parts[0].worked).toBeNull();
    expect(m.reproduces).toBe(false);
  });
});
