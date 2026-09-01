import { describe, expect, it } from "vitest";

import {
  ENTITY_MIN_ESTIMATED_FOR_VERDICT,
  gamesSub,
  hitRateSub,
  medianRevSub,
  revenueEstimateBase,
  splitEntities,
  totalRevSub,
} from "./entities";

// All example strings below are real mart_game.developers/publishers values.
describe("splitEntities", () => {
  it("returns an empty list for null/undefined/empty", () => {
    expect(splitEntities(null)).toEqual([]);
    expect(splitEntities(undefined)).toEqual([]);
    expect(splitEntities("")).toEqual([]);
  });

  it("passes a single plain name through untouched", () => {
    expect(splitEntities("Mike Klubnika")).toEqual(["Mike Klubnika"]);
  });

  it("splits plain comma-joined credits into separate entities", () => {
    expect(splitEntities("Mike Klubnika,GDeavid")).toEqual(["Mike Klubnika", "GDeavid"]);
    expect(splitEntities("Mike Klubnika,Oro Interactive")).toEqual([
      "Mike Klubnika",
      "Oro Interactive",
    ]);
  });

  it("keeps an in-name corporate suffix attached (', Inc.' is not a second entity)", () => {
    expect(splitEntities("FromSoftware, Inc.")).toEqual(["FromSoftware, Inc."]);
    expect(splitEntities("Blizzard Entertainment, Inc.")).toEqual([
      "Blizzard Entertainment, Inc.",
    ]);
    // No comma before the suffix — nothing to remerge, name unchanged.
    expect(splitEntities("Behaviour Interactive Inc.")).toEqual(["Behaviour Interactive Inc."]);
  });

  it("handles 'Co., Ltd.' style double suffixes", () => {
    expect(splitEntities("CAPCOM Co., Ltd.")).toEqual(["CAPCOM Co., Ltd."]);
  });

  it("splits real credits while re-merging each entity's own suffix", () => {
    expect(splitEntities("FromSoftware, Inc.,Bandai Namco Entertainment")).toEqual([
      "FromSoftware, Inc.",
      "Bandai Namco Entertainment",
    ]);
    expect(splitEntities("Nicalis, Inc.,Edmund McMillen")).toEqual([
      "Nicalis, Inc.",
      "Edmund McMillen",
    ]);
  });

  it("re-merges a suffix carrying a parenthetical region note, and keeps unicode names", () => {
    // Sekiro's publishers string.
    expect(
      splitEntities("Activision (Excluding Japan and Asia),FromSoftware, Inc. (Japan),方块游戏 (Asia)"),
    ).toEqual(["Activision (Excluding Japan and Asia)", "FromSoftware, Inc. (Japan)", "方块游戏 (Asia)"]);
  });

  it("does not treat suffix-prefixed names (Co-op, Ltd Edition …) as remergeable suffixes", () => {
    expect(splitEntities("Team Alpha,Co-op Games")).toEqual(["Team Alpha", "Co-op Games"]);
  });
});

// ---- revenue-estimate base --------------------------------------------------------------

/**
 * The Games tile and the revenue tiles beside it are computed over DIFFERENT populations, and
 * the page used to say otherwise. Hooded Horse: "GAMES 50", "HIT RATE >= $200K 91% — Share of
 * releases clearing $200K est.", "median $3.9M per release" — with 17 of those 50 releases
 * carrying no revenue estimate and therefore sitting outside every one of those numbers.
 *
 * est_rev_reviews below is GET /api/entities/profile?role=publisher&name=Hooded Horse verbatim
 * (prod, 2026-09-01), in seq order: 30 releases over $200K, 3 at or under it, 17 null.
 */
const HOODED_HORSE_REV: (number | null)[] = [
  25792599.599999998, 11192133.6, 3374998.5, 3958680, 8215545.600000001, 3621292.5,
  7807647.600000001, 33449946.299999997, 108251330.4, 16929654.9, 32607846, 9298399.5,
  890554.4999999999, 3850716, 1631783.7, 13741525.799999999, 376074.6, 2462368.1999999997,
  4256148.600000001, 3549624.3, 2932122.3, 11737864.8, 15771256.200000001, 1887570.5999999999,
  2013528.5999999999, 6927067.800000001, 26181053.1, 353223.3, 3762259.2, 1882444.2, null, 0,
  null, null, 0, null, null, null, 0, null, null, null, null, null, null, null, null, null,
  null, null,
];
const HOODED_HORSE = HOODED_HORSE_REV.map((est_rev_reviews) => ({ est_rev_reviews }));

// FromSoftware, Inc. (developer) — the control. 12 releases, ALL 12 estimated, 8 over $200K,
// so its 67% was right all along and every string below must read as the plain, unhedged
// statement it always did. This is why the bug varies by entity instead of being an offset.
const FROMSOFTWARE = Array.from({ length: 12 }, (_, i) => ({
  est_rev_reviews: i < 8 ? 5_000_000 : 100_000,
}));

describe("revenueEstimateBase", () => {
  it("separates the releases the page lists from the ones the percentages use", () => {
    expect(revenueEstimateBase(HOODED_HORSE)).toEqual({ listed: 50, estimated: 33 });
  });

  it("reproduces the API's hit_rate_200k from the base it names, and only from that base", () => {
    const base = revenueEstimateBase(HOODED_HORSE);
    const hits = HOODED_HORSE_REV.filter((v) => v !== null && v > 200_000).length;
    expect(hits).toBe(30);
    // 30/33 = 91% is what the tile prints; the API sends exactly this.
    expect(Math.round((hits / base.estimated) * 100)).toBe(91);
    // 30/50 = 60% is what "Share of releases" claimed it meant. The two are not the same
    // number, so the label may not name a base that yields the wrong one.
    expect(Math.round((hits / base.listed) * 100)).toBe(60);
    expect(hitRateSub(base)).toContain("33");
    expect(hitRateSub(base)).not.toMatch(/^Share of releases clearing/);
  });

  it("counts a $0 estimate as estimated — null is 'unknown', 0 is a measured free release", () => {
    // Three of Hooded Horse's 33 are exactly 0 (free-to-play box revenue by construction) and
    // the mart's `est_rev_reviews IS NOT NULL` denominator includes them. Dropping them here
    // would silently move the base to 30 and the printed 91% would stop reproducing.
    expect(revenueEstimateBase([{ est_rev_reviews: 0 }]).estimated).toBe(1);
    expect(revenueEstimateBase([{ est_rev_reviews: null }]).estimated).toBe(0);
  });
});

describe("revenue tile sub-labels", () => {
  it("names the denominator and what sits outside it when coverage is partial", () => {
    const base = revenueEstimateBase(HOODED_HORSE);
    expect(hitRateSub(base)).toBe(
      "Share of the 33 releases with a revenue estimate — 17 of 50 have none",
    );
    expect(medianRevSub("$3.9M", base)).toBe(
      "median $3.9M — both over the 33 of 50 releases with an estimate",
    );
    expect(totalRevSub(base)).toBe("Boxleiter gross over the 33 of 50 releases with an estimate");
    expect(gamesSub(base)).toBe("17 with no revenue estimate");
  });

  it("REGRESSION CONTROL: FromSoftware reads exactly as before, because it always was right", () => {
    const base = revenueEstimateBase(FROMSOFTWARE);
    expect(base).toEqual({ listed: 12, estimated: 12 });
    // 8/12 = 67% over ALL 12 listed releases — no hedging, no "of the N with an estimate".
    expect(hitRateSub(base)).toBe("Share of all 12 releases clearing $200K est.");
    expect(hitRateSub(base)).not.toContain("have none");
    expect(medianRevSub("$155.9M", base)).toBe("median $155.9M per release");
    expect(totalRevSub(base)).toBe("Boxleiter gross across the catalog");
    // Nothing to disclose on the Games tile, so it stays the bare count it has always been.
    expect(gamesSub(base)).toBeUndefined();
  });

  it("says so outright when nothing was estimated at all", () => {
    const base = revenueEstimateBase([{ est_rev_reviews: null }, { est_rev_reviews: null }]);
    expect(hitRateSub(base)).toBe("No release has a revenue estimate");
    expect(totalRevSub(base)).toBe("No release has a revenue estimate");
  });
});

describe("ENTITY_MIN_ESTIMATED_FOR_VERDICT", () => {
  it("withholds the strong-hit-rate colour from a base that can only read 0% or 100%", () => {
    // Zeekerss (publisher): "GAMES 5", 100% — off 3 estimated releases. The 100% still prints;
    // the verdict colour, which is a claim about the studio, does not.
    const thin = revenueEstimateBase([
      { est_rev_reviews: 5_000_000 },
      { est_rev_reviews: 5_000_000 },
      { est_rev_reviews: 5_000_000 },
      { est_rev_reviews: null },
      { est_rev_reviews: null },
    ]);
    expect(thin.estimated).toBeLessThan(ENTITY_MIN_ESTIMATED_FOR_VERDICT);
    // ...while FromSoftware's 12 clear it, so the control keeps its accent.
    expect(revenueEstimateBase(FROMSOFTWARE).estimated).toBeGreaterThanOrEqual(
      ENTITY_MIN_ESTIMATED_FOR_VERDICT,
    );
  });
});
