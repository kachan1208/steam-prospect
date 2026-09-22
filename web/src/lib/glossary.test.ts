import { describe, expect, it } from "vitest";

import { GLOSSARY, GLOSSARY_KEYS, glossary, isGlossaryKey, type GlossaryEntry } from "./glossary";
import {
  DEMAND_DECLINE_PCT,
  DEMAND_ENTER_PCT,
  ENTRANT_RATIO_CATALOG_NORM,
  SAT_FLOOD_YOY,
  SOLO_FRIENDLY_MIN,
  SOLO_MIXED_MIN,
  WC_WINNER_TAKE_MOST,
} from "./radarVerdict";

const entries = GLOSSARY_KEYS.map((k) => [k, glossary(k)] as [string, GlossaryEntry]);

/** Labels the owner rejected as jargon — none may come back as a canonical label. */
const JARGON = [/\bP\d{1,2}\b/, /opp\s*v2/i, /entrant ratio/i, /solo-friendly/i, /\bgross\b/i, /jaccard/i, /\bYoY\b/];

describe("glossary — every metric explains itself", () => {
  it("has the metrics the UX review lists", () => {
    for (const key of [
      "opportunity_v2",
      "momentum",
      "market_pull",
      "revenue_spread",
      "quality_gap",
      "supply_brake",
      "demand_trend_24m_pct",
      "saturation_yoy",
      "p90_rev",
      "median_rev",
      "p25_rev",
      "p75_rev",
      "hit_rate_200k",
      "hit_rate_500k",
      "winner_concentration",
      "entrant_ratio",
      "singleplayer_share",
      "solo_tier",
      "players_now",
      "players_trend_7d_pct",
      "players_trend_7d_vs_market",
      "est_revenue",
      "units",
      "owners",
      "review_velocity",
      "positive_ratio",
      "percentile_vs_genre",
      "tag_overlap",
      "launch_shape",
      "press_mentions",
      "price_history",
    ]) {
      expect(isGlossaryKey(key), key).toBe(true);
    }
  });

  it("gives every entry a plain label, a column-header form and a meaning", () => {
    for (const [key, e] of entries) {
      expect(e.label.trim().length, key).toBeGreaterThan(0);
      expect(e.short.trim().length, key).toBeGreaterThan(0);
      expect(e.short.length, `${key} short "${e.short}"`).toBeLessThanOrEqual(16);
      expect(e.meaning.trim().length, key).toBeGreaterThan(20);
    }
  });

  it("gives every computed metric its exact formula", () => {
    for (const [key, e] of entries) {
      if (e.computed) expect(e.formula?.trim().length ?? 0, `${key} is computed but has no formula`).toBeGreaterThan(0);
    }
  });

  it("keeps jargon out of every label", () => {
    for (const [key, e] of entries) {
      for (const re of JARGON) expect(re.test(e.label), `${key} label "${e.label}" matches ${re}`).toBe(false);
    }
  });

  it("uses one name per concept — no two entries share a label or a column header", () => {
    const labels = entries.map(([, e]) => e.label.toLowerCase());
    const shorts = entries.map(([, e]) => e.short.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it("never lets a retired name come back as a canonical label", () => {
    const canonical = new Set(entries.map(([, e]) => e.label.toLowerCase()));
    for (const [key, e] of entries) {
      for (const old of e.replaces ?? []) {
        expect(canonical.has(old.toLowerCase()), `${key} replaces "${old}", which is still a label`).toBe(false);
      }
    }
  });

  it("names revenue exactly once: “Est. revenue”, and retires the other four names", () => {
    expect(GLOSSARY.est_revenue.label).toBe("Est. revenue");
    for (const old of ["Est. gross", "Gross revenue", "Est. gross revenue"]) {
      expect(GLOSSARY.est_revenue.replaces).toContain(old);
    }
    expect(GLOSSARY.total_rev.replaces).toContain("Total est. revenue");
    expect(GLOSSARY.est_revenue.formula).toBe("reviews × 30 owners-per-review × launch price");
    expect(GLOSSARY.est_revenue_range.formula).toMatch(/20/);
    expect(GLOSSARY.est_revenue_range.formula).toMatch(/55/);
  });

  it("uses the plain labels the review asked for", () => {
    expect(GLOSSARY.p90_rev.label).toBe("Top-10% revenue");
    expect(GLOSSARY.entrant_ratio.label).toBe("Newcomer earnings");
    expect(GLOSSARY.singleplayer_share.label).toBe("Singleplayer share");
    expect(GLOSSARY.singleplayer_share.fields).toContain("solo_viability");
    expect(GLOSSARY.opportunity_v2.label).toBe("Opportunity score");
  });

  it("dates the SteamSpy owners figure — it is a snapshot, not a live feed", () => {
    expect(GLOSSARY.owners.source).toMatch(/snapshot/i);
    expect(GLOSSARY.owners.notes).toMatch(/snapshot/i);
  });
});

describe("glossary — formulas agree with the code that computes them", () => {
  it("the Opportunity score names all four parts, their weights and the brake", () => {
    const f = GLOSSARY.opportunity_v2.formula;
    for (const part of [GLOSSARY.momentum, GLOSSARY.market_pull, GLOSSARY.revenue_spread, GLOSSARY.quality_gap, GLOSSARY.supply_brake]) {
      expect(f).toContain(part.label);
    }
    // etl/build_marts.py W2_MOMENTUM / W2_MARKET / W2_SPREAD / W2_QUALITY.
    for (const w of ["0.40 × Momentum", "0.22 × Market pull", "0.20 × Revenue spread", "0.18 × Quality gap"]) {
      expect(f).toContain(w);
    }
  });

  it("the brake's floor is SUPPLY_BRAKE_FLOOR = 0.35 and its slope 1 − 0.35", () => {
    expect(GLOSSARY.supply_brake.formula).toContain("0.35 + 0.65 × Supply room ÷ 100");
  });

  it("momentum is anchored on the Radar's enter bar (radarVerdict.DEMAND_ENTER_PCT)", () => {
    expect(GLOSSARY.momentum.formula).toContain(`ln(${(1 + DEMAND_ENTER_PCT / 100).toFixed(2)})`);
  });

  it("revenue spread crosses 50 exactly on the winner-take-most bar", () => {
    const span = (2 * (1 - WC_WINNER_TAKE_MOST)).toFixed(2);
    expect(GLOSSARY.revenue_spread.formula).toContain(`÷ ${span}`);
  });

  it("flood room and entrant room use the Radar's flooding line and the catalog norm", () => {
    expect(GLOSSARY.flood_room.formula).toContain(`ln ${(1 + SAT_FLOOD_YOY).toFixed(2)}`);
    expect(GLOSSARY.entrant_room.formula).toContain(String(ENTRANT_RATIO_CATALOG_NORM));
    expect(GLOSSARY.entrant_ratio.meaning).toContain(`${ENTRANT_RATIO_CATALOG_NORM}×`);
  });

  it("the solo flag's bands are the Radar's solo bars", () => {
    expect(GLOSSARY.solo_tier.formula).toContain(`< ${Math.round(SOLO_FRIENDLY_MIN * 100)}%`);
    expect(GLOSSARY.solo_tier.formula).toContain(`≥ ${Math.round(SOLO_MIXED_MIN * 100)}%`);
  });

  it("the Radar verdict formula states the enter, declining and flooding bars", () => {
    const f = GLOSSARY.radar_verdict.formula;
    expect(f).toContain(`≥ +${DEMAND_ENTER_PCT}%`);
    expect(f).toContain(`≤ −${Math.abs(DEMAND_DECLINE_PCT)}%`);
    expect(f).toContain(`> +${Math.round(SAT_FLOOD_YOY * 100)}%`);
    expect(f).toContain(`> ${Math.round(WC_WINNER_TAKE_MOST * 100)}%`);
  });
});
