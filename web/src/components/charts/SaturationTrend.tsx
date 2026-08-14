import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { TrendPoint } from "../../lib/api";
import { fmtCompact, fmtUsd } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * Saturation trend, split into two single-axis small multiples rather than one
 * dual-axis combo chart: releases/year (supply, aqua) and median revenue/year
 * (reward, blue). Each measure keeps its own scale and its own chart.
 */
export function SaturationTrend({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-ink-muted">
        No yearly trend for this niche.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs text-ink-muted">Releases per year (supply)</div>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: "var(--baseline)" }} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => fmtCompact(v)}
              tickLine={false}
              axisLine={false}
              width={32}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as TrendPoint;
                return (
                  <TooltipPanel
                    title={String(label)}
                    rows={[
                      { label: "Releases", value: fmtCompact(p.n_releases), color: CSS_VAR.competition },
                      { label: "Scored", value: fmtCompact(p.n_scored) },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="n_releases" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div className="mb-1 text-xs text-ink-muted">Median revenue per year</div>
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} axisLine={{ stroke: "var(--baseline)" }} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => fmtUsd(v)}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <Tooltip
              cursor={{ stroke: "var(--baseline)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as TrendPoint;
                return (
                  <TooltipPanel
                    title={String(label)}
                    rows={[{ label: "Median revenue", value: fmtUsd(p.median_rev), color: CSS_VAR.demand }]}
                  />
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="median_rev"
              stroke={CSS_VAR.demand}
              strokeWidth={2}
              dot={{ r: 4, fill: CSS_VAR.demand, strokeWidth: 2, stroke: "var(--surface-1)" }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
