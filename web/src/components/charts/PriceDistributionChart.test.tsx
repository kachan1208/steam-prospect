import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  PRICE_PERCENTILE_WORDS,
  PriceDistributionChart,
  PricePercentiles,
  priceBins,
  priceCap,
  priceTakeaway,
} from "./PriceDistributionChart";
import { axisTicks, installChartLayout } from "../../test/recharts";

/**
 * /timing's price histogram drew the API's buckets as evenly spaced CATEGORIES, and the API
 * omits empty buckets — so the axis read "$87.50 → $107.50 → $122.50 → … → $1,900" at equal
 * spacing (2026-09-22 review). Pinned here: every $2.50 band is drawn from $0 to the cap, the
 * ticks step by exactly $10, and what lies past the cap is counted in words.
 */

const bucket = (x: number, count: number) => ({ bucket_index: x / 2.5, x_min: x, x_max: x + 2.5, count });
const BUCKETS = [bucket(0, 17656), bucket(2.5, 28377), bucket(7.5, 16790), bucket(17.5, 6354), bucket(57.5, 333), bucket(87.5, 7), bucket(1900, 1)];
const PCT = [
  { pctile: "p10", value: 1.99 },
  { pctile: "p50", value: 5.99 },
  { pctile: "p90", value: 19.99 },
  { pctile: "p99", value: 49.99 },
];

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 260);
});
afterEach(() => {
  cleanup();
  restore();
});

describe("priceCap / priceBins", () => {
  it("draws to $70 — the AAA price points — or past a pricier genre's 99th percentile", () => {
    expect(priceCap(49.99)).toBe(70);
    expect(priceCap(59.99)).toBe(80);
    expect(priceCap(null)).toBe(70);
  });

  it("fills every empty $2.50 band with a zero bar, so equal spacing IS equal dollars", () => {
    const { bins, width, tail } = priceBins(BUCKETS, 70);
    expect(width).toBe(2.5);
    expect(bins).toHaveLength(28); // $0 .. $67.50
    expect(bins.map((b) => b.lo).slice(0, 5)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(bins.find((b) => b.lo === 5)!.count).toBe(0); // the API sent no $5 bucket
    expect(bins.find((b) => b.lo === 57.5)!.count).toBe(333);
    // Past the cap: counted, not drawn.
    expect(tail).toEqual({ count: 8, maxPrice: 1900 });
  });
});

describe("priceTakeaway / PricePercentiles — plain words, never P10..P99", () => {
  it("reads the median and the dearest tenth as a sentence", () => {
    expect(priceTakeaway(PCT)).toBe("Half of paid games cost $5.99 or less; only 1 in 10 costs $19.99 or more.");
    expect(priceTakeaway([])).toBeNull();
  });

  it("labels each percentile in words, with the side it bounds", () => {
    render(<PricePercentiles percentiles={PCT} n={95_757} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Cheapest 10%: $1.99 or less");
    expect(text).toContain("Median: $5.99");
    expect(text).toContain("Dearest 10%: $19.99 or more");
    expect(text).not.toMatch(/\bP\d\d\b/);
    expect(screen.getByRole("button", { name: "About Price percentiles" })).toBeTruthy();
    expect(Object.keys(PRICE_PERCENTILE_WORDS)).toEqual(["p10", "p25", "p50", "p75", "p90", "p95", "p99"]);
  });
});

describe("PriceDistributionChart — an axis whose spacing is honest", () => {
  it("ticks every $10 from $0, in one vocabulary, and never reaches $1,900", () => {
    const { container } = render(
      <PriceDistributionChart buckets={BUCKETS} percentiles={PCT} n={95_757} genreLabel="All genres" />,
    );
    const ticks = axisTicks(container, "x");
    expect(ticks).toEqual(["$0", "$10", "$20", "$30", "$40", "$50", "$60"]);
    expect(container.textContent).toContain("Not drawn: 8 games priced $70.00 or more");
    expect(container.textContent).toContain("the dearest at about $1,900");
  });
});
