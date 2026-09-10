/**
 * The chrome around a drag-zoomable chart: the positioning context for its reset control,
 * the `select-none` that stops a drag becoming a text selection, the cursor that says the
 * plot is draggable at all, and the note for a series the page's window excludes entirely.
 *
 * One component rather than the same wrapper repeated per chart, because fourteen charts
 * adopting one interaction is exactly how a div and a button drift into fourteen slightly
 * different affordances (the lesson of the ten hand-rolled blueprint frames in IDEAS.md).
 */
import type { ReactNode } from "react";
import clsx from "clsx";

export function ZoomFrame({
  zoomed,
  dragging,
  outOfRange = false,
  onReset,
  className,
  children,
}: {
  zoomed: boolean;
  dragging: boolean;
  outOfRange?: boolean;
  onReset: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      // `cursor-crosshair` is the affordance: without it a zoomable chart looks exactly
      // like a static one and nobody discovers the drag. Crosshair at rest, `col-resize`
      // while sweeping — the pointer says "pick a range" before the band exists and "you
      // are sizing one" during.
      className={clsx(
        "relative",
        dragging ? "cursor-col-resize select-none" : "cursor-crosshair",
        className,
      )}
    >
      {zoomed && !outOfRange && (
        <button
          type="button"
          onClick={onReset}
          // A REAL button, bordered and filled. The first version of this was a 10px muted
          // caption in the corner and the report was "I can't find a button or a way to
          // deselect this range" — which is what a control styled as an annotation earns.
          // It still sits inside the plot's top-right margin so it never displaces the
          // chart, but it now reads as something to press.
          className="absolute right-0 top-0 z-10 rounded-sm border border-borderstrong bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-secondary shadow-sm hover:border-brand hover:text-ink-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Reset zoom
        </button>
      )}
      {outOfRange ? (
        // Honest rather than blank: this series has nothing inside the page's window, and
        // an empty pair of axes reads as a broken chart instead of an empty one.
        <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-1.5 py-6 text-center text-xs text-ink-muted">
          <span>No data in the selected date range.</span>
          <button
            type="button"
            onClick={onReset}
            className="rounded-sm border border-borderstrong bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-secondary hover:border-brand hover:text-ink-primary"
          >
            Reset zoom
          </button>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * The translucent band drawn under the cursor mid-drag. Spread onto Recharts'
 * `ReferenceArea`, which must render INSIDE the chart element to be positioned by its
 * scales — hence a props object rather than a component.
 *
 * Hairline edges plus a wash of the accent: the blueprint identity has no filled shapes, so
 * the selection reads as a measurement band, not a highlight. The wash is 0.22 because the
 * first pass at 0.12 was nearly invisible over bars on these dark panels, which read as the
 * drag not working.
 */
export const SELECTION_AREA_PROPS = {
  strokeOpacity: 1,
  stroke: "var(--accent-300)",
  strokeWidth: 1,
  fill: "var(--accent-300)",
  fillOpacity: 0.22,
  // Recharts animates a ReferenceArea's entry by default; on a band that follows the
  // cursor that reads as lag, not motion.
  isAnimationActive: false,
} as const;
