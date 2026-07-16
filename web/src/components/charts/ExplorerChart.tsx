import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { fmtCompact, fmtInt, fmtPct, fmtUsd } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * The Explorer's auto-chart layer. Unlike the rest of the app's chart components (which
 * each render one fixed, statically-typed shape), this one draws from a *dynamic* result —
 * whatever columns the user picked in the query builder — so there is no static row type to
 * hang formatters off of. formatExploreValue below is the single per-column formatting
 * table (kept in sync with api/app/routers/explore.py's DIMENSIONS/METRICS by name, not by
 * import — this is a display concern, not a validation one; the whitelist itself lives only
 * server-side).
 *
 * Three shapes, one axis each (never dual-axis, per the dataviz skill):
 *   - Bar:     categorical group-by x one metric -> horizontal bars (mirrors PriceByGenreChart)
 *   - Line:    an ordered numeric group-by (release_year) x one metric -> trend (mirrors SaturationTrend)
 *   - Scatter: two user-picked numeric row-level columns -> linear scatter (mirrors
 *              PressCoverageScatter, but linear not log: arbitrary metric pairs here can
 *              include ratios/percentiles where log scale is meaningless or undefined at 0)
 * All three are single-series (one metric / one point cloud at a time) so, per the color
 * formula, they use one hue (CSS_VAR.demand / scatterPoint) and no legend — the chart title
 * and axis labels already name the series.
 */

const CURRENCY_COLS = new Set([
  "price_initial",
  "est_rev_reviews",
  "est_rev_owners",
  "median_price",
  "avg_price",
  "min_price",
  "median_est_rev",
  "sum_est_rev",
  "max_est_rev",
]);
const RATIO_COLS = new Set(["positive_ratio", "median_positive_ratio", "avg_positive_ratio"]);
const PERCENTILE_COLS = new Set(["rev_pct_in_genre", "reviews_pct_in_genre", "owners_pct_in_genre"]);
const COMPACT_COLS = new Set([
  "owners_mid",
  "median_owners",
  "total_reviews",
  "median_reviews",
  "n_games",
  "n_reviews_trailing_30d",
  "achievements_count",
  "avg_playtime_forever",
]);
const INT_COLS = new Set(["release_year", "appid", "metacritic_score"]);

/** Best-effort formatter for an arbitrary Explorer column/metric name, by exact-name
 * lookup against the (small, fixed) DIMENSIONS/METRICS vocabulary above. */
export function formatExploreValue(col: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v !== "number") return String(v);
  if (CURRENCY_COLS.has(col)) return fmtUsd(v);
  if (RATIO_COLS.has(col)) return fmtPct(v);
  if (PERCENTILE_COLS.has(col)) return `${v.toFixed(1)}%`;
  if (COMPACT_COLS.has(col)) return fmtCompact(v);
  if (INT_COLS.has(col)) return fmtInt(v);
  return fmtCompact(v);
}

function EmptyChart({ message = "Not enough data to chart." }: { message?: string }) {
  return <div className="flex h-48 items-center justify-center text-xs text-ink-muted">{message}</div>;
}

export interface ExplorerBarChartProps {
  rows: Record<string, unknown>[];
  groupCol: string;
  metricCol: string;
  metricLabel: string;
}

/** Categorical group-by x one metric. Horizontal bars, sorted by metric descending —
 * mirrors PriceByGenreChart's exact layout/mark spec. */
export function ExplorerBarChart({ rows, groupCol, metricCol, metricLabel }: ExplorerBarChartProps) {
  const data: Record<string, unknown>[] = rows
    .filter((r) => typeof r[metricCol] === "number")
    .map((r) => ({ ...r, __group: r[groupCol] === null || r[groupCol] === undefined ? "—" : String(r[groupCol]) }));
  data.sort((a, b) => (b[metricCol] as number) - (a[metricCol] as number));
  const limited = data.slice(0, 25);
  if (limited.length === 0) return <EmptyChart />;
  const height = Math.max(180, limited.length * 26);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={limited} layout="vertical" margin={{ top: 4, right: 36, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--gridline)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => formatExploreValue(metricCol, v)}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis type="category" dataKey="__group" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={150} />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as Record<string, unknown>;
            return (
              <TooltipPanel
                title={String(p.__group)}
                rows={[{ label: metricLabel, value: formatExploreValue(metricCol, p[metricCol]), color: CSS_VAR.demand }]}
              />
            );
          }}
        />
        <Bar dataKey={metricCol} fill={CSS_VAR.demand} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface ExplorerLineChartProps {
  rows: Record<string, unknown>[];
  groupCol: string;
  groupLabel: string;
  metricCol: string;
  metricLabel: string;
}

/** An ordered numeric group-by (release_year) x one metric -> trend line. Mirrors
 * SaturationTrend's revenue-per-year half (monotone line, 4px dots, connectNulls). */
export function ExplorerLineChart({ rows, groupCol, groupLabel, metricCol, metricLabel }: ExplorerLineChartProps) {
  const data = rows
    .filter((r) => typeof r[groupCol] === "number" && typeof r[metricCol] === "number")
    .sort((a, b) => (a[groupCol] as number) - (b[groupCol] as number));
  if (data.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 4, bottom: 8 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey={groupCol}
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          label={{ value: groupLabel, position: "insideBottom", offset: -6, fontSize: 10, fill: "var(--text-muted)" }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => formatExploreValue(metricCol, v)}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          cursor={{ stroke: "var(--baseline)" }}
          content={({ active, payload, label }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as Record<string, unknown>;
            return (
              <TooltipPanel
                title={String(label)}
                rows={[{ label: metricLabel, value: formatExploreValue(metricCol, p[metricCol]), color: CSS_VAR.demand }]}
              />
            );
          }}
        />
        <Line
          type="monotone"
          dataKey={metricCol}
          stroke={CSS_VAR.demand}
          strokeWidth={2}
          dot={{ r: 4, fill: CSS_VAR.demand, strokeWidth: 2, stroke: "var(--surface-1)" }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface ExplorerScatterChartProps {
  rows: Record<string, unknown>[];
  xCol: string;
  xLabel: string;
  yCol: string;
  yLabel: string;
}

/** Two user-picked numeric row-level columns -> a linear scatter (mirrors
 * PressCoverageScatter's structure; linear rather than log since arbitrary metric pairs
 * here can include ratios/percentiles that a log scale can't represent at/near zero). */
export function ExplorerScatterChart({ rows, xCol, xLabel, yCol, yLabel }: ExplorerScatterChartProps) {
  const data = rows.filter((r) => typeof r[xCol] === "number" && typeof r[yCol] === "number");
  if (data.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ top: 8, right: 16, left: 4, bottom: 24 }}>
        <CartesianGrid stroke="var(--gridline)" />
        <XAxis
          type="number"
          dataKey={xCol}
          name={xLabel}
          domain={["auto", "auto"]}
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => formatExploreValue(xCol, v)}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          label={{ value: xLabel, position: "insideBottom", offset: -14, fontSize: 10, fill: "var(--text-muted)" }}
        />
        <YAxis
          type="number"
          dataKey={yCol}
          name={yLabel}
          domain={["auto", "auto"]}
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => formatExploreValue(yCol, v)}
          tickLine={false}
          axisLine={false}
          width={54}
        />
        <ZAxis range={[42, 42]} />
        <Tooltip
          cursor={{ strokeDasharray: "3 3", stroke: "var(--baseline)" }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as Record<string, unknown>;
            const rows2 = [
              { label: xLabel, value: formatExploreValue(xCol, p[xCol]), color: CSS_VAR.scatterPoint },
              { label: yLabel, value: formatExploreValue(yCol, p[yCol]) },
            ];
            const name = typeof p.name === "string" ? p.name : undefined;
            return <TooltipPanel title={name} rows={rows2} />;
          }}
        />
        <Scatter data={data} fill={CSS_VAR.scatterPoint} fillOpacity={0.75} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
