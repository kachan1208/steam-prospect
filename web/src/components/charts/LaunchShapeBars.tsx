import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { LaunchCurvePoint } from "../../lib/api";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

// Windows after launch. We difference the cumulative median curve into the *share*
// landing in each window — a marginal histogram that actually shows launch shape
// (tall left = front-loaded, flat spread = slow-burn), unlike a cumulative line
// that always climbs to 100% and looks identical for every genre.
const WINDOWS: { label: string; from: number; to: number }[] = [
  { label: "1w", from: 0, to: 7 },
  { label: "2w", from: 7, to: 14 },
  { label: "3–4w", from: 14, to: 30 },
  { label: "2m", from: 30, to: 60 },
  { label: "3m", from: 60, to: 90 },
  { label: "4–6m", from: 90, to: 180 },
  { label: "7–12m", from: 180, to: 365 },
];

export function LaunchShapeBars({ points, height = 200 }: { points: LaunchCurvePoint[]; height?: number }) {
  const cum = (d: number): number | null =>
    d === 0 ? 0 : points.find((p) => p.day === d)?.median_cum_fraction ?? null;

  const data = WINDOWS.map((w) => {
    const a = cum(w.from);
    const b = cum(w.to);
    return { label: w.label, share: a != null && b != null ? Math.max(0, (b - a) * 100) : 0 };
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: "var(--baseline)" }} interval={0} />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          tickLine={false}
          axisLine={false}
          width={34}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.4 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as { label: string; share: number };
            return (
              <TooltipPanel
                title={`${p.label} after launch`}
                rows={[{ label: "Share of first-year reviews", value: `${p.share.toFixed(1)}%`, color: CSS_VAR.demand }]}
              />
            );
          }}
        />
        <Bar dataKey="share" fill={CSS_VAR.demand} radius={[3, 3, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}
