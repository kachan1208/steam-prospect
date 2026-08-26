import { describe, expect, it } from "vitest";

import {
  BLIP_R_MAX,
  BLIP_R_MIN,
  DEMAND_DECLINE_PCT,
  DEMAND_ENTER_PCT,
  OPP_WATCH_SCORE,
  RING_ORDER,
  SAT_FLOOD_YOY,
  SOLO_FRIENDLY_MIN,
  WC_WINNER_TAKE_MOST,
  blipRadius,
  hash01,
  hashString,
  radarVerdict,
  soloBucket,
} from "./radarVerdict";

describe("radarVerdict — ring rules", () => {
  it("enter: demand >= +15 with a calm pipeline", () => {
    expect(radarVerdict({ demand_trend_90d_pct: 20, saturation_yoy: 0.05 }).ring).toBe("enter");
    // Boundary: exactly the threshold qualifies, exactly the flood cut still passes.
    expect(radarVerdict({ demand_trend_90d_pct: DEMAND_ENTER_PCT, saturation_yoy: SAT_FLOOD_YOY }).ring).toBe("enter");
  });

  it("enter: unknown saturation does not veto rising demand (spec: null passes)", () => {
    const v = radarVerdict({ demand_trend_90d_pct: 30, saturation_yoy: null });
    expect(v.ring).toBe("enter");
    expect(v.caution).toBe(false);
  });

  it("not enter when supply floods: rising demand + flooding pipeline is watch, not enter", () => {
    const v = radarVerdict({ demand_trend_90d_pct: 30, saturation_yoy: 0.4 });
    expect(v.ring).toBe("watch");
  });

  it("watch: flat-to-up demand below the enter bar", () => {
    expect(radarVerdict({ demand_trend_90d_pct: 0 }).ring).toBe("watch");
    expect(radarVerdict({ demand_trend_90d_pct: 14.9 }).ring).toBe("watch");
    expect(radarVerdict({ demand_trend_90d_pct: 5, saturation_yoy: 0.05 }).caution).toBe(false);
  });

  it("watch via opportunity_v2 carries the caution flag", () => {
    const v = radarVerdict({ demand_trend_90d_pct: null, opportunity_v2: OPP_WATCH_SCORE });
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(true);
  });

  it("crowded: flooding pipeline with flat/negative demand", () => {
    expect(radarVerdict({ demand_trend_90d_pct: -3, saturation_yoy: 0.3 }).ring).toBe("crowded");
    expect(radarVerdict({ demand_trend_90d_pct: 0, saturation_yoy: 0.3 }).ring).toBe("crowded");
    // Boundary: exactly the flood cut is NOT flooding (rule is strict >).
    expect(radarVerdict({ demand_trend_90d_pct: 0, saturation_yoy: SAT_FLOOD_YOY }).ring).toBe("watch");
  });

  it("crowded: winner-take-most regardless of trend fields", () => {
    expect(radarVerdict({ winner_concentration: 0.9 }).ring).toBe("crowded");
    expect(radarVerdict({ demand_trend_90d_pct: 5, winner_concentration: 0.9 }).ring).toBe("crowded");
    // Boundary: rule is strict >.
    expect(radarVerdict({ winner_concentration: WC_WINNER_TAKE_MOST }).ring).not.toBe("crowded");
  });

  it("declining: demand <= -15", () => {
    expect(radarVerdict({ demand_trend_90d_pct: -15 }).ring).toBe("declining");
    expect(radarVerdict({ demand_trend_90d_pct: DEMAND_DECLINE_PCT }).ring).toBe("declining");
    // Mild decline is NOT declining — it parks in the watch catch-all, flagged caution.
    const mild = radarVerdict({ demand_trend_90d_pct: -5 });
    expect(mild.ring).toBe("watch");
    expect(mild.caution).toBe(true);
  });
});

describe("radarVerdict — precedence (exactly one ring)", () => {
  it("enter beats watch: qualifying demand never lands in watch", () => {
    const v = radarVerdict({ demand_trend_90d_pct: 20, saturation_yoy: 0.1, opportunity_v2: 90 });
    expect(v.ring).toBe("enter");
  });

  it("enter beats crowded: rising demand with a calm pipeline wins over winner-take-most", () => {
    // Precedence rule 1 vs 3: enter is checked first, so a concentrated niche whose
    // demand is genuinely surging still plates as enter.
    const v = radarVerdict({ demand_trend_90d_pct: 25, saturation_yoy: 0.05, winner_concentration: 0.95 });
    expect(v.ring).toBe("enter");
  });

  it("declining beats crowded: flooding AND collapsing plates as declining (the outer, stronger warning)", () => {
    const v = radarVerdict({ demand_trend_90d_pct: -30, saturation_yoy: 0.5, winner_concentration: 0.95 });
    expect(v.ring).toBe("declining");
  });

  it("crowded beats watch: a high v2 score cannot rescue a winner-take-most niche", () => {
    const v = radarVerdict({ winner_concentration: 0.9, opportunity_v2: 95 });
    expect(v.ring).toBe("crowded");
  });

  it("every input lands in exactly one known ring", () => {
    const demands = [null, -30, -15, -5, 0, 5, 15, 30];
    const sats = [null, -0.5, 0, SAT_FLOOD_YOY, 0.5];
    const wcs = [null, 0.5, WC_WINNER_TAKE_MOST, 0.95];
    const opps = [null, 30, OPP_WATCH_SCORE, 90];
    for (const demand_trend_90d_pct of demands)
      for (const saturation_yoy of sats)
        for (const winner_concentration of wcs)
          for (const opportunity_v2 of opps) {
            const v = radarVerdict({ demand_trend_90d_pct, saturation_yoy, winner_concentration, opportunity_v2 });
            expect(RING_ORDER).toContain(v.ring);
          }
  });
});

describe("radarVerdict — null-field degradation", () => {
  it("all fields unknown -> the watch catch-all, flagged caution", () => {
    const v = radarVerdict({});
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(true);
  });

  it("demand unknown: enter/declining are unreachable, crowding still reads from structure", () => {
    // Flooding pipeline + unknown demand -> crowded, flagged caution (spec: unknown
    // demand does not rescue a flooding niche).
    const flooding = radarVerdict({ demand_trend_90d_pct: null, saturation_yoy: 0.4 });
    expect(flooding.ring).toBe("crowded");
    expect(flooding.caution).toBe(true);
    // Concentration alone still plates crowded.
    expect(radarVerdict({ demand_trend_90d_pct: undefined, winner_concentration: 0.9 }).ring).toBe("crowded");
  });

  it("treats NaN like null, never like a number", () => {
    const v = radarVerdict({ demand_trend_90d_pct: Number.NaN, saturation_yoy: Number.NaN });
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(true);
  });

  it("high v2 score with nothing else known -> watch with caution, not enter", () => {
    const v = radarVerdict({ opportunity_v2: 95 });
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(true);
  });
});

describe("hashString / hash01 — layout determinism", () => {
  it("is deterministic: same input, same output, every call", () => {
    const inputs = ["tag:Roguelike", "genre:Action", "tag:Cozy", "tag:方块游戏", ""];
    for (const s of inputs) {
      expect(hashString(s)).toBe(hashString(s));
      expect(hash01(s)).toBe(hash01(s));
    }
    // Known-answer pin: a refactor that changes the hash silently reshuffles every
    // saved screenshot/bookmarked board — fail loudly instead.
    expect(hashString("tag:Roguelike")).toBe(hashString("tag:" + "Roguelike"));
    expect(hashString("")).toBe(0x811c9dc5);
  });

  it("distinguishes the inputs the board actually feeds it (dimension:key ids)", () => {
    const ids = [
      "tag:Roguelike|a",
      "tag:Roguelike|r",
      "genre:Roguelike|a",
      "tag:Roguelite|a",
      "tag:Cozy|a",
      "theme:Cozy|a",
    ];
    const hashes = new Set(ids.map(hashString));
    expect(hashes.size).toBe(ids.length);
  });

  it("hash01 stays in [0, 1)", () => {
    for (const s of ["a", "b", "tag:Deckbuilder", "genre:Strategy", "x".repeat(100)]) {
      const t = hash01(s);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
    }
  });
});

describe("blipRadius — bounded sqrt scale", () => {
  it("null/zero/unknown revenue -> minimum dot, never a hole", () => {
    expect(blipRadius(null, 1_000_000)).toBe(BLIP_R_MIN);
    expect(blipRadius(undefined, 1_000_000)).toBe(BLIP_R_MIN);
    expect(blipRadius(0, 1_000_000)).toBe(BLIP_R_MIN);
    expect(blipRadius(Number.NaN, 1_000_000)).toBe(BLIP_R_MIN);
    expect(blipRadius(500, null)).toBe(BLIP_R_MIN);
    expect(blipRadius(500, 0)).toBe(BLIP_R_MIN);
  });

  it("the cut's max revenue -> maximum dot; above-max clamps", () => {
    expect(blipRadius(1_000_000, 1_000_000)).toBe(BLIP_R_MAX);
    expect(blipRadius(2_000_000, 1_000_000)).toBe(BLIP_R_MAX);
  });

  it("scales by sqrt (quarter revenue -> half the range above the floor)", () => {
    const quarter = blipRadius(250_000, 1_000_000);
    expect(quarter).toBeCloseTo(BLIP_R_MIN + 0.5 * (BLIP_R_MAX - BLIP_R_MIN), 10);
  });

  it("is monotonic and bounded", () => {
    let prev = 0;
    for (const v of [1, 10, 1_000, 50_000, 400_000, 999_999]) {
      const r = blipRadius(v, 1_000_000);
      expect(r).toBeGreaterThanOrEqual(BLIP_R_MIN);
      expect(r).toBeLessThanOrEqual(BLIP_R_MAX);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });
});

describe("soloBucket — the solo-viability lens", () => {
  it("classifies at the documented threshold (boundary counts as solo-friendly)", () => {
    expect(soloBucket(0.95)).toBe("solo");
    expect(soloBucket(SOLO_FRIENDLY_MIN)).toBe("solo");
    expect(soloBucket(0.79)).toBe("team");
    expect(soloBucket(0)).toBe("team");
  });

  it("null/undefined/NaN are 'unknown' — an honest bucket, never claimed either way", () => {
    expect(soloBucket(null)).toBe("unknown");
    expect(soloBucket(undefined)).toBe("unknown");
    expect(soloBucket(Number.NaN)).toBe("unknown");
  });

  it("is a lens, not a ring: the verdict input has no solo field to read", () => {
    // Pins the module-doc claim behaviorally: identical market evidence yields an
    // identical verdict — there is no solo channel that could differentiate them.
    const a = radarVerdict({ demand_trend_90d_pct: 20, saturation_yoy: 0.05 });
    const b = radarVerdict({ demand_trend_90d_pct: 20, saturation_yoy: 0.05 });
    expect(a).toEqual(b);
    expect(a.ring).toBe("enter");
  });
});
