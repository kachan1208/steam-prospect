import { describe, expect, it } from "vitest";

import {
  estimateSentinel,
  fmtPts,
  fmtShareTrim,
  fmtTrendPct,
  gameEstimate,
  missingEstimateText,
  playersTrendRead,
} from "./gameEstimates";
import { fmtPriceFor, priceKind } from "./format";

/** GET /api/games/{appid} on the 2026-09-23 mart, the fields the estimate reads. */
const BALATRO = { total_reviews: 198_859, price_initial: 14.99, is_free: 0, price_status: "paid" as const, est_rev_reviews: 89_426_892.3 };

describe("gameEstimate — one estimator, with its reasons", () => {
  it("prints the mart's own estimate with the ×20–×55 range and the units it implies", () => {
    const e = gameEstimate(BALATRO);
    expect(e.status).toBe("estimated");
    expect(e.mid).toBeCloseTo(89_426_892.3, 1);
    expect(e.low).toBeCloseTo(198_859 * 20 * 14.99, 1);
    expect(e.high).toBeCloseTo(198_859 * 55 * 14.99, 1);
    // Units are the displayed revenue ÷ the price, so the pair can't disagree.
    expect((e.units as number) * 14.99).toBeCloseTo(e.mid as number, 3);
    expect(e.revenueWorked).toBe("198,859 reviews × 30 × $14.99 = $89.4M");
    expect(e.rangeWorked).toBe("× 20 = $59.6M … × 55 = $163.9M");
    expect(e.unitsWorked).toBe("198,859 reviews × 30 = 6.0M = $89.4M ÷ $14.99");
    expect(estimateSentinel(e)).toBeNull();
  });

  it("refuses to estimate a 0-review game rather than print $0", () => {
    const e = gameEstimate({ total_reviews: 0, price_initial: 7.99, is_free: 0, est_rev_reviews: 0 });
    expect(e.status).toBe("no-reviews");
    expect(e.mid).toBeNull();
    expect(missingEstimateText(e, "revenue")).toBe("Not enough reviews to estimate (0 reviews)");
    expect(estimateSentinel(e)).toBe("not estimated");
  });

  it("gives a free game no unit sales and no box revenue", () => {
    const e = gameEstimate({ total_reviews: 9_871_661, price_initial: 0, is_free: 1, price_status: "free" });
    expect(e.status).toBe("free");
    expect(e.units).toBeNull();
    expect(missingEstimateText(e, "units")).toBe("Free to play — no unit sales");
    expect(estimateSentinel(e)).toBe("not applicable");
  });

  it("calls a $0 price without Steam's free flag unknown, not free", () => {
    const e = gameEstimate({ total_reviews: 2_078_902, price_initial: 0, is_free: 0 });
    expect(e.status).toBe("price-unknown");
    expect(missingEstimateText(e, "revenue")).toBe("Price unknown — the estimate needs a list price");
  });

  it("flags an estimate on a handful of reviews", () => {
    const e = gameEstimate({ total_reviews: 8, price_initial: 6.99, is_free: 0, est_rev_reviews: 1677.6 });
    expect(e.status).toBe("estimated");
    expect(e.smallSample).toBe(true);
    expect(estimateSentinel(e)).toBe("small sample");
  });
});

describe("priceKind — the page reads price the way every page does", () => {
  it("prefers the mart's price_status over the price/flag heuristic", () => {
    expect(priceKind({ price_initial: 19.99, is_free: 1 })).toBe("paid"); // Rainbow Six Siege
    expect(priceKind({ price_initial: 0, is_free: 0 })).toBe("unknown");
    expect(priceKind({ price_initial: null, is_free: 1 })).toBe("free");
    expect(priceKind({ price_initial: 0, is_free: 1, price_status: "unknown" })).toBe("unknown");
  });

  it("prints the price a reader should see", () => {
    expect(fmtPriceFor({ price_initial: 14.99, is_free: 0 })).toBe("$14.99");
    expect(fmtPriceFor({ price_initial: 0, is_free: 1 })).toBe("Free");
    expect(fmtPriceFor({ price_initial: 0, is_free: 0 })).toBe("Price unknown");
    expect(fmtPriceFor({ price_initial: null, is_free: null })).toBe("Price unknown");
  });
});

describe("players trend vs the market", () => {
  it("reads the game's week against Steam's when the market trend is served (SCUM)", () => {
    const r = playersTrendRead({ players_trend_7d_pct: -5.75, players_trend_7d_market_pct: 0.75, players_trend_7d_rel_pct: -6.5 });
    expect(r.trend).toBe("-5.8% vs the prior 7 days");
    expect(r.market).toBe("Steam overall +0.8% → -6.5 pts vs market");
    expect(r.worked).toBe("-5.8% (this game) − +0.8% (all of Steam) = -6.5 pts");
  });

  it("shows a served relative figure it can't reproduce as served, without the equation", () => {
    const r = playersTrendRead({ players_trend_7d_pct: 5, players_trend_7d_market_pct: 2, players_trend_7d_rel_pct: 2.94 });
    expect(r.worked).toBe("this game +5.0%, all of Steam +2.0%; served relative trend +2.9 pts");
  });

  it("falls back to the plain trend on a mart without the market columns", () => {
    const r = playersTrendRead({ players_trend_7d_pct: -3.49 });
    expect(r.trend).toBe("-3.5% vs the prior 7 days");
    expect(r.market).toBeNull();
  });

  it("formats shares and signed changes without a trailing .0 or a -0", () => {
    expect(fmtShareTrim(1)).toBe("100%");
    expect(fmtShareTrim(0.9783)).toBe("97.8%");
    expect(fmtTrendPct(0.02)).toBe("0.0%");
    expect(fmtPts(-0.001)).toBe("0.0 pts");
  });
});
