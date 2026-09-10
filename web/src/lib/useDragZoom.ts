/**
 * Drag a range on a chart to zoom EVERY chart on the page to it.
 *
 * The window itself lives in lib/zoomRange (one shared date interval per page, and the
 * reasoning for why it is dates rather than indices). This hook is the per-chart half: it
 * turns Recharts' mouse events into a selection, converts the selected buckets into that
 * shared interval, and filters its own rows back out of it.
 *
 * WHY IT FILTERS ROWS INSTEAD OF SETTING A DOMAIN. Every time axis here is a CATEGORY axis
 * — `dataKey="period"` / `"captured_on"` / `"year"` / `"date"` / `"month"`, because the
 * marts pre-bucket the series and the tick labels are the bucket names. On a category axis
 * Recharts ignores `XAxis domain`, so the usual `domain={[left, right]} + allowDataOverflow`
 * recipe (written for `type="number"`) draws nothing. Handing the chart fewer rows moves the
 * axis, the grid, the marks and the Y scale together, and it stays right on unevenly spaced
 * buckets: a month with no reviews has no row, and a drag across the gap still selects
 * exactly the rows swept.
 *
 * Recharts reports `activeLabel` — the category under the cursor — on its mouse events, and
 * that is the whole input. Labels keep their ORIGINAL type on the way to the ReferenceArea:
 * a `year` axis holds the numbers 2014..2026, and Recharts positions a reference mark by
 * matching the axis domain by value, so handing it "2014" drew nothing at all while the
 * zoom still worked — the band silently missing was most of what "there is a lack of visual
 * change when you grab" meant.
 *
 * TOUCH IS DELIBERATELY NOT WIRED. A touch drag on a chart is already the page's scroll
 * gesture; hijacking it would trap a phone reader inside the chart.
 */
import { useCallback, useMemo, useState } from "react";

import { bucketSpan, spanUnion, spansOverlap, useZoomRange } from "./zoomRange";

/**
 * Recharts' mouse-event payload, narrowed to the one field this needs. Recharts types it as
 * `CategoricalChartState`, which is not exported from the package root and whose fields are
 * all optional anyway — so this is the honest shape rather than a cast.
 */
export type ChartMouseEvent = { activeLabel?: string | number } | null | undefined;

export interface DragZoomOptions<T> {
  /**
   * The date a row sits on, when the x category is not itself one. The release trajectory
   * is keyed "#seq" and carries `release_date` beside it; without this it could join the
   * drag but never the shared window.
   */
  dateOf?: (row: T) => string | number | null | undefined;
}

export interface DragZoom<T> {
  /** The rows to render — everything, or only what overlaps the page's window. */
  data: T[];
  /** True when the page's window is applied to this chart. */
  zoomed: boolean;
  /** True mid-drag; the caller sets `select-none` so the drag does not select text. */
  dragging: boolean;
  /** The window hides this chart's whole series — the caller says so rather than drawing an empty frame. */
  outOfRange: boolean;
  /** In-progress selection, for a `<ReferenceArea x1 x2>`, in the axis's own value type. */
  selection: { x1: string | number; x2: string | number } | null;
  /** Spread onto the Recharts chart element. */
  handlers: {
    onMouseDown: (e: ChartMouseEvent) => void;
    onMouseMove: (e: ChartMouseEvent) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
    onDoubleClick: () => void;
  };
  /** Clear the page's window. */
  reset: () => void;
}

/**
 * @param data full series, ordered as it should be drawn
 * @param xKey the field the chart's XAxis uses as `dataKey`
 */
export function useDragZoom<T>(
  data: T[],
  xKey: keyof T & string,
  options: DragZoomOptions<T> = {},
): DragZoom<T> {
  const { range, setRange } = useZoomRange();
  const { dateOf } = options;
  // Raw category values, not stringified: the ReferenceArea needs the axis's own type.
  const [anchor, setAnchor] = useState<string | number | null>(null);
  const [cursor, setCursor] = useState<string | number | null>(null);

  const spanOf = useCallback(
    (row: T) => bucketSpan(dateOf ? dateOf(row) : row[xKey]),
    [dateOf, xKey],
  );

  const visible = useMemo(() => {
    if (!range) return data;
    const kept = data.filter((row) => {
      const span = spanOf(row);
      // A row with no readable date is never filtered out: it cannot contradict the
      // window, and dropping it would blank a chart the window says nothing about.
      return span === null || spansOverlap(span, range);
    });
    return kept;
  }, [data, range, spanOf]);

  // A series that is entirely outside the window (a price history that starts after it)
  // renders nothing useful; the frame reports it in words instead of drawing empty axes.
  const outOfRange = range !== null && data.length > 0 && visible.length === 0;

  const reset = useCallback(() => {
    setRange(null);
    setAnchor(null);
    setCursor(null);
  }, [setRange]);

  const onMouseDown = useCallback((e: ChartMouseEvent) => {
    const label = e?.activeLabel;
    if (label == null) return;
    setAnchor(label);
    setCursor(label);
  }, []);

  const onMouseMove = useCallback(
    (e: ChartMouseEvent) => {
      if (anchor === null) return;
      const label = e?.activeLabel;
      if (label == null) return;
      setCursor(label);
    },
    [anchor],
  );

  const commit = useCallback(() => {
    const from = anchor;
    const to = cursor;
    setAnchor(null);
    setCursor(null);
    if (from === null || to === null || String(from) === String(to)) return;

    const rowFor = (label: string | number) =>
      visible.find((row) => String(row[xKey]) === String(label));
    const a = rowFor(from);
    const b = rowFor(to);
    if (!a || !b) return;
    const spanA = spanOf(a);
    const spanB = spanOf(b);
    if (!spanA || !spanB) return; // a chart with no dates cannot define the page's window
    setRange(spanUnion(spanA, spanB));
  }, [anchor, cursor, visible, xKey, spanOf, setRange]);

  // Leaving the plot mid-drag abandons the selection rather than committing whatever label
  // happened to be last — a pointer that exits the chart never expressed a range.
  const onMouseLeave = useCallback(() => {
    setAnchor(null);
    setCursor(null);
  }, []);

  const selection =
    anchor !== null && cursor !== null && String(anchor) !== String(cursor)
      ? { x1: anchor, x2: cursor }
      : null;

  return {
    data: visible,
    zoomed: range !== null && visible.length !== data.length,
    dragging: anchor !== null,
    outOfRange,
    selection,
    handlers: {
      onMouseDown,
      onMouseMove,
      onMouseUp: commit,
      onMouseLeave,
      onDoubleClick: reset,
    },
    reset,
  };
}
