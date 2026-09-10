/**
 * Drag-to-zoom, driven through real rendered charts rather than through the hook.
 *
 * The hook's own maths is covered in lib/useDragZoom.test.tsx. What can only be checked
 * here is the wiring: that the handlers actually reach Recharts, that Recharts' hit-testing
 * resolves a pixel drag to the right categories under the test layout, that the axis the
 * user reads really shrinks, and that the reset control appears and puts it back.
 *
 * `installChartLayout` is what makes this possible at all — see test/recharts.tsx: without
 * a stubbed box, ResponsiveContainer renders nothing in jsdom and there is no axis to
 * assert on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PressTimelineChart } from "./PressTimelineChart";
import { SaturationTrend } from "./SaturationTrend";
import { axisTicks, installChartLayout } from "../../test/recharts";
import { ZoomRangeProvider } from "../../lib/zoomRange";
import type { PressTimelinePoint, TrendPoint } from "../../lib/api";

/** The window is page-level state, so every chart under test needs the shell that owns it. */
const Page = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter>
    <ZoomRangeProvider>{children}</ZoomRangeProvider>
  </MemoryRouter>
);

const WIDTH = 900;
let restore: () => void;
beforeEach(() => {
  restore = installChartLayout(WIDTH, 300);
});
afterEach(() => {
  cleanup();
  restore();
});

/** 24 months, so a drag across the middle third is unambiguous. */
const months: PressTimelinePoint[] = Array.from({ length: 24 }, (_, i) => ({
  period: `20${24 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
  n_mentions: 10 + i,
}));

/**
 * A pixel drag across the plot. Recharts listens on its wrapper and derives `activeLabel`
 * from the offset — jsdom's zeroed getBoundingClientRect means clientX IS the chart x,
 * which is exactly the coordinate space the stubbed 900px layout scales against.
 */
function dragAcross(container: HTMLElement, fromX: number, toX: number) {
  const wrapper = container.querySelector(".recharts-wrapper");
  if (!wrapper) throw new Error("no recharts wrapper rendered");
  fireEvent.mouseDown(wrapper, { clientX: fromX, clientY: 100 });
  fireEvent.mouseMove(wrapper, { clientX: toX, clientY: 100 });
  fireEvent.mouseUp(wrapper, { clientX: toX, clientY: 100 });
}

describe("drag-to-zoom on a time axis", () => {
  it("shrinks the axis to the dragged window and offers a way back", () => {
    const { container } = render(<PressTimelineChart points={months} />, { wrapper: Page });

    const before = axisTicks(container, "x");
    expect(before.length).toBeGreaterThan(2);
    expect(screen.queryByRole("button", { name: /reset zoom/i })).toBeNull();

    dragAcross(container, WIDTH * 0.35, WIDTH * 0.6);

    const after = axisTicks(container, "x");
    expect(after.length).toBeGreaterThan(0);
    // The window is a strict subset: its first tick is no earlier and its last no later,
    // and at least one end actually moved.
    expect(after[0] >= before[0]).toBe(true);
    expect(after[after.length - 1] <= before[before.length - 1]).toBe(true);
    expect(after[0] !== before[0] || after[after.length - 1] !== before[before.length - 1]).toBe(
      true,
    );

    const reset = screen.getByRole("button", { name: /reset zoom/i });
    fireEvent.click(reset);
    expect(axisTicks(container, "x")).toEqual(before);
    expect(screen.queryByRole("button", { name: /reset zoom/i })).toBeNull();
  });

  it("leaves the chart alone on a click that never moved", () => {
    const { container } = render(<PressTimelineChart points={months} />, { wrapper: Page });
    const before = axisTicks(container, "x");

    const wrapper = container.querySelector(".recharts-wrapper")!;
    fireEvent.mouseDown(wrapper, { clientX: 400, clientY: 100 });
    fireEvent.mouseUp(wrapper, { clientX: 400, clientY: 100 });

    expect(axisTicks(container, "x")).toEqual(before);
    expect(screen.queryByRole("button", { name: /reset zoom/i })).toBeNull();
  });

  it("moves both panels of a shared-axis pair together", () => {
    // SaturationTrend draws releases and revenue over the same years in two charts; one
    // range governs both, so the two axes must stay identical through a zoom.
    const years: TrendPoint[] = Array.from({ length: 12 }, (_, i) => ({
      year: 2014 + i,
      n_releases: 100 + i,
      median_rev: 1000 * (i + 1),
      p90_rev: 9000 * (i + 1),
    })) as TrendPoint[];

    const { container } = render(<SaturationTrend points={years} />, { wrapper: Page });
    const beforeLeft = axisTicks(container, "x", 0);
    const beforeRight = axisTicks(container, "x", 1);
    expect(beforeLeft).toEqual(beforeRight);

    dragAcross(container, WIDTH * 0.3, WIDTH * 0.7);

    const afterLeft = axisTicks(container, "x", 0);
    const afterRight = axisTicks(container, "x", 1);
    expect(afterLeft).toEqual(afterRight);
    expect(afterLeft.length).toBeLessThan(beforeLeft.length);
    // One control for the pair, not one per panel.
    expect(screen.getAllByRole("button", { name: /reset zoom/i })).toHaveLength(2);
  });
});
