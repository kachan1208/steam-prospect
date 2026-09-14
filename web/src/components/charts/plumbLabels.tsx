/**
 * The chart-side half of the plumb-line labels (the selection, wording and layout are pure,
 * in lib/notable.ts). Three charts draw the same dotted markers — ReviewVelocityBars,
 * ReviewsTimelineChart, GameTrendsChart — and this is what keeps their labels one treatment:
 * the band above the plot they are drawn in, the Recharts label props that put a label in
 * its row, the plot-width measurement the collision layout needs, the tooltip row and the
 * legend entry.
 *
 * WHY A BAND. Recharts puts a `position: "top"` reference-line label 5px ABOVE the plot's
 * top edge; with the old `margin.top: 4` that was y ≈ -1, outside the <svg>, which clips —
 * so the only label these charts ever had ("Released") never showed. The band is two rows
 * of 9.5px annotations; a chart sets margin.top to it and grows its height by the same
 * amount so the plot itself keeps its size.
 */
import { useCallback, useState } from "react";
import type { LabelProps } from "recharts";

import {
  changeSummary,
  MARKER_RATIO,
  MARKER_WINDOW,
  UNMEASURED_PLOT_PX,
  type MarkerReason,
  type PlumbLabel,
} from "../../lib/notable";
import { CSS_VAR } from "../../lib/palette";
import { LegendTick } from "./Legend";
import type { TooltipRow } from "./TooltipPanel";

/** Row pitch of the 9.5px labels. */
export const PLUMB_ROW_PITCH = 11;
/** margin.top that fits two label rows: baselines at 10px and 21px, the plot edge at 26px. */
export const PLUMB_LABEL_BAND = 2 * PLUMB_ROW_PITCH + 4;

/**
 * Recharts `label` props for one plumb line, or undefined when the layout hid the label (the
 * line is still drawn). Row 1 sits where Recharts puts a "top" label — its default 5px
 * offset above the plot edge — and row 0 one pitch higher; both inside the band. Colour and
 * type come from the `.plumb-label` rules in index.css: a class, because the stylesheet's
 * `.recharts-label { fill }` rule beats any fill ATTRIBUTE, which is why the old label's
 * `fill: var(--text-muted)` never applied either.
 */
export function plumbLabelProps(label: PlumbLabel, release: boolean): LabelProps | undefined {
  if (!label.show) return undefined;
  return {
    value: label.text,
    position: "top",
    dy: (label.row - 1) * PLUMB_ROW_PITCH,
    className: release ? "plumb-label plumb-label-release" : "plumb-label",
  };
}

/**
 * The plot width in px for `layoutPlumbLabels`, from ResponsiveContainer's `onResize`:
 * container width minus the chart's fixed chrome (its YAxis widths plus margin.right).
 * Wide until the first measurement lands, so the first paint shows every label and the
 * measured layout only ever takes labels away, never flashes them in.
 */
export function usePlotWidth(chromePx: number): { width: number; onResize: (width: number) => void } {
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const onResize = useCallback((width: number) => setContainerWidth(width), []);
  return {
    width: containerWidth === null ? UNMEASURED_PLOT_PX : Math.max(0, containerWidth - chromePx),
    onResize,
  };
}

/** The tooltip's "Spike 3.0× the trailing 6-mo median (36 → 107)" row, when the hovered
 * month's line is about a change. */
export function changeTooltipRow(reason: MarkerReason | undefined): TooltipRow | undefined {
  if (!reason?.change) return undefined;
  const summary = changeSummary(reason);
  if (summary === undefined) return undefined;
  return { label: reason.change === "spike" ? "Spike" : "Drop", value: summary, color: CSS_VAR.textMuted };
}

/** What the dotted lines are — one sentence, built from the detector's own thresholds so the
 * legend cannot drift from the rule. */
export const PLUMB_LEGEND_LABEL = `Release · catalog events · months that move ≥${MARKER_RATIO}× against the trailing ${MARKER_WINDOW}-month median`;

/** The legend entry for the plumb lines; drop it into a chart's legend row. */
export function PlumbLegendTick() {
  return <LegendTick color={CSS_VAR.textMuted} dotted label={PLUMB_LEGEND_LABEL} />;
}
