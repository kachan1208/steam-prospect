import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  NicheDistribution,
  extendSelection,
  isBucketSelected,
  rangeSelection,
  selectedCount,
  toggleSelection,
  type BucketSelection,
  type DistributionBucket,
} from "./NicheDistribution";

// Recharts' ResponsiveContainer observes its box; jsdom 25 ships no ResizeObserver, so
// rendering the chart would throw. The interaction layer under test is plain HTML sitting
// beside the SVG, so a no-op observer is enough to let the tree mount.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

// Log-spaced revenue edges, exactly the shape the marts emit: widening buckets, and a
// deliberately EMPTY one ($1M-$10M) that must survive to the DOM as its own band.
const REVENUE: DistributionBucket[] = [
  { bucket_index: 0, x_min: 0, x_max: 1_000, count: 40 },
  { bucket_index: 1, x_min: 1_000, x_max: 10_000, count: 25 },
  { bucket_index: 2, x_min: 10_000, x_max: 100_000, count: 12 },
  { bucket_index: 3, x_min: 100_000, x_max: 1_000_000, count: 3 },
  { bucket_index: 4, x_min: 1_000_000, x_max: 10_000_000, count: 0 },
  { bucket_index: 5, x_min: 10_000_000, x_max: 100_000_000, count: 1 },
];

// Price edges with free-to-play as its own POINT bucket [0, 0] — the case a naive
// overlap test silently drops.
const PRICE: DistributionBucket[] = [
  { bucket_index: 0, x_min: 0, x_max: 0, count: 18 },
  { bucket_index: 1, x_min: 0.01, x_max: 4.99, count: 30 },
  { bucket_index: 2, x_min: 4.99, x_max: 9.99, count: 22 },
  { bucket_index: 3, x_min: 9.99, x_max: 19.99, count: 14 },
  { bucket_index: 4, x_min: 19.99, x_max: 39.99, count: 6 },
];

/** The per-bucket hit targets, in axis order — everything inside the chart's role="group". */
function bands(): HTMLElement[] {
  return within(screen.getByRole("group")).getAllByRole("button");
}

function renderChart(props: Partial<Parameters<typeof NicheDistribution>[0]> = {}) {
  const onSelectionChange = vi.fn();
  const utils = render(
    <NicheDistribution
      metric="revenue"
      buckets={REVENUE}
      selection={null}
      onSelectionChange={onSelectionChange}
      {...props}
    />,
  );
  return { ...utils, onSelectionChange };
}

describe("NicheDistribution — selection edges", () => {
  it("emits the clicked bucket's exact edges, not rounded or neighbouring ones", () => {
    const { onSelectionChange } = renderChart();

    fireEvent.click(bands()[2]);

    // $10K-$100K bucket: the two numbers here become rev_min/rev_max on the API call.
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 10_000, max: 100_000 });
  });

  it("clears when the already-selected bucket is clicked again", () => {
    const { onSelectionChange } = renderChart({ selection: { min: 10_000, max: 100_000 } });

    fireEvent.click(bands()[2]);

    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it("re-clicking a DIFFERENT bucket moves the selection rather than clearing it", () => {
    const { onSelectionChange } = renderChart({ selection: { min: 10_000, max: 100_000 } });

    fireEvent.click(bands()[3]);

    expect(onSelectionChange).toHaveBeenCalledWith({ min: 100_000, max: 1_000_000 });
  });

  it("clicking one bucket of a multi-bucket selection narrows to that bucket", () => {
    // Selection spans buckets 1..3; clicking bucket 2 is not an exact match, so it selects.
    const { onSelectionChange } = renderChart({ selection: { min: 1_000, max: 1_000_000 } });

    fireEvent.click(bands()[2]);

    expect(onSelectionChange).toHaveBeenCalledWith({ min: 10_000, max: 100_000 });
  });

  it("drag across bands emits the first band's x_min and the last band's x_max", () => {
    const { onSelectionChange } = renderChart();

    fireEvent.mouseDown(bands()[1]);
    fireEvent.mouseOver(bands()[2]);
    fireEvent.mouseOver(bands()[3]);
    fireEvent.mouseUp(window);

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 1_000, max: 1_000_000 });
  });

  it("drag right-to-left produces the same normalised range as left-to-right", () => {
    const { onSelectionChange } = renderChart();

    fireEvent.mouseDown(bands()[3]);
    fireEvent.mouseOver(bands()[2]);
    fireEvent.mouseOver(bands()[1]);
    fireEvent.mouseUp(window);

    expect(onSelectionChange).toHaveBeenCalledWith({ min: 1_000, max: 1_000_000 });
  });

  it("a drag spanning an EMPTY bucket still includes it in the range", () => {
    const { onSelectionChange } = renderChart();

    // buckets 3..5, with the zero-count $1M-$10M band in the middle.
    fireEvent.mouseDown(bands()[3]);
    fireEvent.mouseOver(bands()[4]);
    fireEvent.mouseOver(bands()[5]);
    fireEvent.mouseUp(window);

    expect(onSelectionChange).toHaveBeenCalledWith({ min: 100_000, max: 100_000_000 });
  });

  it("a mouseDown/mouseUp on one band is a click, and the drag does not double-fire", () => {
    const { onSelectionChange } = renderChart();

    fireEvent.mouseDown(bands()[0]);
    fireEvent.mouseUp(window);
    fireEvent.click(bands()[0]);

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 0, max: 1_000 });
  });

  it("the click that follows a real drag is swallowed, so the range is not re-toggled", () => {
    const { onSelectionChange } = renderChart();

    fireEvent.mouseDown(bands()[1]);
    fireEvent.mouseOver(bands()[3]);
    fireEvent.mouseUp(window);
    // The browser fires click on the anchor when a drag returns to/ends on a band.
    fireEvent.click(bands()[3]);

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 1_000, max: 1_000_000 });
  });
});

describe("NicheDistribution — clearing the filter", () => {
  it("shows a labelled Clear control only while a selection exists", () => {
    const { rerender, onSelectionChange } = renderChart();
    expect(screen.queryByRole("button", { name: /clear revenue filter/i })).toBeNull();

    rerender(
      <NicheDistribution
        metric="revenue"
        buckets={REVENUE}
        selection={{ min: 1_000, max: 10_000 }}
        onSelectionChange={onSelectionChange}
      />,
    );

    const clear = screen.getByRole("button", { name: /clear revenue filter/i });
    fireEvent.click(clear);
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it("Escape on a band clears the selection", () => {
    const { onSelectionChange } = renderChart({ selection: { min: 1_000, max: 10_000 } });

    fireEvent.keyDown(bands()[1], { key: "Escape" });

    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it("Escape with no selection stays quiet", () => {
    const { onSelectionChange } = renderChart();

    fireEvent.keyDown(bands()[1], { key: "Escape" });

    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe("NicheDistribution — keyboard", () => {
  it("arrow keys move focus between bands without changing the selection", () => {
    const { onSelectionChange } = renderChart();
    const all = bands();
    all[0].focus();

    fireEvent.keyDown(all[0], { key: "ArrowRight" });

    expect(document.activeElement).toBe(all[1]);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("Shift+Arrow extends the selection to the newly focused band, using exact edges", () => {
    const { onSelectionChange } = renderChart({ selection: { min: 1_000, max: 10_000 } });
    const all = bands();
    all[1].focus();

    fireEvent.keyDown(all[1], { key: "ArrowRight", shiftKey: true });

    expect(onSelectionChange).toHaveBeenCalledWith({ min: 1_000, max: 100_000 });
  });

  it("Enter/Space reach the same toggle as a click (native button activation)", () => {
    const { onSelectionChange } = renderChart();
    // jsdom turns Enter/Space on a <button> into a click, which is exactly the point of
    // using real buttons rather than SVG paths for the hit targets.
    fireEvent.click(bands()[5]);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 10_000_000, max: 100_000_000 });
  });

  it("keeps exactly one band in the tab order (roving tabindex)", () => {
    renderChart();
    const tabbable = bands().filter((b) => b.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
  });
});

describe("NicheDistribution — buckets, labels and states", () => {
  it("renders one band per bucket, keeping empty buckets", () => {
    renderChart();
    expect(bands()).toHaveLength(REVENUE.length);
    expect(screen.getByRole("button", { name: "$1.0M – $10.0M: 0 games" })).toBeTruthy();
  });

  it("marks every bucket inside the selection as pressed, empty ones included", () => {
    renderChart({ selection: { min: 100_000, max: 100_000_000 } });
    const pressed = bands().map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["false", "false", "false", "true", "true", "true"]);
  });

  it("names the free-to-play point bucket 'Free' and never folds it into the first paid band", () => {
    renderChart({ metric: "price", buckets: PRICE });

    expect(screen.getByRole("button", { name: "Free ($0): 18 games" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "$0.01 – $4.99: 30 games" })).toBeTruthy();
    expect(screen.getByText(/free-to-play \(\$0\) gets its own band/i)).toBeTruthy();
  });

  it("selects the free-to-play point bucket as {min: 0, max: 0} and shows it pressed", () => {
    const { onSelectionChange, rerender } = renderChart({ metric: "price", buckets: PRICE });

    fireEvent.click(bands()[0]);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 0, max: 0 });

    rerender(
      <NicheDistribution
        metric="price"
        buckets={PRICE}
        selection={{ min: 0, max: 0 }}
        onSelectionChange={onSelectionChange}
      />,
    );
    expect(bands().map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
  });

  it("keeps cents in price edges instead of rounding $19.99 to $20", () => {
    renderChart({ metric: "price", buckets: PRICE });
    expect(screen.getByRole("button", { name: "$9.99 – $19.99: 14 games" })).toBeTruthy();
  });

  it("says out loud that equal-width bands cover unequal ranges", () => {
    renderChart();
    expect(screen.getByText(/equal-width bands, unequal dollar ranges/i)).toBeTruthy();
  });

  it("reserves the plot height while loading with no data yet", () => {
    const { container } = renderChart({ buckets: [], loading: true, height: 300 });
    const plot = container.querySelector('[aria-busy="true"]') as HTMLElement;
    expect(plot).toBeTruthy();
    expect(plot.style.height).toBe("300px");
    expect(screen.getByText(/loading revenue distribution/i)).toBeTruthy();
  });

  it("holds the previous render (bands still interactive) while refetching", () => {
    const { onSelectionChange } = renderChart({ loading: true });
    expect(bands()).toHaveLength(REVENUE.length);
    fireEvent.click(bands()[1]);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 1_000, max: 10_000 });
  });

  it("reports the selected game count against the charted total", () => {
    renderChart({ selection: { min: 0, max: 10_000 }, totalGames: 90 });
    expect(screen.getByText("65 of 81 games in the selected range")).toBeTruthy();
  });

  it("flags games excluded from the chart when totalGames exceeds the bucket sum", () => {
    renderChart({ totalGames: 90 });
    expect(screen.getByText("81 of 90 games have a revenue to chart")).toBeTruthy();
  });
});

describe("selection algebra", () => {
  it("rangeSelection returns the outer edges of the span, in either argument order", () => {
    expect(rangeSelection(REVENUE, 1, 3)).toEqual({ min: 1_000, max: 1_000_000 });
    expect(rangeSelection(REVENUE, 3, 1)).toEqual({ min: 1_000, max: 1_000_000 });
    expect(rangeSelection(REVENUE, 0, 0)).toEqual({ min: 0, max: 1_000 });
    expect(rangeSelection([], 0, 0)).toBeNull();
  });

  it("rangeSelection clamps out-of-bounds indices instead of reading past the array", () => {
    expect(rangeSelection(REVENUE, -4, 99)).toEqual({ min: 0, max: 100_000_000 });
  });

  it("orders by bucket_index, not array position", () => {
    const shuffled = [REVENUE[3], REVENUE[0], REVENUE[1]];
    const { onSelectionChange } = renderChart({ buckets: shuffled });
    fireEvent.click(bands()[0]);
    expect(onSelectionChange).toHaveBeenCalledWith({ min: 0, max: 1_000 });
  });

  it("toggleSelection clears only on an exact match", () => {
    expect(toggleSelection(REVENUE, { min: 0, max: 1_000 }, 0)).toBeNull();
    expect(toggleSelection(REVENUE, { min: 0, max: 10_000 }, 0)).toEqual({ min: 0, max: 1_000 });
    expect(toggleSelection(REVENUE, null, 0)).toEqual({ min: 0, max: 1_000 });
  });

  it("isBucketSelected is half-open: a bucket ending exactly at min is out", () => {
    const sel: BucketSelection = { min: 10_000, max: 100_000 };
    expect(isBucketSelected(REVENUE[1], sel)).toBe(false); // [1_000, 10_000)
    expect(isBucketSelected(REVENUE[2], sel)).toBe(true); // [10_000, 100_000)
    expect(isBucketSelected(REVENUE[3], sel)).toBe(false); // [100_000, 1_000_000)
  });

  it("isBucketSelected still matches a range that does not land on our edges", () => {
    // e.g. rev_min/rev_max restored from a URL a human typed.
    expect(isBucketSelected(REVENUE[2], { min: 5_000, max: 50_000 })).toBe(true);
  });

  it("extendSelection unions the current span with the new index", () => {
    expect(extendSelection(REVENUE, { min: 1_000, max: 10_000 }, 4)).toEqual({
      min: 1_000,
      max: 10_000_000,
    });
    expect(extendSelection(REVENUE, null, 2)).toEqual({ min: 10_000, max: 100_000 });
  });

  it("selectedCount sums only the buckets inside the range", () => {
    expect(selectedCount(REVENUE, { min: 0, max: 10_000 })).toBe(65);
    expect(selectedCount(REVENUE, null)).toBe(0);
    expect(selectedCount(PRICE, { min: 0, max: 0 })).toBe(18);
  });
});
