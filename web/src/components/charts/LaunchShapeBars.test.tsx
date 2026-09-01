import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { LaunchShapeBars, StaggeredTick, needsStaggeredAxis } from "./LaunchShapeBars";
import { axisTicks, installChartLayout } from "../../test/recharts";
import type { LaunchCurvePoint } from "../../lib/api";

/**
 * A10 — the launch-shape x-axis ran its labels together at phone widths: /timing @390
 * printed `4–6m7–12m`, because with `interval={0}` all seven windows share one row and
 * the gap between those two collapsed to 1px.
 *
 * The widths below are measured, not chosen: on production 2026-09-01 the chart's
 * container was 274px at 390 (1px gap — collision), 292px at 1440 where /timing lays the
 * charts out four to a row (3px — no better), and 417px at 1024 where the same axis is
 * comfortable (21px). Note the ordering: 1440 is NARROWER than 1024, which is why the fix
 * keys off the chart's own measured width and not a viewport breakpoint.
 */
describe("needsStaggeredAxis", () => {
  it("staggers where the labels were measured to collide", () => {
    expect(needsStaggeredAxis(274)).toBe(true); // /timing @390 — the reported `4–6m7–12m`
    expect(needsStaggeredAxis(292)).toBe(true); // /timing @1440 — 3px apart, four to a row
  });

  it("leaves the axis alone where it already had room", () => {
    expect(needsStaggeredAxis(417)).toBe(false); // /timing @1024 — 21px apart
    expect(needsStaggeredAxis(900)).toBe(false);
  });

  it("does not stagger before the container has been measured", () => {
    // Width 0 is the pre-measure state; guessing "narrow" there would flash a two-row
    // axis on every mount at desktop widths.
    expect(needsStaggeredAxis(0)).toBe(false);
  });
});

describe("StaggeredTick", () => {
  it("alternates rows so neighbouring labels never share one", () => {
    const dy = [0, 1, 2, 3].map((index) => {
      const { container } = render(
        <svg>
          <StaggeredTick x={10} y={20} index={index} payload={{ value: "7–12m" }} />
        </svg>,
      );
      return container.querySelector("text")?.getAttribute("dy");
    });
    expect(dy).toEqual(["11", "23", "11", "23"]);
  });

  it("still renders the label, so staggering never costs a window", () => {
    const { container } = render(
      <svg>
        <StaggeredTick x={10} y={20} index={5} payload={{ value: "4–6m" }} />
      </svg>,
    );
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("4–6m");
    // recharts' own class has to survive: index.css styles ticks through it.
    expect(text?.getAttribute("class")).toBe("recharts-cartesian-axis-tick-value");
  });
});

/**
 * A5, the y-axis half — and the one assertion the A5 work shipped without.
 *
 * LaunchShapeBars routes its y-axis through the shared `axisScale(max, "pct", 4)` instead
 * of letting recharts pick a domain off the data. With this fixture the largest window is
 * 32%, so the two behaviours are visibly different:
 *
 *     shared scale (correct)   0% / 10% / 20% / 30% / 40%
 *     recharts' own domain     0% /  8% / 16% / 24% / 32%
 *
 * That second row is verbatim the defect quoted in axisConsistency.test.tsx's own fixture
 * comment. It was nonetheless invisible to every test in the tree: the sibling check in
 * axisConsistency compares only tick SUFFIXES and DECIMAL COUNTS between the mini and the
 * big charts, and 8/16/24/32 and 10/20/30/40 are both integer-and-percent — identical
 * vocabularies, different numbers. Reverting the axis wiring left the whole suite green.
 *
 * So this asserts the tick STRINGS. The load-bearing part is the top tick: a shared scale
 * rounds UP past the data (40 > 32), while a data-fitted domain lands exactly on it.
 */
describe("LaunchShapeBars y-axis", () => {
  const CURVE = [
    { day: 7, median_cum_fraction: 0.32, n_games: 100 },
    { day: 14, median_cum_fraction: 0.44, n_games: 100 },
    { day: 30, median_cum_fraction: 0.56, n_games: 100 },
    { day: 60, median_cum_fraction: 0.66, n_games: 100 },
    { day: 90, median_cum_fraction: 0.73, n_games: 100 },
    { day: 180, median_cum_fraction: 0.86, n_games: 100 },
    { day: 365, median_cum_fraction: 1, n_games: 100 },
  ] as unknown as LaunchCurvePoint[];

  it("takes its ticks from the shared percent scale, not from the data's own maximum", () => {
    const restore = installChartLayout(900, 320);
    try {
      const { container } = render(<LaunchShapeBars points={CURVE} />);
      expect(axisTicks(container, "y")).toEqual(["0%", "10%", "20%", "30%", "40%"]);
    } finally {
      restore();
    }
  });

  it("rounds the axis up past the tallest bar rather than stopping on it", () => {
    // The generic form of the above: whatever the scale picks, the top tick must clear the
    // data (here 32%). This is what a data-fitted domain can never satisfy.
    const restore = installChartLayout(900, 320);
    try {
      const { container } = render(<LaunchShapeBars points={CURVE} />);
      const ticks = axisTicks(container, "y").map((t) => Number(t.replace("%", "")));
      expect(Math.max(...ticks)).toBeGreaterThan(32);
      for (const t of ticks) expect(t % 10).toBe(0);
    } finally {
      restore();
    }
  });
});
