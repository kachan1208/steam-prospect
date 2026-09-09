import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { PressTimelinePoint } from "../../lib/api";
import { fmtInt } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { useDragZoom } from "../../lib/useDragZoom";
import { SELECTION_AREA_PROPS, ZoomFrame } from "./ZoomFrame";
import { TooltipPanel } from "./TooltipPanel";

/**
 * Monthly press-mention volume — a single-tone count-per-period bar chart, the same
 * shape as the "reviews per month" half of ReviewsTimelineChart / the releases-per-year
 * half of SaturationTrend. Same tone (CSS_VAR.competition, mono paper) as
 * PressBySourceChart: both charts slice the identical underlying metric (press
 * mentions), just by source vs. by month, so they should read as one measure, not two.
 */
export function PressTimelineChart({ points }: { points: PressTimelinePoint[] }) {
  // Before the empty guard: useDragZoom is a hook, so it must run on every render.
  const zoom = useDragZoom(points, "period");
  if (points.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-ink-muted">
        No press coverage to chart a timeline.
      </div>
    );
  }
  return (
    <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} onReset={zoom.reset}>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={zoom.data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="period"
          tick={{ fontSize: 10 }}
          interval="preserveStartEnd"
          minTickGap={24}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtInt(v)}
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
            return (
              <TooltipPanel
                title={String(label)}
                rows={[{ label: "Press mentions", value: fmtInt(p.n_mentions), color: CSS_VAR.competition }]}
              />
            );
          }}
        />
        <Bar dataKey="n_mentions" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
        {zoom.selection && (
          <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />
        )}
        </BarChart>
      </ResponsiveContainer>
    </ZoomFrame>
  );
}
