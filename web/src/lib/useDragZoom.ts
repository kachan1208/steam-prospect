/**
 * Drag a range on a chart to zoom into it.
 *
 * WHY IT SLICES INSTEAD OF SETTING A DOMAIN. Every time axis in this app is a CATEGORY
 * axis — `dataKey="period"` / `"captured_on"` / `"year"` / `"date"`, all strings, because
 * the series are pre-bucketed by the marts and the tick labels are the bucket names. On a
 * category axis Recharts ignores `XAxis domain`, so the usual `domain={[left, right]} +
 * allowDataOverflow` recipe (which is written for `type="number"`) draws nothing. The
 * equivalent for a category axis is to hand the chart fewer rows: slice the data and every
 * axis, grid line, bar, line and reference mark follows, and the Y axis rescales on its own
 * because `domain={['auto','auto']}` (Recharts' default) reads the rows it was given.
 *
 * The zoom therefore lives as an INDEX RANGE into the caller's full array, never as pixel
 * or value math — which is also what makes it safe on unevenly spaced buckets (a game with
 * no reviews in March has no March row, and dragging across the gap still selects exactly
 * the rows the user swept over).
 *
 * Recharts gives us `activeLabel` — the category under the cursor — on its mouse events.
 * That is the whole input: mouse-down records the anchor label, mouse-move tracks the
 * cursor label, mouse-up resolves both back to indices. Labels, not indices, because
 * `activeLabel` is what the event carries and re-deriving an index from a pixel would
 * duplicate Recharts' own hit-testing.
 *
 * TOUCH IS DELIBERATELY NOT WIRED. A touch drag on a chart is already the page's scroll
 * gesture; hijacking it would trap a phone reader inside the chart. Pinch-zoom on a
 * category axis needs a different interaction (and a visible affordance) than this one, so
 * the phone keeps the full series and the desktop gets the drag.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Recharts' mouse-event payload, narrowed to the one field this needs. Recharts types it
 * as `CategoricalChartState`, which is not exported from the package root, and every field
 * on it is optional anyway — so this is the honest shape rather than a cast.
 */
export type ChartMouseEvent = { activeLabel?: string | number } | null | undefined;

/** Rows narrower than this are a click, not a drag: a selection must span 2+ categories. */
const MIN_SPAN = 1;

export interface DragZoom<T> {
  /** The rows to render — the full array, or the zoomed slice of it. */
  data: T[];
  /** True once a range is applied; drives the reset control's visibility. */
  zoomed: boolean;
  /** True mid-drag; the caller sets `select-none` so the drag does not select text. */
  dragging: boolean;
  /**
   * The in-progress selection, for a `<ReferenceArea x1 x2>`.
   *
   * These carry the category's ORIGINAL type, not a stringified copy. Half these axes are
   * numeric (`year`), and Recharts matches a ReferenceArea's x against the axis domain by
   * value: handing it "2014" for a domain of 2014 positions nothing, so the band silently
   * never drew on those charts while the zoom itself still worked — which read as the drag
   * doing nothing at all.
   */
  selection: { x1: string | number; x2: string | number } | null;
  /** Spread onto the Recharts chart element. */
  handlers: {
    onMouseDown: (e: ChartMouseEvent) => void;
    onMouseMove: (e: ChartMouseEvent) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
    onDoubleClick: () => void;
  };
  /** Drop the zoom (Escape, double-click, or the reset control). */
  reset: () => void;
}

/**
 * @param data full series, ordered as it should be drawn
 * @param xKey the field the chart's XAxis uses as `dataKey`
 */
export function useDragZoom<T>(data: T[], xKey: keyof T & string): DragZoom<T> {
  const [range, setRange] = useState<[number, number] | null>(null);
  // Raw category values, not stringified: the ReferenceArea below needs the axis's own
  // type to position itself (see `selection`). Comparisons go through String().
  const [anchor, setAnchor] = useState<string | number | null>(null);
  const [cursor, setCursor] = useState<string | number | null>(null);

  const visible = useMemo(
    () => (range ? data.slice(range[0], range[1] + 1) : data),
    [data, range],
  );

  // A new series (another game, another niche) must not inherit the previous one's window.
  // Keyed on a signature rather than on `data` itself: a parent that rebuilds the array on
  // every render would otherwise reset the zoom the instant it is applied.
  const signature = data.length
    ? `${data.length}|${String(data[0][xKey])}|${String(data[data.length - 1][xKey])}`
    : "empty";
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setRange(null);
      setAnchor(null);
      setCursor(null);
    }
  }, [signature]);

  const reset = useCallback(() => {
    setRange(null);
    setAnchor(null);
    setCursor(null);
  }, []);

  // Escape is the conventional "get me out" for a transient view state, and it also
  // cancels a drag in progress — releasing the button afterwards must then do nothing,
  // which falls out of `anchor` already being null.
  useEffect(() => {
    if (!range && anchor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [range, anchor, reset]);

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
    if (anchor === null || cursor === null) {
      setAnchor(null);
      setCursor(null);
      return;
    }
    const key = (row: T) => String(row[xKey]);
    let i = visible.findIndex((row) => key(row) === String(anchor));
    let j = visible.findIndex((row) => key(row) === String(cursor));
    setAnchor(null);
    setCursor(null);
    if (i < 0 || j < 0) return;
    if (i > j) [i, j] = [j, i];
    if (j - i < MIN_SPAN) return; // a click, or a twitch inside one bucket
    const base = range ? range[0] : 0;
    setRange([base + i, base + j]);
  }, [anchor, cursor, visible, xKey, range]);

  // Leaving the plot mid-drag abandons the selection rather than committing whatever the
  // last label happened to be — a pointer that exits the chart never expressed a range.
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
    zoomed: range !== null,
    dragging: anchor !== null,
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
