import { useEffect, useRef, useState } from "react";
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

const Y_AXIS_WIDTH = 34;
const MARGIN_RIGHT = 8;

/**
 * Below this container width the seven `interval={0}` ticks stop fitting on one row (A10).
 * Measured on production 2026-09-01: at a 274px container (/timing @390) the gap between
 * "4–6m" and "7–12m" is 1px, so they read as one word — `4–6m7–12m`. At 292px (/timing
 * @1440, where these lay out four to a row) it is 3px, no better; at 417px (/timing @1024)
 * it is 21px and the axis is fine. The widest label is "7–12m" at 34–35px in the 11px axis
 * font index.css pins, and it needs ~8px of clearance, so a band must be ≥43px:
 * 43 × 7 windows + the 34px Y axis + the 8px right margin = 343.
 */
const ONE_ROW_MIN_WIDTH = 43 * WINDOWS.length + Y_AXIS_WIDTH + MARGIN_RIGHT;

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

export function LaunchShapeBars({ points, height = 200 }: { points: LaunchCurvePoint[]; height?: number }) {
  const cum = (d: number): number | null =>
    d === 0 ? 0 : points.find((p) => p.day === d)?.median_cum_fraction ?? null;

  const data = WINDOWS.map((w) => {
    const a = cum(w.from);
    const b = cum(w.to);
    return { label: w.label, share: a != null && b != null ? Math.max(0, (b - a) * 100) : 0 };
  });

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

  return (
    <div ref={wrapRef}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: MARGIN_RIGHT, left: 0, bottom: 0 }}>
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
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_WIDTH}
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
    </div>
  );
}
