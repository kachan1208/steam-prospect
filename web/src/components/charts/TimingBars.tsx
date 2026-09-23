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

import { axisFormatter, niceAxisTicks, type AxisKind } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { MonthEventsStrip } from "./MonthEventsStrip";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

export interface TimingBarsDatum {
  label: string;
  value: number | null;
  /** Highlighted bars (e.g. recommended months) get the full-strength fill. */
  highlighted?: boolean;
  /** Extra tooltip rows under the value — a score's components, worked through
   * ("Buying 1.13 − Crowding 0.82 = +0.31"), so the hover never shows a bare number. */
  details?: TooltipRow[];
  /** The tooltip's value text, when it must match worked arithmetic printed beside it
   * (a difference of two ROUNDED indices) rather than `formatValue(value)`. */
  valueText?: string;
}

/** The plot's horizontal gutters, exported so anything drawn under it (MonthEventsStrip)
 * can line its twelve columns up with the twelve bars: the y-axis column on the left, the
 * chart margin on the right. */
export const TIMING_Y_AXIS_WIDTH = 44;
export const TIMING_RIGHT_MARGIN = 8;

/**
 * Marginal bars for the Launch & Timing page — the house style for timing reads (the
 * user-preferred alternative to heatmaps/cumulative lines). One series, an optional
 * reference line (e.g. the 8.3% "average month" baseline), optional per-bar highlighting
 * for recommended windows, and — for a month axis — the Steam events strip under it.
 *
 * ONE SERIES, ONE AXIS (2026-09-23). This component used to draw an optional second series
 * on its own right-hand axis ("$200K+ releases" beside all releases), a dual-axis chart the
 * owner's rules exclude: two scales on one plot invite comparing bar heights that mean
 * different things. Two quantities are now two aligned charts (small multiples) stacked on
 * the same month axis — see LaunchTiming's crowding card.
 */
export function TimingBars({
  data,
  height = 180,
  color = CSS_VAR.demand,
  valueLabel,
  formatValue,
  axisKind = "count",
  referenceY,
  referenceLabel,
  dimUnhighlighted = false,
  months = false,
}: {
  data: TimingBarsDatum[];
  height?: number;
  color?: string;
  valueLabel: string;
  /** TOOLTIP precision — deliberately finer than the axis (a tooltip names one bar). */
  formatValue: (v: number) => string;
  /** What the y-axis measures. The AXIS ticks are formatted from this, not from
   *  `formatValue`: passing the tooltip's formatter through to the ticks is what put
   *  "0.0% / 5.0% / 10.0% / 15.0% / 20.0%" on /timing's big charts while the launch-shape
   *  minis on the same page printed "0% / 8% / 16% / 24% / 32%". */
  axisKind?: AxisKind;
  referenceY?: number;
  referenceLabel?: string;
  dimUnhighlighted?: boolean;
  /** The data are the twelve calendar months, Jan..Dec: draw the Steam events strip under
   * the axis, column-aligned with the bars ("compact" = a short key, for a page's second
   * and later month charts). */
  months?: boolean | "compact";
}) {
  // Ticks are computed here so the formatter is sized for exactly the values printed.
  // The domain can go negative (window scores), so both ends get nice ticks.
  const values = data.map((d) => d.value).filter((v): v is number => v != null);
  const lo = Math.min(0, ...values, ...(referenceY != null ? [referenceY] : []));
  const hi = Math.max(0, ...values, ...(referenceY != null ? [referenceY] : []));
  // An axis that straddles zero splits the tick budget between its halves, so a +/-0.4
  // score axis stays at 5 ticks rather than doubling to 9.
  const perSide = lo < 0 ? 2 : 4;
  const posTicks = niceAxisTicks(hi, perSide);
  const negTicks = niceAxisTicks(-lo, perSide).filter((t) => t > 0).map((t) => -t);
  const leftTicks = [...negTicks].reverse().concat(posTicks);
  const leftFormat = axisFormatter(leftTicks, axisKind);

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: TIMING_RIGHT_MARGIN, left: 0, bottom: 0 }}>
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
            tick={{ fontSize: 10 }}
            ticks={leftTicks}
            interval={0}
            domain={[leftTicks[0] ?? 0, leftTicks[leftTicks.length - 1] ?? 0]}
            tickFormatter={(v: number) => leftFormat(v)}
            tickLine={false}
            axisLine={false}
            width={TIMING_Y_AXIS_WIDTH}
          />
          {referenceY !== undefined && (
            <ReferenceLine
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
              const rows: TooltipRow[] = [
                { label: valueLabel, value: p.valueText ?? (p.value === null ? "no data" : formatValue(p.value)), color },
                ...(p.details ?? []),
              ];
              return <TooltipPanel title={p.label} rows={rows} />;
            }}
          />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={36}>
            {data.map((d) => (
              <Cell key={d.label} fill={color} opacity={dimUnhighlighted && !d.highlighted ? 0.35 : 1} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {months && (
        <MonthEventsStrip
          left={TIMING_Y_AXIS_WIDTH}
          right={TIMING_RIGHT_MARGIN}
          legend={months === "compact" ? "compact" : "full"}
        />
      )}
    </div>
  );
}
