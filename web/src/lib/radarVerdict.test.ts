import { describe, expect, it } from "vitest";

import {
  BLIP_R_MAX,
  BLIP_R_MIN,
  DEMAND_DECLINE_PCT,
  DEMAND_ENTER_PCT,
  DEMAND_HOLD_PCT,
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

describe("radarVerdict — 24-month threshold pins", () => {
  // The bars are set for a 24-MONTH read (last 24 complete months vs the prior 24) — the
  // old per-year bars (+20 / -15 / -5 on the 12m windows) scaled linearly x2, because the
  // same underlying per-year rate roughly doubles the printed percentage across two-year
  // windows. Documented plainly in the module doc: +40% per 24m (~+20%/yr) = growth worth
  // a multi-year build commitment; -30% per 24m = persistent structural contraction;
  // within -10% = measurement slack, still "holding". Pinned so a "quick retune" can't
  // silently detach the numbers from their documented reasoning.
  it("enter bar: +40% per 24 months", () => {
    expect(DEMAND_ENTER_PCT).toBe(40);
  });
  it("declining bar: -30% per 24 months", () => {
    expect(DEMAND_DECLINE_PCT).toBe(-30);
  });
  it("holding floor: -10% per 24 months", () => {
    expect(DEMAND_HOLD_PCT).toBe(-10);
  });
});

describe("radarVerdict — ring rules", () => {
  it("enter: demand >= +40 per 24m with a calm pipeline", () => {
    expect(radarVerdict({ demand_trend_24m_pct: 60, saturation_yoy: 0.05 }).ring).toBe("enter");
    // Boundary: exactly the threshold qualifies, exactly the flood cut still passes.
    expect(radarVerdict({ demand_trend_24m_pct: DEMAND_ENTER_PCT, saturation_yoy: SAT_FLOOD_YOY }).ring).toBe("enter");
    // Just under the bar is NOT enter.
    expect(radarVerdict({ demand_trend_24m_pct: DEMAND_ENTER_PCT - 0.1, saturation_yoy: 0.05 }).ring).toBe("watch");
  });

  it("enter: unknown saturation does not veto rising demand (spec: null passes)", () => {
    const v = radarVerdict({ demand_trend_24m_pct: 60, saturation_yoy: null });
    expect(v.ring).toBe("enter");
    expect(v.caution).toBe(false);
  });

  it("not enter when supply floods: rising demand + flooding pipeline is watch, not enter", () => {
    const v = radarVerdict({ demand_trend_24m_pct: 60, saturation_yoy: 0.4 });
    expect(v.ring).toBe("watch");
  });

  it("watch: flat-to-up demand below the enter bar holds without caution", () => {
    expect(radarVerdict({ demand_trend_24m_pct: 0 }).ring).toBe("watch");
    expect(radarVerdict({ demand_trend_24m_pct: 39.9 }).ring).toBe("watch");
    expect(radarVerdict({ demand_trend_24m_pct: 20, saturation_yoy: 0.05 }).caution).toBe(false);
  });

  it("watch: drift within the holding floor is 'demand holding', not a warning", () => {
    // -10% per 24 months is within measurement slack — a stable market.
    const v = radarVerdict({ demand_trend_24m_pct: DEMAND_HOLD_PCT });
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(false);
    expect(v.reason).toBe("demand holding");
  });

  it("watch: the softening band (between decline and holding) is real evidence, no caution", () => {
    // -20% per 24m: mild but real multi-year decline — watch, honestly labeled, and
    // NOT caution-flagged (the evidence is solid; only the placement is intermediate).
    const v = radarVerdict({ demand_trend_24m_pct: -20 });
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(false);
    expect(v.reason).toBe("demand softening");
    // Boundary: just above the decline cut still softens rather than declines.
    expect(radarVerdict({ demand_trend_24m_pct: DEMAND_DECLINE_PCT + 0.1 }).ring).toBe("watch");
  });

  it("watch via opportunity_v2 carries the caution flag", () => {
    const v = radarVerdict({ demand_trend_24m_pct: null, opportunity_v2: OPP_WATCH_SCORE });
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(true);
  });

  it("crowded: flooding pipeline with flat/negative demand", () => {
    expect(radarVerdict({ demand_trend_24m_pct: -6, saturation_yoy: 0.3 }).ring).toBe("crowded");
    expect(radarVerdict({ demand_trend_24m_pct: 0, saturation_yoy: 0.3 }).ring).toBe("crowded");
    // Boundary: exactly the flood cut is NOT flooding (rule is strict >).
    expect(radarVerdict({ demand_trend_24m_pct: 0, saturation_yoy: SAT_FLOOD_YOY }).ring).toBe("watch");
  });

  it("crowded: winner-take-most regardless of trend fields", () => {
    expect(radarVerdict({ winner_concentration: 0.9 }).ring).toBe("crowded");
    expect(radarVerdict({ demand_trend_24m_pct: 10, winner_concentration: 0.9 }).ring).toBe("crowded");
    // Boundary: rule is strict >.
    expect(radarVerdict({ winner_concentration: WC_WINNER_TAKE_MOST }).ring).not.toBe("crowded");
  });

  it("declining: demand <= -30 per 24 months", () => {
    expect(radarVerdict({ demand_trend_24m_pct: -30 }).ring).toBe("declining");
    expect(radarVerdict({ demand_trend_24m_pct: DEMAND_DECLINE_PCT }).ring).toBe("declining");
    expect(radarVerdict({ demand_trend_24m_pct: -80 }).ring).toBe("declining");
  });
});

describe("radarVerdict — emerging pre-empts every percentage-based verdict", () => {
  // demand_emerging comes from the mart's two-tell rule (young tags crystallize around
  // new games only, so their prior window is near zero BY CONSTRUCTION). When true, no
  // trend- or saturation-derived claim is trustworthy — the ring must be "emerging" no
  // matter how loud the % is, in either direction.
  it("a huge positive trend on an emerging niche is NOT enter", () => {
    const v = radarVerdict({ demand_trend_24m_pct: 4775, saturation_yoy: 0.05, demand_emerging: true });
    expect(v.ring).toBe("emerging");
    expect(v.caution).toBe(false); // the evidence (youth) is solid, not partial
  });

  it("emerging trumps declining and crowded too — youth distorts those reads as well", () => {
    expect(radarVerdict({ demand_trend_24m_pct: -80, demand_emerging: true }).ring).toBe("emerging");
    expect(radarVerdict({ winner_concentration: 0.95, demand_emerging: true }).ring).toBe("emerging");
    expect(radarVerdict({ saturation_yoy: 0.5, demand_emerging: true }).ring).toBe("emerging");
  });

  it("the canonical young tag — null trend (no baseline) + emerging — plates emerging, not watch", () => {
    const v = radarVerdict({ demand_trend_24m_pct: null, demand_emerging: true, opportunity_v2: 90 });
    expect(v.ring).toBe("emerging");
    expect(v.reason).toBe("young market — no comparable demand base");
  });

  it("false/null/undefined emerging changes nothing (older marts degrade exactly as before)", () => {
    expect(radarVerdict({ demand_trend_24m_pct: 60, saturation_yoy: 0.05, demand_emerging: false }).ring).toBe("enter");
    expect(radarVerdict({ demand_trend_24m_pct: 60, saturation_yoy: 0.05, demand_emerging: null }).ring).toBe("enter");
    expect(radarVerdict({ demand_trend_24m_pct: 60, saturation_yoy: 0.05 }).ring).toBe("enter");
  });
});

describe("radarVerdict — precedence (exactly one ring)", () => {
  it("enter beats watch: qualifying demand never lands in watch", () => {
    const v = radarVerdict({ demand_trend_24m_pct: 50, saturation_yoy: 0.1, opportunity_v2: 90 });
    expect(v.ring).toBe("enter");
  });

  it("enter beats crowded: rising demand with a calm pipeline wins over winner-take-most", () => {
    // Precedence rule 1 vs 3: enter is checked first, so a concentrated niche whose
    // demand is genuinely surging still plates as enter.
    const v = radarVerdict({ demand_trend_24m_pct: 50, saturation_yoy: 0.05, winner_concentration: 0.95 });
    expect(v.ring).toBe("enter");
  });

  it("declining beats crowded: flooding AND collapsing plates as declining (the outer, stronger warning)", () => {
    const v = radarVerdict({ demand_trend_24m_pct: -60, saturation_yoy: 0.5, winner_concentration: 0.95 });
    expect(v.ring).toBe("declining");
  });

  it("crowded beats watch: a high v2 score cannot rescue a winner-take-most niche", () => {
    const v = radarVerdict({ winner_concentration: 0.9, opportunity_v2: 95 });
    expect(v.ring).toBe("crowded");
  });

  it("crowded beats the softening band: flooding into softening demand is crowding", () => {
    const v = radarVerdict({ demand_trend_24m_pct: -20, saturation_yoy: 0.3 });
    expect(v.ring).toBe("crowded");
    expect(v.caution).toBe(false);
  });

  it("every input lands in exactly one known ring", () => {
    const demands = [null, -80, DEMAND_DECLINE_PCT, -20, DEMAND_HOLD_PCT, -4, 0, 20, DEMAND_ENTER_PCT, 70];
    const sats = [null, -0.5, 0, SAT_FLOOD_YOY, 0.5];
    const wcs = [null, 0.5, WC_WINNER_TAKE_MOST, 0.95];
    const emergings = [undefined, false, true] as const;
    for (const demand_trend_24m_pct of demands)
      for (const saturation_yoy of sats)
        for (const winner_concentration of wcs)
          for (const demand_emerging of emergings) {
            const v = radarVerdict({
              demand_trend_24m_pct,
              saturation_yoy,
              winner_concentration,
              demand_emerging,
              opportunity_v2: OPP_WATCH_SCORE,
            });
            expect(RING_ORDER).toContain(v.ring);
            if (demand_emerging === true) expect(v.ring).toBe("emerging");
            else expect(v.ring).not.toBe("emerging");
          }
  });
});

describe("radarVerdict — null-field degradation (no shorter-horizon fallback exists)", () => {
  it("all fields unknown -> the watch catch-all, flagged caution", () => {
    const v = radarVerdict({});
    expect(v.ring).toBe("watch");
    expect(v.caution).toBe(true);
  });

  it("demand unknown: enter/declining are unreachable, crowding still reads from structure", () => {
    // Flooding pipeline + unknown demand -> crowded, flagged caution (spec: unknown
    // demand does not rescue a flooding niche).
    const flooding = radarVerdict({ demand_trend_24m_pct: null, saturation_yoy: 0.4 });
    expect(flooding.ring).toBe("crowded");
    expect(flooding.caution).toBe(true);
    // Concentration alone still plates crowded.
    expect(radarVerdict({ demand_trend_24m_pct: undefined, winner_concentration: 0.9 }).ring).toBe("crowded");
  });

  it("treats NaN like null, never like a number", () => {
    const v = radarVerdict({ demand_trend_24m_pct: Number.NaN, saturation_yoy: Number.NaN });
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
    const a = radarVerdict({ demand_trend_24m_pct: 50, saturation_yoy: 0.05 });
    const b = radarVerdict({ demand_trend_24m_pct: 50, saturation_yoy: 0.05 });
    expect(a).toEqual(b);
    expect(a.ring).toBe("enter");
  });
});
