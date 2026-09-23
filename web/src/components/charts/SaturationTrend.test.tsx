import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SaturationTrend, partialTrendYear, trendTakeaways } from "./SaturationTrend";
import { axisTicks, installChartLayout } from "../../test/recharts";
import type { TrendPoint } from "../../lib/api";

/**
 * The niche page's yearly chart is two aligned small multiples, each with a takeaway computed
 * from the data (2026-09-23): it replaced a dual-axis chart whose caption apologised that
 * "where the lines cross means nothing", and whose partial-year copy called every partial
 * year a "drop" — Roguelike Deckbuilder's 2026 is a rise.
 */

const AS_OF = new Date("2026-09-21T22:28:20Z");

// Roguelike Deckbuilder-shaped: releases still growing INTO the partial year.
const RISING: TrendPoint[] = [
  { year: 2023, n_releases: 150, n_scored: 40, median_rev: 60_000, p90_rev: 2_000_000 },
  { year: 2024, n_releases: 190, n_scored: 47, median_rev: 70_622, p90_rev: 5_874_407 },
  { year: 2025, n_releases: 250, n_scored: 50, median_rev: 116_338, p90_rev: 11_245_567 },
  { year: 2026, n_releases: 260, n_scored: 36, median_rev: 116_520, p90_rev: 1_202_827 },
];

// A niche whose partial year hasn't caught up yet.
const LAGGING: TrendPoint[] = RISING.map((p) => (p.year === 2026 ? { ...p, n_releases: 120 } : p));

describe("trendTakeaways — one plain line per panel", () => {
  it("compares the last two FULL years, bearish caveat included", () => {
    const t = trendTakeaways(RISING, AS_OF);
    expect(t.releases).toBe("Releases are rising: 250 in 2025 vs 190 in 2024 (+32%).");
    expect(t.revenue).toMatch(/^Top-10% revenue of each year's releases rose: \$11\.2M for 2025 vs \$5\.9M for 2024 \(\+91%\)\./);
    expect(t.revenue).toContain("Newer games have had less time to earn");
    expect(t.partialYear).toBe(2026);
  });

  it("describes the partial year by what it actually does — never a blanket 'drop'", () => {
    const up = trendTakeaways(RISING, AS_OF).partial!;
    expect(up).toBe(
      "2026 is a partial year (to Sep 21), and its 260 releases already exceed 2025's 250 — the pipeline is still growing.",
    );
    expect(up).not.toMatch(/drop|cliff/);
    const lag = trendTakeaways(LAGGING, AS_OF).partial!;
    expect(lag).toBe(
      "2026 is a partial year (to Sep 21): 120 releases so far against 2025's 250 — the rest of the year is still to come, so its lower bar is not a drop.",
    );
  });

  it("no partial year once the series stops before the data's year", () => {
    const t = trendTakeaways(RISING.slice(0, 3), AS_OF);
    expect(t.partial).toBeNull();
    expect(partialTrendYear(RISING.slice(0, 3), AS_OF)).toBeNull();
    expect(t.releases).toBe("Releases are rising: 250 in 2025 vs 190 in 2024 (+32%).");
  });

  it("falls back to the median line — named as such — on a mart without the top-10% column", () => {
    const noP90 = RISING.map(({ p90_rev: _p, ...rest }) => rest);
    expect(trendTakeaways(noP90, AS_OF).revenueLabel).toBe("Median revenue");
  });
});

describe("SaturationTrend — two single-unit panels, no dual axis", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installChartLayout(900, 320);
  });
  afterEach(() => {
    cleanup();
    restore();
  });

  it("draws releases and revenue as two charts, each with ONE y-axis in its own unit", () => {
    const { container } = render(<SaturationTrend points={RISING} asOf={AS_OF} />);
    const charts = container.querySelectorAll<HTMLElement>(".recharts-wrapper");
    expect(charts).toHaveLength(2);
    for (const c of charts) expect(c.querySelectorAll(".recharts-yAxis")).toHaveLength(1);
    const releaseTicks = axisTicks(charts[0], "y", 0);
    const revenueTicks = axisTicks(charts[1], "y", 0);
    for (const t of releaseTicks) expect(t.startsWith("$")).toBe(false);
    for (const t of revenueTicks) expect(t.startsWith("$")).toBe(true);
    // The apology caption is gone; the takeaways say what the panels show.
    expect(screen.queryByText(/Where the lines cross means nothing/)).toBeNull();
    expect(screen.getByTestId("takeaway-releases").textContent).toContain("Releases are rising");
    expect(screen.getByTestId("takeaway-partial").textContent).toContain("still growing");
  });
});
