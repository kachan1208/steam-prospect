import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  errorMessage,
  gamePlayersQueryOptions,
  gameTrendsQueryOptions,
  type GamePlayersMonthlyPoint,
  type GamePlayersPoint,
  type GamePlayersResponse,
  type GameTrendPoint,
} from "../../lib/api";
import { fillMonthlyGaps, fmtDay, fmtMonth, partialMonth } from "../../lib/dates";
import { axisScale, fmtAxisCompact, fmtCompact, fmtInt } from "../../lib/format";
import { fmtTrendPct, playersTrendRead } from "../../lib/gameEstimates";
import { CSS_VAR } from "../../lib/palette";
import { RetryButton } from "../ui/ErrorState";
import { BulletMeter } from "../ui/Meter";
import { useDragZoom } from "../../lib/useDragZoom";
import { HatchDefs, partialBarLabel, partialNote, useHatchId } from "./partialMonth";
import { SELECTION_AREA_PROPS, ZoomFrame } from "./ZoomFrame";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * Click-through drilldown for the game page's Estimates panel: GameProfile.tsx keeps "which
 * row is selected" as its own state and renders this underneath, passing the metric key plus
 * the few profile fields each view needs. It self-fetches GET /api/games/{appid}/trends
 * through the shared query factory (["game-trends", appid]).
 *
 *   reviews      cumulative sum of n_reviews (Steam's full-history monthly review counts from
 *                its store review graph) beside the monthly count.
 *   live_players the daily capture series, the steamcharts monthly history, and the 7-day
 *                trend read against the whole of Steam when the mart serves it.
 *
 * NO OWNERS OR REVENUE CHARTS (2026-09-23). They were the reviews curve × a constant — the
 * owners-per-review ratio, then × the launch price — so the page drew the same shape three
 * times under three names. Est. revenue and Est. units now say so in the Estimates panel and
 * the reviews drilldown carries the one real curve.
 *
 * The month still being counted is hatched and labelled "partial" on the monthly bars, and a
 * partial month's point on the steamcharts history is drawn hollow (lib/dates partialMonth —
 * the data's as-of month, pass `asOf`).
 */
export type DrilldownMetric = "reviews" | "live_players";

export const DRILLDOWN_META: Record<DrilldownMetric, { title: string; subtitle: string }> = {
  reviews: {
    title: "Reviews — growth over time",
    subtitle:
      "Cumulative reviews by month, with the monthly count beside it. Est. revenue and Est. units are this same curve × 30 (× the launch price), so they have no chart of their own.",
  },
  live_players: {
    title: "Players now — over time",
    subtitle: "One capture a day (a point sample, not the day's peak), plus the monthly history where steamcharts has it.",
  },
};

export interface DrilldownProfile {
  total_reviews: number | null;
  live_players: number | null;
}

interface SeriesPoint {
  period: string;
  monthly: number | null;
  cumulative: number | null;
}

const XAXIS_PROPS = {
  dataKey: "period",
  tick: { fontSize: 10 },
  tickFormatter: (v: string) => fmtMonth(v) ?? v,
  interval: "preserveStartEnd" as const,
  minTickGap: 24,
  tickLine: false,
  axisLine: { stroke: "var(--baseline)" },
};

/** Running total of `pick(point)` per charted month, with skipped months filled as zero so
 * the axis spaces months evenly. */
function cumulativeFrom(points: GameTrendPoint[], pick: (p: GameTrendPoint) => number): SeriesPoint[] {
  const filled = fillMonthlyGaps(points, (period) => ({ period, n_reviews: 0, ccu_avg: null }));
  let running = 0;
  return filled.map((p) => {
    const v = pick(p);
    running += v;
    return { period: p.period, monthly: v, cumulative: running };
  });
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="flex h-24 items-center justify-center text-center text-xs text-ink-muted">{children}</div>;
}

/** "Cumulative growth curve (filled area) + monthly bars" — two single-axis small multiples
 * (own scale each) rather than one combo chart: a running total and its own monthly delta
 * share a unit but not a legible scale. */
function GrowthPanels({
  data,
  cumulativeLabel,
  monthlyLabel,
  color,
  asOf,
}: {
  data: SeriesPoint[];
  cumulativeLabel: string;
  monthlyLabel: string;
  color: string;
  asOf?: Date | null;
}) {
  // One range across both panels: they are the cumulative and monthly views of the same
  // months, so zooming one and not the other would put two different windows side by side.
  const zoom = useDragZoom(data, "period");
  const hatchId = useHatchId("drill-hatch");
  const partial = partialMonth(data[data.length - 1]?.period, asOf);
  const periods = zoom.data.map((d) => d.period);
  // One unit per axis ("0 / 80K / 160K", never "80.0K" beside "320K" or "9,000" beside
  // "18.0K") — lib/format axisScale, sized to the visible rows.
  const cumAxis = axisScale(Math.max(1, ...zoom.data.map((d) => d.cumulative ?? 0)), "count");
  const monthAxis = axisScale(Math.max(1, ...zoom.data.map((d) => d.monthly ?? 0)), "count");
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs text-ink-muted">{cumulativeLabel}</div>
        <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
          <ResponsiveContainer width="100%" height={168}>
            <AreaChart data={zoom.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis {...XAXIS_PROPS} />
              <YAxis
                tick={{ fontSize: 10 }}
                ticks={cumAxis.ticks}
                interval={0}
                domain={cumAxis.domain}
                tickFormatter={(v: number) => cumAxis.format(v)}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ stroke: "var(--baseline)" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as SeriesPoint;
                  return (
                    <TooltipPanel
                      title={fmtMonth(String(label)) ?? String(label)}
                      rows={[{ label: cumulativeLabel, value: p.cumulative != null ? fmtCompact(p.cumulative) : "—", color }]}
                    />
                  );
                }}
              />
              <Area
                type="linear"
                dataKey="cumulative"
                stroke={color}
                strokeWidth={1.5}
                fill={color}
                fillOpacity={0.14}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              {zoom.selection && <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />}
            </AreaChart>
          </ResponsiveContainer>
        </ZoomFrame>
      </div>
      <div>
        <div className="mb-1 text-xs text-ink-muted">{monthlyLabel}</div>
        <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
          <ResponsiveContainer width="100%" height={168}>
            <BarChart data={zoom.data} margin={{ top: 14, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
              <HatchDefs id={hatchId} color={color} />
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis {...XAXIS_PROPS} />
              <YAxis
                tick={{ fontSize: 10 }}
                ticks={monthAxis.ticks}
                interval={0}
                domain={monthAxis.domain}
                tickFormatter={(v: number) => monthAxis.format(v)}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as SeriesPoint;
                  const rows: TooltipRow[] = [
                    { label: monthlyLabel, value: p.monthly != null ? fmtCompact(p.monthly) : "—", color },
                  ];
                  if (p.period === partial) rows.push({ label: "Note", value: partialNote(asOf) });
                  return <TooltipPanel title={fmtMonth(String(label)) ?? String(label)} rows={rows} />;
                }}
              />
              <Bar dataKey="monthly" fill={color} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false}>
                {zoom.data.map((d) => (
                  <Cell
                    key={d.period}
                    fill={d.period === partial ? `url(#${hatchId})` : color}
                    stroke={d.period === partial ? color : undefined}
                    strokeDasharray={d.period === partial ? "2 2" : undefined}
                  />
                ))}
                <LabelList dataKey="monthly" content={partialBarLabel(periods, partial)} />
              </Bar>
              {zoom.selection && <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />}
            </BarChart>
          </ResponsiveContainer>
        </ZoomFrame>
      </div>
    </div>
  );
}

function ThinDataNote({ thin }: { thin: boolean }) {
  if (!thin) return null;
  return <> Only a few months so far — the series fills in as more accumulate.</>;
}

function ReviewsDrilldown({
  points,
  totalReviews,
  thin,
  asOf,
}: {
  points: GameTrendPoint[];
  totalReviews: number | null;
  thin: boolean;
  asOf?: Date | null;
}) {
  const series = cumulativeFrom(points, (p) => p.n_reviews);
  const lastCum = series[series.length - 1]?.cumulative ?? 0;
  const partial = partialMonth(series[series.length - 1]?.period, asOf);
  return (
    <div className="flex flex-col gap-4">
      <GrowthPanels
        data={series}
        cumulativeLabel="Cumulative reviews"
        monthlyLabel="Reviews added / month"
        color={CSS_VAR.competition}
        asOf={asOf}
      />
      <p className="text-[11px] italic text-ink-muted">
        From Steam's full-history review graph — monthly review counts over the game's whole life. This chart covers{" "}
        {fmtInt(lastCum)} review{lastCum === 1 ? "" : "s"} across {series.length} month{series.length === 1 ? "" : "s"}
        {totalReviews != null ? `, vs. ${fmtInt(totalReviews)} Steam reports in total (the small gap is reviews since removed or not yet bucketed)` : ""}.
        {partial && <> {fmtMonth(partial)} is a {partialNote(asOf)}.</>}
        <ThinDataNote thin={thin} />
      </p>
    </div>
  );
}

/** A monthly-history point, drawn hollow when its month is still being counted. */
function monthlyDot(partial: string | null, color: string) {
  return function MonthlyDot(props: { cx?: number; cy?: number; index?: number; payload?: GamePlayersMonthlyPoint }) {
    const { cx, cy, index, payload } = props;
    if (cx == null || cy == null || !payload || payload.month.slice(0, 7) !== partial) return <g key={`md-${index}`} />;
    return (
      <g key={`md-${index}`}>
        <circle cx={cx} cy={cy} r={3.5} fill="var(--surface-1)" stroke={color} strokeWidth={1.5} strokeDasharray="2 1.5" />
        <text x={cx} y={cy - 7} textAnchor="end" className="partial-month-label" style={{ fontSize: 9, fill: "var(--text-muted)" }}>
          partial
        </text>
      </g>
    );
  };
}

/** The monthly-average fallback's dots: solid, and hollow for the month still being counted. */
function ccuDot(partial: string | null) {
  return function CcuDot(props: { cx?: number; cy?: number; index?: number; payload?: GameTrendPoint }) {
    const { cx, cy, index, payload } = props;
    if (cx == null || cy == null || !payload || payload.ccu_avg == null) return <g key={`cd-${index}`} />;
    const isPartial = payload.period === partial;
    return (
      <circle
        key={`cd-${index}`}
        cx={cx}
        cy={cy}
        r={3}
        fill={isPartial ? "var(--surface-1)" : CSS_VAR.demand}
        stroke={CSS_VAR.demand}
        strokeWidth={isPartial ? 1.5 : 0}
        strokeDasharray={isPartial ? "2 1.5" : undefined}
      />
    );
  };
}

function LivePlayersDrilldown({
  points,
  daily,
  livePlayers,
  thin,
  asOf,
}: {
  points: GameTrendPoint[];
  daily: GamePlayersResponse | null;
  livePlayers: number | null;
  thin: boolean;
  asOf?: Date | null;
}) {
  const hasCcu = points.some((p) => p.ccu_avg != null);
  const splitMax = Math.max(livePlayers ?? 0, 1);
  const noSplitSnapshot = livePlayers == null;
  // Daily point samples when the mart carries them (mart_game_players_daily); otherwise the
  // monthly ccu_avg fallback so older marts still show something.
  const dailyPoints = daily?.available ? daily.points : [];
  const useDaily = dailyPoints.length > 0;
  const summary = daily?.summary ?? null;
  const trend = playersTrendRead({
    players_trend_7d_pct: summary?.players_trend_7d_pct,
    players_trend_7d_market_pct: summary?.players_trend_7d_market_pct,
    players_trend_7d_rel_pct: summary?.players_trend_7d_rel_pct,
  });
  const trendPct = summary?.players_trend_7d_pct ?? null;
  // The panel swaps between a daily series and a monthly fallback with different x keys, so
  // each alternative carries its own range; both hooks run every render.
  const dailyZoom = useDragZoom(dailyPoints, "date");
  const ccuMonthZoom = useDragZoom(points, "period");
  const monthly = daily?.monthly ?? [];
  const monthlyZoom = useDragZoom(monthly, "month");
  const monthlyPartial = partialMonth(monthly[monthly.length - 1]?.month.slice(0, 7), asOf);
  const ccuPartial = partialMonth(points[points.length - 1]?.period, asOf);
  const seriesAsOf = daily?.data_as_of ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-ink-muted">
            {useDaily ? "Players at each daily capture" : "Players (monthly average of captures)"}
          </div>
          <ResponsiveContainer width="100%" height={168}>
            {useDaily ? (
              <LineChart data={dailyZoom.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} {...dailyZoom.handlers}>
                <CartesianGrid stroke="var(--gridline)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: string) => (fmtDay(v) ?? v).replace(/, \d{4}$/, "")}
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
                />
                <Tooltip
                  cursor={{ stroke: "var(--baseline)" }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const p = payload[0].payload as GamePlayersPoint;
                    return (
                      <TooltipPanel
                        title={fmtDay(String(label)) ?? String(label)}
                        rows={[{ label: "Players (capture)", value: fmtCompact(p.players), color: CSS_VAR.demand }]}
                      />
                    );
                  }}
                />
                {/* Measured days only — unmeasured days simply aren't in the data, so the
                    line spans the real samples without fabricating zeros between them. */}
                <Line
                  type="linear"
                  dataKey="players"
                  stroke={CSS_VAR.demand}
                  strokeWidth={1.5}
                  dot={dailyPoints.length <= 45 ? { r: 2.5, fill: CSS_VAR.demand, strokeWidth: 0 } : false}
                  isAnimationActive={false}
                />
                {dailyZoom.selection && (
                  <ReferenceArea x1={dailyZoom.selection.x1} x2={dailyZoom.selection.x2} {...SELECTION_AREA_PROPS} />
                )}
              </LineChart>
            ) : (
              <LineChart data={ccuMonthZoom.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} {...ccuMonthZoom.handlers}>
                <CartesianGrid stroke="var(--gridline)" vertical={false} />
                <XAxis {...XAXIS_PROPS} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => fmtAxisCompact(v)}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip
                  cursor={{ stroke: "var(--baseline)" }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const p = payload[0].payload as GameTrendPoint;
                    return (
                      <TooltipPanel
                        title={fmtMonth(String(label)) ?? String(label)}
                        rows={[
                          {
                            label: "Players (monthly average)",
                            value: p.ccu_avg != null ? fmtCompact(p.ccu_avg) : "no capture",
                            color: CSS_VAR.demand,
                          },
                        ]}
                      />
                    );
                  }}
                />
                {/* No connectNulls: a month with no capture is a genuine gap in monitoring,
                    not zero players, so the line breaks there instead of interpolating. */}
                <Line
                  type="linear"
                  dataKey="ccu_avg"
                  stroke={CSS_VAR.demand}
                  strokeWidth={1.5}
                  dot={ccuDot(ccuPartial)}
                  isAnimationActive={false}
                />
                {ccuMonthZoom.selection && (
                  <ReferenceArea x1={ccuMonthZoom.selection.x1} x2={ccuMonthZoom.selection.x2} {...SELECTION_AREA_PROPS} />
                )}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Latest capture</div>
        <div className="flex flex-col gap-3 sm:max-w-sm">
          <BulletMeter
            label="Playing now (Steam)"
            value={livePlayers != null ? livePlayers / splitMax : null}
            color={CSS_VAR.demand}
            valueLabel={livePlayers != null ? fmtCompact(livePlayers) : "not captured"}
          />
        </div>
        {summary?.players_7d_avg != null && (
          <p className="mt-2 text-xs text-ink-secondary">
            7-day average {fmtCompact(summary.players_7d_avg)} players
            {trendPct != null && (
              // Trend verdict language (design handoff): ▲/▼ + signed %, mono steel —
              // up reads accent-300, down/flat recedes to muted paper. Never red/green.
              <span style={{ color: trendPct >= 0 ? "var(--verdict-up)" : "var(--verdict-flat)" }}>
                {" "}
                ({trendPct >= 0 ? "▲ " : "▼ "}
                {fmtTrendPct(trendPct)} vs the prior 7 days)
              </span>
            )}
            {trend.market && <span className="text-ink-muted"> · {trend.market}</span>}
          </p>
        )}
        {noSplitSnapshot && <p className="mt-2 text-[11px] italic text-ink-muted">No player count captured for this game yet.</p>}
      </div>

      {monthly.length >= 3 && (
        <div>
          <div className="mb-1 text-xs text-ink-muted">Full history — monthly average & peak players</div>
          <ZoomFrame zoomed={monthlyZoom.zoomed} dragging={monthlyZoom.dragging} outOfRange={monthlyZoom.outOfRange} onReset={monthlyZoom.reset}>
            <ResponsiveContainer width="100%" height={170}>
              <LineChart data={monthlyZoom.data} margin={{ top: 14, right: 8, left: 0, bottom: 0 }} {...monthlyZoom.handlers}>
                <CartesianGrid stroke="var(--gridline)" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: string) => fmtMonth(v) ?? v}
                  interval="preserveStartEnd"
                  minTickGap={40}
                  tickLine={false}
                  axisLine={{ stroke: "var(--baseline)" }}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => fmtAxisCompact(v)}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip
                  cursor={{ stroke: "var(--baseline)" }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const p = payload[0].payload as GamePlayersMonthlyPoint;
                    const rows: TooltipRow[] = [
                      { label: "Monthly average", value: fmtCompact(p.avg_players), color: CSS_VAR.demand },
                      {
                        label: "Monthly peak",
                        value: p.peak_players != null ? fmtCompact(p.peak_players) : "not recorded",
                        color: CSS_VAR.competition,
                      },
                    ];
                    if (p.month.slice(0, 7) === monthlyPartial) rows.push({ label: "Note", value: `${partialNote(asOf)} — the peak can still rise` });
                    return <TooltipPanel title={fmtMonth(String(label)) ?? String(label)} rows={rows} />;
                  }}
                />
                {/* Two-series trend language (design handoff): primary (avg) accent-300 solid,
                    secondary (peak) paper-alpha dashed "4 3". */}
                <Line
                  type="linear"
                  dataKey="peak_players"
                  stroke={CSS_VAR.competition}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="avg_players"
                  stroke={CSS_VAR.demand}
                  strokeWidth={1.5}
                  dot={monthlyDot(monthlyPartial, CSS_VAR.demand)}
                  isAnimationActive={false}
                />
                {monthlyZoom.selection && (
                  <ReferenceArea x1={monthlyZoom.selection.x1} x2={monthlyZoom.selection.x2} {...SELECTION_AREA_PROPS} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </ZoomFrame>
          <p className="mt-1 text-[11px] italic text-ink-muted">
            Monthly figures via steamcharts.com (hourly polling of Steam's API since 2012) — period AVERAGES and true monthly
            peaks, a different measure from the daily captures above; the two are never mixed.
            {monthlyPartial && <> {fmtMonth(monthlyPartial)} (hollow dot) is a {partialNote(asOf)}.</>}
          </p>
        </div>
      )}

      <p className="text-[11px] italic text-ink-muted">
        {useDaily
          ? `Each dot is one capture a day — a point sample, not the day's peak, so peak charts elsewhere run higher. ${
              seriesAsOf ? `The series runs to ${fmtDay(seriesAsOf)}, the latest capture day. ` : ""
            }Missing days are real gaps in monitoring (a game may rotate out of the capture panel), never zero players.`
          : "A month with no capture is left blank — gaps in the line are real gaps in monitoring, not zero players." +
            (!hasCcu ? " This game has no player capture at all yet." : "")}
        <ThinDataNote thin={thin} />
      </p>
    </div>
  );
}

export function GameMetricDrilldown({
  appid,
  metric,
  profile,
  asOf,
}: {
  appid: number;
  metric: DrilldownMetric;
  profile: DrilldownProfile;
  /** The data's as-of date — marks the month still being counted. */
  asOf?: Date | null;
}) {
  // Shared factories from lib/api.ts — one query key for the trends endpoint, so any other
  // reader on the page shares this cache entry by construction.
  const trendsQuery = useQuery({
    ...gameTrendsQueryOptions(appid),
    enabled: Number.isFinite(appid),
  });
  // Daily captures — the page already fetches this summary for the Estimates panel, so opening
  // the drilldown hits the cache. available=false on marts that predate the daily CCU marts
  // (then the monthly ccu_avg series above stands in).
  const playersQuery = useQuery({
    ...gamePlayersQueryOptions(appid),
    enabled: Number.isFinite(appid) && metric === "live_players",
  });

  if (trendsQuery.isLoading) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading trend data…</div>;
  }
  if (trendsQuery.isError) {
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-2 text-center text-xs text-verdict-serious">
        <span>Couldn&apos;t load trend data. {errorMessage(trendsQuery.error)}</span>
        <RetryButton onClick={() => void trendsQuery.refetch()} />
      </div>
    );
  }

  const points = trendsQuery.data?.points ?? [];
  if (points.length === 0) {
    return <EmptyNote>No monthly history for this game yet — the drilldown fills in once a month of data exists.</EmptyNote>;
  }

  const thin = points.length < 3;

  switch (metric) {
    case "reviews":
      return <ReviewsDrilldown points={points} totalReviews={profile.total_reviews} thin={thin} asOf={asOf} />;
    case "live_players":
      return (
        <LivePlayersDrilldown
          points={points}
          daily={playersQuery.data ?? null}
          livePlayers={profile.live_players}
          thin={thin}
          asOf={asOf}
        />
      );
    default:
      return null;
  }
}

export default GameMetricDrilldown;
