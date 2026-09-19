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

/** The same months with a trailing 3-month positive share, so the rating panel draws. */
const RATED: ReviewTimelinePoint[] = TIMELINE.map((p, i, all) => {
  const win = all.slice(Math.max(0, i - 2), i + 1);
  const n = win.reduce((s, q) => s + q.n_reviews, 0);
  const pos = win.reduce((s, q) => s + q.n_positive, 0);
  return { ...p, trailing_reviews: n, trailing_positive_share: pos / n };
});

describe("ReviewVelocityBars — rating panel over the bars", () => {
  it("draws the rating line above the bars, labels once, and lines up the months in both panels", () => {
    const { container } = render(<ReviewVelocityBars points={RATED} events={EVENTS} />, { wrapper: Page });

    const charts = container.querySelectorAll(".recharts-wrapper");
    expect(charts.length).toBe(2);
    const [rating, bars] = Array.from(charts);
    expect(rating.querySelector(".recharts-line")).toBeTruthy();
    expect(bars.querySelector(".recharts-bar")).toBeTruthy();

    // Every plumb line runs through both panels; only the top panel carries the labels.
    const lineX = (root: Element) =>
      Array.from(root.querySelectorAll(".recharts-reference-line line")).map((l) => l.getAttribute("x1"));
    expect(lineX(rating).length).toBe(4);
    expect(lineX(bars)).toEqual(lineX(rating));
    expect(rating.querySelectorAll("text.plumb-label").length).toBe(4);
    expect(bars.querySelectorAll("text.plumb-label").length).toBe(0);
    for (const t of Array.from(rating.querySelectorAll("text.plumb-label"))) {
      expect(baseline(t)).toBeGreaterThanOrEqual(9);
      expect(baseline(t)).toBeLessThanOrEqual(PLUMB_LABEL_BAND);
    }

    // Both panels are named, and the rating axis is a padded % band, not 0-100%.
    expect(screen.getByText(/Positive rating — trailing 3-month/)).toBeTruthy();
    expect(screen.getByText(/Reviews per month/)).toBeTruthy();
    const ticks = Array.from(rating.querySelectorAll(".recharts-yAxis .recharts-cartesian-axis-tick-value")).map(
      (t) => t.textContent,
    );
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks).not.toContain("0%");
  });

  it("keeps the labels on the bars when no month has a trailing share", () => {
    const { container } = render(<ReviewVelocityBars points={TIMELINE} events={EVENTS} />, { wrapper: Page });
    expect(container.querySelectorAll(".recharts-wrapper").length).toBe(1);
    expect(container.querySelectorAll("text.plumb-label").length).toBe(4);
  });
});
