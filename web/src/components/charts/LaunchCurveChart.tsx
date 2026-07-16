import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { GameLaunchCurvePoint, LaunchCurvePoint } from "../../lib/api";
import { fmtPct } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

interface MergedPoint extends LaunchCurvePoint {
  selfFraction?: number;
}

/**
 * Emphasis pattern: median (the reliable "typical" trajectory) in the accent
 * blue, mean shown as muted dashed context so outlier-driven skew is visible
 * without pretending both lines are equally-weighted categorical series.
 *
 * Optional `selfPoints` overlays one specific game's own curve (aqua, solid)
 * for the Game Profile "this game vs. genre average" comparison — additive
 * and opt-in, so the existing Launch & Timing small-multiples (which never
 * pass it) render byte-for-byte as before. This component has no internal
 * legend (matches its pre-Phase-2 contract); the caller renders one when
 * `selfPoints` is used — see GameProfile.tsx.
 */
export function LaunchCurveChart({
  points,
  selfPoints,
  height = 180,
}: {
  points: LaunchCurvePoint[];
  selfPoints?: GameLaunchCurvePoint[];
  height?: number;
}) {
  if (points.length === 0) {
    return <div className="flex h-32 items-center justify-center text-xs text-ink-muted">No launch-curve data.</div>;
  }
  const selfByDay = new Map((selfPoints ?? []).map((p) => [p.day, p.cum_fraction]));
  const hasSelf = selfByDay.size > 0;
  const data: MergedPoint[] = points.map((p) => ({ ...p, selfFraction: selfByDay.get(p.day) }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="day"
          tick={{ fontSize: 10 }}
          tickFormatter={(d: number) => `d${d}`}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis
          domain={[0, 1]}
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtPct(v, 0)}
          tickLine={false}
          axisLine={false}
          width={36}
        />
        <Tooltip
          cursor={{ stroke: "var(--baseline)" }}
          content={({ active, payload, label }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as MergedPoint;
            const rows: TooltipRow[] = [
              { label: "Median", value: fmtPct(p.median_cum_fraction, 0), color: CSS_VAR.demand },
              { label: "Mean", value: fmtPct(p.mean_cum_fraction, 0), color: "var(--text-muted)" },
            ];
            if (hasSelf) {
              rows.push({
                label: "This game",
                value: p.selfFraction !== undefined ? fmtPct(p.selfFraction, 0) : "no data yet",
                color: CSS_VAR.competition,
              });
            }
            rows.push({ label: "Games", value: String(p.n_games) });
            return <TooltipPanel title={`Day ${label}`} rows={rows} />;
          }}
        />
        <Line
          type="monotone"
          dataKey="median_cum_fraction"
          name="Median"
          stroke={CSS_VAR.demand}
          strokeWidth={2}
          dot={{ r: 4, fill: CSS_VAR.demand, strokeWidth: 2, stroke: "var(--surface-1)" }}
        />
        <Line
          type="monotone"
          dataKey="mean_cum_fraction"
          name="Mean"
          stroke="var(--text-muted)"
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={{ r: 3, fill: "var(--text-muted)", strokeWidth: 2, stroke: "var(--surface-1)" }}
        />
        {hasSelf && (
          <Line
            type="monotone"
            dataKey="selfFraction"
            name="This game"
            stroke={CSS_VAR.competition}
            strokeWidth={2}
            dot={{ r: 4, fill: CSS_VAR.competition, strokeWidth: 2, stroke: "var(--surface-1)" }}
            connectNulls
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
