/**
 * The selection maths behind drag-to-zoom, exercised through the hook rather than through
 * a chart: Recharts only ever hands the hook an `activeLabel`, so a fake event with that
 * one field IS the real input, and driving it directly covers the reversed drag / click /
 * out-of-range cases that would need pixel-perfect mouse choreography in a rendered chart.
 * The rendered-chart side is covered in components/charts/dragZoom.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useDragZoom } from "./useDragZoom";

type Row = { period: string; n: number };
const rows: Row[] = ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"].map((period, n) => ({
  period,
  n,
}));

/** What Recharts passes to onMouseDown/onMouseMove. */
const at = (period: string) => ({ activeLabel: period });

function drag(
  result: { current: ReturnType<typeof useDragZoom<Row>> },
  from: string,
  to: string,
) {
  act(() => result.current.handlers.onMouseDown(at(from)));
  act(() => result.current.handlers.onMouseMove(at(to)));
  act(() => result.current.handlers.onMouseUp());
}

describe("useDragZoom", () => {
  it("passes the full series through until something is selected", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    expect(result.current.data).toHaveLength(5);
    expect(result.current.zoomed).toBe(false);
    expect(result.current.selection).toBeNull();
    expect(result.current.dragging).toBe(false);
  });

  it("slices to the dragged range, inclusive of both ends", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    drag(result, "2024-02", "2024-04");
    expect(result.current.data.map((r) => r.period)).toEqual(["2024-02", "2024-03", "2024-04"]);
    expect(result.current.zoomed).toBe(true);
  });

  it("reads a right-to-left drag as the same range", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    drag(result, "2024-04", "2024-02");
    expect(result.current.data.map((r) => r.period)).toEqual(["2024-02", "2024-03", "2024-04"]);
  });

  it("treats a press and release inside one bucket as a click, not a zoom", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    drag(result, "2024-03", "2024-03");
    expect(result.current.zoomed).toBe(false);
    expect(result.current.data).toHaveLength(5);
  });

  it("exposes the in-progress band while the button is down, and only then", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    act(() => result.current.handlers.onMouseDown(at("2024-02")));
    expect(result.current.selection).toBeNull(); // anchor === cursor: nothing swept yet
    act(() => result.current.handlers.onMouseMove(at("2024-04")));
    expect(result.current.selection).toEqual({ x1: "2024-02", x2: "2024-04" });
    expect(result.current.dragging).toBe(true);
    act(() => result.current.handlers.onMouseUp());
    expect(result.current.selection).toBeNull();
    expect(result.current.dragging).toBe(false);
  });

  it("abandons the selection when the pointer leaves the plot", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    act(() => result.current.handlers.onMouseDown(at("2024-01")));
    act(() => result.current.handlers.onMouseMove(at("2024-05")));
    act(() => result.current.handlers.onMouseLeave());
    expect(result.current.dragging).toBe(false);
    expect(result.current.zoomed).toBe(false);
    act(() => result.current.handlers.onMouseUp()); // the release that follows does nothing
    expect(result.current.zoomed).toBe(false);
  });

  it("zooms again inside an existing zoom, against the visible rows", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    drag(result, "2024-01", "2024-04");
    expect(result.current.data).toHaveLength(4);
    drag(result, "2024-02", "2024-03");
    expect(result.current.data.map((r) => r.period)).toEqual(["2024-02", "2024-03"]);
  });

  it("resets to the full series", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    drag(result, "2024-02", "2024-04");
    act(() => result.current.reset());
    expect(result.current.zoomed).toBe(false);
    expect(result.current.data).toHaveLength(5);
  });

  it("resets on Escape, mid-drag as well as when zoomed", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    drag(result, "2024-02", "2024-04");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.zoomed).toBe(false);

    act(() => result.current.handlers.onMouseDown(at("2024-01")));
    act(() => result.current.handlers.onMouseMove(at("2024-05")));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.dragging).toBe(false);
    expect(result.current.selection).toBeNull();
  });

  it("resets on double-click", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    drag(result, "2024-02", "2024-04");
    act(() => result.current.handlers.onDoubleClick());
    expect(result.current.zoomed).toBe(false);
  });

  it("ignores events with no category under the cursor (the margins and axes)", () => {
    const { result } = renderHook(() => useDragZoom(rows, "period"));
    act(() => result.current.handlers.onMouseDown({}));
    act(() => result.current.handlers.onMouseDown(null));
    expect(result.current.dragging).toBe(false);
    act(() => result.current.handlers.onMouseUp());
    expect(result.current.zoomed).toBe(false);
  });

  it("drops the zoom when the series is replaced (another game, another niche)", () => {
    const other: Row[] = ["2019-01", "2019-02", "2019-03"].map((period, n) => ({ period, n }));
    const { result, rerender } = renderHook(({ data }) => useDragZoom(data, "period"), {
      initialProps: { data: rows },
    });
    drag(result, "2024-02", "2024-04");
    expect(result.current.zoomed).toBe(true);
    rerender({ data: other });
    expect(result.current.zoomed).toBe(false);
    expect(result.current.data.map((r) => r.period)).toEqual(["2019-01", "2019-02", "2019-03"]);
  });

  it("keeps the zoom when the parent rebuilds an identical array", () => {
    // The guard above must key on the series, not on array identity: a parent that maps a
    // fresh array every render would otherwise clear the zoom on the next keystroke.
    const { result, rerender } = renderHook(({ data }) => useDragZoom(data, "period"), {
      initialProps: { data: rows },
    });
    drag(result, "2024-02", "2024-04");
    rerender({ data: rows.map((r) => ({ ...r })) });
    expect(result.current.zoomed).toBe(true);
    expect(result.current.data).toHaveLength(3);
  });

  it("survives an empty series", () => {
    const { result } = renderHook(() => useDragZoom([] as Row[], "period"));
    expect(result.current.data).toEqual([]);
    expect(result.current.zoomed).toBe(false);
  });
});
