import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";

import type { ChannelBuzzPoint } from "../../lib/api";
import { fmtCompact } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * Reach-weighted monthly sparkline for one channel-buzz term — same shape/rationale as
 * BuzzTrendsList's BuzzSparkline (shared month axis zero-filled by the caller, direction
 * color reused from the app's documented diverging pair), plotting reach_weighted_score
 * instead of a raw mention count.
 */
export function ChannelBuzzSparkline({
  series,
  periods,
  direction,
  width = 104,
  height = 28,
}: {
  series: ChannelBuzzPoint[];
  periods: string[];
  direction: "rising" | "cooling" | "flat";
  width?: number;
  height?: number;
}) {
  const byPeriod = new Map(series.map((p) => [p.period, p.reach_weighted_score]));
  const data = periods.map((period) => ({ period, reach_weighted_score: byPeriod.get(period) ?? 0 }));
  const color = direction === "rising" ? CSS_VAR.praise : direction === "cooling" ? CSS_VAR.complaint : CSS_VAR.textMuted;

  return (
    <div style={{ width, height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 1, left: 1, bottom: 1 }}>
          <YAxis hide domain={[0, (max: number) => Math.max(max, 1)]} />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as { period: string; reach_weighted_score: number };
              return (
                <TooltipPanel title={p.period} rows={[{ label: "Weighted score", value: fmtCompact(p.reach_weighted_score), color }]} />
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="reach_weighted_score"
            stroke={color}
            strokeWidth={2}
            fill={color}
            fillOpacity={0.15}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
