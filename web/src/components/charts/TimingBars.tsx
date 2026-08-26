import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CSS_VAR, MONO } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

export interface TimingBarsDatum {
  label: string;
  value: number | null;
  /** Optional second series rendered on its own right-hand axis (e.g. big releases). */
  secondary?: number | null;
  /** Highlighted bars (e.g. recommended months) get the full-strength fill. */
  highlighted?: boolean;
}

/**
 * Marginal bars for the Launch & Timing page — the house style for timing reads (the
 * user-preferred alternative to heatmaps/cumulative lines). One primary series, an
 * optional secondary series on a right axis, an optional reference line (e.g. the 8.3%
 * "average month" baseline), and optional per-bar highlighting for recommended windows.
 *
 * `secondaryColor` defaults to a mono paper tone rather than CSS_VAR.qualityGap: since
 * the design handoff (lib/palette.ts) moved qualityGap onto the same accent-300 as
 * demand, defaulting both `color` and `secondaryColor` to CSS_VAR constants would make
 * every un-styled two-series call collide on one hue — the two-series trend-chart
 * convention (primary accent-300, secondary paper) applies here even though this is a
 * bar chart rather than a line, just without the "dashed" part (bars have no stroke to
 * dash).
 */
export function TimingBars({
  data,
  height = 180,
  color = CSS_VAR.demand,
  secondaryColor = MONO.paper45,
  valueLabel,
  secondaryLabel,
  formatValue,
  formatSecondary,
  referenceY,
  referenceLabel,
  dimUnhighlighted = false,
}: {
  data: TimingBarsDatum[];
  height?: number;
  color?: string;
  secondaryColor?: string;
  valueLabel: string;
  secondaryLabel?: string;
  formatValue: (v: number) => string;
  formatSecondary?: (v: number) => string;
  referenceY?: number;
  referenceLabel?: string;
  dimUnhighlighted?: boolean;
}) {
  const hasSecondary = data.some((d) => d.secondary !== undefined && d.secondary !== null);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: hasSecondary ? 0 : 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
          // minTickGap instead of a forced interval-0: 12 month labels fit at desktop
          // widths but run together as "JanFebMar…" on a 390px phone — let recharts
          // thin to every other month when the slots get tighter than one label.
          interval={data.length > 14 ? 1 : "preserveStartEnd"}
          minTickGap={4}
        />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 10 }}
          tickFormatter={formatValue}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        {hasSecondary && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 10 }}
            tickFormatter={formatSecondary ?? formatValue}
            tickLine={false}
            axisLine={false}
            width={40}
          />
        )}
        {referenceY !== undefined && (
          <ReferenceLine
            yAxisId="left"
            y={referenceY}
            stroke="var(--baseline)"
            strokeDasharray="4 3"
            label={
              referenceLabel
                ? { value: referenceLabel, fontSize: 9, fill: "var(--text-muted)", position: "insideTopRight" }
                : undefined
            }
          />
        )}
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as TimingBarsDatum;
            const rows = [
              { label: valueLabel, value: p.value === null ? "—" : formatValue(p.value), color },
            ];
            if (p.secondary !== undefined && p.secondary !== null) {
              rows.push({
                label: secondaryLabel ?? "secondary",
                value: (formatSecondary ?? formatValue)(p.secondary),
                color: secondaryColor,
              });
            }
            return <TooltipPanel title={p.label} rows={rows} />;
          }}
        />
        <Bar yAxisId="left" dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={36}>
          {data.map((d) => (
            <Cell
              key={d.label}
              fill={color}
              opacity={dimUnhighlighted && !d.highlighted ? 0.35 : 1}
            />
          ))}
        </Bar>
        {hasSecondary && (
          <Bar yAxisId="right" dataKey="secondary" fill={secondaryColor} radius={[3, 3, 0, 0]} maxBarSize={36} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
