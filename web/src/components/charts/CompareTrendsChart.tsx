import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useGameTrendsWithComps, type GameTrendPoint } from "../../lib/api";
import { fmtAxisCompact, fmtCompact } from "../../lib/format";
import { MONO } from "../../lib/palette";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * Compare-page trends overlay: monthly sampled-review velocity, one line per compared
 * game. Fetched as ONE request — game 1 is the primary and the rest ride the trends
 * endpoint's ?comps= overlay (GET /api/games/{appid}/trends?comps=…). GameTrendsChart
 * doesn't speak `comps` (it draws a single game's two-panel small multiples), so this is
 * a purpose-built multi-series line using the house chart tokens: gridline/baseline vars,
 * TooltipPanel, neutral-ink legend labels with color only on the marks.
 *
 * Color is MONO STEEL, not categorical — a deliberate deviation from this file's old
 * fixed --series-N slot order, and the one place in the chart layer where a genuinely
 * multi-entity overlay (up to COMPARE_CAP games) still goes mono rather than categorical.
 * This isn't a judgment call so much as a direct read of the design handoff's own
 * mockup (Prospect Mockups.dc.html, #4d "Compare"): its three-game overlay chart is
 * drawn with exactly `var(--color-accent-300)`, `rgba(242,242,243,.75)`,
 * `rgba(242,242,243,.35)` — solid lines (no dashing), decreasing paper alpha by rank,
 * not per-game hue. The rationale reads the same as the D/C/Q bars: "3 of 4 slots" is
 * few enough, and consistently ordered enough (slot 1 is always the primary/pinned
 * game), that rank-by-recession communicates identity better than 4 arbitrary hues
 * would, and it keeps Compare visually consistent with every other mono chart on the
 * page rather than being the one categorical outlier. Slots past the mockup's three
 * aren't in the handoff — the compare cap is 6, so the extra tones are interpolated in
 * even steps between the two paper values the mockup DOES show (75% and 35%) rather
 * than invented from nothing.
 *
 * Review velocity is the only series deep enough to compare across months today (CCU/
 * player snapshots are typically a single current month — see GameTrendsChart's caveat),
 * which is why this chart draws n_reviews only. Months before a game existed are gaps
 * (connectNulls off), not zeros.
 */

// Mono steel ramp, rank order (1st = the pinned/primary game) — see module doc above.
// One distinct tone per COMPARE_CAP (6) slot: the ramp interpolates 10%-alpha steps
// between the mockup's own paper values (75% and 35%). Before this the array held 4 and
// wrapped with i % length, so a 5th compared game came out in the SAME accent as the
// primary — two different games, one color. Defensive modulo stays for safety, but every
// reachable slot now has its own tone.
const SERIES_VARS = [MONO.primary, MONO.paper75, MONO.paper65, MONO.paper55, MONO.paper45, MONO.paper35];

export function compareSeriesColor(i: number): string {
  return SERIES_VARS[i % SERIES_VARS.length];
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
    return (
      <div className="flex h-24 items-center justify-center text-xs text-verdict-serious">
        Failed to load trends{trendsQ.error instanceof Error ? `: ${trendsQ.error.message}` : "."}
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
            tickFormatter={(v: number) => fmtAxisCompact(v)}
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
          {chartIds.map((id, i) => (
            <Line
              key={id}
              type="linear"
              dataKey={`g${id}`}
              stroke={compareSeriesColor(i)}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {!hideLegend && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
          {chartIds.map((id, i) => (
            <span key={id} className="inline-flex items-center gap-1.5">
              {/* 14x2px line-key swatch (design handoff: "Legend swatches 14×2px"), matching
                  the #4d mockup's own inline legend markup exactly. */}
              <span className="h-0.5 w-3.5 shrink-0" style={{ backgroundColor: compareSeriesColor(i) }} />
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
