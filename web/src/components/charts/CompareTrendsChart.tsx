import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { errorMessage, useGameTrendsWithComps, type GameTrendPoint } from "../../lib/api";
import { axisScale, fmtCompact } from "../../lib/format";
import { compareSeries, type CompareSeriesShape, type CompareSeriesStyle } from "../../lib/palette";
import { RetryButton } from "../ui/ErrorState";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * Compare-page trends overlay: monthly sampled-review velocity, one line per compared
 * game. Fetched as ONE request — game 1 is the primary and the rest ride the trends
 * endpoint's ?comps= overlay (GET /api/games/{appid}/trends?comps=…). GameTrendsChart
 * doesn't speak `comps` (it draws a single game's two-panel small multiples), so this is
 * a purpose-built multi-series line using the house chart tokens: gridline/baseline vars,
 * TooltipPanel, neutral-ink legend labels with color only on the marks.
 *
 * Series identity is COLOUR + DASH + MARKER SHAPE, from lib/palette.ts COMPARE_SERIES
 * (which carries the contrast arithmetic and the reason the mono ramp was withdrawn from
 * this one chart). The short version: the previous mono ramp — the design handoff's own
 * #4d mockup tones, accent-300 / paper 75% / paper 65% — measured 1.24:1 and 1.25:1
 * between neighbouring lines on production, against WCAG 1.4.11's 3:1, and the two grey
 * lines cross around 2026-08. Rank-by-recession is a POLARITY language; three independent
 * games need an IDENTITY one. Every consecutive pair now clears 3:1, and because a 3:1
 * chain of three is arithmetically impossible on a 14:1 ground, dash and marker shape
 * carry identity where luminance cannot — so the chart also survives greyscale.
 *
 * Review velocity is the only series deep enough to compare across months today (CCU/
 * player snapshots are typically a single current month — see GameTrendsChart's caveat),
 * which is why this chart draws n_reviews only. Months before a game existed are gaps
 * (connectNulls off), not zeros.
 */

/** Kept as a named export: Compare.tsx paints its column dots and legend from it. */
export function compareSeriesColor(i: number): string {
  return compareSeries(i).color;
}

/**
 * The marker glyph, centred on (cx, cy). Filled paths only — a 5px outline would vanish
 * at this size, and a filled mark keeps the same ink weight as the line it belongs to.
 */
export function seriesShapePath(shape: CompareSeriesShape, cx: number, cy: number, r: number): string {
  const t = r * 0.42; // arm half-width for plus/cross
  switch (shape) {
    case "square":
      return `M ${cx - r} ${cy - r} H ${cx + r} V ${cy + r} H ${cx - r} Z`;
    case "triangle":
      return `M ${cx} ${cy - r * 1.15} L ${cx + r} ${cy + r * 0.8} L ${cx - r} ${cy + r * 0.8} Z`;
    case "diamond":
      return `M ${cx} ${cy - r * 1.25} L ${cx + r * 1.25} ${cy} L ${cx} ${cy + r * 1.25} L ${cx - r * 1.25} ${cy} Z`;
    case "plus":
      return (
        `M ${cx - t} ${cy - r} H ${cx + t} V ${cy - t} H ${cx + r} V ${cy + t} H ${cx + t} ` +
        `V ${cy + r} H ${cx - t} V ${cy + t} H ${cx - r} V ${cy - t} H ${cx - t} Z`
      );
    case "cross": {
      // A saltire (X): the plus's arms swung 45 degrees, written out rather than applied
      // as an SVG transform so the whole glyph stays one `d` string that tests can read.
      const a = r * 0.8;
      const b = t * 0.9;
      return (
        `M ${cx - a} ${cy - a + b} L ${cx - a + b} ${cy - a} L ${cx} ${cy - b} L ${cx + a - b} ${cy - a} ` +
        `L ${cx + a} ${cy - a + b} L ${cx + b} ${cy} L ${cx + a} ${cy + a - b} L ${cx + a - b} ${cy + a} ` +
        `L ${cx} ${cy + b} L ${cx - a + b} ${cy + a} L ${cx - a} ${cy + a - b} L ${cx - b} ${cy} Z`
      );
    }
    default:
      return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  }
}

/** One legend key: the series' own dash pattern with its own marker stamped mid-line, so
 *  the legend is readable by the same three channels the chart is. */
export function SeriesKey({ style: s, size = 22 }: { style: CompareSeriesStyle; size?: number }) {
  const h = 10;
  return (
    <svg
      data-testid="series-key"
      width={size}
      height={h}
      viewBox={`0 0 ${size} ${h}`}
      aria-hidden
      className="shrink-0 overflow-visible"
    >
      <line
        x1={0}
        y1={h / 2}
        x2={size}
        y2={h / 2}
        stroke={s.color}
        strokeWidth={1.75}
        strokeDasharray={s.dash}
      />
      <path d={seriesShapePath(s.shape, size / 2, h / 2, 3.1)} fill={s.color} />
    </svg>
  );
}

interface MergedRow {
  period: string;
  [appidKey: string]: string | number | null;
}

function mergeSeries(byAppid: Map<number, GameTrendPoint[]>): MergedRow[] {
  const periods = new Set<string>();
  for (const pts of byAppid.values()) for (const p of pts) periods.add(p.period);
  const sorted = [...periods].sort();
  return sorted.map((period) => {
    const row: MergedRow = { period };
    for (const [appid, pts] of byAppid) {
      row[`g${appid}`] = pts.find((p) => p.period === period)?.n_reviews ?? null;
    }
    return row;
  });
}

export function CompareTrendsChart({
  ids,
  names,
  hideLegend = false,
}: {
  ids: number[];
  names: Map<number, string>;
  /** Suppress the built-in below-chart legend when the caller already renders its own
   * (Compare.tsx puts the one legend inline with the panel title, per mockup 4d —
   * without this the page showed the same legend twice). */
  hideLegend?: boolean;
}) {
  const primary = ids[0] ?? null;
  const comps = ids.slice(1);
  const trendsQ = useGameTrendsWithComps(primary, comps);

  if (trendsQ.isLoading) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading trends…</div>;
  }
  if (trendsQ.isError || !trendsQ.data) {
    // `error.message` here is the raw exception: with the API unreachable this read
    // "Failed to load trends: Failed to fetch" (measured on production 2026-09-01).
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-2 text-center text-xs text-verdict-serious">
        <span>Couldn&apos;t load trends. {errorMessage(trendsQ.error)}</span>
        <RetryButton onClick={() => void trendsQ.refetch()} />
      </div>
    );
  }

  const byAppid = new Map<number, GameTrendPoint[]>();
  if (trendsQ.data.eligible && primary !== null) byAppid.set(primary, trendsQ.data.points);
  for (const s of trendsQ.data.comps?.series ?? []) byAppid.set(s.appid, s.points);
  // Keep the caller's column order (and its color slots) rather than response order.
  const chartIds = ids.filter((id) => byAppid.has(id));
  const data = mergeSeries(new Map(chartIds.map((id) => [id, byAppid.get(id)!])));

  if (chartIds.length === 0 || data.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
        No monthly trend data for these games yet.
      </div>
    );
  }

  const nameOf = (id: number) => names.get(id) ?? `App ${id}`;

  // One unit for the whole y-axis: the ticks are computed here (not left to recharts) so
  // the formatter is sized for exactly the values that will be printed — see
  // lib/format.ts axisScale. Before this the same axis printed "60.0K" above "120K".
  const peak = Math.max(
    0,
    ...data.flatMap((row) => chartIds.map((id) => (typeof row[`g${id}`] === "number" ? (row[`g${id}`] as number) : 0))),
  );
  const y = axisScale(peak, "count");

  // Markers are stamped on a sampled subset of points, not on all ~170 months: enough to
  // read the shape as a series, few enough that the line stays a line.
  const markerEvery = Math.max(1, Math.round(data.length / 9));

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="period"
            tick={{ fontSize: 10 }}
            interval="preserveStartEnd"
            minTickGap={24}
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
            cursor={{ stroke: "var(--gridline)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const row = payload[0].payload as MergedRow;
              const rows: TooltipRow[] = chartIds
                .filter((id) => row[`g${id}`] != null)
                .map((id, _i) => ({
                  label: nameOf(id),
                  value: fmtCompact(row[`g${id}`] as number),
                  color: compareSeriesColor(chartIds.indexOf(id)),
                }));
              return <TooltipPanel title={String(label)} rows={rows} />;
            }}
          />
          {chartIds.map((id, i) => {
            const s = compareSeries(i);
            return (
              <Line
                key={id}
                type="linear"
                dataKey={`g${id}`}
                stroke={s.color}
                strokeDasharray={s.dash}
                strokeWidth={1.5}
                connectNulls={false}
                isAnimationActive={false}
                dot={(props: { cx?: number; cy?: number; index?: number; value?: number | null }) => {
                  const { cx, cy, index } = props;
                  // A gap (null month) has no coordinates — draw nothing rather than a
                  // marker parked at the origin.
                  if (cx == null || cy == null || index == null || index % markerEvery !== 0) {
                    return <g key={`m${id}-${index}`} />;
                  }
                  return (
                    <path
                      key={`m${id}-${index}`}
                      data-testid={`compare-marker-${i}`}
                      d={seriesShapePath(s.shape, cx, cy, 3)}
                      fill={s.color}
                    />
                  );
                }}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
      {!hideLegend && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
          {chartIds.map((id, i) => (
            <span key={id} className="inline-flex items-center gap-1.5">
              {/* The key repeats all three channels the line uses — colour, dash pattern
                  AND marker — so two games are never told apart by colour alone. */}
              <SeriesKey style={compareSeries(i)} />
              {nameOf(id)}
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] italic text-ink-muted">
        Monthly SAMPLED review velocity (the reviews table is a per-game sample, recency-biased for older/popular
        titles) — relative shape and momentum are comparable; absolute counts undercount older hits. Months before a
        game's release are gaps, not zeros.
      </p>
    </div>
  );
}

export default CompareTrendsChart;
