import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useGameTrendsWithComps, type GameTrendPoint } from "../../lib/api";
import { fmtCompact } from "../../lib/format";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * Compare-page trends overlay: monthly sampled-review velocity, one line per compared
 * game. Fetched as ONE request — game 1 is the primary and the rest ride the trends
 * endpoint's ?comps= overlay (GET /api/games/{appid}/trends?comps=…). GameTrendsChart
 * doesn't speak `comps` (it draws a single game's two-panel small multiples), so this is
 * a purpose-built multi-series line using the house chart tokens: categorical series
 * colors in fixed slot order (var(--series-N)), gridline/baseline vars, TooltipPanel,
 * neutral-ink legend labels with color only on the marks (dataviz conventions shared by
 * the other components/charts).
 *
 * Review velocity is the only series deep enough to compare across months today (CCU/
 * Twitch snapshots are typically a single current month — see GameTrendsChart's caveat),
 * which is why this chart draws n_reviews only. Months before a game existed are gaps
 * (connectNulls off), not zeros.
 */

// Fixed categorical slot order — supports up to the compare cap of 6 series.
const SERIES_VARS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
];

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

export function CompareTrendsChart({ ids, names }: { ids: number[]; names: Map<number, string> }) {
  const primary = ids[0] ?? null;
  const comps = ids.slice(1);
  const trendsQ = useGameTrendsWithComps(primary, comps);

  if (trendsQ.isLoading) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading trends…</div>;
  }
  if (trendsQ.isError || !trendsQ.data) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-status-serious">
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
            tickFormatter={(v: number) => fmtCompact(v)}
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
              type="monotone"
              dataKey={`g${id}`}
              stroke={compareSeriesColor(i)}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
        {chartIds.map((id, i) => (
          <span key={id} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: compareSeriesColor(i) }} />
            {nameOf(id)}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[11px] italic text-ink-muted">
        Monthly SAMPLED review velocity (the reviews table is a per-game sample, recency-biased for older/popular
        titles) — relative shape and momentum are comparable; absolute counts undercount older hits. Months before a
        game's release are gaps, not zeros.
      </p>
    </div>
  );
}

export default CompareTrendsChart;
