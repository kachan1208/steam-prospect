import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { EntityGameRow } from "../../lib/api";
import { axisScale, fmtUsd } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * Release trajectory: one MARGINAL bar per release in career order (x = seq, labeled with
 * the release year; y = that game's own est_rev_reviews). Deliberately not a cumulative
 * curve — per-release bars show whether an entity is growing, one-hit, or fading, where a
 * cumulative line always climbs and flattens the story. No reusable per-item bar chart
 * existed (Histogram is bucket-counts, LaunchShapeBars is fixed launch windows), hence
 * this small one in the same recharts idiom.
 */
export function EntityReleaseBars({
  games,
  height = 220,
  onBarClick,
}: {
  games: EntityGameRow[]; // seq ASC from the API
  height?: number;
  onBarClick?: (appid: number) => void;
}) {
  if (games.length === 0) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">No releases.</div>;
  }

  const data = games.map((g) => ({
    ...g,
    // Unique category key (years repeat); the tick shows the year only.
    key: `#${g.seq}`,
    rev: g.est_rev_reviews ?? 0,
  }));

  // One unit for the whole axis. fmtAxisUsd switches ladder rung per value, so a career
  // topping $1B printed "$0 / $250M / $500M / $750M / $1.0B" — three of the five ticks in
  // millions and the last in billions, which makes an even scale look irregular.
  const y = axisScale(Math.max(0, ...data.map((d) => d.rev)), "usd");

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="key"
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          interval={data.length > 24 ? "preserveStartEnd" : 0}
          // One bar per RELEASE, labeled by year — several releases share a year, so
          // consecutive repeats print once ("2025 · · 2026", not "2025 2025 2025"),
          // which is also what keeps the axis legible at phone widths.
          tickFormatter={(key: string) => {
            const i = data.findIndex((d) => d.key === key);
            const year = i >= 0 ? data[i].release_year : null;
            if (year == null) return String(key);
            const prev = i > 0 ? data[i - 1].release_year : null;
            return year === prev ? "" : String(year);
          }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          ticks={y.ticks}
          interval={0}
          domain={y.domain}
          tickFormatter={(v: number) => y.format(v)}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.4 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const g = payload[0].payload as (typeof data)[number];
            return (
              <TooltipPanel
                title={`${g.name ?? `App ${g.appid}`}${g.release_year != null ? ` (${g.release_year})` : ""}`}
                rows={[
                  { label: "Est. revenue", value: fmtUsd(g.rev), color: CSS_VAR.demand },
                  { label: "Release #", value: String(g.seq) },
                ]}
              />
            );
          }}
        />
        <Bar
          dataKey="rev"
          fill={CSS_VAR.demand}
          radius={[3, 3, 0, 0]}
          maxBarSize={48}
          cursor={onBarClick ? "pointer" : undefined}
          onClick={(entry: unknown) => {
            const g = entry as { appid?: number } | null;
            if (onBarClick && g && typeof g.appid === "number") onBarClick(g.appid);
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
