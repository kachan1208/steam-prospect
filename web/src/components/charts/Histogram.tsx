import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { HistBucket } from "../../lib/api";
import { axisFormatter, axisScale, fmtCompact, type AxisKind } from "../../lib/format";
import { TooltipPanel } from "./TooltipPanel";

interface HistogramMark {
  label: string;
  value: number;
}

interface HistogramProps {
  buckets: HistBucket[];
  color: string;
  /** What the bucket EDGES measure — picks the x-label vocabulary ($ vs plain counts). */
  xKind: AxisKind;
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
 *
 * BOTH axes are formatted from their own full value set, not per value. The callers used
 * to hand in `formatX={fmtUsd}`, which decides its unit one tick at a time — the price
 * histogram on /timing shipped an x-axis reading "$0.00 / $5.00 / $10 / $13 / … / $1.9K"
 * (cents, then whole dollars, then thousands) and a y-axis reading "0 / 7,000 / 14.0K /
 * 21.0K / 28.0K". See lib/format.ts axisFormatter.
 */
export function Histogram({ buckets, color, xKind, formatCount = fmtCompact, marks = [], height = 260 }: HistogramProps) {
  if (buckets.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-ink-muted">No data for this slice.</div>
    );
  }

  // Sized over EVERY edge the chart can print — tick labels and the tooltip's range
  // headline read as one axis. maxDecimals 2 so a cents-priced edge survives verbatim
  // rather than rounding onto a gridline it isn't at (the $12.50 bin printed "$13").
  // Benchmark marks are excluded on purpose: they carry their own label from the API
  // ("$9.99"), and letting one drag the whole axis to 2 decimals would put ".00" under
  // every $2.50 bin edge.
  const formatX = axisFormatter(buckets.flatMap((b) => [b.x_min, b.x_max]), xKind, 2);
  const y = axisScale(Math.max(0, ...buckets.map((b) => b.count ?? 0)), "count");
  // A FLOORED bucket (the API's `floored`, 2026-09-23) is the lowest band of a log histogram
  // into which the marts clamp everything under 1 — $0 revenue, 0 players. Its lower edge is
  // a floor sentinel, not a measurement, so it is labelled by its upper edge ("<3.16") and
  // its tooltip says what it holds ("< 3.16 (incl. 0)") — never "0 – 3.16" or "1 – 3.16".
  const zero = xKind === "usd" ? "$0" : "0";
  // The floor band's upper edge is 10^0.5 = 3.162…, which the axis vocabulary rounds to "3";
  // printed as the ceiling of a "<" it needs its three significant digits ("<3.16").
  const floorEdge = (v: number) =>
    Number.isInteger(v) ? formatX(v) : `${xKind === "usd" ? "$" : ""}${Number(v.toPrecision(3))}`;
  const labelOf = (b: HistBucket) => (b.floored ? `<${floorEdge(b.x_max)}` : formatX(b.x_min));
  const rangeOf = (b: HistBucket) =>
    b.floored ? `< ${floorEdge(b.x_max)} (incl. ${zero})` : `${formatX(b.x_min)} – ${formatX(b.x_max)}`;
  const data = buckets.map((b) => ({ ...b, label: labelOf(b) }));

  function bucketLabelFor(value: number): string {
    const hit = buckets.find((b) => value >= b.x_min && value < b.x_max);
    if (hit) return labelOf(hit);
    return value < buckets[0].x_min ? labelOf(buckets[0]) : labelOf(buckets[buckets.length - 1]);
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
          ticks={y.ticks}
          interval={0}
          domain={y.domain}
          tickFormatter={(v: number) => y.format(v)}
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
                title={rangeOf(b)}
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
            strokeDasharray="3 4"
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
