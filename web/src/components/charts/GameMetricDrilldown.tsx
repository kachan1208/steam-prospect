import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { request } from "../../lib/api";
import { fmtCompact, fmtInt, fmtPrice, fmtUsd } from "../../lib/format";
import { channelColor, CSS_VAR } from "../../lib/palette";
import { BulletMeter } from "../ui/Meter";
import { TooltipPanel } from "./TooltipPanel";
import type { GameTrendPoint } from "./GameTrendsChart";

/**
 * Click-through drilldown for the Game Profile stat row: GameProfile.tsx keeps "which card is
 * selected" as its own state and renders this underneath the grid, passing the metric key plus
 * the handful of `profile` fields each derivation needs. This self-fetches
 * GET /api/games/{appid}/trends under the SAME react-query key GameTrendsChart uses
 * (["game-trends", appid]) so the two components share one cached response instead of issuing
 * a second request — this drilldown can be opened from either profile tab (the stat row sits
 * above both), while GameTrendsChart's own "Momentum over time" card only mounts on Overview.
 *
 * Four of the five stat cards open here (see DrilldownMetric) — each derived client-side from
 * the trends endpoint's monthly `points`, per its docstring caveats:
 *   reviews      cumulative sum of n_reviews (Steam's full-history monthly review counts from
 *                its store review graph; a per-appid sample fallback for un-backfilled titles).
 *   owners       that same cumulative-reviews curve x an owners-per-review ratio (the cited
 *                Boxleiter mid, falling back to this game's own owners_mid/total_reviews).
 *   revenue      the owners curve x price_initial — same Boxleiter method as the "Est. revenue"
 *                card above, just walked out over time instead of collapsed to one number.
 *   live_players ccu_avg over months (a real gap, not zero, for any month without a snapshot —
 *                rendered as an honest break in the line, no connectNulls)
 *                alongside it and today's playing-vs-watching split ("who's watching, and
 *                where") from the profile snapshot.
 *
 * "Positive rating" is deliberately NOT one of these: the trends endpoint carries no
 * positive-share field, and the one place a genuine %-positive-over-time series exists
 * (mart_game_reviews_timeline's trailing_positive_share, GET /reviews-summary) is already a
 * full chart on this same page (the "Review timeline" card) — a drilldown here would just
 * reopen that exact chart under a second name, so the card stays a plain (non-clickable) tile
 * rather than manufacture a redundant click target.
 *
 * Every derived (owners/revenue) chart is captioned as an estimate, built on the full-history
 * review curve so its running total tracks toward the headline stat rather than a fraction of
 * it — the review_histogram backfill is what makes that full-history curve possible.
 */
export type DrilldownMetric = "reviews" | "owners" | "revenue" | "live_players";

export const DRILLDOWN_META: Record<DrilldownMetric, { title: string; subtitle: string }> = {
  reviews: {
    title: "Total reviews — growth over time",
    subtitle: "Cumulative reviews by month, with the monthly count alongside it.",
  },
  owners: {
    title: "Owners (est.) — growth over time",
    subtitle: "A derived estimate, not a measured count — see the caveat below the chart.",
  },
  revenue: {
    title: "Est. revenue — growth over time",
    subtitle: "A derived estimate, not measured sales — see the caveat below the chart.",
  },
  live_players: {
    title: "Live players — over time, and who's watching where",
    subtitle: "Daily concurrent-player samples (nightly point samples, not peaks).",
  },
};

export interface OwnersPerReview {
  value: number;
  source: "benchmark" | "game";
}

export interface DrilldownProfile {
  price_initial: number | null;
  total_reviews: number | null;
  owners_mid: number | null;
  live_players: number | null;
}

interface TrendsResponse {
  appid: number;
  eligible: boolean;
  points: GameTrendPoint[];
}

/** GET /api/games/{appid}/players — daily CCU point samples (mart_game_players_daily). */
interface PlayersPoint {
  date: string; // 'YYYY-MM-DD'
  players: number;
}

interface PlayersSummary {
  live_players: number | null;
  players_7d_avg: number | null;
  players_trend_7d_pct: number | null;
  n_days_measured: number;
  first_date: string | null;
  last_date: string | null;
}

interface PlayersMonthlyPoint {
  month: string; // 'YYYY-MM-DD' (month start)
  avg_players: number;
  peak_players: number | null;
}

interface PlayersResponse {
  appid: number;
  days: number;
  available: boolean; // false = mart predates the daily CCU marts -> fall back to monthly
  summary: PlayersSummary | null;
  points: PlayersPoint[];
  // Deep monthly history via steamcharts (top-8k games; empty when uncovered/absent).
  monthly?: PlayersMonthlyPoint[];
}

interface SeriesPoint {
  period: string;
  monthly: number | null;
  cumulative: number | null;
}

const XAXIS_PROPS = {
  dataKey: "period",
  tick: { fontSize: 10 },
  interval: "preserveStartEnd" as const,
  minTickGap: 24,
  tickLine: false,
  axisLine: { stroke: "var(--baseline)" },
};

/** Running total of `pick(point)` per charted month. n_reviews is always a real, non-null
 * integer in the trends payload, so both fields start non-null here — `scaleSeries` below is
 * what can turn them null (only when the multiplier itself is unavailable). */
function cumulativeFrom(points: GameTrendPoint[], pick: (p: GameTrendPoint) => number): SeriesPoint[] {
  let running = 0;
  return points.map((p) => {
    const v = pick(p);
    running += v;
    return { period: p.period, monthly: v, cumulative: running };
  });
}

/** Walk a series through a constant multiplier — reviews-cumulative -> owners (x owners/review),
 * then owners -> revenue (x price). `factor == null` propagates to `null` (no ratio available)
 * rather than silently rendering a false zero line. */
function scaleSeries(series: SeriesPoint[], factor: number | null): SeriesPoint[] {
  return series.map((d) => ({
    period: d.period,
    monthly: factor != null && d.monthly != null ? d.monthly * factor : null,
    cumulative: factor != null && d.cumulative != null ? d.cumulative * factor : null,
  }));
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="flex h-24 items-center justify-center text-center text-xs text-ink-muted">{children}</div>;
}

/** Shared "cumulative growth curve (filled area) + monthly bars" pair for reviews/owners/
 * revenue — two true single-axis small multiples (own scale each), the same
 * dual-axis-avoidance convention as GameTrendsChart/SaturationTrend, rather than one combo
 * chart: a cumulative total and its own monthly delta share a unit but not a legible scale
 * (the delta flattens to a sliver next to a large running total). The flat-opacity area fill
 * (no gradient — matches BuzzSparkline's existing fill idiom, just at full chart size) reads
 * as "this is a running total," distinct from the plain bars beside it. */
function GrowthPanels({
  data,
  cumulativeLabel,
  monthlyLabel,
  color,
  formatter,
}: {
  data: SeriesPoint[];
  cumulativeLabel: string;
  monthlyLabel: string;
  color: string;
  formatter: (v: number) => string;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs text-ink-muted">{cumulativeLabel}</div>
        <ResponsiveContainer width="100%" height={168}>
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis {...XAXIS_PROPS} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => formatter(v)}
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
                    title={String(label)}
                    rows={[
                      {
                        label: cumulativeLabel,
                        value: p.cumulative != null ? formatter(p.cumulative) : "—",
                        color,
                      },
                    ]}
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
              dot={{ r: 3, fill: color, strokeWidth: 0 }}
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div className="mb-1 text-xs text-ink-muted">{monthlyLabel}</div>
        <ResponsiveContainer width="100%" height={168}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--gridline)" vertical={false} />
            <XAxis {...XAXIS_PROPS} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => formatter(v)}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <Tooltip
              cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as SeriesPoint;
                return (
                  <TooltipPanel
                    title={String(label)}
                    rows={[{ label: monthlyLabel, value: p.monthly != null ? formatter(p.monthly) : "—", color }]}
                  />
                );
              }}
            />
            <Bar dataKey="monthly" fill={color} radius={[4, 4, 0, 0]} maxBarSize={20} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ThinDataNote({ thin }: { thin: boolean }) {
  if (!thin) return null;
  return <> Collectors are recent, so this series is still short — it fills in as more months accumulate.</>;
}

function ReviewsDrilldown({
  points,
  totalReviews,
  thin,
}: {
  points: GameTrendPoint[];
  totalReviews: number | null;
  thin: boolean;
}) {
  const series = cumulativeFrom(points, (p) => p.n_reviews);
  const lastCum = series[series.length - 1]?.cumulative ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <GrowthPanels
        data={series}
        cumulativeLabel="Cumulative reviews"
        monthlyLabel="Reviews added / month"
        color={CSS_VAR.competition}
        formatter={fmtCompact}
      />
      <p className="text-[11px] italic text-ink-muted">
        From Steam's full-history review graph — monthly review counts over the game's whole life. This chart covers{" "}
        {fmtInt(lastCum)} review{lastCum === 1 ? "" : "s"} across {points.length}{" "}
        charted month{points.length === 1 ? "" : "s"}
        {totalReviews != null ? `, vs. ${fmtInt(totalReviews)} Steam reports total today (the small gap is reviews since removed or not yet bucketed)` : ""}.
        <ThinDataNote thin={thin} />
      </p>
    </div>
  );
}

function OwnersDrilldown({
  points,
  ownersPerReview,
  ownersMid,
  thin,
}: {
  points: GameTrendPoint[];
  ownersPerReview: OwnersPerReview | null;
  ownersMid: number | null;
  thin: boolean;
}) {
  if (ownersPerReview == null) {
    return (
      <EmptyNote>
        No owners-per-review ratio available yet (needs market benchmarks or an owners estimate) — can't derive an
        owners growth curve.
      </EmptyNote>
    );
  }
  const reviewsCum = cumulativeFrom(points, (p) => p.n_reviews);
  const series = scaleSeries(reviewsCum, ownersPerReview.value);
  const ratioNote =
    ownersPerReview.source === "benchmark"
      ? `the cited Boxleiter mid ratio (${ownersPerReview.value.toFixed(1)} owners/review)`
      : `this title's own owners-to-review ratio (${ownersPerReview.value.toFixed(1)} owners/review)`;
  return (
    <div className="flex flex-col gap-4">
      <GrowthPanels
        data={series}
        cumulativeLabel="Est. cumulative owners"
        monthlyLabel="Est. owners added / month"
        color={CSS_VAR.demand}
        formatter={fmtCompact}
      />
      <p className="text-[11px] italic text-ink-muted">
        Estimate, not a measured count: cumulative reviews × {ratioNote}. Built on the full-history review growth
        curve above, so it trends toward the {fmtCompact(ownersMid)} headline estimate.
        <ThinDataNote thin={thin} />
      </p>
    </div>
  );
}

function RevenueDrilldown({
  points,
  ownersPerReview,
  price,
  thin,
}: {
  points: GameTrendPoint[];
  ownersPerReview: OwnersPerReview | null;
  price: number | null;
  thin: boolean;
}) {
  if (price == null) {
    return <EmptyNote>Price is unknown for this title, so a revenue growth curve can't be estimated.</EmptyNote>;
  }
  if (price === 0) {
    return (
      <EmptyNote>
        This title's list price is $0 (free-to-play) — box revenue is $0 throughout, so there's no growth curve to
        chart.
      </EmptyNote>
    );
  }
  if (ownersPerReview == null) {
    return (
      <EmptyNote>
        No owners-per-review ratio available yet (needs market benchmarks or an owners estimate) — can't derive a
        revenue growth curve.
      </EmptyNote>
    );
  }
  const reviewsCum = cumulativeFrom(points, (p) => p.n_reviews);
  const ownersSeries = scaleSeries(reviewsCum, ownersPerReview.value);
  const series = scaleSeries(ownersSeries, price);
  return (
    <div className="flex flex-col gap-4">
      <GrowthPanels
        data={series}
        cumulativeLabel="Est. cumulative revenue (gross)"
        monthlyLabel="Est. revenue added / month"
        color={CSS_VAR.qualityGap}
        formatter={fmtUsd}
      />
      <p className="text-[11px] italic text-ink-muted">
        Estimate, not measured sales: cumulative reviews × owners-per-review × this title's {fmtPrice(price)}{" "}
        list price — the same Boxleiter method as the Est. revenue card above, walked out over the full-history review
        growth curve instead of collapsed to one number. That card shows the full low/mid/high range; this curve
        tracks the mid case only.
        <ThinDataNote thin={thin} />
      </p>
    </div>
  );
}

function LivePlayersDrilldown({
  points,
  daily,
  livePlayers,
  thin,
}: {
  points: GameTrendPoint[];
  daily: PlayersResponse | null;
  livePlayers: number | null;
  thin: boolean;
}) {
  const hasCcu = points.some((p) => p.ccu_avg != null);
  const splitMax = Math.max(livePlayers ?? 0, 1);
  const noSplitSnapshot = livePlayers == null;
  // Daily point samples when the mart carries them (mart_game_players_daily); otherwise the
  // pre-existing monthly ccu_avg fallback so older marts still show something.
  const dailyPoints = daily?.available ? daily.points : [];
  const useDaily = dailyPoints.length > 0;
  const summary = daily?.summary ?? null;
  const trendPct = summary?.players_trend_7d_pct ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-ink-muted">
            {useDaily ? "Live players (nightly sample) / day" : "Live players (avg CCU) / month"}
          </div>
          <ResponsiveContainer width="100%" height={168}>
            {useDaily ? (
              <LineChart data={dailyPoints} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--gridline)" vertical={false} />
                <XAxis {...XAXIS_PROPS} dataKey="date" tickFormatter={(v: string) => v.slice(5)} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => fmtCompact(v)}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip
                  cursor={{ stroke: "var(--baseline)" }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const p = payload[0].payload as PlayersPoint;
                    return (
                      <TooltipPanel
                        title={String(label)}
                        rows={[{ label: "Live players (sample)", value: fmtCompact(p.players), color: CSS_VAR.demand }]}
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
                />
              </LineChart>
            ) : (
              <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--gridline)" vertical={false} />
                <XAxis {...XAXIS_PROPS} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => fmtCompact(v)}
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
                        title={String(label)}
                        rows={[
                          {
                            label: "Live players (avg)",
                            value: p.ccu_avg != null ? fmtCompact(p.ccu_avg) : "no snapshot",
                            color: CSS_VAR.demand,
                          },
                        ]}
                      />
                    );
                  }}
                />
                {/* No connectNulls: a month with no player-count snapshot is a genuine gap in
                    monitoring, not zero players, so the line honestly breaks there instead of
                    interpolating across it. */}
                <Line
                  type="linear"
                  dataKey="ccu_avg"
                  stroke={CSS_VAR.demand}
                  strokeWidth={1.5}
                  dot={{ r: 3, fill: CSS_VAR.demand, strokeWidth: 0 }}
                />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Who's watching, and where — today's snapshot
        </div>
        <div className="flex flex-col gap-3 sm:max-w-sm">
          <BulletMeter
            label="Playing now (Steam)"
            value={livePlayers != null ? livePlayers / splitMax : null}
            color={CSS_VAR.demand}
            valueLabel={livePlayers != null ? fmtCompact(livePlayers) : "—"}
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
                ({trendPct >= 0 ? "▲ +" : "▼ "}
                {trendPct.toFixed(1)}% vs prior 7d)
              </span>
            )}
          </p>
        )}
        {noSplitSnapshot && <p className="mt-2 text-[11px] italic text-ink-muted">No live snapshot yet for this title.</p>}
      </div>

      {(daily?.monthly?.length ?? 0) >= 3 && (
        <div>
          <div className="mb-1 text-xs text-ink-muted">Full history — monthly average & peak players</div>
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={daily!.monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: string) => v.slice(0, 7)}
                interval="preserveStartEnd"
                minTickGap={40}
                tickLine={false}
                axisLine={{ stroke: "var(--baseline)" }}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => fmtCompact(v)}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ stroke: "var(--baseline)" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as PlayersMonthlyPoint;
                  return (
                    <TooltipPanel
                      title={String(label).slice(0, 7)}
                      rows={[
                        { label: "Monthly average", value: fmtCompact(p.avg_players), color: CSS_VAR.demand },
                        {
                          label: "Monthly peak",
                          value: p.peak_players != null ? fmtCompact(p.peak_players) : "—",
                          color: CSS_VAR.competition,
                        },
                      ]}
                    />
                  );
                }}
              />
              {/* Two-series trend language (design handoff): primary (avg) accent-300 solid,
                  secondary (peak) paper-alpha dashed "4 3" — CSS_VAR.competition already
                  carries the recession, so no extra strokeOpacity is needed on top of it. */}
              <Line
                type="linear"
                dataKey="peak_players"
                stroke={CSS_VAR.competition}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                connectNulls
              />
              <Line type="linear" dataKey="avg_players" stroke={CSS_VAR.demand} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <p className="mt-1 text-[11px] italic text-ink-muted">
            Historical monthly figures via steamcharts.com (hourly polling of Steam's API since 2012) — period
            AVERAGES and true monthly peaks, a different measure from the nightly samples above; the two are never
            mixed.
          </p>
        </div>
      )}

      <p className="text-[11px] italic text-ink-muted">
        {useDaily
          ? "Each dot is one nightly capture (~21-22:00 UTC) — a point sample, not the day's peak, so peak charts " +
            "elsewhere run higher. Missing days are real gaps in monitoring (this title may be on the capture " +
            "rotation), never zero players."
          : "ccu_avg is left blank for months with no player-count snapshot — gaps in the line above are real gaps in " +
            `monitoring, not zero players.${!hasCcu ? " This title has no CCU snapshot at all yet — the" : " The"} ` +
            "live-player collector is recent, so this series typically thickens as more months accumulate."}
        <ThinDataNote thin={thin} />
      </p>
    </div>
  );
}

export function GameMetricDrilldown({
  appid,
  metric,
  profile,
  ownersPerReview,
}: {
  appid: number;
  metric: DrilldownMetric;
  profile: DrilldownProfile;
  ownersPerReview: OwnersPerReview | null;
}) {
  const trendsQuery = useQuery({
    queryKey: ["game-trends", appid],
    queryFn: () => request<TrendsResponse>(`/games/${appid}/trends`),
    enabled: Number.isFinite(appid),
    staleTime: 5 * 60_000,
  });
  // Daily CCU samples — only fetched for the live_players drilldown; the endpoint answers
  // available=false on marts that predate the daily CCU marts (we then fall back to the
  // monthly ccu_avg series above).
  const playersQuery = useQuery({
    queryKey: ["game-players", appid],
    queryFn: () => request<PlayersResponse>(`/games/${appid}/players?days=90`),
    enabled: Number.isFinite(appid) && metric === "live_players",
    staleTime: 5 * 60_000,
  });

  if (trendsQuery.isLoading) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading trend data…</div>;
  }
  if (trendsQuery.isError) {
    return (
      <div className="flex h-24 items-center justify-center text-center text-xs text-verdict-serious">
        {trendsQuery.error instanceof Error ? trendsQuery.error.message : "Failed to load trend data."}
      </div>
    );
  }

  const points = trendsQuery.data?.points ?? [];
  if (points.length === 0) {
    return (
      <EmptyNote>
        No monthly trend data for this game yet — the drilldown fills in once the collectors have logged a month of
        signal.
      </EmptyNote>
    );
  }

  const thin = points.length < 3;

  switch (metric) {
    case "reviews":
      return <ReviewsDrilldown points={points} totalReviews={profile.total_reviews} thin={thin} />;
    case "owners":
      return (
        <OwnersDrilldown
          points={points}
          ownersPerReview={ownersPerReview}
          ownersMid={profile.owners_mid}
          thin={thin}
        />
      );
    case "revenue":
      return (
        <RevenueDrilldown
          points={points}
          ownersPerReview={ownersPerReview}
          price={profile.price_initial}
          thin={thin}
        />
      );
    case "live_players":
      return (
        <LivePlayersDrilldown
          points={points}
          daily={playersQuery.data ?? null}
          livePlayers={profile.live_players}
          thin={thin}
        />
      );
    default:
      return null;
  }
}

export default GameMetricDrilldown;
