import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { LaunchCurvePoint } from "../../lib/api";
import { axisScale } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * Windows after launch. We difference the cumulative median curve into the share landing in
 * each window — a marginal view that shows launch shape, unlike a cumulative line that always
 * climbs to 100% and looks identical for every genre.
 *
 * PER WEEK, NOT PER WINDOW (2026-09-23). The windows run from one week ("1w") to 185 days
 * ("7–12m"), and they used to be drawn as equal bars of their RAW share. That painted every
 * genre the same U: the 7–12m bar held ~20% of first-year reviews and stood two-thirds as tall
 * as week one — but it took 26 weeks to collect them, 0.76% a week against week one's 28%.
 * The U was the window widths, not the market. Each bar is now the window's share divided by
 * its length in weeks — the average weekly pace — so equal heights mean equal pace and the
 * chart shows what actually happens: a steep fall from launch week.
 */
export const LAUNCH_WINDOWS: readonly { label: string; long: string; from: number; to: number }[] = [
  { label: "1w", long: "week 1", from: 0, to: 7 },
  { label: "2w", long: "week 2", from: 7, to: 14 },
  { label: "3–4w", long: "weeks 3–4", from: 14, to: 30 },
  { label: "2m", long: "month 2", from: 30, to: 60 },
  { label: "3m", long: "month 3", from: 60, to: 90 },
  { label: "4–6m", long: "months 4–6", from: 90, to: 180 },
  { label: "7–12m", long: "months 7–12", from: 180, to: 365 },
];

/** Week-one pace at or above this multiple of the months-7–12 pace reads "front-loaded". */
export const FRONT_LOADED_RATIO = 5;

export interface LaunchWindowShare {
  label: string;
  long: string;
  from: number;
  to: number;
  /** Window length in weeks (days ÷ 7). */
  weeks: number;
  /** Share of first-year reviews landing in the window, 0–100; null when the curve lacks an end. */
  share: number | null;
  /** share ÷ weeks — the bar's height, % of first-year reviews per week; null when unknown. */
  perWeek: number | null;
}

/** The seven windows with their raw share and weekly pace, off the median cumulative curve. */
export function launchWindows(points: readonly LaunchCurvePoint[]): LaunchWindowShare[] {
  const cum = (d: number): number | null =>
    d === 0 ? 0 : points.find((p) => p.day === d)?.median_cum_fraction ?? null;
  return LAUNCH_WINDOWS.map((w) => {
    const a = cum(w.from);
    const b = cum(w.to);
    const weeks = (w.to - w.from) / 7;
    const share = a != null && b != null ? Math.max(0, (b - a) * 100) : null;
    return { ...w, weeks, share, perWeek: share === null ? null : share / weeks };
  });
}

/** "30%" from 10 up, "8.5%" / "0.7%" below — the bar labels and the headline share one form. */
export function fmtShare(v: number): string {
  return v >= 9.95 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
}

export interface LaunchShapeSummary {
  firstWeek: LaunchWindowShare;
  lastWindow: LaunchWindowShare;
  /** Week-one pace ÷ months-7–12 pace. */
  ratio: number;
  /** Cumulative share by day 30, 0–100 (null when the curve has no day-30 point). */
  byDay30: number | null;
  frontLoaded: boolean;
  /** The plain takeaway, bearish reading first. */
  headline: string;
  /** The weekly-pace arithmetic with these numbers, for an ⓘ. */
  worked: string;
}

/**
 * The takeaway headline for a launch curve — how much faster week one runs than months 7–12,
 * and what that means for a launch, bearish reading first — or null when the curve lacks
 * either end. `genre` names the population ("a typical Action game"); omit it for the
 * catalog-wide curve.
 */
export function launchShapeSummary(points: readonly LaunchCurvePoint[], genre?: string | null): LaunchShapeSummary | null {
  const windows = launchWindows(points);
  const firstWeek = windows[0];
  const lastWindow = windows[windows.length - 1];
  if (firstWeek.perWeek === null || lastWindow.perWeek === null || lastWindow.perWeek <= 0) return null;
  const ratio = firstWeek.perWeek / lastWindow.perWeek;
  const d30 = points.find((p) => p.day === 30)?.median_cum_fraction;
  const byDay30 = typeof d30 === "number" ? d30 * 100 : null;
  const frontLoaded = ratio >= FRONT_LOADED_RATIO;
  const subject = genre ? `a typical ${genre} game` : "a typical game";
  const times = `${ratio >= 9.95 ? Math.round(ratio) : ratio.toFixed(1)}×`;
  const w1 = fmtShare(firstWeek.share as number);
  const late = fmtShare(lastWindow.perWeek);
  const headline = frontLoaded
    ? `Front-loaded: ${subject} collects ${w1} of its first-year reviews in week 1 alone, then ${late} a week in months 7–12 — a ${times} slower pace.` +
      (byDay30 !== null ? ` ${Math.round(byDay30)}% have landed by day 30,` : "") +
      `${byDay30 !== null ? " so" : " So"} a weak launch week is hard to make up later.`
    : `Slow burn: ${subject} collects ${w1} of its first-year reviews in week 1 and still ${late} a week in months 7–12 — only ${times} apart, so updates and marketing keep paying all year.`;
  const worked =
    `week 1: ${w1} ÷ 1 week = ${fmtShare(firstWeek.perWeek)}/week; ` +
    `months 7–12: ${fmtShare(lastWindow.share as number)} ÷ ${lastWindow.weeks.toFixed(1)} weeks = ${late}/week; ` +
    `${fmtShare(firstWeek.perWeek)} ÷ ${late} = ${times}` +
    (byDay30 !== null ? `; by day 30: ${Math.round(byDay30)}%` : "");
  return { firstWeek, lastWindow, ratio, byDay30, frontLoaded, headline, worked };
}

const Y_AXIS_WIDTH = 34;
const MARGIN_RIGHT = 8;
/** Room above the tallest bar for its value label. */
const MARGIN_TOP = 16;

/**
 * Below this container width the seven `interval={0}` ticks stop fitting on one row (A10).
 * Measured on production 2026-09-01: at a 274px container (/timing @390) the gap between
 * "4–6m" and "7–12m" is 1px, so they read as one word — `4–6m7–12m`. At 292px (/timing
 * @1440, where these lay out four to a row) it is 3px, no better; at 417px (/timing @1024)
 * it is 21px and the axis is fine. The widest label is "7–12m" at 34–35px in the 11px axis
 * font index.css pins, and it needs ~8px of clearance, so a band must be ≥43px:
 * 43 × 7 windows + the 34px Y axis + the 8px right margin = 343.
 */
const ONE_ROW_MIN_WIDTH = 43 * LAUNCH_WINDOWS.length + Y_AXIS_WIDTH + MARGIN_RIGHT;

/** Exported so the test can pin those three measured widths to the right verdict. */
export function needsStaggeredAxis(containerWidth: number): boolean {
  return containerWidth > 0 && containerWidth < ONE_ROW_MIN_WIDTH;
}

/** Every other label drops to a second row, which doubles the horizontal room each one
 * gets. Staggering keeps all seven labels AND keeps them horizontal — dropping ticks or
 * rotating them would trade one unreadable axis for another. */
export function StaggeredTick({ x, y, payload, index }: { x?: number; y?: number; payload?: { value: string }; index?: number }) {
  return (
    // Keeps recharts' own tick class so index.css's `.recharts-cartesian-axis-tick text`
    // ink/size still applies and the ticks stay selectable the way they are everywhere else.
    <text className="recharts-cartesian-axis-tick-value" x={x} y={y} dy={(index ?? 0) % 2 === 0 ? 11 : 23} textAnchor="middle">
      {payload?.value}
    </text>
  );
}

/**
 * The launch-shape bars: each window's share of first-year reviews PER WEEK (see the module
 * note). Props are unchanged from the raw-share version, so /timing's small multiples pick up
 * the per-week reading without a change on their side.
 */
export function LaunchShapeBars({ points, height = 200 }: { points: LaunchCurvePoint[]; height?: number }) {
  const data = launchWindows(points);

  // Percent axis through the shared scale, like every other chart on /timing: these minis
  // printed "32%" beside big charts printing "20.0%" on the same page. The unit (per week)
  // is named in the caption above the plot, not in the ticks, so the tick vocabulary stays
  // the page's.
  const y = axisScale(Math.max(0, ...data.map((d) => d.perWeek ?? 0)), "pct", 4);

  // The chart is sized by its CONTAINER, not by the viewport: /timing lays these out four
  // to a row at 1440, which is narrower (292px) than the single column at 1024 (417px). So
  // the axis has to react to its own measured width, never to a breakpoint.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const stagger = needsStaggeredAxis(width);
  const missing = data.filter((d) => d.perWeek === null);

  return (
    <div ref={wrapRef}>
      <div className="mb-1 text-[10px] text-ink-muted" data-testid="launch-shape-unit">
        % of first-year reviews per week, by window after launch
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: MARGIN_TOP, right: MARGIN_RIGHT, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          {/* A staggered axis needs a taller band for its second row, or the lower labels
              are clipped by the chart's own bottom edge. */}
          <XAxis
            dataKey="label"
            tick={stagger ? <StaggeredTick /> : { fontSize: 10 }}
            height={stagger ? 42 : 30}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
            interval={0}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            ticks={y.ticks}
            interval={0}
            domain={y.domain}
            tickFormatter={(v: number) => y.format(v)}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_WIDTH}
          />
          <Tooltip
            cursor={{ fill: "var(--gridline)", opacity: 0.4 }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as LaunchWindowShare;
              return (
                <TooltipPanel
                  title={`${p.long.charAt(0).toUpperCase()}${p.long.slice(1)} after launch`}
                  rows={
                    p.share === null || p.perWeek === null
                      ? [{ label: "Share of first-year reviews", value: "not in this curve" }]
                      : [
                          { label: "Per week", value: `${fmtShare(p.perWeek)}`, color: CSS_VAR.demand },
                          {
                            label: "Whole window",
                            value: `${fmtShare(p.share)} over ${p.weeks < 1.95 ? `${p.weeks.toFixed(0)} week` : `${p.weeks.toFixed(1)} weeks`}`,
                          },
                        ]
                  }
                />
              );
            }}
          />
          <Bar dataKey="perWeek" fill={CSS_VAR.demand} radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false}>
            {/* The small late-window bars are a few px tall on a week-one scale; their value
                rides on top so a 0.7% bar is read as 0.7%, not as nothing. */}
            <LabelList
              dataKey="perWeek"
              position="top"
              offset={4}
              className="launch-shape-value"
              formatter={(v: number | null) => (typeof v === "number" ? fmtShare(v) : "")}
              style={{ fontSize: 9, fill: "var(--text-secondary)" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {missing.length > 0 && (
        <div className="mt-1 text-[10px] text-ink-muted">
          No reading for {missing.map((m) => m.label).join(", ")} — the curve has no point at that window's edge.
        </div>
      )}
    </div>
  );
}
