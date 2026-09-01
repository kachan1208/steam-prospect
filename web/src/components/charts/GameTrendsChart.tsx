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

import {
  errorMessage,
  gameCatalogEventsQueryOptions,
  gameMarketingEventsQueryOptions,
  gameTrendsQueryOptions,
  type GameEvent,
  type GameTrendPoint,
  type MarketingEvent,
} from "../../lib/api";
import { fmtAxisCompact, fmtCompact } from "../../lib/format";
import { markerMonths } from "../../lib/notable";
import { CSS_VAR } from "../../lib/palette";
import { RetryButton } from "../ui/ErrorState";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

/**
 * Per-game momentum over time — the monthly signals Prospect collects
 * (mart_game_trends → GET /api/games/{appid}/trends), rendered as two single-axis
 * small multiples (the same dual-axis-avoidance move as ReviewsTimelineChart /
 * SaturationTrend): a bar for the dominant COUNT metric plus one overlaid LINE on a
 * secondary axis for the audience/attention gauge that rides alongside it, so the two
 * very different scales never fight for one y-axis. Color is mono steel (lib/palette.ts).
 *
 *   Panel 1  sampled reviews / month (paper bars) + avg live players (accent-300 line, 2nd axis)
 *
 * "My marketing events on the timeline" — one opt-in overlay rides on Panel 1 (the
 * review-velocity backbone): the org's own marketing log (GET /api/inputs/events?appid=…)
 * drops a vertical marker at each event's month, labelled with its kind, with the note in
 * the tooltip. Months with no charted trend row (no signal) are skipped so markers never
 * float.
 *
 * Reviews are the real multi-month backbone; the player-count series is only as deep as
 * the collector has run, so it renders as a lone dot until history accumulates — see the
 * caveat line below and the mart header. ccu_avg is NULL (a gap, not zero) for any month with no snapshot;
 * connectNulls keeps a single reading visible as a dot.
 *
 * Self-fetches by `appid` (via react-query + the shared queryOptions factories in
 * lib/api.ts) unless `points` is passed in, so it can be embedded as just
 * <GameTrendsChart appid={appid} />. The event overlay is only wired in that
 * self-fetching mode.
 */

// "My marketing events" are user milestones, not a data series — brand-toned so they read
// as annotations distinct from the aqua review bars and blue player line.
const EVENT_COLOR = "var(--brand)";
// Catalog events recede to muted ink: they are context, and a patch-heavy game can have one in
// almost every charted month — at brand strength that would shout down the data. Only the
// release line carries a text label; every other marker explains itself in the tooltip, which
// is what keeps a 24-line month axis readable instead of a picket fence of labels.
const CATALOG_EVENT_COLOR = CSS_VAR.textMuted;

const XAXIS_PROPS = {
  dataKey: "period",
  tick: { fontSize: 10 },
  interval: "preserveStartEnd" as const,
  minTickGap: 24,
  tickLine: false,
  axisLine: { stroke: "var(--baseline)" },
};

// 14x2px line-key swatch (design handoff: "Legend swatches 14×2px"), used for both the
// bar and line series in this file's legends — a thin bar reads fine as a generic swatch
// for either mark type, and matches every line-legend in the mockups pixel-for-pixel.
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-0.5 w-3.5 shrink-0" style={{ backgroundColor: color }} />
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

  // All three queries come from the shared factories in lib/api.ts (one canonical contract
  // per endpoint; the queryKeys match GameMetricDrilldown / useGameEvents by construction
  // so every chart on the page shares one cached response per endpoint).
  const trendsQuery = useQuery({
    ...gameTrendsQueryOptions(appid),
    enabled: selfFetch,
  });

  // Marketing annotations are additive — the factory's contract (stable miss → [], one
  // retry on a transient blip) keeps a failing endpoint from blanking the chart.
  const eventsQuery = useQuery({
    ...gameMarketingEventsQueryOptions(appid),
    enabled: selfFetch,
  });

  // Same additive contract for the catalog annotations: an old mart (no mart_game_event
  // yet) answers items=[] server-side anyway.
  const catalogQuery = useQuery({
    ...gameCatalogEventsQueryOptions(appid),
    enabled: selfFetch,
  });

  const basePoints = points ?? trendsQuery.data?.points ?? [];

  if (selfFetch && trendsQuery.isLoading) {
    return <div className="flex h-40 items-center justify-center text-xs text-ink-muted">Loading trends…</div>;
  }
  if (selfFetch && trendsQuery.isError) {
    // Was `error.message` — the raw exception, i.e. a bare "Failed to fetch" on any network
    // blip. errorMessage() keeps the API's own words when the API actually answered.
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-2 text-center text-xs text-verdict-serious">
        <span>Couldn&apos;t load trends. {errorMessage(trendsQuery.error)}</span>
        <RetryButton onClick={() => void trendsQuery.refetch()} />
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

  // Catalog events bucket by charted month exactly like the marketing ones. The release month
  // is singled out: it is the one marker whose label earns axis space.
  const catalogByMonth = new Map<string, GameEvent[]>();
  for (const e of catalogQuery.data ?? []) {
    const month = e.event_date.slice(0, 7);
    if (!periodSet.has(month)) continue;
    const bucket = catalogByMonth.get(month);
    if (bucket) bucket.push(e);
    else catalogByMonth.set(month, [e]);
  }
  // One shared gate for the catalog plumb lines (lib/notable.ts markerMonths: adaptive
  // spike/drop rule, sparse-events fallback, 14-line cap, release always drawn); the
  // tooltip keeps every month's events either way.
  const releaseMonth = (catalogQuery.data ?? []).find((e) => e.kind === "release")?.event_date.slice(0, 7);
  const catalogMonths = [
    ...markerMonths(
      data.map((d) => ({ period: d.period, value: d.n_reviews })),
      catalogByMonth.keys(),
      releaseMonth,
    ),
  ].sort();
  const hasCatalog = catalogMonths.length > 0;

  const hasCcu = data.some((d) => d.ccu_avg != null);

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
                tickFormatter={(v: number) => fmtAxisCompact(v)}
                tickLine={false}
                axisLine={false}
                width={40}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="ccu"
                orientation="right"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => fmtAxisCompact(v)}
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
                  for (const e of catalogByMonth.get(String(label)) ?? []) {
                    const title = e.title.length > 60 ? `${e.title.slice(0, 57)}…` : e.title;
                    rows.push({ label: capitalize(e.kind), value: title, color: CATALOG_EVENT_COLOR });
                  }
                  return <TooltipPanel title={String(label)} rows={rows} />;
                }}
              />
              <Bar yAxisId="reviews" dataKey="n_reviews" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Line
                yAxisId="ccu"
                type="linear"
                dataKey="ccu_avg"
                stroke={CSS_VAR.demand}
                strokeWidth={1.5}
                dot={{ r: 3, fill: CSS_VAR.demand, strokeWidth: 0 }}
                connectNulls
              />
              {/* catalog events — muted, mostly-unlabelled plumb lines UNDER the marketing
                  layer. Dash "2 5" (sparser than the marketing "3 4") so overlapping months
                  stay tellable apart; only the release line gets a text label. Details are
                  in the tooltip, which is what keeps a patch-heavy game readable. */}
              {catalogMonths.map((month) => (
                <ReferenceLine
                  key={`cat-${month}`}
                  yAxisId="reviews"
                  x={month}
                  stroke={CATALOG_EVENT_COLOR}
                  strokeDasharray="2 5"
                  strokeOpacity={month === releaseMonth ? 0.9 : 0.55}
                  label={
                    month === releaseMonth
                      ? { value: "Released", position: "top", fill: CATALOG_EVENT_COLOR, fontSize: 9 }
                      : undefined
                  }
                />
              ))}
              {/* my marketing events — a labelled plumb line at each event's month.
                  Dash "3 4" per the design handoff's event-marker spec. */}
              {eventMonths.map((month, i) => (
                <ReferenceLine
                  key={month}
                  yAxisId="reviews"
                  x={month}
                  stroke={EVENT_COLOR}
                  strokeDasharray="3 4"
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
            {hasCatalog && <LegendTick color={CATALOG_EVENT_COLOR} label="Release / notable event" />}
          </div>
        </div>

      </div>

      {!hasCcu && (
        <p className="text-[11px] italic text-ink-muted">
          Reviews/month is the real multi-month history (from the sampled reviews table — recency-biased for
          older/popular titles). Live-player snapshots are recent, so that series is typically a single current
          month today and thickens as the collector keeps running.
        </p>
      )}
    </div>
  );
}

export default GameTrendsChart;
