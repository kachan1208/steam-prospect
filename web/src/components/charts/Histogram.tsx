import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { HistBucket } from "../../lib/api";
import { fmtCompact } from "../../lib/format";
import { TooltipPanel } from "./TooltipPanel";

interface HistogramMark {
  label: string;
  value: number;
}

interface HistogramProps {
  buckets: HistBucket[];
  color: string;
  formatX: (n: number) => string;
  formatCount?: (n: number) => string;
  marks?: HistogramMark[];
  height?: number;
}

/**
 * A bucketed magnitude histogram. Buckets already come log-spaced from the API
 * (mart_market_hist / mart_niche_hist), so we render them as an evenly-spaced
 * categorical axis labeled with each bucket's lower edge — that reproduces the
 * "long-tail on log x" read without fighting Recharts' numeric log scale (which
 * chokes on the sparse/zero-count buckets the API omits).
 */
export function Histogram({ buckets, color, formatX, formatCount = fmtCompact, marks = [], height = 260 }: HistogramProps) {
  if (buckets.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-ink-muted">No data for this slice.</div>
    );
  }

  const data = buckets.map((b) => ({ ...b, label: formatX(b.x_min) }));

  function bucketLabelFor(value: number): string {
    const hit = buckets.find((b) => value >= b.x_min && value < b.x_max);
    if (hit) return formatX(hit.x_min);
    return value < buckets[0].x_min ? formatX(buckets[0].x_min) : formatX(buckets[buckets.length - 1].x_min);
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 22, right: 12, left: 4, bottom: 8 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10 }}
          interval="preserveStartEnd"
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => formatCount(v)}
          tickLine={false}
          axisLine={false}
          width={40}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const b = payload[0].payload as HistBucket & { label: string };
            return (
              <TooltipPanel
                title={`${formatX(b.x_min)} – ${formatX(b.x_max)}`}
                rows={[{ label: "Games", value: formatCount(b.count), color }]}
              />
            );
          }}
        />
        <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} />
        {marks.map((m, i) => (
          <ReferenceLine
            key={m.label}
            x={bucketLabelFor(m.value)}
            stroke="var(--text-muted)"
            strokeDasharray="3 3"
            label={{
              value: m.label,
              position: "top",
              fill: "var(--text-secondary)",
              fontSize: 10,
              dy: (i % 2) * 13,
            }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
