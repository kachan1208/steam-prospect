import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import {
  FRONT_LOADED_RATIO,
  LaunchShapeBars,
  StaggeredTick,
  fmtShare,
  launchShapeSummary,
  launchWindows,
  needsStaggeredAxis,
} from "./LaunchShapeBars";
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

/**
 * PER WEEK, NOT PER WINDOW (2026-09-23). The windows run from 7 days to 185, and drawing their
 * RAW shares as equal bars gave every genre the same fake U: GET /api/launch-curve?genre=Action
 * (median column verbatim below) puts 19.1% of first-year reviews in months 7–12 — a bar
 * two-thirds the height of week one's 30% — but that 19.1% took 26.4 weeks: 0.72% a week.
 */
const ACTION = [
  { day: 7, mean_cum_fraction: 0.323, median_cum_fraction: 0.3, n_games: 23443 },
  { day: 14, mean_cum_fraction: 0.397, median_cum_fraction: 0.38461538461538464, n_games: 23443 },
  { day: 30, mean_cum_fraction: 0.479, median_cum_fraction: 0.48, n_games: 23443 },
  { day: 60, mean_cum_fraction: 0.57, median_cum_fraction: 0.5852713178294574, n_games: 23443 },
  { day: 90, mean_cum_fraction: 0.637, median_cum_fraction: 0.66, n_games: 23443 },
  { day: 180, mean_cum_fraction: 0.779, median_cum_fraction: 0.8088235294117647, n_games: 23443 },
  { day: 365, mean_cum_fraction: 1, median_cum_fraction: 1, n_games: 23443 },
] as LaunchCurvePoint[];

describe("launchWindows — each window's share per WEEK", () => {
  it("divides every window's share by its length in weeks", () => {
    const w = launchWindows(ACTION);
    expect(w.map((x) => x.label)).toEqual(["1w", "2w", "3–4w", "2m", "3m", "4–6m", "7–12m"]);
    // Raw shares still come off the median curve's differences...
    expect(w[0].share).toBeCloseTo(30, 6);
    expect(w[6].share).toBeCloseTo(19.12, 2);
    // ...but the bar is the weekly pace: 19.1% over 185 days is 0.72%/week, not 19.1.
    expect(w[0].perWeek).toBeCloseTo(30, 6);
    expect(w[6].weeks).toBeCloseTo(185 / 7, 6);
    expect(w[6].perWeek).toBeCloseTo(0.7235, 3);
    // No U: the pace falls from launch week to the back half of the year.
    const pace = w.map((x) => x.perWeek as number);
    for (let i = 1; i < pace.length; i++) expect(pace[i]).toBeLessThan(pace[i - 1]);
  });

  it("reports a window with a missing edge as unknown, never as a 0% bar", () => {
    const w = launchWindows(ACTION.filter((p) => p.day !== 90));
    expect(w.find((x) => x.label === "3m")?.perWeek).toBeNull();
    expect(w.find((x) => x.label === "4–6m")?.perWeek).toBeNull();
    expect(w.find((x) => x.label === "2m")?.perWeek).not.toBeNull();
  });
});

describe("launchShapeSummary — the takeaway headline", () => {
  it("leads with the front-loaded pace and what it costs a weak launch", () => {
    const s = launchShapeSummary(ACTION, "Action")!;
    expect(s.frontLoaded).toBe(true);
    expect(s.ratio).toBeCloseTo(30 / 0.7235, 1);
    expect(s.headline).toBe(
      "Front-loaded: a typical Action game collects 30% of its first-year reviews in week 1 alone, then 0.7% a week in months 7–12 — a 41× slower pace. 48% have landed by day 30, so a weak launch week is hard to make up later.",
    );
    expect(s.worked).toBe(
      "week 1: 30% ÷ 1 week = 30%/week; months 7–12: 19% ÷ 26.4 weeks = 0.7%/week; 30% ÷ 0.7% = 41×; by day 30: 48%",
    );
  });

  it("calls a flat curve a slow burn", () => {
    // 1/52 of the year every week: week one runs at the same pace as months 7–12.
    const flat = [7, 14, 30, 60, 90, 180, 365].map((day) => ({
      day,
      mean_cum_fraction: day / 365,
      median_cum_fraction: day / 365,
      n_games: 100,
    })) as LaunchCurvePoint[];
    const s = launchShapeSummary(flat)!;
    expect(s.ratio).toBeLessThan(FRONT_LOADED_RATIO);
    expect(s.frontLoaded).toBe(false);
    expect(s.headline).toMatch(/^Slow burn: a typical game collects 1\.9% of its first-year reviews in week 1/);
  });

  it("has nothing to say without both ends of the curve", () => {
    expect(launchShapeSummary(ACTION.filter((p) => p.day !== 7))).toBeNull();
    expect(launchShapeSummary([])).toBeNull();
  });

  it("formats shares one way everywhere: whole percent from 10 up, one decimal below", () => {
    expect(fmtShare(30)).toBe("30%");
    expect(fmtShare(8.462)).toBe("8.5%");
    expect(fmtShare(0.7235)).toBe("0.7%");
    expect(fmtShare(9.96)).toBe("10%");
  });
});

describe("LaunchShapeBars — rendered per week", () => {
  it("draws the months 7–12 bar at its weekly pace, a sliver of week one's, and labels it", () => {
    const restore = installChartLayout(900, 320);
    try {
      const { container } = render(<LaunchShapeBars points={ACTION} />);
      const bars = Array.from(container.querySelectorAll(".recharts-bar-rectangle path")).map((p) =>
        Number(p.getAttribute("height") ?? 0),
      );
      expect(bars.length).toBe(7);
      // Week one 30%/wk vs months 7–12 0.72%/wk: the last bar is ~2.4% of the first, where
      // the raw-share chart drew it at 64%.
      expect(bars[6] / bars[0]).toBeLessThan(0.05);
      const labels = Array.from(container.querySelectorAll(".launch-shape-value")).map((t) => t.textContent);
      expect(labels).toContain("30%");
      expect(labels).toContain("0.7%");
      // The unit is named on the chart itself, so /timing's minis carry it too.
      expect(container.querySelector('[data-testid="launch-shape-unit"]')?.textContent).toBe(
        "% of first-year reviews per week, by window after launch",
      );
    } finally {
      restore();
    }
  });
});
