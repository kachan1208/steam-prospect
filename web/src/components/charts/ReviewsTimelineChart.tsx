import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { gameCatalogEventsQueryOptions, type GameEvent, type ReviewTimelinePoint } from "../../lib/api";
import { fmtAxisCompact, fmtCompact, fmtPct } from "../../lib/format";
import { layoutPlumbLabels, markerReasons } from "../../lib/notable";
import { CSS_VAR } from "../../lib/palette";
import { useDragZoom } from "../../lib/useDragZoom";
import { changeTooltipRow, PLUMB_LABEL_BAND, PlumbLegendTick, plumbLabelProps, usePlotWidth } from "./plumbLabels";
import { SELECTION_AREA_PROPS, ZoomFrame } from "./ZoomFrame";
import { TooltipPanel, type TooltipRow } from "./TooltipPanel";

const EVENT_COLOR = CSS_VAR.textMuted;

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Two single-axis small multiples (same dual-axis-avoidance move as SaturationTrend)
 * rather than one combo chart: a trailing 3-month positive-rating trajectory
 * (CSS_VAR.demand, mono accent-300 line — "how is it landing, and is that changing")
 * and reviews per month (CSS_VAR.competition, mono paper bars — "how much signal /
 * velocity"). Different scales (a narrow %-band vs. a count), so each gets its own axis
 * instead of a second y-scale on one plot.
 *
 * DATA SOURCE (2026-08-18): Steam's own full-history monthly review counts (the store
 * review graph — uncapped), never the text sample; a capped/recency-biased sample lies
 * about historic shape, so games without full data show no timeline at all rather than
 * a misleading one (see mart_game_reviews.sql SOURCE POLICY).
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
export function ReviewsTimelineChart({ points, appid }: { points: ReviewTimelinePoint[]; appid?: number }) {
  // Shared by the velocity line and the volume bars below: same months, one range.
  const zoom = useDragZoom(points, "period");
  // Catalog-event overlay ("why did the curve move HERE" — GET /api/games/{appid}/events,
  // the release, shipped updates, press coverage): optional and additive on the shared
  // factory's contract — a chart without markers is complete, just less explained. Same
  // queryKey as GameTrendsChart's overlay, so both charts share one cached response.
  const eventsQuery = useQuery({
    ...gameCatalogEventsQueryOptions(appid ?? -1),
    enabled: appid !== undefined,
  });
  // The volume panel's plot width, for the label layout: container minus its 40px YAxis and
  // 8px right margin. A hook, so it sits with the others above the early return.
  const plot = usePlotWidth(40 + 8);

  const periodSet = new Set(points.map((d) => d.period));
  const eventsByMonth = new Map<string, GameEvent[]>();
  for (const e of eventsQuery.data ?? []) {
    const month = e.event_date.slice(0, 7);
    if (!periodSet.has(month)) continue;
    const bucket = eventsByMonth.get(month);
    if (bucket) bucket.push(e);
    else eventsByMonth.set(month, [e]);
  }
  // One shared gate for the plumb lines (see lib/notable.ts markerReasons: adaptive
  // spike/drop rule, sparse-events fallback, 14-line cap, release always drawn). Tooltips
  // keep every month's events; only the lines are gated.
  const releaseMonth = (eventsQuery.data ?? []).find((e) => e.kind === "release")?.event_date.slice(0, 7);
  const reasons = markerReasons(
    points.map((p) => ({ period: p.period, value: p.n_reviews })),
    eventsByMonth.keys(),
    releaseMonth,
  );
  // Each line's label over two rows above the plot, thinned where the measured width cannot
  // fit them; visible months only, so nothing floats off a zoomed axis.
  const labels = layoutPlumbLabels(zoom.data.map((d) => d.period), reasons, plot.width, eventsByMonth);

  if (points.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-ink-muted">
        No full review history for this title yet — the timeline only charts complete data.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs text-ink-muted">Positive rating trend (trailing 3-month)</div>
        <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
          {/* No markers on this panel, but the same label band as its neighbour so the two
              plots stay level and a zoom band lands at the same height in both. */}
          <ResponsiveContainer width="100%" height={160 - 4 + PLUMB_LABEL_BAND}>
            <LineChart data={zoom.data} margin={{ top: PLUMB_LABEL_BAND, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
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
              type="linear"
              dataKey="trailing_positive_share"
              stroke={CSS_VAR.demand}
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            {zoom.selection && (
              <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />
            )}
            </LineChart>
          </ResponsiveContainer>
        </ZoomFrame>
      </div>
      <div>
        <div className="mb-1 text-xs text-ink-muted">Reviews per month — Steam's full history</div>
        <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
          {/* The label band replaces the old 4px top margin and the height grows by the
              difference, so the bars keep their size. */}
          <ResponsiveContainer width="100%" height={160 - 4 + PLUMB_LABEL_BAND} onResize={plot.onResize}>
            <BarChart data={zoom.data} margin={{ top: PLUMB_LABEL_BAND, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
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
              cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as ReviewTimelinePoint;
                const rows: TooltipRow[] = [
                  { label: "Reviews", value: fmtCompact(p.n_reviews), color: CSS_VAR.competition },
                  { label: "Positive", value: fmtCompact(p.n_positive) },
                ];
                const change = changeTooltipRow(reasons.get(String(label)));
                if (change) rows.push(change);
                for (const e of eventsByMonth.get(String(label)) ?? []) {
                  const title = e.title.length > 60 ? `${e.title.slice(0, 57)}…` : e.title;
                  rows.push({ label: capitalize(e.kind), value: title, color: EVENT_COLOR });
                }
                return <TooltipPanel title={String(label)} rows={rows} />;
              }}
            />
            <Bar dataKey="n_reviews" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
            {/* catalog events — muted plumb lines, each labelled (RELEASED / the event kind /
                the month's multiple of its trailing median); the layout thins the labels
                where they would collide, so a patch-heavy lifetime cannot picket-fence.
                Titles live in the tooltip. */}
            {[...labels].map(([month, label]) => (
              <ReferenceLine
                key={month}
                x={month}
                stroke={EVENT_COLOR}
                strokeDasharray="2 5"
                strokeOpacity={month === releaseMonth ? 0.9 : 0.5}
                label={plumbLabelProps(label, month === releaseMonth)}
              />
            ))}
            {zoom.selection && (
              <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />
            )}
            </BarChart>
          </ResponsiveContainer>
        </ZoomFrame>
        {reasons.size > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
            <PlumbLegendTick />
          </div>
        )}
      </div>
    </div>
  );
}
