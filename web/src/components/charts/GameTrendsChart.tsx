import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { request } from "../../lib/api";
import { fmtCompact } from "../../lib/format";
import { channelColor, CSS_VAR } from "../../lib/palette";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * Per-game momentum over time — the monthly signals Prospect collects
 * (mart_game_trends → GET /api/games/{appid}/trends), rendered as two single-axis
 * small multiples (the same dual-axis-avoidance move as ReviewsTimelineChart /
 * SaturationTrend): a bar for the dominant COUNT metric plus one overlaid LINE on a
 * secondary axis for the audience/attention gauge that rides alongside it, so the two
 * very different scales never fight for one y-axis.
 *
 *   Panel 1  sampled reviews / month (aqua bars) + avg live players (blue line, 2nd axis)
 *   Panel 2  Twitch viewers / month (purple bars) + creator mentions (yellow line, 2nd axis)
 *
 * "My marketing events on the timeline" — one opt-in overlay rides on Panel 1 (the
 * review-velocity backbone): the org's own marketing log (GET /api/inputs/events?appid=…)
 * drops a vertical marker at each event's month, labelled with its kind, with the note in
 * the tooltip. Months with no charted trend row (no signal) are skipped so markers never
 * float.
 *
 * Reviews are the real multi-month backbone; the player-count / Twitch / mention series
 * are only as deep as the collectors have run (today typically a single current month),
 * so they render as a lone dot until history accumulates — see the caveat line below and
 * the mart header. ccu_avg is NULL (a gap, not zero) for any month with no snapshot;
 * connectNulls keeps a single reading visible as a dot.
 *
 * Self-fetches by `appid` (via react-query + the exported `request`) unless `points` is
 * passed in, so it can be embedded as just <GameTrendsChart appid={appid} />. The event
 * overlay is only wired in that self-fetching mode.
 */
export interface GameTrendPoint {
  period: string; // 'YYYY-MM'
  n_reviews: number;
  ccu_avg: number | null;
  twitch_viewers: number;
  n_mentions: number;
}

interface GameTrendsResponse {
  appid: number;
  eligible: boolean;
  points: GameTrendPoint[];
}

interface MarketingEvent {
  id: number;
  appid: number;
  event_date: string; // 'YYYY-MM-DD'
  kind: string; // trailer | festival | press | update | other
  note: string | null;
}

// "My marketing events" are user milestones, not a data series — brand-toned so they read
// as annotations distinct from the aqua review bars and blue player line.
const EVENT_COLOR = "var(--brand)";

const XAXIS_PROPS = {
  dataKey: "period",
  tick: { fontSize: 10 },
  interval: "preserveStartEnd" as const,
  minTickGap: 24,
  tickLine: false,
  axisLine: { stroke: "var(--baseline)" },
};

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function LegendTick({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-3 w-0.5 shrink-0" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function eventMarkerLabel(evts: MarketingEvent[]): string {
  return evts.length === 1 ? capitalize(evts[0].kind) : `${evts.length} events`;
}

export function GameTrendsChart({
  appid,
  points,
}: {
  appid: number;
  points?: GameTrendPoint[];
}) {
  const selfFetch = points === undefined && Number.isFinite(appid);

  const trendsQuery = useQuery({
    queryKey: ["game-trends", appid],
    queryFn: () => request<GameTrendsResponse>(`/games/${appid}/trends`),
    enabled: selfFetch,
    staleTime: 5 * 60_000,
  });

  // Marketing annotations are additive — a failing/empty events endpoint must never blank
  // the chart, so this query swallows errors into an empty list rather than surfacing them.
  const eventsQuery = useQuery({
    queryKey: ["game-events", appid],
    queryFn: async () => {
      try {
        return await request<MarketingEvent[]>(`/inputs/events?appid=${appid}`);
      } catch {
        return [] as MarketingEvent[];
      }
    },
    enabled: selfFetch,
    staleTime: 5 * 60_000,
  });

  const basePoints = points ?? trendsQuery.data?.points ?? [];

  if (selfFetch && trendsQuery.isLoading) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading trends…</div>;
  }
  if (selfFetch && trendsQuery.isError) {
    return (
      <div className="flex h-24 items-center justify-center text-center text-xs text-status-serious">
        {trendsQuery.error instanceof Error ? trendsQuery.error.message : "Failed to load trends."}
      </div>
    );
  }
  if (basePoints.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-center text-xs text-ink-muted">
        No monthly trend data for this game yet.
      </div>
    );
  }

  const data: GameTrendPoint[] = basePoints;

  // ---- group marketing events onto charted months (drop months not on the axis) ----------
  const periodSet = new Set(data.map((d) => d.period));
  const eventsByMonth = new Map<string, MarketingEvent[]>();
  for (const e of eventsQuery.data ?? []) {
    const month = e.event_date.slice(0, 7); // 'YYYY-MM'
    if (!periodSet.has(month)) continue;
    const bucket = eventsByMonth.get(month);
    if (bucket) bucket.push(e);
    else eventsByMonth.set(month, [e]);
  }
  const eventMonths = [...eventsByMonth.keys()].sort();
  const hasEvents = eventMonths.length > 0;

  const twitchColor = channelColor("twitch");
  const hasCcu = data.some((d) => d.ccu_avg != null);
  const hasTwitch = data.some((d) => d.twitch_viewers > 0);
  const hasMentions = data.some((d) => d.n_mentions > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Panel 1 — review velocity + live players (+ event markers) */}
        <div>
          <div className="mb-1 text-xs text-ink-muted">Sampled reviews &amp; live players / month</div>
          <ResponsiveContainer width="100%" height={168}>
            <ComposedChart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis {...XAXIS_PROPS} />
              <YAxis
                yAxisId="reviews"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => fmtCompact(v)}
                tickLine={false}
                axisLine={false}
                width={40}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="ccu"
                orientation="right"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => fmtCompact(v)}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip
                cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as GameTrendPoint;
                  const rows: TooltipRow[] = [
                    { label: "Reviews (sampled)", value: fmtCompact(p.n_reviews), color: CSS_VAR.competition },
                    {
                      label: "Live players (avg)",
                      value: p.ccu_avg != null ? fmtCompact(p.ccu_avg) : "no snapshot",
                      color: CSS_VAR.demand,
                    },
                  ];
                  for (const e of eventsByMonth.get(String(label)) ?? []) {
                    const note = e.note ? (e.note.length > 60 ? `${e.note.slice(0, 57)}…` : e.note) : "—";
                    rows.push({ label: capitalize(e.kind), value: note, color: EVENT_COLOR });
                  }
                  return <TooltipPanel title={String(label)} rows={rows} />;
                }}
              />
              <Bar yAxisId="reviews" dataKey="n_reviews" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Line
                yAxisId="ccu"
                type="monotone"
                dataKey="ccu_avg"
                stroke={CSS_VAR.demand}
                strokeWidth={2}
                dot={{ r: 3, fill: CSS_VAR.demand, strokeWidth: 0 }}
                connectNulls
              />
              {/* my marketing events — a labelled plumb line at each event's month */}
              {eventMonths.map((month, i) => (
                <ReferenceLine
                  key={month}
                  yAxisId="reviews"
                  x={month}
                  stroke={EVENT_COLOR}
                  strokeDasharray="2 2"
                  strokeOpacity={0.85}
                  label={{
                    value: eventMarkerLabel(eventsByMonth.get(month)!),
                    position: "top",
                    fill: EVENT_COLOR,
                    fontSize: 9,
                    dy: (i % 2) * 11,
                  }}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
            <LegendDot color={CSS_VAR.competition} label="Reviews / mo" />
            <LegendDot color={CSS_VAR.demand} label="Live players (avg)" />
            {hasEvents && <LegendTick color={EVENT_COLOR} label="Marketing event" />}
          </div>
        </div>

        {/* Panel 2 — Twitch viewers + creator mentions */}
        <div>
          <div className="mb-1 text-xs text-ink-muted">Twitch viewers &amp; creator mentions / month</div>
          <ResponsiveContainer width="100%" height={168}>
            <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--gridline)" vertical={false} />
              <XAxis {...XAXIS_PROPS} />
              <YAxis
                yAxisId="twitch"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => fmtCompact(v)}
                tickLine={false}
                axisLine={false}
                width={40}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="mentions"
                orientation="right"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => fmtCompact(v)}
                tickLine={false}
                axisLine={false}
                width={32}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as GameTrendPoint;
                  return (
                    <TooltipPanel
                      title={String(label)}
                      rows={[
                        { label: "Twitch viewers", value: fmtCompact(p.twitch_viewers), color: twitchColor },
                        { label: "Creator mentions", value: fmtCompact(p.n_mentions), color: CSS_VAR.qualityGap },
                      ]}
                    />
                  );
                }}
              />
              <Bar yAxisId="twitch" dataKey="twitch_viewers" fill={twitchColor} radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Line
                yAxisId="mentions"
                type="monotone"
                dataKey="n_mentions"
                stroke={CSS_VAR.qualityGap}
                strokeWidth={2}
                dot={{ r: 3, fill: CSS_VAR.qualityGap, strokeWidth: 0 }}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
            <LegendDot color={twitchColor} label="Twitch viewers" />
            <LegendDot color={CSS_VAR.qualityGap} label="Creator mentions" />
          </div>
        </div>
      </div>

      {(!hasCcu || !hasTwitch || !hasMentions) && (
        <p className="text-[11px] italic text-ink-muted">
          Reviews/month is the real multi-month history (from the sampled reviews table — recency-biased for
          older/popular titles). Live-player, Twitch, and creator-mention snapshots are recent, so those series are
          typically a single current month today and thicken as the collectors keep running.
        </p>
      )}
    </div>
  );
}

export default GameTrendsChart;
