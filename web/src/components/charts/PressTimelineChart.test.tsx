import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PressTimelineChart, wholeCountAxis } from "./PressTimelineChart";
import { axisTicks, installChartLayout } from "../../test/recharts";
import { ZoomRangeProvider } from "../../lib/zoomRange";
import type { PressTimelinePoint } from "../../lib/api";

const Page = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter>
    <ZoomRangeProvider>{children}</ZoomRangeProvider>
  </MemoryRouter>
);

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 300);
});
afterEach(() => {
  cleanup();
  restore();
});

/** Balatro's press timeline (GET /api/games/2379780/teardown), verbatim: 6 months of
 * coverage spread over 15. */
const BALATRO: PressTimelinePoint[] = [
  { period: "2024-02", n_mentions: 2 },
  { period: "2024-03", n_mentions: 2 },
  { period: "2024-07", n_mentions: 1 },
  { period: "2024-09", n_mentions: 1 },
  { period: "2024-12", n_mentions: 1 },
  { period: "2025-04", n_mentions: 1 },
];

function bars(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".recharts-bar-rectangle path"));
}

describe("PressTimelineChart — every month gets a slot", () => {
  it("draws the silent months as empty slots, so gaps are as wide as they were", () => {
    const { container } = render(<PressTimelineChart points={BALATRO} asOf={new Date(Date.UTC(2026, 8, 21))} />, { wrapper: Page });
    // 2024-02 .. 2025-04 is 15 months; the 9 silent ones are zero-height bars, not missing.
    const heights = bars(container).map((b) => Number(b.getAttribute("height") ?? 0));
    const drawn = heights.filter((h) => h > 0);
    expect(drawn).toHaveLength(6);
    // Recharts skips zero-height paths, so count the data slots through the axis instead.
    const ticks = axisTicks(container, "x");
    expect(ticks[0]).toBe("Feb 2024");
    expect(ticks[ticks.length - 1]).toBe("Apr 2025");
  });

  it("uses whole-number ticks for counts", () => {
    const { container } = render(<PressTimelineChart points={BALATRO} />, { wrapper: Page });
    for (const t of axisTicks(container, "y")) expect(t).toMatch(/^\d+$/);
  });
});

describe("wholeCountAxis — no half articles", () => {
  it("steps in whole mentions at every scale", () => {
    // CS2's 9-mention peak ticked 0 / 2.5 / 5.0 / 7.5 / 10.0 on the shared scale.
    expect(wholeCountAxis(9).ticks).toEqual([0, 2, 4, 6, 8, 10]);
    expect(wholeCountAxis(2).ticks).toEqual([0, 1, 2]);
    expect(wholeCountAxis(23).ticks).toEqual([0, 5, 10, 15, 20, 25]);
    expect(wholeCountAxis(140).ticks).toEqual([0, 50, 100, 150]);
    for (const top of [1, 3, 7, 9, 13, 48, 99, 101, 999]) {
      const { ticks, domain } = wholeCountAxis(top);
      for (const t of ticks) expect(Number.isInteger(t)).toBe(true);
      expect(domain[1]).toBeGreaterThanOrEqual(top);
      expect(ticks.length - 1).toBeLessThanOrEqual(5);
    }
  });
});

describe("PressTimelineChart — the partial month", () => {
  const THIS_MONTH: PressTimelinePoint[] = [
    { period: "2026-07", n_mentions: 4 },
    { period: "2026-08", n_mentions: 5 },
    { period: "2026-09", n_mentions: 1 },
  ];

  it("hatches and labels the data's as-of month", () => {
    const { container } = render(<PressTimelineChart points={THIS_MONTH} asOf={new Date(Date.UTC(2026, 8, 21))} />, {
      wrapper: Page,
    });
    const fills = bars(container).map((b) => b.getAttribute("fill") ?? "");
    expect(fills[fills.length - 1]).toMatch(/^url\(#press-hatch-/);
    expect(fills.slice(0, -1).every((f) => !f.startsWith("url("))).toBe(true);
    expect(Array.from(container.querySelectorAll("text.partial-month-label")).map((t) => t.textContent)).toEqual(["partial"]);
  });

  it("marks nothing when the last month is complete", () => {
    const { container } = render(<PressTimelineChart points={THIS_MONTH} asOf={new Date(Date.UTC(2026, 9, 3))} />, {
      wrapper: Page,
    });
    expect(container.querySelector("text.partial-month-label")).toBeNull();
    expect(bars(container).every((b) => !(b.getAttribute("fill") ?? "").startsWith("url("))).toBe(true);
  });
});
