import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ReviewVelocityBars } from "./GameProfile";
import { PLUMB_LABEL_BAND } from "../components/charts/plumbLabels";
import { ZoomRangeProvider } from "../lib/zoomRange";
import { installChartLayout } from "../test/recharts";
import type { GameEvent, ReviewTimelinePoint } from "../lib/api";

/**
 * "There are lines but they don't show any additional info" (2026-09-15): the velocity
 * chart's plumb lines had one label, "Released", and it rendered above the SVG's top edge —
 * clipped — while spike/drop months had no label at all. Pinned against Tiny Terraces
 * (appid 3136330, prod API 2026-09-15), the report's own example, whose half-elapsed
 * current month also used to draw a false "drop" line.
 */

const TIMELINE: ReviewTimelinePoint[] = (
  "2025-07:86|2025-08:43|2025-09:21|2025-10:28|2025-11:107|2025-12:35|2026-01:49|2026-02:32|" +
  "2026-03:55|2026-04:50|2026-05:72|2026-06:209|2026-07:86|2026-08:54|2026-09:21"
)
  .split("|")
  .map((pair) => {
    const [period, v] = pair.split(":");
    const n = Number(v);
    return {
      period,
      n_reviews: n,
      n_positive: Math.round(n * 0.9),
      cum_reviews: 0,
      cum_positive: 0,
      cum_positive_share: null,
      trailing_reviews: null,
      trailing_positive_share: null,
    };
  });

const EVENTS: GameEvent[] = [{ event_date: "2025-07-31", kind: "release", title: "Released", url: null }];

const Page = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter>
    <ZoomRangeProvider>{children}</ZoomRangeProvider>
  </MemoryRouter>
);

/** Where a label's baseline lands, in SVG px from the chart's top edge. */
function baseline(text: Element): number {
  return Number(text.getAttribute("y")) + Number(text.getAttribute("dy") ?? 0);
}

let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(900, 260);
  // The fixture's last month IS the current month — that is the false-drop case.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 15));
});
afterEach(() => {
  cleanup();
  restore();
  vi.useRealTimers();
});

describe("ReviewVelocityBars — labelled plumb lines", () => {
  it("labels the release, the drop and both spikes, and draws no line on the half-elapsed month", () => {
    const { container } = render(<ReviewVelocityBars points={TIMELINE} events={EVENTS} />, { wrapper: Page });

    const labels = Array.from(container.querySelectorAll("text.plumb-label")).map((t) => t.textContent?.trim());
    expect(labels).toEqual(["RELEASED", "▼ 0.3×", "▲ 3.0×", "▲ 4.2×"]);
    // Four lines, four labels: 2026-09 (21 reviews, 15 days in) is not a "drop".
    expect(container.querySelectorAll(".recharts-reference-line").length).toBe(4);
    expect(container.querySelector("text.plumb-label-release")?.textContent?.trim()).toBe("RELEASED");
  });

  it("keeps every label inside the band above the plot (nothing above the SVG's top edge)", () => {
    const { container } = render(<ReviewVelocityBars points={TIMELINE} events={EVENTS} />, { wrapper: Page });
    const texts = Array.from(container.querySelectorAll("text.plumb-label"));
    expect(texts.length).toBe(4);
    for (const t of texts) {
      const y = baseline(t);
      // A 9.5px glyph above the baseline must still start below y=0, and the baseline
      // itself must not sink into the plot.
      expect(y).toBeGreaterThanOrEqual(9);
      expect(y).toBeLessThanOrEqual(PLUMB_LABEL_BAND);
    }
    // Nothing is close to colliding at this width, so every label sits on the plot-edge row
    // (Recharts' "top" position is 5px above the plot).
    expect([...new Set(texts.map(baseline))]).toEqual([PLUMB_LABEL_BAND - 5]);
  });

  it("says what the dotted lines are", () => {
    render(<ReviewVelocityBars points={TIMELINE} events={EVENTS} />, { wrapper: Page });
    expect(screen.getByText(/Release · catalog events · months that move ≥1\.75×/)).toBeTruthy();
    expect(screen.getByText(/Highlighted: Jun 2026/)).toBeTruthy();
  });
});
