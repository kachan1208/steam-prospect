import { describe, expect, it } from "vitest";

import { DEFAULT_NICHE_CUT, findNicheVariant } from "./nicheSelection";

/**
 * The mart emits one row per (window × review-floor) cut, in this order. These are the REAL
 * variants GET /api/niches/tag/Souls-like returns, opportunity_v2 included — the same payload
 * GameProfile's "In niches" rail reads. Note that variants[0] and the first `window === "24m"`
 * row are the SAME row: the >=0-reviews cut. That is the row the rail used to quote, which is
 * why /games/367520 said Souls-like "opp 57.7" while /niches/tag/Souls-like — one click away,
 * the Niche Finder and the Radar all said 77.3.
 */
const SOULS_LIKE = [
  { window: "24m", min_reviews: 0, n_games: 624, opportunity_v2: 57.73 },
  { window: "24m", min_reviews: 50, n_games: 223, opportunity_v2: 77.25 },
  { window: "24m", min_reviews: 100, n_games: 177, opportunity_v2: 80.52 },
  { window: "all", min_reviews: 0, n_games: 1841, opportunity_v2: 57.87 },
  { window: "all", min_reviews: 50, n_games: 739, opportunity_v2: 70.81 },
  { window: "all", min_reviews: 100, n_games: 584, opportunity_v2: 72.37 },
];

/** Metroidvania errs the OTHER way — the >=0 cut reads high, not low (58.73 vs 30.09) — so a
 * test that only pinned "the sidebar under-reports" would miss half the bug. */
const METROIDVANIA = [
  { window: "24m", min_reviews: 0, n_games: 480, opportunity_v2: 58.73 },
  { window: "24m", min_reviews: 50, n_games: 178, opportunity_v2: 30.09 },
  { window: "24m", min_reviews: 100, n_games: 120, opportunity_v2: 30.16 },
];

describe("DEFAULT_NICHE_CUT", () => {
  it("is the cut every niche surface opens on with no override", () => {
    expect(DEFAULT_NICHE_CUT).toEqual({ win: "24m", min_reviews: 50 });
  });
});

describe("findNicheVariant", () => {
  it("selects the app-default cut, not the first 24m row and not index 0", () => {
    const v = findNicheVariant(SOULS_LIKE);
    expect(v?.min_reviews).toBe(50);
    expect(v?.opportunity_v2).toBe(77.25);
    // The two shapes the old code used, both wrong, both the >=0-reviews population.
    expect(v).not.toBe(SOULS_LIKE[0]);
    expect(v).not.toBe(SOULS_LIKE.find((x) => x.window === "24m"));
  });

  it("does not merely bias upward — it lands on the same population either way", () => {
    expect(findNicheVariant(METROIDVANIA)?.opportunity_v2).toBe(30.09);
    expect(findNicheVariant(METROIDVANIA)?.n_games).toBe(178);
  });

  it("matches on BOTH axes, so an all-time row can never answer a 24m question", () => {
    expect(findNicheVariant(SOULS_LIKE, { win: "all", min_reviews: 50 })?.opportunity_v2).toBe(70.81);
    expect(findNicheVariant(SOULS_LIKE, { win: "24m", min_reviews: 100 })?.opportunity_v2).toBe(80.52);
  });

  it("returns undefined rather than a near-miss when the cut was never materialized", () => {
    // A near-miss is a DIFFERENT population; substituting one silently is the whole bug. The
    // caller decides what to do (GameProfile falls back but labels the row with the real cut).
    expect(findNicheVariant([{ window: "24m", min_reviews: 0, opportunity_v2: 1 }])).toBeUndefined();
    expect(findNicheVariant([])).toBeUndefined();
    expect(findNicheVariant(undefined)).toBeUndefined();
  });
});
