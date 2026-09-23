import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  SaturationTrend,
  TREND_REV_MIN_SCORED,
  partialTrendYear,
  trendTakeaways,
  yearRanges,
} from "./SaturationTrend";
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

/**
 * THIN YEARS (2026-09-23 visual check): Roguelike's 2012 had 9 games with 50+ reviews, so its
 * "top 10%" ($27.8M) was one hit — and it set the axis, pressing every later year flat.
 */
describe("thin years — a top-10% figure off one or two games is never plotted", () => {
  // The real GET /api/niches/tag/Roguelike saturation_trend, 2026-09-23 mart (trimmed).
  const ROGUELIKE: TrendPoint[] = [
    { year: 2012, n_releases: 10, n_scored: 9, median_rev: 217_522.5, p90_rev: 27_774_577.62 },
    { year: 2013, n_releases: 31, n_scored: 31, median_rev: 1_035_681.9, p90_rev: 7_127_455.5 },
    { year: 2024, n_releases: 1477, n_scored: 469, median_rev: 58_792.95, p90_rev: 986_135.28 },
    { year: 2025, n_releases: 1781, n_scored: 504, median_rev: 73_966.2, p90_rev: 866_086.74 },
    { year: 2026, n_releases: 2000, n_scored: 369, median_rev: 59_205.9, p90_rev: 605_206.26 },
  ];
  // Naval Combat-shaped: most years under the bar, including 2025.
  const SMALL: TrendPoint[] = [
    { year: 2022, n_releases: 35, n_scored: 16, median_rev: 279_966, p90_rev: 1_410_541 },
    { year: 2023, n_releases: 42, n_scored: 13, median_rev: 87_655, p90_rev: 2_303_795 },
    { year: 2024, n_releases: 49, n_scored: 21, median_rev: 274_326, p90_rev: 3_384_312 },
    { year: 2025, n_releases: 49, n_scored: 12, median_rev: 89_349, p90_rev: 21_524_773 },
    { year: 2026, n_releases: 53, n_scored: 1, median_rev: 240_174, p90_rev: 42_917_317 },
  ];

  it("names the thin year and its count, and plots the rest", () => {
    const t = trendTakeaways(ROGUELIKE, AS_OF);
    expect(TREND_REV_MIN_SCORED).toBe(20);
    expect(t.thinYears).toEqual([2012]);
    expect(t.plottedYears).toEqual([2013, 2024, 2025, 2026]);
    expect(t.thinNote).toBe(
      "Not plotted: 2012 — only 9 games with 50+ reviews; under 20, a year's top 10% is just its one or two biggest games.",
    );
    // The full-year comparison is unaffected: both years are well sampled.
    expect(t.revenue).toMatch(/^Top-10% revenue of each year's releases fell: \$866\.1K for 2025 vs \$986\.1K for 2024/);
  });

  it("refuses a year-over-year read when either year is thin, and lists many thin years as ranges", () => {
    const t = trendTakeaways(SMALL, AS_OF);
    expect(t.revenue).toBe(
      "Too few games with 50+ reviews for a year-over-year revenue read: 2025 has 12, 2024 has 21 — a year needs 20.",
    );
    expect(t.thinYears).toEqual([2022, 2023, 2025, 2026]);
    expect(t.thinNote).toBe(
      "Not plotted: 2022–2023, 2025–2026 — each has fewer than 20 games with 50+ reviews; under 20, a year's top 10% is just its one or two biggest games.",
    );
    expect(yearRanges([2016, 2012, 2013, 2014])).toBe("2012–2014, 2016");
    expect(yearRanges([])).toBe("");
  });

  describe("drawn", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = installChartLayout(900, 320);
    });
    afterEach(() => {
      cleanup();
      restore();
    });

    it("scales the revenue axis on the plotted years — the one-hit 2012 no longer sets it", () => {
      const { container } = render(<SaturationTrend points={ROGUELIKE} asOf={AS_OF} />);
      const charts = container.querySelectorAll<HTMLElement>(".recharts-wrapper");
      expect(charts).toHaveLength(2);
      const top = axisTicks(charts[1], "y", 0).at(-1)!;
      // 2013's $7.1M is the largest plotted figure; the axis tops out just above it, not at $30M.
      expect(top).toMatch(/^\$(7\.5|8|10)M$/);
      expect(screen.getByTestId("takeaway-thin").textContent).toContain("2012 — only 9 games");
    });

    it("draws no revenue line at all when fewer than two years clear the bar — and says why", () => {
      const { container } = render(<SaturationTrend points={SMALL} asOf={AS_OF} />);
      expect(container.querySelectorAll(".recharts-wrapper")).toHaveLength(1); // releases only
      expect(screen.getByTestId("revenue-not-drawn").textContent).toBe(
        "No yearly revenue line: only 2024 has 20 or more games with 50+ reviews — too few for a year-by-year read in a niche this size.",
      );
      // The flagged box is the whole story: no year-over-year line, no list of thin years.
      expect(screen.queryByTestId("takeaway-revenue")).toBeNull();
      expect(screen.queryByTestId("takeaway-thin")).toBeNull();
    });
  });
});
