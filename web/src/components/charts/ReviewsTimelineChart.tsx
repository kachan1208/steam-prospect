import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ReviewTimelinePoint } from "../../lib/api";
import { fmtCompact, fmtPct } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

/**
 * Two single-axis small multiples (same dual-axis-avoidance move as SaturationTrend)
 * rather than one combo chart: a trailing 3-month positive-rating trajectory (blue line
 * — "how is it landing, and is that changing") and sampled reviews per month (aqua bars
 * — "how much signal / velocity"). Different scales (a narrow %-band vs. a count), so
 * each gets its own axis instead of a second y-scale on one plot.
 *
 * The line deliberately charts trailing_positive_share, NOT cum_positive_share: an
 * all-time cumulative share mathematically converges as cum_reviews grows (each new
 * month's weight on the ratio shrinks), so for any game with real history it flattens to
 * a near-static plateau and reads as "this chart shows nothing" — the same failure mode
 * the launch curve had before LaunchShapeBars.tsx replaced it with a marginal/windowed
 * view. A bounded trailing window can rise AND fall, so genuine sentiment swings (a bad
 * patch, a content update, a review-bomb) are visible instead of averaged away.
 *
 * Y-domain is padded-to-data (not a fixed 0-100%): most titles sit in a fairly narrow
 * band (say 70-95% positive), and locking the axis to the full percentage range would
 * squash real movement into a thin sliver near the top — the same "shows nothing" bug
 * by another route. Padding is symmetric and clamped to valid [0,1], and the axis still
 * carries real tick labels, so this stays an honest read, not a misleading zoom.
 */
export function ReviewsTimelineChart({ points }: { points: ReviewTimelinePoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-ink-muted">
        Not enough sampled reviews to chart a timeline.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs text-ink-muted">Positive rating trend (trailing 3-month)</div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
              domain={[(min: number) => Math.max(0, min - 0.05), (max: number) => Math.min(1, max + 0.05)]}
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => fmtPct(v, 0)}
              tickLine={false}
              axisLine={false}
              width={36}
            />
            <Tooltip
              cursor={{ stroke: "var(--baseline)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as ReviewTimelinePoint;
                return (
                  <TooltipPanel
                    title={String(label)}
                    rows={[
                      { label: "Positive (trailing 3mo)", value: fmtPct(p.trailing_positive_share, 0), color: CSS_VAR.demand },
                      { label: "Reviews (trailing 3mo)", value: fmtCompact(p.trailing_reviews) },
                      { label: "Reviews this month", value: fmtCompact(p.n_reviews) },
                    ]}
                  />
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="trailing_positive_share"
              stroke={CSS_VAR.demand}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div className="mb-1 text-xs text-ink-muted">Sampled reviews per month</div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
              tickFormatter={(v: number) => fmtCompact(v)}
              tickLine={false}
              axisLine={false}
              width={40}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as ReviewTimelinePoint;
                return (
                  <TooltipPanel
                    title={String(label)}
                    rows={[
                      { label: "Reviews", value: fmtCompact(p.n_reviews), color: CSS_VAR.competition },
                      { label: "Positive", value: fmtCompact(p.n_positive) },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="n_reviews" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
