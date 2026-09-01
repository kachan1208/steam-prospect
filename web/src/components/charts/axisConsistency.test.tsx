import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { EntityReleaseBars } from "./EntityReleaseBars";
import { LaunchShapeBars } from "./LaunchShapeBars";
import { TimingBars } from "./TimingBars";
import { axisTicks, installChartLayout } from "../../test/recharts";
import type { EntityGameRow, LaunchCurvePoint } from "../../lib/api";

/**
 * A5 — the axes the audit measured, asserted on rendered ticks.
 *
 * Every "before" quoted here is a production tick string from 2026-09-01.
 */

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 300);
});
afterEach(() => {
  cleanup();
  restore();
});

/** Suffix + decimal-count vocabulary of a tick set; the bare "0"/"$0"/"0%" origin is exempt. */
function vocabulary(labels: string[]) {
  const suffixes = new Set<string>();
  const decimals = new Set<number>();
  for (const label of labels) {
    if (/^-?\$?0%?$/.test(label)) continue;
    const m = label.match(/^-?\$?([\d,]+)(?:\.(\d+))?([KMB%]?)$/);
    expect(m, `unparseable tick ${JSON.stringify(label)}`).not.toBeNull();
    suffixes.add(m![3]);
    decimals.add(m![2]?.length ?? 0);
  }
  return { suffixes, decimals };
}

describe("percent axes speak one vocabulary across the whole /timing page", () => {
  // "When players buy" — monthly demand share, ~8.3% average. Before: "0.0% / 3.0% /
  // 6.0% / 9.0% / 12.0%".
  const DEMAND = [7.4, 8.1, 9.6, 8.8, 7.9, 7.2, 8.0, 8.5, 8.9, 9.1, 11.7, 9.8].map((v, i) => ({
    label: String(i + 1),
    value: v,
  }));

  // "Launch shape by genre" mini — before: "0% / 8% / 16% / 24% / 32%", i.e. a DIFFERENT
  // vocabulary from the big charts above it on the same page.
  const CURVE: LaunchCurvePoint[] = [
    { day: 7, median_cum_fraction: 0.32, n_games: 100 },
    { day: 14, median_cum_fraction: 0.44, n_games: 100 },
    { day: 30, median_cum_fraction: 0.56, n_games: 100 },
    { day: 60, median_cum_fraction: 0.66, n_games: 100 },
    { day: 90, median_cum_fraction: 0.73, n_games: 100 },
    { day: 180, median_cum_fraction: 0.86, n_games: 100 },
    { day: 365, median_cum_fraction: 1, n_games: 100 },
  ] as unknown as LaunchCurvePoint[];

  it("prints the big percent chart with one decimal count", () => {
    const { container } = render(
      <TimingBars data={DEMAND} valueLabel="Share" formatValue={(v) => `${v.toFixed(1)}%`} axisKind="pct" />,
    );
    const ticks = axisTicks(container, "y");
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) expect(t.endsWith("%")).toBe(true);
    expect(vocabulary(ticks).decimals.size).toBe(1);
  });

  it("prints the launch-shape mini in the SAME vocabulary as the big charts", () => {
    const big = render(
      <TimingBars data={DEMAND} valueLabel="Share" formatValue={(v) => `${v.toFixed(1)}%`} axisKind="pct" />,
    );
    const bigTicks = axisTicks(big.container, "y");
    cleanup();
    const mini = render(<LaunchShapeBars points={CURVE} />);
    const miniTicks = axisTicks(mini.container, "y");
    expect(miniTicks.length).toBeGreaterThan(2);
    // Same decimal count on both — "20.0%" beside "32%" was the reported defect.
    expect(vocabulary(miniTicks).decimals).toEqual(vocabulary(bigTicks).decimals);
  });

  it("keeps a straddling score axis to one vocabulary and a sane tick count", () => {
    // "Best launch windows" — before: "-0.40 / -0.20 / 0.00 / 0.20 / 0.40".
    const scores = [-0.31, -0.12, 0.04, 0.22, 0.38, 0.11, -0.06, 0.19, 0.28, -0.22, 0.09, 0.33].map((v, i) => ({
      label: String(i + 1),
      value: v,
    }));
    const { container } = render(
      <TimingBars data={scores} valueLabel="Score" formatValue={(v) => v.toFixed(2)} axisKind="count" referenceY={0} />,
    );
    const ticks = axisTicks(container, "y");
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(9);
    expect(vocabulary(ticks).decimals.size).toBe(1);
    expect(ticks).toContain("0");
  });

  it("keeps the crowding chart's counts unabbreviated rather than printing 0.5K", () => {
    const congestion = [1_540, 1_210, 980, 1_100, 1_320, 760, 640, 890, 1_450, 1_600, 1_180, 1_020].map((v, i) => ({
      label: String(i + 1),
      value: v,
      secondary: Math.round(v / 13),
    }));
    const { container } = render(
      <TimingBars
        data={congestion}
        valueLabel="Releases / yr"
        formatValue={(v) => v.toFixed(0)}
        formatSecondary={(v) => v.toFixed(0)}
        axisKind="count"
      />,
    );
    const left = axisTicks(container, "y", 0);
    const right = axisTicks(container, "y", 1);
    expect(vocabulary(left).suffixes).toEqual(new Set([""]));
    expect(vocabulary(right).suffixes).toEqual(new Set([""]));
    for (const t of [...left, ...right]) expect(t).not.toMatch(/^0\.\d/);
  });
});

describe("EntityReleaseBars — the career revenue axis stays in one unit", () => {
  // A publisher whose biggest release clears $1B: before, the axis read
  // "$0 / $250M / $500M / $750M / $1.0B" — four ticks in millions, one in billions.
  const GAMES = [90e6, 310e6, 180e6, 620e6, 940e6, 410e6].map((rev, i) => ({
    appid: 100 + i,
    seq: i + 1,
    name: `Game ${i + 1}`,
    release_year: 2006 + i,
    est_rev_reviews: rev,
  })) as unknown as EntityGameRow[];

  it("prints every tick in the same unit", () => {
    const { container } = render(<EntityReleaseBars games={GAMES} />);
    const ticks = axisTicks(container, "y");
    expect(ticks.length).toBeGreaterThan(2);
    expect(vocabulary(ticks).suffixes.size).toBe(1);
    expect(vocabulary(ticks).decimals.size).toBe(1);
    expect(ticks.some((t) => t.endsWith("B"))).toBe(false);
  });

  it("keeps every tick prefixed with the currency it measures", () => {
    const { container } = render(<EntityReleaseBars games={GAMES} />);
    for (const t of axisTicks(container, "y")) expect(t.startsWith("$")).toBe(true);
  });
});
