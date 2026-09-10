/**
 * The selection maths behind drag-to-zoom, exercised through the hook rather than a chart:
 * Recharts only ever hands it an `activeLabel`, so a fake event carrying that one field IS
 * the real input, and driving it directly covers the reversed drag / click / cross-chart
 * cases that would need pixel-perfect choreography in a rendered chart.
 *
 * The window is shared page-wide (lib/zoomRange), so every case runs inside a provider, and
 * the interesting ones render TWO hooks at different granularities to prove they agree.
 */
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { useDragZoom } from "./useDragZoom";
import { ZoomRangeProvider, bucketSpan, formatRange } from "./zoomRange";

type Month = { period: string; n: number };
type Year = { year: number; n: number };
type Day = { date: string; n: number };

const months: Month[] = [
  "2024-01",
  "2024-02",
  "2024-03",
  "2024-04",
  "2024-05",
].map((period, n) => ({ period, n }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <ZoomRangeProvider>{children}</ZoomRangeProvider>
  </MemoryRouter>
);

const at = (label: string | number) => ({ activeLabel: label });

function drag<T>(
  zoom: () => ReturnType<typeof useDragZoom<T>>,
  from: string | number,
  to: string | number,
) {
  act(() => zoom().handlers.onMouseDown(at(from)));
  act(() => zoom().handlers.onMouseMove(at(to)));
  act(() => zoom().handlers.onMouseUp());
}

describe("useDragZoom", () => {
  it("passes the full series through until something is selected", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    expect(result.current.data).toHaveLength(5);
    expect(result.current.zoomed).toBe(false);
    expect(result.current.selection).toBeNull();
    expect(result.current.dragging).toBe(false);
  });

  it("keeps the dragged buckets, both ends included", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    drag(() => result.current, "2024-02", "2024-04");
    expect(result.current.data.map((r) => r.period)).toEqual(["2024-02", "2024-03", "2024-04"]);
    expect(result.current.zoomed).toBe(true);
  });

  it("reads a right-to-left drag as the same window", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    drag(() => result.current, "2024-04", "2024-02");
    expect(result.current.data.map((r) => r.period)).toEqual(["2024-02", "2024-03", "2024-04"]);
  });

  it("treats a press and release inside one bucket as a click, not a zoom", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    drag(() => result.current, "2024-03", "2024-03");
    expect(result.current.zoomed).toBe(false);
    expect(result.current.data).toHaveLength(5);
  });

  it("exposes the in-progress band while the button is down, and only then", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    act(() => result.current.handlers.onMouseDown(at("2024-02")));
    expect(result.current.selection).toBeNull(); // anchor === cursor: nothing swept yet
    act(() => result.current.handlers.onMouseMove(at("2024-04")));
    expect(result.current.selection).toEqual({ x1: "2024-02", x2: "2024-04" });
    expect(result.current.dragging).toBe(true);
    act(() => result.current.handlers.onMouseUp());
    expect(result.current.selection).toBeNull();
    expect(result.current.dragging).toBe(false);
  });

  it("keeps a numeric category numeric, so the band can be positioned", () => {
    // Recharts matches a ReferenceArea's x against the axis domain BY VALUE; a `year` axis
    // holds numbers, and handing it "2014" positions nothing and draws nothing.
    const years: Year[] = [2014, 2015, 2016, 2017].map((year, n) => ({ year, n }));
    const { result } = renderHook(() => useDragZoom(years, "year"), { wrapper });
    act(() => result.current.handlers.onMouseDown(at(2015)));
    act(() => result.current.handlers.onMouseMove(at(2017)));
    expect(result.current.selection).toEqual({ x1: 2015, x2: 2017 });
    expect(typeof result.current.selection!.x1).toBe("number");
  });

  it("abandons the selection when the pointer leaves the plot", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    act(() => result.current.handlers.onMouseDown(at("2024-01")));
    act(() => result.current.handlers.onMouseMove(at("2024-05")));
    act(() => result.current.handlers.onMouseLeave());
    expect(result.current.dragging).toBe(false);
    expect(result.current.zoomed).toBe(false);
    act(() => result.current.handlers.onMouseUp()); // the release that follows does nothing
    expect(result.current.zoomed).toBe(false);
  });

  it("narrows further when dragged inside an existing window", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    drag(() => result.current, "2024-01", "2024-04");
    expect(result.current.data).toHaveLength(4);
    drag(() => result.current, "2024-02", "2024-03");
    expect(result.current.data.map((r) => r.period)).toEqual(["2024-02", "2024-03"]);
  });

  it("resets, by control and by double-click", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    drag(() => result.current, "2024-02", "2024-04");
    act(() => result.current.reset());
    expect(result.current.zoomed).toBe(false);
    expect(result.current.data).toHaveLength(5);

    drag(() => result.current, "2024-02", "2024-04");
    act(() => result.current.handlers.onDoubleClick());
    expect(result.current.zoomed).toBe(false);
  });

  it("resets on Escape from anywhere on the page", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    drag(() => result.current, "2024-02", "2024-04");
    expect(result.current.zoomed).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.zoomed).toBe(false);
  });

  it("ignores events with no category under the cursor (margins, axes)", () => {
    const { result } = renderHook(() => useDragZoom(months, "period"), { wrapper });
    act(() => result.current.handlers.onMouseDown({}));
    act(() => result.current.handlers.onMouseDown(null));
    expect(result.current.dragging).toBe(false);
    act(() => result.current.handlers.onMouseUp());
    expect(result.current.zoomed).toBe(false);
  });

  it("survives an empty series", () => {
    const { result } = renderHook(() => useDragZoom([] as Month[], "period"), { wrapper });
    expect(result.current.data).toEqual([]);
    expect(result.current.zoomed).toBe(false);
    expect(result.current.outOfRange).toBe(false);
  });
});

describe("one window across charts of different granularity", () => {
  /** A monthly chart, a yearly chart and a daily chart on one page. */
  function renderPage() {
    const years: Year[] = [2023, 2024, 2025].map((year, n) => ({ year, n }));
    const days: Day[] = ["2024-01-15", "2024-03-02", "2024-09-30"].map((date, n) => ({ date, n }));
    return renderHook(
      () => ({
        month: useDragZoom(months, "period"),
        year: useDragZoom(years, "year"),
        day: useDragZoom(days, "date"),
      }),
      { wrapper },
    );
  }

  it("a drag on the monthly chart moves the yearly and daily ones with it", () => {
    const { result } = renderPage();
    drag(() => result.current.month, "2024-02", "2024-04");

    // Feb–Apr 2024 overlaps only the 2024 bar of the yearly chart...
    expect(result.current.year.data.map((r) => r.year)).toEqual([2024]);
    expect(result.current.year.zoomed).toBe(true);
    // ...and only the March day of the daily one.
    expect(result.current.day.data.map((r) => r.date)).toEqual(["2024-03-02"]);
  });

  it("a drag on the yearly chart widens the others to that whole year", () => {
    const { result } = renderPage();
    drag(() => result.current.year, 2023, 2024);
    // 2023-01-01..2024-12-31 covers every month row, so the monthly chart keeps them all.
    expect(result.current.month.data).toHaveLength(5);
    expect(result.current.day.data).toHaveLength(3);
  });

  it("clearing from one chart clears them all", () => {
    const { result } = renderPage();
    drag(() => result.current.month, "2024-02", "2024-03");
    expect(result.current.year.zoomed).toBe(true);
    act(() => result.current.day.reset());
    expect(result.current.month.zoomed).toBe(false);
    expect(result.current.year.zoomed).toBe(false);
  });

  it("reports a series the window excludes entirely instead of drawing it empty", () => {
    const later: Day[] = ["2026-08-24", "2026-08-25"].map((date, n) => ({ date, n }));
    const { result } = renderHook(
      () => ({ month: useDragZoom(months, "period"), price: useDragZoom(later, "date") }),
      { wrapper },
    );
    drag(() => result.current.month, "2024-02", "2024-04");
    expect(result.current.price.data).toEqual([]);
    expect(result.current.price.outOfRange).toBe(true);
  });

  it("leaves rows with no readable date alone", () => {
    // A chart keyed on something that is not a date cannot be contradicted by the window.
    type Row = { key: string; n: number };
    const rows: Row[] = ["#1", "#2", "#3"].map((key, n) => ({ key, n }));
    const { result } = renderHook(
      () => ({ month: useDragZoom(months, "period"), seq: useDragZoom(rows, "key") }),
      { wrapper },
    );
    drag(() => result.current.month, "2024-02", "2024-03");
    expect(result.current.seq.data).toHaveLength(3);
    expect(result.current.seq.outOfRange).toBe(false);
  });

  it("maps a non-date category onto the window through dateOf", () => {
    type Release = { key: string; release_date: string | null; release_year: number | null };
    const releases: Release[] = [
      { key: "#1", release_date: "2019-05-01", release_year: 2019 },
      { key: "#2", release_date: "2024-02-20", release_year: 2024 },
      { key: "#3", release_date: null, release_year: 2025 },
    ];
    const { result } = renderHook(
      () => ({
        month: useDragZoom(months, "period"),
        rel: useDragZoom(releases, "key", { dateOf: (r) => r.release_date ?? r.release_year }),
      }),
      { wrapper },
    );
    drag(() => result.current.month, "2024-01", "2024-05");
    expect(result.current.rel.data.map((r) => r.key)).toEqual(["#2"]);
  });
});

describe("bucket spans and labels", () => {
  it("reads every bucket shape the charts use", () => {
    expect(bucketSpan("2024-02-20")).toEqual(["2024-02-20", "2024-02-20"]);
    expect(bucketSpan("2024-02")).toEqual(["2024-02-01", "2024-02-29"]); // leap year
    expect(bucketSpan("2023-02")).toEqual(["2023-02-01", "2023-02-28"]);
    expect(bucketSpan(2014)).toEqual(["2014-01-01", "2014-12-31"]);
    expect(bucketSpan("#7")).toBeNull();
    expect(bucketSpan(null)).toBeNull();
    expect(bucketSpan("2024-13")).toBeNull();
  });

  it("names a window at the coarsest unit that still describes it", () => {
    expect(formatRange({ from: "2024-01-01", to: "2024-12-31" })).toBe("2024");
    expect(formatRange({ from: "2023-01-01", to: "2024-12-31" })).toBe("2023 – 2024");
    expect(formatRange({ from: "2024-02-01", to: "2024-02-29" })).toBe("Feb 2024");
    expect(formatRange({ from: "2024-02-01", to: "2024-04-30" })).toBe("Feb 2024 – Apr 2024");
    expect(formatRange({ from: "2024-02-03", to: "2024-04-11" })).toBe("2024-02-03 – 2024-04-11");
  });
});
