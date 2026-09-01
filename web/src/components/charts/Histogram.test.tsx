import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Histogram } from "./Histogram";
import { axisTicks, installChartLayout } from "../../test/recharts";

/**
 * A5 — the /timing "Price distribution" histogram, the chart the mixed-format defect was
 * reported on. Fixtures are the real bucket edges from
 * GET /api/market/distribution?metric=price&window=all (2026-09-01): 46 linear $2.50 bins
 * from $0 with a sparse tail out to $1,902.50, plus the two benchmark marks the chart
 * draws on the same axis.
 *
 * Before the fix this rendered
 *   x: "$0.00 / $5.00 / $10 / $13 / $15 / $18 / … / $500 / $1.9K"
 *   y: "0 / 7,000 / 14.0K / 21.0K / 28.0K"
 * — three dollar vocabularies on one axis, two count vocabularies on the other, and "$13"
 * was a $12.50 bin edge rounded past the gridline it actually sits on.
 */

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 300);
});
afterEach(() => {
  cleanup();
  restore();
});

const EDGES: number[] = [];
for (let i = 0; i < 40; i++) EDGES.push(i * 2.5);
EDGES.push(197.5, 247.5, 297.5, 482.5, 500, 615, 997.5, 1900);

const PRICE_BUCKETS = EDGES.map((x_min, i) => ({
  bucket_index: i,
  x_min,
  x_max: x_min + 2.5,
  count: Math.max(0, 27_736 - i * 600),
}));

const MARKS = [
  { label: "$9.99", value: 9.99 },
  { label: "$19.99", value: 19.99 },
];

function renderHistogram() {
  return render(<Histogram buckets={PRICE_BUCKETS} color="var(--accent-300)" xKind="usd" marks={MARKS} />);
}

/** The suffix + decimal-count vocabulary of a set of tick strings; "0" is exempt. */
function vocabulary(labels: string[]) {
  const suffixes = new Set<string>();
  const decimals = new Set<number>();
  for (const label of labels) {
    if (/^-?\$?0$/.test(label)) continue;
    const m = label.match(/^-?\$?([\d,]+)(?:\.(\d+))?([KMB]?)$/);
    expect(m, `unparseable tick ${JSON.stringify(label)}`).not.toBeNull();
    suffixes.add(m![3]);
    decimals.add(m![2]?.length ?? 0);
  }
  return { suffixes, decimals };
}

describe("Histogram — the price-distribution axes speak one language each", () => {
  it("draws its axes at all under the test layout (guards the harness, not the fix)", () => {
    const { container } = renderHistogram();
    expect(axisTicks(container, "x").length).toBeGreaterThan(3);
    expect(axisTicks(container, "y").length).toBeGreaterThan(2);
  });

  it("prints one dollar unit and one decimal count across the whole x-axis", () => {
    const { container } = renderHistogram();
    const v = vocabulary(axisTicks(container, "x"));
    expect(v.suffixes.size).toBe(1);
    expect(v.decimals.size).toBe(1);
  });

  it("never abbreviates the tail to $1.9K while the head is still in dollars", () => {
    const { container } = renderHistogram();
    expect(axisTicks(container, "x").some((t) => /[KMB]$/.test(t))).toBe(false);
  });

  it("stops rounding the $12.50 bin edge onto a $13 label it does not sit at", () => {
    const { container } = renderHistogram();
    const ticks = axisTicks(container, "x");
    expect(ticks).not.toContain("$13");
    expect(ticks).not.toContain("$18");
  });

  it("prints one count unit across the whole y-axis", () => {
    const { container } = renderHistogram();
    const v = vocabulary(axisTicks(container, "y"));
    expect(v.suffixes.size).toBe(1);
    expect(v.decimals.size).toBe(1);
    // And no comma-grouped thousand sitting under a K-abbreviated one.
    expect(axisTicks(container, "y")).not.toContain("7,000");
  });
});
