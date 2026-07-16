import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { BoxleiterRow } from "../../lib/api";
import { fmtCompact } from "../../lib/format";
import { CSS_VAR } from "../../lib/palette";
import { TooltipPanel } from "./TooltipPanel";

const REVIEW_CHECKPOINTS = [0, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];

/**
 * Explains the reviews -> owners conversion the /api/estimate endpoint actually
 * uses: a genre-fitted slope (clamped to the cited 20-55 owners/review band) for
 * the mid line, and the cited band itself as the aqua wash — same math, same
 * numbers, just visualized across a synthetic review axis.
 */
export function BoxleiterFitChart({
  genre,
  rows,
  min,
  max,
  height = 260,
}: {
  genre: string;
  rows: BoxleiterRow[];
  min: number;
  max: number;
  height?: number;
}) {
  const row = rows.find((r) => r.genre === genre) ?? rows.find((r) => r.genre === "__all__");
  const rawSlope = row?.slope ?? (min + max) / 2;
  const clampedSlope = Math.min(max, Math.max(min, rawSlope));

  const data = REVIEW_CHECKPOINTS.map((reviews) => ({
    reviews,
    low: reviews * min,
    band: reviews * max - reviews * min,
    mid: reviews * clampedSlope,
  }));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-[11px] text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3" style={{ backgroundColor: CSS_VAR.demand }} />
          Fitted owners — {genre === "__all__" ? "all genres" : genre} ({clampedSlope.toFixed(0)}/review)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3 rounded-sm" style={{ backgroundColor: CSS_VAR.competition, opacity: 0.3 }} />
          Cited range ({min}-{max}/review)
        </span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 20 }}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="reviews"
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => fmtCompact(v)}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
            label={{ value: "Reviews", position: "insideBottom", offset: -8, fontSize: 10, fill: "var(--text-muted)" }}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => fmtCompact(v)}
            tickLine={false}
            axisLine={false}
            width={44}
            // No rotated "Owners" axis title (see PressCoverageScatter's identical call for
            // its y-axis): at this width it collides with longer tick labels like "280.0K" —
            // the Card title ("Boxleiter: reviews -> owners"), the legend line above, and the
            // tooltip already say "owners" without it.
          />
          <Tooltip
            cursor={{ stroke: "var(--baseline)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload.find((entry) => entry.dataKey === "band")?.payload as
                | { reviews: number; low: number; band: number; mid: number }
                | undefined;
              if (!p) return null;
              return (
                <TooltipPanel
                  title={`${fmtCompact(Number(label))} reviews`}
                  rows={[
                    { label: "Fitted owners", value: fmtCompact(p.mid), color: CSS_VAR.demand },
                    { label: "Cited low", value: fmtCompact(p.low) },
                    { label: "Cited high", value: fmtCompact(p.low + p.band) },
                  ]}
                />
              );
            }}
          />
          <Area dataKey="low" stackId="band" stroke="none" fill="transparent" isAnimationActive={false} />
          <Area
            dataKey="band"
            stackId="band"
            stroke="none"
            fill={CSS_VAR.competition}
            fillOpacity={0.18}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="mid"
            stroke={CSS_VAR.demand}
            strokeWidth={2}
            dot={{ r: 4, fill: CSS_VAR.demand, strokeWidth: 2, stroke: "var(--surface-1)" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
