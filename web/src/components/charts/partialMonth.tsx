/**
 * THE MONTH STILL BEING COUNTED, marked the same way on every monthly count chart on the game
 * page (review velocity, the reviews drilldown, press coverage).
 *
 * A monthly COUNT whose month isn't over yet always looks like a collapse: Hades' Sep 2026
 * review bar held 610 reviews on the 21st against 1,323 for all of August. Drawn solid, it is
 * read as demand falling off a cliff; drawn hatched with "partial" over it (and said again in
 * the tooltip), it is read as what it is. Which month is partial comes from lib/dates
 * `partialMonth` — the data's as-of month, not the viewer's.
 */
import { useId } from "react";

import { daysIntoMonth, fmtDay } from "../../lib/dates";

/** An SVG-safe pattern id (React's useId has colons, which break `url(#…)`). */
export function useHatchId(prefix = "hatch"): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Diagonal hatch in `color` — the partial bar's fill. Render inside the chart element. */
export function HatchDefs({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <pattern id={id} patternUnits="userSpaceOnUse" width={5} height={5} patternTransform="rotate(45)">
        <rect width={5} height={5} fill={color} fillOpacity={0.15} />
        <line x1={0} y1={0} x2={0} y2={5} stroke={color} strokeWidth={2} />
      </pattern>
    </defs>
  );
}

/**
 * A recharts LabelList `content` that writes "partial" above ONE bar — the one whose row's
 * period is `partial` — and nothing above the rest. `periods` is the rendered rows' periods,
 * in order (LabelList hands over the row index).
 */
export function partialBarLabel(periods: readonly string[], partial: string | null) {
  return function PartialLabel(props: { x?: number | string; y?: number | string; width?: number | string; index?: number }) {
    const { index } = props;
    const x = Number(props.x);
    const y = Number(props.y);
    const width = Number(props.width);
    if (partial === null || index == null || periods[index] !== partial || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    // The partial month is always the LAST bar, at the plot's right edge: anchored at the bar's
    // right side the word runs leftward over the plot, never out into the right-hand axis.
    return (
      <text
        x={x + (Number.isFinite(width) ? width : 0)}
        y={y - 4}
        textAnchor="end"
        className="partial-month-label"
        style={{ fontSize: 9, fill: "var(--text-muted)" }}
      >
        partial
      </text>
    );
  };
}

/** The tooltip / legend wording: "partial month — data through Sep 21, 2026 (21 of 30 days)". */
export function partialNote(asOf: Date | null | undefined): string {
  const days = daysIntoMonth(asOf);
  if (!asOf || !days) return "partial month — still being counted";
  return `partial month — data through ${fmtDay(asOf.toISOString())} (${days.day} of ${days.of} days)`;
}
