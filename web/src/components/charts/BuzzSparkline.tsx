import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";

import type { BuzzTermPoint } from "../../lib/api";
import { fmtInt } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * A tiny inline monthly-frequency sparkline for one buzz term. `periods` is the SHARED
 * month axis computed once by the caller (BuzzTrendsList) from the union of every row's
 * series, so every sparkline in a list zero-fills against the identical set of months and
 * lines up column-for-column — a term with no mentions in a given month reads as a true
 * gap (0), not a skipped/compressed point. Colored by direction (reuses the app's
 * documented diverging pair, same rationale as praise/complaint) — decorative, not the
 * only identity signal: the row it sits in already carries the term name + a rising/
 * cooling arrow in neutral ink (see BuzzTrendsList).
 */
export function BuzzSparkline({
  series,
  periods,
  direction,
  width = 104,
  height = 28,
}: {
  series: BuzzTermPoint[];
  periods: string[];
  direction: "rising" | "cooling" | "flat";
  width?: number;
  height?: number;
}) {
  const bySeries = new Map(series.map((p) => [p.period, p.n_mentions]));
  const data = periods.map((period) => ({ period, n_mentions: bySeries.get(period) ?? 0 }));
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
              const p = payload[0].payload as { period: string; n_mentions: number };
              return <TooltipPanel title={p.period} rows={[{ label: "Mentions", value: fmtInt(p.n_mentions), color }]} />;
            }}
          />
          <Area
            type="monotone"
            dataKey="n_mentions"
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
