import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { PressTimelinePoint } from "../../lib/api";
import { fillMonthlyGaps, fmtMonth, partialMonth } from "../../lib/dates";
import { fmtInt } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { useDragZoom } from "../../lib/useDragZoom";
import { HatchDefs, partialBarLabel, partialNote, useHatchId } from "./partialMonth";
import { SELECTION_AREA_PROPS, ZoomFrame } from "./ZoomFrame";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * An integer count axis: the smallest 1 / 2 / 5 × 10^n step that covers `top` in at most five
 * intervals, so every tick is a whole number of articles. Exported for tests.
 */
export function wholeCountAxis(top: number): { ticks: number[]; domain: [number, number]; format: (v: number | null | undefined) => string } {
  const max = Math.max(1, Math.ceil(top));
  let step = 1;
  for (let mag = 1; ; mag *= 10) {
    const hit = [1, 2, 5].map((m) => m * mag).find((s) => Math.ceil(max / s) <= 5);
    if (hit !== undefined) {
      step = hit;
      break;
    }
  }
  const last = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= last; t += step) ticks.push(t);
  return { ticks, domain: [0, last], format: (v) => fmtInt(v) };
}

/**
 * Monthly press-mention volume — a single-tone count-per-period bar chart, the same
 * shape as the "reviews per month" half of ReviewVelocityBars / the releases-per-year
 * half of SaturationTrend. Same tone (CSS_VAR.competition, mono paper) as
 * PressBySourceChart: both charts slice the identical underlying metric (press
 * mentions), just by source vs. by month, so they should read as one measure, not two.
 *
 * EVERY MONTH GETS A SLOT (2026-09-23). The mart only emits months that had coverage, and a
 * category axis spaces whatever it is given evenly: Hollow Knight's timeline was 41 bars for
 * 108 months, its 67 silent months simply gone, so a 2017 burst and a 2026 one stood side by
 * side as neighbours. Missing months are filled with a zero here (props unchanged), so the
 * gaps are as wide as they were. The month still being counted is hatched and labelled
 * "partial" — pass `asOf` (the data's as-of date) to pin which one; without it the viewer's
 * current month stands in.
 */
export function PressTimelineChart({ points, asOf }: { points: PressTimelinePoint[]; asOf?: Date | null }) {
  const filled = fillMonthlyGaps(points, (period) => ({ period, n_mentions: 0 }));
  // Before the empty guard: useDragZoom is a hook, so it must run on every render.
  const zoom = useDragZoom(filled, "period");
  const hatchId = useHatchId("press-hatch");
  if (points.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-ink-muted">
        No press coverage to chart a timeline.
      </div>
    );
  }
  const partial = partialMonth(filled[filled.length - 1]?.period, asOf);
  const periods = zoom.data.map((p) => p.period);
  // Whole mentions only: the shared scale's 2.5-steps ticked CS2's 9-mention peak as
  // 0 / 2.5 / 5.0 / 7.5 / 10.0, and half an article is not a thing.
  const y = wholeCountAxis(Math.max(1, ...zoom.data.map((p) => p.n_mentions)));
  return (
    <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={zoom.data} margin={{ top: 14, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
          <HatchDefs id={hatchId} color={CSS_VAR.competition} />
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="period"
            tick={{ fontSize: 10 }}
            tickFormatter={(v: string) => fmtMonth(v) ?? v}
            interval="preserveStartEnd"
            minTickGap={24}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            ticks={y.ticks}
            interval={0}
            domain={y.domain}
            tickFormatter={(v: number) => y.format(v)}
            tickLine={false}
            axisLine={false}
            width={32}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as PressTimelinePoint;
              const rows: TooltipRow[] = [{ label: "Press mentions", value: fmtInt(p.n_mentions), color: CSS_VAR.competition }];
              if (p.period === partial) rows.push({ label: "Note", value: partialNote(asOf) });
              return <TooltipPanel title={fmtMonth(String(label)) ?? String(label)} rows={rows} />;
            }}
          />
          <Bar dataKey="n_mentions" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false}>
            {zoom.data.map((p) => (
              <Cell
                key={p.period}
                fill={p.period === partial ? `url(#${hatchId})` : CSS_VAR.competition}
                stroke={p.period === partial ? CSS_VAR.competition : undefined}
                strokeDasharray={p.period === partial ? "2 2" : undefined}
              />
            ))}
            <LabelList dataKey="n_mentions" content={partialBarLabel(periods, partial)} />
          </Bar>
          {zoom.selection && <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />}
        </BarChart>
      </ResponsiveContainer>
    </ZoomFrame>
  );
}
