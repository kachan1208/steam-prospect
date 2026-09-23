/**
 * The chart-side half of the plumb-line labels (the selection, wording and layout are pure,
 * in lib/notable.ts). ReviewVelocityBars draws the dotted markers (GameTrendsChart did too,
 * until 2026-09-19) and this is what keeps the labels one treatment:
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
  LABEL_CHAR_PX,
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
export function plumbLabelProps(
  label: PlumbLabel,
  release: boolean,
  /** The plot's left and right edges in SVG px. When given, a label that would overhang
   * either edge is pinned inside it — see plumbLabelX. */
  bounds?: PlotBounds,
): LabelProps | undefined {
  if (!label.show) return undefined;
  const className = release ? "plumb-label plumb-label-release" : "plumb-label";
  const dy = (label.row - 1) * PLUMB_ROW_PITCH;
  if (!bounds) return { value: label.text, position: "top", dy, className };
  return {
    value: label.text,
    position: "top",
    className,
    // A custom renderer so the anchor can change at the edges; same row, same class, same
    // baseline Recharts' "top" position gives (5px above the plot edge, then the row offset).
    content: (props: { viewBox?: unknown }) => {
      const vb = props.viewBox as { x?: number; y?: number } | undefined;
      if (!vb || typeof vb.x !== "number" || typeof vb.y !== "number") return null;
      const { x, anchor } = plumbLabelX(vb.x, label.text, bounds);
      return (
        <text className={className} x={x} y={vb.y - 5} dy={dy} textAnchor={anchor}>
          {label.text}
        </text>
      );
    },
  };
}

export interface PlotBounds {
  left: number;
  right: number;
}

/**
 * Where a plumb label sits horizontally: centred on its line, unless that would push it past
 * the plot's left or right edge — then it is pinned to that edge (anchored start / end), still
 * spanning its line. Centred, the first month's "RELEASED" hung ~26px left of the plot and
 * over the y-axis column, printed on top of the axis's top tick ("RELEASED" over "25K").
 * Width is the layout's own estimate (LABEL_CHAR_PX per character).
 */
export function plumbLabelX(lineX: number, text: string, bounds: PlotBounds): { x: number; anchor: "middle" | "start" | "end" } {
  const half = (text.length * LABEL_CHAR_PX) / 2;
  if (lineX - half < bounds.left) return { x: bounds.left, anchor: "start" };
  if (lineX + half > bounds.right) return { x: bounds.right, anchor: "end" };
  return { x: lineX, anchor: "middle" };
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

/** Height of the legend row the charts put under the plot (`mt-2` + one line of 10px text),
 * measured at 23px, so a loading placeholder can reserve it and the card does not jump when
 * the data lands. A legend that wraps to a second line is 19px taller than this. */
export const PLUMB_LEGEND_ROW_PX = 23;
