/**
 * Legend swatches shared by the chart files (moved out of the since-removed GameTrendsChart
 * once a second chart needed them). Design handoff: "Legend swatches 14×2px".
 */

/** 14x2px line-key swatch — a thin bar reads fine as a generic swatch for either a bar or a
 * line series, and matches every line-legend in the mockups pixel-for-pixel. */
export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-0.5 w-3.5 shrink-0" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/** A short vertical tick, for the plumb-line markers. `dotted` draws it as the dotted line it
 * stands for rather than a solid stroke the chart never uses. */
export function LegendTick({ color, label, dotted = false }: { color: string; label: string; dotted?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {dotted ? (
        <span className="h-3 w-0 shrink-0 border-l-2 border-dotted" style={{ borderColor: color }} />
      ) : (
        <span className="h-3 w-0.5 shrink-0" style={{ backgroundColor: color }} />
      )}
      {label}
    </span>
  );
}
