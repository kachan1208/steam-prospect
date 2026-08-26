import { describe, expect, it } from "vitest";

import type { PricePoint } from "../../lib/api";
import { discountLabel, priceSeriesState } from "./PriceHistoryChart";

function point(overrides: Partial<PricePoint> = {}): PricePoint {
  return {
    captured_on: "2026-08-24",
    final_cents: 3999,
    original_cents: null,
    discount_pct: 0,
    is_free: false,
    country: "US",
    ...overrides,
  };
}

describe("priceSeriesState — thin-data render states", () => {
  it("empty series -> 'empty' (also the swallowed-error state)", () => {
    expect(priceSeriesState([])).toBe("empty");
  });

  it("snapshots with no plottable price -> 'empty', not a chart of nothing", () => {
    expect(priceSeriesState([point({ final_cents: null })])).toBe("empty");
  });

  it("1-2 points -> 'dots' (no pretense of a curve)", () => {
    expect(priceSeriesState([point()])).toBe("dots");
    expect(priceSeriesState([point(), point({ captured_on: "2026-08-25" })])).toBe("dots");
  });

  it("3+ points -> 'line'", () => {
    expect(
      priceSeriesState([
        point(),
        point({ captured_on: "2026-08-25" }),
        point({ captured_on: "2026-08-26" }),
      ]),
    ).toBe("line");
  });

  it("null-price days don't count toward the 3-point line threshold", () => {
    expect(
      priceSeriesState([
        point(),
        point({ captured_on: "2026-08-25", final_cents: null }),
        point({ captured_on: "2026-08-26" }),
      ]),
    ).toBe("dots");
  });

  it("free to play (latest snapshot) -> 'free', regardless of series depth", () => {
    expect(priceSeriesState([point({ final_cents: null, is_free: true })])).toBe("free");
    expect(
      priceSeriesState([
        point(),
        point({ captured_on: "2026-08-25", final_cents: null, is_free: true }),
      ]),
    ).toBe("free");
  });
});

describe("discountLabel — tooltip emphasis row", () => {
  it("undiscounted day -> null (no row)", () => {
    expect(discountLabel(point())).toBeNull();
  });

  it("discounted day -> '−N% (was $X)'", () => {
    expect(discountLabel(point({ final_cents: 1999, original_cents: 3999, discount_pct: 50 }))).toBe(
      "−50% (was $39.99)",
    );
  });

  it("discount without a recorded original price omits the 'was' clause", () => {
    expect(discountLabel(point({ final_cents: 1999, original_cents: null, discount_pct: 50 }))).toBe("−50%");
  });
});
