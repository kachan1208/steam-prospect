import { describe, expect, it } from "vitest";

import { BOXLEITER_OWNERS_PER_REVIEW_MID, estimatedUnits } from "./estimates";

/**
 * The invariant this module exists to hold: the revenue figure and the unit figure printed
 * beside each other come from ONE estimator, so `units × launch price === revenue` is true of
 * the numbers actually on screen.
 *
 * The regression these pin is live-API real. GET /api/games/367520 (Hollow Knight) carries BOTH
 * estimators:
 *     price_initial   14.99
 *     total_reviews   559,257
 *     est_rev_reviews 251,497,872.9   (reviews-based:  559,257 × 30 × 14.99)
 *     owners_mid      7,500,000       (owners-based:   SteamSpy bucket midpoint)
 *     est_rev_owners  112,425,000     (owners-based:   7,500,000 × 14.99)
 * The profile used to print est_rev_reviews next to owners_mid — $251.5M over 7.5M units, i.e.
 * $33.53 a copy against a $14.99 price, under a footnote that spells out the division.
 */
const HOLLOW_KNIGHT = {
  price_initial: 14.99,
  total_reviews: 559_257,
  est_rev_reviews: 251_497_872.9,
  owners_mid: 7_500_000,
  est_rev_owners: 112_425_000,
};

describe("estimatedUnits", () => {
  it("pairs with the revenue it was given: units × price === revenue", () => {
    const units = estimatedUnits(
      HOLLOW_KNIGHT.est_rev_reviews,
      HOLLOW_KNIGHT.price_initial,
      HOLLOW_KNIGHT.total_reviews,
    );
    expect(units).not.toBeNull();
    expect((units as number) * HOLLOW_KNIGHT.price_initial).toBeCloseTo(HOLLOW_KNIGHT.est_rev_reviews, 6);
  });

  it("never returns the owners-based count for a reviews-based revenue", () => {
    const units = estimatedUnits(
      HOLLOW_KNIGHT.est_rev_reviews,
      HOLLOW_KNIGHT.price_initial,
      HOLLOW_KNIGHT.total_reviews,
    );
    // The old bug in one line: 251.5M / 7.5M = $33.53, not the $14.99 list price.
    expect(units).not.toBe(HOLLOW_KNIGHT.owners_mid);
    expect(units as number).toBeCloseTo(HOLLOW_KNIGHT.total_reviews * BOXLEITER_OWNERS_PER_REVIEW_MID, 0);
    expect(HOLLOW_KNIGHT.est_rev_reviews / (units as number)).toBeCloseTo(HOLLOW_KNIGHT.price_initial, 6);
  });

  it("stays on the reviews estimator for free-to-play, where there is no revenue to divide", () => {
    // price 0 -> est_rev_reviews is 0 and the revenue row prints "no box revenue at $0"; the
    // unit count still has to come from the same estimator rather than fall back to owners_mid.
    expect(estimatedUnits(0, 0, 10_000)).toBe(10_000 * BOXLEITER_OWNERS_PER_REVIEW_MID);
    expect(estimatedUnits(null, null, 10_000)).toBe(10_000 * BOXLEITER_OWNERS_PER_REVIEW_MID);
  });

  it("honours a caller-supplied owners-per-review ratio on the free-to-play branch", () => {
    expect(estimatedUnits(null, 0, 1_000, 55)).toBe(55_000);
  });

  it("is null only when neither a divisible revenue nor a review count exists", () => {
    expect(estimatedUnits(null, null, null)).toBeNull();
    expect(estimatedUnits(1_000, null, null)).toBeNull();
  });

  it("matches the mart's own multiplier, so the derived units reproduce est_rev_reviews", () => {
    // est_rev_reviews = total_reviews × BOXLEITER_MID × price (etl/build_marts.py); the same
    // constant here is what keeps the free-to-play branch on the same estimator as the rest.
    expect(HOLLOW_KNIGHT.total_reviews * BOXLEITER_OWNERS_PER_REVIEW_MID * HOLLOW_KNIGHT.price_initial).toBeCloseTo(
      HOLLOW_KNIGHT.est_rev_reviews,
      0,
    );
  });
});
