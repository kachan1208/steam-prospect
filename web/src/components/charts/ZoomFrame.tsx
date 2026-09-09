/**
 * The chrome around a drag-zoomable chart: the positioning context the reset control sits
 * in, and the `select-none` that stops a drag from turning into a text selection.
 *
 * Kept as one component rather than repeated per chart because seven charts adopting the
 * same interaction is exactly how a wrapper div and a button end up drifting into seven
 * slightly different affordances (which is the lesson of the ten hand-rolled blueprint
 * frames recorded in IDEAS.md).
 *
 * The control only exists while zoomed: an always-present "Reset" on an unzoomed chart is
 * a dead control, and these panels are dense enough already.
 */
import type { ReactNode } from "react";
import clsx from "clsx";

export function ZoomFrame({
  zoomed,
  dragging,
  onReset,
  className,
  children,
}: {
  zoomed: boolean;
  dragging: boolean;
  onReset: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={clsx("relative", dragging && "select-none", className)}>
      {zoomed && (
        <button
          type="button"
          onClick={onReset}
          // Caption vocabulary, not button vocabulary: uppercase 10px muted, no fill and no
          // border, so it reads as the chart's own annotation layer (same family as the
          // "MONTHLY" / "PARTIAL" marks) instead of competing with the page's real buttons.
          className="absolute right-0 top-0 z-10 text-[10px] font-semibold uppercase tracking-wide text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Reset zoom
        </button>
      )}
      {children}
    </div>
  );
}

/**
 * The translucent band drawn under the cursor mid-drag. Props are spread onto Recharts'
 * `ReferenceArea`, which must be rendered INSIDE the chart element to be positioned by its
 * scales — hence a props object rather than a component of its own.
 *
 * Hairline stroke + a wash of the accent: the blueprint identity has no filled shapes, so
 * the selection reads as a measurement band rather than a highlight.
 */
export const SELECTION_AREA_PROPS = {
  strokeOpacity: 0.9,
  stroke: "var(--accent-300)",
  strokeWidth: 1,
  fill: "var(--accent-300)",
  fillOpacity: 0.12,
  // Recharts animates a ReferenceArea's entry by default; on a band that follows the
  // cursor that reads as lag, not motion.
  isAnimationActive: false,
} as const;
