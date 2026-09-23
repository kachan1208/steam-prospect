import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { errorMessage, useGameTrendsWithComps, type GameTrendPoint } from "../../lib/api";
import { alignByLaunch, completeMonths, periodLabel } from "../../lib/compareTrends";
import { axisScale, fmtCompact } from "../../lib/format";
import type { LaunchAnchor } from "../../lib/lifecycle";
import { compareSeries, type CompareSeriesShape, type CompareSeriesStyle } from "../../lib/palette";
import { RetryButton } from "../ui/ErrorState";
import { useDragZoom } from "../../lib/useDragZoom";
import { SELECTION_AREA_PROPS, ZoomFrame } from "./ZoomFrame";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/** How the x-axis lines the games up. */
export type CompareAlign = "calendar" | "launch";

/**
 * Compare-page trends overlay: MONTHLY REVIEWS from Steam's own per-game review histogram —
 * each game's full history, uncapped, NOT our recency-biased review sample (this chart's
 * caption said "sampled … undercounts older hits" until 2026-09-23, which was never true of
 * this series: Hollow Knight's histogram holds 531,566 of its 562,038 reviews). One line per
 * compared game. Fetched as ONE request — game 1 is the primary and the rest ride the trends
 * endpoint's ?comps= overlay (GET /api/games/{appid}/trends?comps=…). The single-game
 * trends chart never spoke `comps` (and is gone since 2026-09-19), so this is
 * a purpose-built multi-series line using the house chart tokens: gridline/baseline vars,
 * TooltipPanel, neutral-ink legend labels with color only on the marks.
 *
 * TWO ALIGNMENTS (2026-09-23): the calendar (what happened when), or "since launch" — x =
 * months since each game's launch month (its first public date when the mart has one, else
 * its release date), so a 2017 hit and a 2024 hit compare launch-for-launch, which is the
 * question mockup 4d's "first 12 weeks" panel was really asking.
 *
 * The data's current month is left out: it is only partly over, so every line dived at the
 * right edge — a "collapse" that was just the calendar.
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
 * player snapshots are typically a single current month),
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

/** One chart row. `x` is the category the axis draws: a 'YYYY-MM' period on the calendar,
 * months-since-launch when aligned by launch. `g{id}` = reviews, `p{id}` = the period the
 * value came from (the launch-aligned tooltip names it). */
interface MergedRow {
  x: string | number;
  [appidKey: string]: string | number | null;
}

function mergeSeries(byAppid: Map<number, GameTrendPoint[]>): MergedRow[] {
  const periods = new Set<string>();
  for (const pts of byAppid.values()) for (const p of pts) periods.add(p.period);
  const sorted = [...periods].sort();
  return sorted.map((period) => {
    const row: MergedRow = { x: period };
    for (const [appid, pts] of byAppid) {
      row[`g${appid}`] = pts.find((p) => p.period === period)?.n_reviews ?? null;
      row[`p${appid}`] = period;
    }
    return row;
  });
}

function offsetTitle(offset: number): string {
  if (offset === 0) return "Launch month";
  if (offset > 0) return `Month ${offset} after launch`;
  return `${-offset} month${offset === -1 ? "" : "s"} before launch`;
}

export function CompareTrendsChart({
  ids,
  names,
  hideLegend = false,
  align = "calendar",
  anchors,
  partialPeriod = null,
}: {
  ids: number[];
  names: Map<number, string>;
  /** Suppress the built-in below-chart legend when the caller already renders its own
   * (Compare.tsx puts the one legend inline with the panel title, per mockup 4d —
   * without this the page showed the same legend twice). */
  hideLegend?: boolean;
  /** Line the games up on the calendar (default) or on months since each one's launch. */
  align?: CompareAlign;
  /** Each game's launch anchor (lib/lifecycle launchAnchor) — required for align="launch". */
  anchors?: Map<number, LaunchAnchor | null>;
  /** The data's still-running month ('YYYY-MM'), left out of every line. */
  partialPeriod?: string | null;
}) {
  const primary = ids[0] ?? null;
  const comps = ids.slice(1);
  const trendsQ = useGameTrendsWithComps(primary, comps);

  // Derived ABOVE the early returns so useDragZoom below runs on every render — a hook
  // after a conditional return changes hook order between the loading and loaded frames.
  // Pure map/filter work; on a loading render the inputs are simply absent.
  const byAppid = new Map<number, GameTrendPoint[]>();
  if (trendsQ.data?.eligible && primary !== null) byAppid.set(primary, completeMonths(trendsQ.data.points, partialPeriod));
  for (const s of trendsQ.data?.comps?.series ?? []) byAppid.set(s.appid, completeMonths(s.points, partialPeriod));
  // Keep the caller's column order (and its color slots) rather than response order.
  const seriesIds = ids.filter((id) => byAppid.has(id));
  const launch = align === "launch";
  // Aligned by launch, a game with no usable launch date has no x to sit on: left out, and
  // named under the chart.
  const unanchored = launch ? seriesIds.filter((id) => !anchors?.get(id)) : [];
  const chartIds = seriesIds.filter((id) => !unanchored.includes(id));
  const series = new Map(chartIds.map((id) => [id, byAppid.get(id)!]));
  const data: MergedRow[] = launch
    ? alignByLaunch(series, anchors ?? new Map()).map(({ offset, ...rest }) => ({ ...rest, x: offset }))
    : mergeSeries(series);
  // Launch-aligned x values are month offsets, not dates, so the page's shared date window
  // cannot apply to them — useDragZoom passes rows without a date straight through.
  const zoom = useDragZoom(data, "x");

  if (trendsQ.isLoading) {
    // The loaded chart's own height (220px plot + a caption line), so nothing below jumps
    // when it arrives.
    return <div className="flex h-[244px] items-center justify-center text-xs text-ink-muted">Loading trends…</div>;
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

  if (chartIds.length === 0 || data.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
        {launch && unanchored.length > 0
          ? "None of these games has a launch date to line them up on."
          : "No monthly trend data for these games yet."}
      </div>
    );
  }

  const nameOf = (id: number) => names.get(id) ?? `App ${id}`;
  // Aligned on a release date, reviews BEFORE month 0 mean the game was on sale earlier
  // (Early Access) and the mart doesn't carry its first public date yet — say which games.
  const earlyStarters = launch
    ? chartIds.filter(
        (id) => anchors?.get(id)?.source === "release" && data.some((r) => Number(r.x) < 0 && r[`g${id}`] != null),
      )
    : [];

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
      <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={zoom.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="x"
            tick={{ fontSize: 10 }}
            interval="preserveStartEnd"
            minTickGap={24}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
          />
          {launch && (
            <ReferenceLine
              x={0}
              stroke="var(--text-muted)"
              strokeDasharray="3 4"
              label={{ value: "launch", position: "insideTopLeft", fontSize: 9, fill: "var(--text-muted)" }}
            />
          )}
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
                .map((id) => ({
                  label: nameOf(id),
                  // Aligned by launch, the same x is a different calendar month per game.
                  value: launch
                    ? `${fmtCompact(row[`g${id}`] as number)} · ${periodLabel(String(row[`p${id}`]))}`
                    : fmtCompact(row[`g${id}`] as number),
                  color: compareSeriesColor(chartIds.indexOf(id)),
                }));
              return (
                <TooltipPanel
                  title={launch ? offsetTitle(Number(label)) : periodLabel(String(label))}
                  rows={rows}
                />
              );
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
          {zoom.selection && (
            <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />
          )}
          </LineChart>
        </ResponsiveContainer>
      </ZoomFrame>
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
      <p className="mt-2 text-[11px] text-ink-muted">
        {launch
          ? "X = months since each game's launch month (0 = the month it went on sale: its first public date when we have it, else its release date). "
          : null}
        Reviews per month from Steam&apos;s own review histogram — each game&apos;s full history, not a sample.
        Months before a game was on sale are gaps, not zeros
        {partialPeriod ? `; ${periodLabel(partialPeriod)} is still running, so it isn't drawn` : ""}.
      </p>
      {unanchored.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-muted">
          Not drawn: {unanchored.map(nameOf).join(", ")} — no release date to line up on.
        </p>
      )}
      {earlyStarters.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-muted">
          Reviews before month 0: {earlyStarters.map(nameOf).join(", ")} sold before{" "}
          {earlyStarters.length === 1 ? "its" : "their"} release date (Early Access) — aligned on the 1.0 release
          until the data carries a first public date.
        </p>
      )}
    </div>
  );
}

export default CompareTrendsChart;
