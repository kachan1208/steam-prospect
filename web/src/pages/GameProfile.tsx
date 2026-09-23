import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AspectDivergingBars } from "../components/charts/AspectDivergingBars";
import { GameMetricDrilldown, DRILLDOWN_META, type DrilldownMetric } from "../components/charts/GameMetricDrilldown";
import { GameEstimatesPanel } from "../components/GameEstimates";
import { LanguageSplitChart } from "../components/charts/LanguageSplitChart";
import { LaunchShapeBars, launchShapeSummary } from "../components/charts/LaunchShapeBars";
import { PressBySourceChart } from "../components/charts/PressBySourceChart";
import { PressTimelineChart } from "../components/charts/PressTimelineChart";
import { PriceHistoryChart } from "../components/charts/PriceHistoryChart";
import { TooltipPanel, type TooltipRow } from "../components/charts/TooltipPanel";
import { HatchDefs, partialBarLabel, partialNote, useHatchId } from "../components/charts/partialMonth";
import { changeTooltipRow, PLUMB_LABEL_BAND, PLUMB_LEGEND_ROW_PX, PlumbLegendTick, plumbLabelProps, usePlotWidth } from "../components/charts/plumbLabels";
import { NotableCoverageCard } from "../components/NotableCoverageCard";
import { OpportunityBreakdown } from "../components/OpportunityBreakdown";
import { Badge } from "../components/ui/Badge";
import { InfoTip } from "../components/ui/InfoTip";
import { EmptyState } from "../components/ui/EmptyState";
import { HeaderLabel } from "../components/ui/HeaderLabel";
import { SentinelTag } from "../components/ui/SentinelTag";
import { ErrorState } from "../components/ui/ErrorState";
import { InlineError } from "../components/ui/InlineError";
import { Loading } from "../components/ui/Loading";
import { SocialLinks } from "../components/ui/SocialLinks";
import { TableScroll } from "../components/ui/TableScroll";
import { Meter, PercentileMeter } from "../components/ui/Meter";
import { ViewToggle } from "../components/ui/ViewToggle";
import { trackEvent } from "../lib/analytics";
import { gameWatchlistId, toggleGameWatchlist, useWatchlist, WATCHLIST_CAP } from "../lib/watchlist";
import {
  gamePlayersQueryOptions,
  isNotFound,
  notFoundReason,
  useGameComparables,
  useGameEvents,
  useGameProfile,
  useGameReviewsSummary,
  useGameTeardown,
  useLaunchCurve,
  useMarketBenchmarks,
  useNicheDetail,
  type GameComparable,
  type GameEvent,
  type NicheRow,
  type ReviewTimelinePoint,
} from "../lib/api";
import { COMPARE_CAP, toggleCompare, useCompareList } from "../lib/compareList";
import { splitEntities } from "../lib/entities";
import { addMonths, fmtDay, fmtMonth, launchFacts, partialMonth } from "../lib/dates";
import { fmtListPrice, priceStatus } from "../lib/priceStatus";
import { glossary } from "../lib/glossary";
import { DEFAULT_NICHE_CUT, findNicheVariant } from "../lib/nicheSelection";
import { axisScale, fmtCompact, fmtInt, fmtMinutes, fmtMonths, fmtPct, fmtPrice, fmtUsd, monthName } from "../lib/format";
import { heatDomain, heatStyle, positiveRatioClass } from "../lib/heat";
import { layoutPlumbLabels, markerReasons } from "../lib/notable";
import { CSS_VAR, MONO} from "../lib/palette";
import { useDataAge } from "../lib/dataAge";
import { usePageTitle } from "../lib/usePageTitle";
import { useDetailView } from "../lib/viewMode";
import { useDragZoom } from "../lib/useDragZoom";
import { SELECTION_AREA_PROPS, ZoomFrame } from "../components/charts/ZoomFrame";

const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };

/** "Review velocity since launch" bars (§4c) are muted accent-400 at the mockup's exact
 * 55% alpha (`rgba(148,188,227,.55)` in the mockup's inline SVG == #94bce3 == --accent-400),
 * not a paper alpha — the one mark on this page that isn't on the demand/competition mono
 * language in lib/palette.ts, kept local since that file is foundation-owned. */
const BAR_MUTED = "color-mix(in srgb, var(--accent-400) 55%, transparent)";
/** The same hue at full strength — the partial month's hatch lines and dashed outline. */
const BAR_MUTED_SOLID = "var(--accent-400)";

/**
 * The catalog events plus an Early Access graduate's 1.0, when the feed dropped it. The
 * rebuilt mart emits the 1.0 as an 'update' titled "1.0 release", but the events endpoint
 * keeps only the most recent few dozen, so a patch-heavy veteran (CS2's Aug 2012 1.0) loses
 * it — and its launch spike then read "▲ >99×" against a beta month instead of "1.0".
 */
function withOneZero(
  events: GameEvent[] | undefined,
  p: { is_ea_graduate?: boolean | null; release_date_1_0?: string | null },
): GameEvent[] | undefined {
  if (!p.is_ea_graduate || !p.release_date_1_0) return events;
  const list = events ?? [];
  if (list.some((e) => e.kind === "update" && /^1\.0 release/i.test(e.title))) return list;
  return [...list, { event_date: p.release_date_1_0.slice(0, 10), kind: "update", title: "1.0 release", url: null }];
}

/** Comparables header type: the table's own 11px muted weight, in the HeaderLabel's shape. */
const COMPARABLE_HEADER: CSSProperties = { fontSize: 11, letterSpacing: "0.02em", textTransform: "none", fontWeight: 500 };

/**
 * The Tag overlap ⓘ's worked line from one comparable: shared tags ÷ all distinct tags across
 * the two games' top 10 (Jaccard), e.g. "Slay the Spire: 9 shared ÷ 11 distinct = 82%". The
 * API sends the shared list and the ratio; the distinct count is shared ÷ ratio.
 */
function tagOverlapWorked(c: GameComparable | undefined): string | undefined {
  if (!c || !(c.jaccard > 0)) return undefined;
  const shared = c.shared_tags.length;
  const distinct = Math.round(shared / c.jaccard);
  return `${c.name ?? `App ${c.appid}`}: ${shared} shared ÷ ${distinct} distinct = ${Math.round(c.jaccard * 100)}% (${c.shared_tags.join(", ")})`;
}

/** The teardown's caveats minus the ones about things this page no longer shows: the press
 * TONE caveat (the API still sends it) describes a coverage-tone read that was removed
 * because it was wrong more often than right — see components/NotableCoverageCard.tsx. */
function pageCaveats(caveats: readonly string[]): string[] {
  return caveats.filter((c) => !/^press coverage tone\b/i.test(c.trim()));
}

/** The review timeline with its empty months put back as zero-review rows (the cumulative
 * columns carry forward; there is no trailing share for a month nobody reviewed). */
function fillReviewMonths(points: ReviewTimelinePoint[]): ReviewTimelinePoint[] {
  const out: ReviewTimelinePoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && /^\d{4}-\d{2}$/.test(prev.period) && /^\d{4}-\d{2}$/.test(p.period)) {
      for (let m = addMonths(prev.period, 1); m < p.period && out.length < 2400; m = addMonths(m, 1)) {
        out.push({
          period: m,
          n_reviews: 0,
          n_positive: 0,
          cum_reviews: prev.cum_reviews,
          cum_positive: prev.cum_positive,
          cum_positive_share: prev.cum_positive_share,
          trailing_reviews: null,
          trailing_positive_share: null,
        });
      }
    }
    out.push(p);
  }
  return out;
}

/**
 * The blueprint frame — THE signature mark of the Industry identity: a hairline box with
 * four "+" registration marks overhanging the corners (drawn by .blueprint/.bp-corner in
 * index.css, foundation-owned). `accent` swaps the border to accent-300 for the one
 * emphasized frame per screen (here: the Estimates panel) — an inline style, because
 * .blueprint's own `border` shorthand is declared after Tailwind's utility layer and would
 * otherwise beat a `border-*` utility class on specificity ties.
 */
function BlueprintFrame({
  children,
  className,
  accent,
  style,
}: {
  children: ReactNode;
  className?: string;
  accent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={clsx("blueprint relative", className)} style={accent ? { borderColor: "var(--brand)", ...style } : style}>
      <i className="bp-corner" />
      {children}
    </div>
  );
}

/** BlueprintFrame + the Card-shaped title/subtitle/action header this page's sections were
 * already using — kept as a drop-in so every existing section only changes its wrapper, not
 * its content. Card itself (src/components/ui/Card.tsx) can't grow corner marks without
 * editing a file another agent owns, so this local twin carries the blueprint grammar
 * instead of Card for every panel on this page. */
function BlueprintPanel({
  children,
  className,
  title,
  subtitle,
  action,
  accent,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  accent?: boolean;
}) {
  return (
    <BlueprintFrame accent={accent} className={clsx("px-[22px] py-[18px]", className)}>
      {(title || action) && (
        <div className="mb-3.5 flex items-start justify-between gap-3">
          <div>
            {title && <h5 className="text-[16px] text-ink-primary">{title}</h5>}
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </BlueprintFrame>
  );
}

/** Header add/remove-from-compare toggle — the profile-header twin of the search rows'
 * per-row button. "+ Compare" is the primary action on this screen (accent-300 fill, per
 * the 4c handoff); already-queued flips to a hairline tinted "added" state instead of a
 * second competing fill color. */
function CompareToggle({ appid, name }: { appid: number; name: string | null }) {
  const list = useCompareList();
  const inList = list.some((e) => e.appid === appid);
  const full = !inList && list.length >= COMPARE_CAP;
  return (
    <button
      type="button"
      onClick={() => toggleCompare(appid, name)}
      disabled={full}
      aria-pressed={inList}
      title={
        inList
          ? "Remove from compare list"
          : full
            ? `Compare list is full (max ${COMPARE_CAP})`
            : "Add to the compare list (tray at the bottom of the screen)"
      }
      className={clsx(
        "inline-flex items-center gap-1.5 border px-3.5 py-[7px] text-xs font-semibold transition-colors",
        inList ? "border-brand bg-brand-tint text-brand" : "border-brand bg-brand text-brand-fg hover:bg-brand-hover",
        full && "cursor-not-allowed opacity-40",
      )}
    >
      {inList ? "✓ Comparing" : "+ Compare"}
    </button>
  );
}

/** "+ Watchlist" — the mockup's secondary header action (4c) and the entry point to the
 * Watchlist page (4f). It was deliberately inert while the store did not exist; it does now
 * (src/lib/watchlist.ts, same versioned-localStorage shape as compareList), so this is wired.
 * An inert button here would have made the Watchlist page a dead end: reachable, and
 * impossible to put anything into. */
function WatchlistButton({ appid, name }: { appid: number; name?: string | null }) {
  const entries = useWatchlist();
  const on = entries.some((e) => e.id === gameWatchlistId(appid));
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        const r = toggleGameWatchlist(appid, name);
        if (r === "full") window.alert(`Watchlist is full (${WATCHLIST_CAP} items).`);
        else trackEvent("view_save");
      }}
      title={on ? "Remove from watchlist" : "Track this game on the Watchlist page"}
      className={clsx(
        "inline-flex items-center gap-1.5 border px-3.5 py-[7px] text-xs font-semibold transition-colors",
        on
          ? "border-brand bg-brand-tint text-brand"
          : "border-chartborder text-ink-secondary hover:text-ink-primary",
      )}
    >
      {on ? "✓ Watchlist" : "+ Watchlist"}
    </button>
  );
}

/** The credit line's comma-joined developers/publishers string as per-entity links to
 * /entity/:role?name=… — split via splitEntities (suffix-aware; "Studio, Inc." stays ONE
 * link), never a naive split(","). */
function CreditLinks({ role, joined }: { role: "developer" | "publisher"; joined: string }) {
  return (
    <>
      {splitEntities(joined).map((n, i) => (
        <span key={`${n}-${i}`}>
          {i > 0 && ", "}
          <Link
            to={`/entity/${role}?name=${encodeURIComponent(n)}`}
            title={`View ${role} profile`}
            className="underline decoration-chartborder decoration-dotted underline-offset-2 hover:text-ink-primary hover:decoration-solid"
          >
            {n}
          </Link>
        </span>
      ))}
    </>
  );
}

/**
 * "Review velocity since launch" (§4c main chart) — the mockup draws this as bars, not the
 * line the since-removed ReviewsTimelineChart used to render further down this page.
 * Rebuilt locally on raw recharts primitives (rather than restyling that chart in place, or
 * extending TimingBars.tsx — both lived under components/charts/*, owned by another agent
 * for this rebuild) so it can match the mockup's two-tone bar language exactly: every bar
 * muted BAR_MUTED, one bar lifted to full accent-300.
 *
 * The mockup's data is illustrative WEEKLY bars; the real timeline this page has (from
 * useGameReviewsSummary) is Steam's full-history MONTHLY
 * review count — so the axis is labeled MONTHLY rather than copying a cadence we don't have.
 * The highlighted bar is the game's own highest-volume month (data-driven), standing in for
 * the mockup's arbitrary "highlight week" — not a fabricated sale event.
 *
 * `eventMarker` wires the mockup's dashed vertical "-20% SALE · JUL 30" annotation through to
 * a real <ReferenceLine> (dashed "3 4" per the handoff's event-marker spec). It sat with no
 * caller until 2026-08-25 because Prospect had no real event feed and inventing a date would
 * be a fabricated series; mart_game_event (release / shipped updates / press) is that feed
 * now, passed in as `events` — the "why did THIS month spike" answer this chart's mockup
 * annotation was always sketching. The single-marker prop stays for the future price-drop
 * feed (price_snapshots started accruing 2026-08-24).
 *
 * Every catalog plumb line carries a label — RELEASED, the event kind, or the month's
 * multiple of its trailing median ("▲ 3.0×") — laid out in a band above the plot by the
 * shared helpers (lib/notable.ts, components/charts/plumbLabels.tsx). Exported for its
 * render test.
 *
 * RATING ON THE RIGHT AXIS (2026-09-19): "combine the velocity bars with the review-rating
 * graph so the change is easier to see … don't add an additional axis/graph, put it on the
 * right side: left = count of reviews, right = % positive." So this is ONE plot with two
 * y-scales — the user's explicit call after seeing the stacked-panels version, which drew
 * the rating in its own aligned panel above the bars to avoid a dual axis. The trailing
 * 3-month positive share (the series the old "Review timeline" card drew on its own until
 * that card was removed as a duplicate the same day) rides over the bars as a line read
 * against the right-hand %-axis; the bars keep the left count axis; the plumb lines, the
 * drag-zoom and the tooltip are shared. Two series on one plot, so the legend row under
 * the plot names both marks.
 *
 * The rating axis is padded to the VISIBLE data, not 0-100%: most titles sit in a narrow
 * band (say 70-95% positive) and a full-range axis squashes real movement into a sliver
 * at the top — the "shows nothing" failure; padding is symmetric, clamped to [0,1], and
 * the ticks are real numbers. And it is the TRAILING share, not cum_positive_share: an
 * all-time cumulative ratio converges as the count grows and flattens into a plateau,
 * while a bounded window can rise AND fall, so a bad patch or a review-bomb is visible
 * instead of averaged away. When no month carries a trailing share the right axis and
 * the line are simply not drawn.
 */
/** The mockup's 150px chart at its old 4px top margin; the label band replaces that margin
 * and the height grows by the difference, so the bars keep their size. */
const VELOCITY_CHART_HEIGHT = 150 - 4 + PLUMB_LABEL_BAND;
/** The 11px series legend row under the plot (`mt-1.5` + one line). */
const VELOCITY_SERIES_ROW_PX = 21;
/** What the drawn component occupies — chart, series legend, plumb legend row, the
 * "Highlighted:" caption (`mt-1` + one 11px italic line) — so its loading placeholder
 * reserves the same and the card does not jump when the data lands. */
const VELOCITY_BLOCK_HEIGHT = VELOCITY_CHART_HEIGHT + VELOCITY_SERIES_ROW_PX + PLUMB_LEGEND_ROW_PX + 21;
/** Each y-axis column is 40px wide; the right margin stays 8px. */
const VELOCITY_Y_AXIS_PX = 40;
/** Both y-axes plus the right margin — what usePlotWidth subtracts. The plot then runs from
 * x = 40 to x = 40 + plot width, the bounds the plumb labels are pinned inside. */
const VELOCITY_AXIS_CHROME = VELOCITY_Y_AXIS_PX + VELOCITY_Y_AXIS_PX + 8;
/** The rating line — paper ink, not the bars' accent, so it stays legible where it crosses
 * a bar of the same hue (the peak bar is full accent). */
const RATING_STROKE = MONO.paper75;

/** The rating axis, padded to the VISIBLE data and clamped to [0, 1] — a zoom rescales it,
 * a flat run still gets a readable band rather than a 0-100% sliver. */
function ratingAxisFor(points: ReviewTimelinePoint[]): { domain: [number, number]; ticks: number[]; decimals: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const v = p.trailing_positive_share;
    if (v === null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return { domain: [0, 1], ticks: [0, 0.5, 1], decimals: 0 };
  // Whole-percent bounds, so the end ticks print as the numbers they are. Recharts' own
  // "nice" ticks on a narrow band like 0.88-1.00 collapsed to a lone "100%" — the axis
  // has to carry its ends and a midpoint explicitly to be readable at all.
  const min = Math.max(0, Math.floor((lo - 0.05) * 100) / 100);
  const max = Math.min(1, Math.ceil((hi + 0.05) * 100) / 100);
  const mid = Math.round(((min + max) / 2) * 1000) / 1000;
  return { domain: [min, max], ticks: [min, mid, max], decimals: max - min < 0.06 ? 1 : 0 };
}

export function ReviewVelocityBars({
  points: rawPoints,
  eventMarker,
  events,
  asOf,
  launchDate,
}: {
  points: ReviewTimelinePoint[];
  eventMarker?: { period: string; label: string };
  events?: GameEvent[];
  /** The data's as-of date (lib/dataAge) — decides which month is still being counted.
   * Without it the viewer's current month stands in. */
  asOf?: Date | null;
  /** The game's launch day ('YYYY-MM-DD' — the first public date, Early Access included), for
   * the launch line when the catalog events carry no release event. */
  launchDate?: string | null;
}) {
  // Every month gets a slot: the timeline skips months with no reviews (CS2 jumps from
  // 2012-05 to 2012-08), and a category axis would draw those neighbours side by side.
  const points = useMemo(() => fillReviewMonths(rawPoints), [rawPoints]);
  // Drag a range to zoom (lib/useDragZoom). Above the early return, never below it: a render
  // that took the "no history" branch ran one hook fewer than the next, which is React #310
  // and the whole page swapped for the error boundary. Event markers below are narrowed to the
  // visible months: a ReferenceLine whose category is off the sliced axis has nowhere to stand.
  const zoom = useDragZoom(points, "period");
  // The plot width the label layout needs — the container minus both 40px y-axes and the
  // 8px right margin. A hook as well, so it stays above the early return with the zoom.
  const plot = usePlotWidth(VELOCITY_AXIS_CHROME);
  const hatchId = useHatchId("velocity-hatch");

  if (points.length === 0) {
    return (
      <div className="flex h-[150px] items-center justify-center text-center text-xs text-ink-muted">
        No full review history for this title yet — the timeline only charts complete data.
      </div>
    );
  }

  // The month still being counted (the data's as-of month): hatched, labelled "partial", and
  // never a "drop" line — lib/notable's detector reads its "now" from the same date.
  const partial = partialMonth(points[points.length - 1]?.period, asOf);
  const peak = points.reduce((best, p) => (p.n_reviews > best.n_reviews ? p : best), points[0]);
  // One unit for the whole review-velocity axis — it used to read "0 / 30.0K / 60.0K /
  // 90.0K / 120K", losing its decimal at exactly the tick where fmtAxisCompact's clipping
  // guard kicks in. See lib/format.ts axisScale.
  const reviewsAxis = axisScale(peak.n_reviews, "count");

  // Catalog events bucketed onto charted months — same overlay language as the lifetime and
  // trends charts: muted plumb lines, release month labelled, titles in the tooltip.
  const periodSet = new Set(points.map((p) => p.period));
  const eventsByMonth = new Map<string, GameEvent[]>();
  for (const e of events ?? []) {
    const month = e.event_date.slice(0, 7);
    if (!periodSet.has(month)) continue;
    const bucket = eventsByMonth.get(month);
    if (bucket) bucket.push(e);
    else eventsByMonth.set(month, [e]);
  }
  // One shared gate for the plumb lines (see lib/notable.ts markerReasons): adaptive
  // spike/drop detection so small/mid games mark too, a sparse-events fallback, a 14-line
  // readability cap, and the release always drawn. Spike months are marked event or not —
  // CS2's real inflections (2019 operations, the 2023-03 CS2 announcement, the 2023-09
  // release) predate our article scrape, so gating lines on having an event erased them
  // all. Every month's events stay readable in the tooltip regardless.
  const releaseMonth =
    (events ?? []).find((e) => e.kind === "release")?.event_date.slice(0, 7) ?? (launchDate ? launchDate.slice(0, 7) : undefined);
  const reasons = markerReasons(
    points.map((p) => ({ period: p.period, value: p.n_reviews })),
    eventsByMonth.keys(),
    releaseMonth,
    asOf ? { now: new Date(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) } : {},
  );
  // Each line's label, spread over two rows above the plot and degraded/hidden where the
  // measured width cannot fit them — for the visible months only, so nothing floats off a
  // zoomed axis.
  const labels = layoutPlumbLabels(zoom.data.map((d) => d.period), reasons, plot.width, eventsByMonth);

  const visibleMonths = new Set(zoom.data.map((d) => d.period));

  // The line and its axis draw only when the mart computed a trailing share for at least
  // one month (it is null only while trailing_reviews is 0).
  const hasRating = points.some((p) => p.trailing_positive_share !== null);
  const ratingAxis = ratingAxisFor(zoom.data);
  const ratingRow = (p: ReviewTimelinePoint): TooltipRow | null => {
    if (p.trailing_positive_share === null || p.trailing_reviews === null) return null;
    const positive = Math.round(p.trailing_positive_share * p.trailing_reviews);
    return {
      label: "Positive (trailing 3mo)",
      // The share AND the fraction it came from, so a 100% on three reviews reads as such.
      value: `${fmtPct(p.trailing_positive_share, 0)} · ${fmtCompact(positive)} of ${fmtCompact(p.trailing_reviews)}`,
      color: RATING_STROKE,
    };
  };

  return (
    <div>
      <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
        <ResponsiveContainer width="100%" height={VELOCITY_CHART_HEIGHT} onResize={plot.onResize}>
          <ComposedChart data={zoom.data} margin={{ top: PLUMB_LABEL_BAND, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <HatchDefs id={hatchId} color={BAR_MUTED_SOLID} />
          <XAxis
            dataKey="period"
            tick={{ fontSize: 10 }}
            tickFormatter={(v: string) => fmtMonth(v) ?? v}
            interval="preserveStartEnd"
            minTickGap={24}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
          />
          {/* Left: reviews per month (the bars). */}
          <YAxis
            yAxisId="reviews"
            tick={{ fontSize: 10 }}
            ticks={reviewsAxis.ticks}
            interval={0}
            domain={reviewsAxis.domain}
            tickFormatter={(v: number) => reviewsAxis.format(v)}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
          />
          {/* Right: positive share, trailing 3 months (the line). Always mounted so the
              plot keeps one width whether or not the line draws; hidden without data. */}
          <YAxis
            yAxisId="rating"
            orientation="right"
            hide={!hasRating}
            domain={ratingAxis.domain}
            ticks={ratingAxis.ticks}
            interval={0}
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => fmtPct(v, ratingAxis.decimals)}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          {eventMarker && visibleMonths.has(eventMarker.period) && (
            <ReferenceLine
              yAxisId="reviews"
              x={eventMarker.period}
              stroke="var(--text-primary)"
              strokeDasharray="3 4"
              label={{
                value: eventMarker.label,
                position: "insideTopRight",
                fontSize: 10,
                fill: "var(--text-secondary)",
              }}
            />
          )}
          {[...labels].map(([month, label]) => (
            <ReferenceLine
              key={`ev-${month}`}
              yAxisId="reviews"
              x={month}
              stroke="var(--text-muted)"
              strokeDasharray="2 5"
              strokeOpacity={month === releaseMonth ? 0.9 : 0.5}
              label={plumbLabelProps(label, month === releaseMonth, { left: VELOCITY_Y_AXIS_PX, right: VELOCITY_Y_AXIS_PX + plot.width })}
            />
          ))}
          <Tooltip
            cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as ReviewTimelinePoint;
              const rows: TooltipRow[] = [
                {
                  label: "Reviews",
                  value: fmtCompact(p.n_reviews),
                  color: p.period === peak.period ? "var(--brand)" : BAR_MUTED,
                },
                { label: "Positive", value: fmtCompact(p.n_positive) },
              ];
              const rating = ratingRow(p);
              if (rating) rows.push(rating);
              if (p.period === partial) rows.push({ label: "Note", value: partialNote(asOf) });
              const change = changeTooltipRow(reasons.get(String(label)));
              if (change) rows.push(change);
              for (const e of eventsByMonth.get(String(label)) ?? []) {
                const t = e.title.length > 60 ? `${e.title.slice(0, 57)}…` : e.title;
                rows.push({ label: e.kind.charAt(0).toUpperCase() + e.kind.slice(1), value: t, color: "var(--text-muted)" });
              }
              return <TooltipPanel title={fmtMonth(String(label)) ?? String(label)} rows={rows} />;
            }}
          />
          <Bar yAxisId="reviews" dataKey="n_reviews" radius={[2, 2, 0, 0]} maxBarSize={28} isAnimationActive={false}>
            {zoom.data.map((p) => (
              <Cell
                key={p.period}
                fill={
                  p.period === partial ? `url(#${hatchId})` : p.period === peak.period ? "var(--brand)" : BAR_MUTED
                }
                stroke={p.period === partial ? BAR_MUTED_SOLID : undefined}
                strokeDasharray={p.period === partial ? "2 2" : undefined}
              />
            ))}
            <LabelList dataKey="n_reviews" content={partialBarLabel(zoom.data.map((d) => d.period), partial)} />
          </Bar>
          {hasRating && (
            <Line
              yAxisId="rating"
              type="linear"
              dataKey="trailing_positive_share"
              stroke={RATING_STROKE}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: RATING_STROKE, stroke: "var(--surface-1)", strokeWidth: 2 }}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {zoom.selection && (
            <ReferenceArea yAxisId="reviews" x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />
          )}
          </ComposedChart>
        </ResponsiveContainer>
      </ZoomFrame>
      {/* Two marks on one plot, two scales: the legend says which axis reads which. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2 w-3 rounded-[1px]" style={{ background: BAR_MUTED }} />
          Reviews per month (left axis)
        </span>
        {hasRating && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-[2px] w-3" style={{ background: RATING_STROKE }} />
            Positive rating, trailing 3-month share (right axis)
          </span>
        )}
        {partial && (
          <span className="inline-flex items-center gap-1.5" data-testid="velocity-partial">
            <svg aria-hidden width="12" height="8">
              <rect width="12" height="8" fill={`url(#${hatchId})`} stroke={BAR_MUTED_SOLID} strokeDasharray="2 2" />
            </svg>
            {fmtMonth(partial)}: {partialNote(asOf)}
          </span>
        )}
      </div>
      {reasons.size > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
          <PlumbLegendTick />
        </div>
      )}
      <p className="mt-1 text-[11px] italic text-ink-muted">
        Highlighted: {fmtMonth(peak.period)} — the highest-volume month of reviews since launch.
      </p>
    </div>
  );
}

export default function GameProfile() {
  const { appid: appidParam } = useParams<{ appid: string }>();
  const navigate = useNavigate();
  const appid = appidParam ? Number(appidParam) : NaN;
  const validAppid = Number.isFinite(appid);
  const [selectedMetric, setSelectedMetric] = useState<DrilldownMetric | null>(null);
  const [view, setView] = useDetailView();

  const profileQ = useGameProfile(validAppid ? appid : null);
  const comparablesQ = useGameComparables(validAppid ? appid : null);
  const reviewsQ = useGameReviewsSummary(validAppid ? appid : null);
  const eventsQ = useGameEvents(validAppid ? appid : null);
  // null until the profile RESOLVES — the genre isn't known before then, and passing
  // "__all__" as a stand-in fired a throwaway catalog-wide /launch-curve on every mount
  // that the real genre request immediately superseded. Once resolved, a game with no
  // primary_genre still falls back to the catalog-wide cut, now as a deliberate choice
  // (the panel labels it "These games") rather than an artifact of a pending query.
  const genreCurveQ = useLaunchCurve(profileQ.data ? (profileQ.data.primary_genre ?? "__all__") : null);
  const benchmarksQ = useMarketBenchmarks();
  // How old the served data is — the as-of date decides which month is still being counted
  // and replaces the old hard-coded "21:00 UTC" schedule copy.
  const dataAge = useDataAge();
  // The game's own name once it lands; the app default holds until then (never
  // "undefined — Prospect"), so a history entry reads as the game you looked at.
  usePageTitle(profileQ.data?.name);
  const teardownQ = useGameTeardown(validAppid ? appid : null);
  // The daily player series' summary — the capture dates behind "Players now" (and the same
  // cache entry the Players drilldown opens on).
  const playersQ = useQuery({ ...gamePlayersQueryOptions(appid), enabled: validAppid });

  // "In niches" (sidebar, §4c) — up to 3 of the game's own top tags, resolved to their real
  // niche opportunity score via the SAME endpoint the Niche Finder/deep-dive use. Fixed-count
  // hook calls (not one per tag in a loop) so the Rules of Hooks hold before `profile` exists.
  const nicheTag0 = profileQ.data?.top_tags?.[0] ?? null;
  const nicheTag1 = profileQ.data?.top_tags?.[1] ?? null;
  const nicheTag2 = profileQ.data?.top_tags?.[2] ?? null;
  const niche0Q = useNicheDetail("tag", nicheTag0);
  const niche1Q = useNicheDetail("tag", nicheTag1);
  const niche2Q = useNicheDetail("tag", nicheTag2);
  // Right endpoint, WRONG CUT was the old bug: `find(v => v.window === "24m")` matches the first
  // 24m row the mart emits, which is the >=0-reviews cut — a different population than the niche
  // page this row LINKS TO, the Niche Finder and the Radar, all of which default to 24m/>=50.
  // Souls-like read 57.7 here against 77.3 there; Metroidvania read 58.7 here against 30.1 there.
  // Match DEFAULT_NICHE_CUT exactly; when the mart never built that cut for a niche, fall back
  // but SAY SO on the row rather than pass a different population off as the default.
  const inNiches = [
    { tag: nicheTag0, q: niche0Q },
    { tag: nicheTag1, q: niche1Q },
    { tag: nicheTag2, q: niche2Q },
  ]
    .filter((e): e is { tag: string; q: typeof niche0Q } => e.tag !== null)
    .map((e) => {
      const variants = e.q.data?.variants;
      const exact = findNicheVariant(variants, DEFAULT_NICHE_CUT);
      const variant = exact ?? variants?.[0];
      return {
        tag: e.tag,
        variant,
        // null on the default cut (nothing to disclose); the actual cut otherwise.
        offCut: exact || !variant ? null : `${variant.window === "24m" ? "24m" : "all-time"} · ≥${variant.min_reviews}`,
      };
    })
    .filter((e): e is { tag: string; variant: NicheRow; offCut: string | null } => e.variant?.opportunity_v2 != null);

  const profile = profileQ.data;
  const launch = launchFacts(profile ?? {});
  const ownersAsOfIso = profile?.owners_as_of ?? (dataAge.ownersAsOf ? dataAge.ownersAsOf.toISOString().slice(0, 10) : null);
  // The genre as prose ("a typical Action game"); null for the catalog-wide fallback.
  const genreName = profile?.primary_genre && profile.primary_genre !== "__all__" ? profile.primary_genre : null;

  // Rank-vs-genre rows with the reason a rank is missing, never an empty bar.
  const rankPeers = `${genreName ?? "catalog"} games with 50+ reviews`;
  const unranked = (what: string): { tag: string; detail: string } | null => {
    if (!profile) return null;
    const n = profile.total_reviews;
    if (n != null && n < 50) {
      return { tag: "not ranked", detail: `fewer than 50 reviews (${fmtInt(n)}) — ranks only cover ${rankPeers}` };
    }
    return { tag: "not ranked", detail: `no ${what} rank in this data build` };
  };
  const status = profile ? priceStatus(profile) : "paid";
  const rankRows = profile
    ? [
        {
          label: glossary("est_revenue").label,
          percentile: profile.rev_pct_in_genre,
          sentinel:
            profile.rev_pct_in_genre != null
              ? null
              : status === "free"
                ? { tag: "not applicable", detail: "free to play — no revenue estimate to rank; read reviews and owners instead" }
                : status === "unknown"
                  ? { tag: "not ranked", detail: "price unknown — no revenue estimate to rank" }
                  : unranked("revenue"),
        },
        { label: "Reviews", percentile: profile.reviews_pct_in_genre, sentinel: profile.reviews_pct_in_genre != null ? null : unranked("review") },
        {
          label: `Owners (SteamSpy${fmtDay(ownersAsOfIso) ? `, as of ${fmtDay(ownersAsOfIso)}` : " snapshot"})`,
          percentile: profile.owners_pct_in_genre,
          sentinel: profile.owners_pct_in_genre != null ? null : unranked("owners"),
        },
      ]
    : [];

  function toggleMetric(metric: DrilldownMetric) {
    setSelectedMetric((cur) => (cur === metric ? null : metric));
  }

  if (!validAppid) {
    // Every sibling dead end offers a way out — /games/999999999 and /games/-5 both print
    // "Back to search", /entity/<bogus> "Back to games", /niches/tag/<bogus> "Back to the
    // Niche Finder". This branch was the one that stranded the reader (measured on
    // production 2026-09-01: /games/notanumber rendered one sentence and no links).
    return (
      <BlueprintPanel>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-verdict-serious">Invalid game ID in the URL.</span>
          <Link to="/games" className="text-brand hover:underline">
            Back to search
          </Link>
        </div>
      </BlueprintPanel>
    );
  }

  if (profileQ.isLoading) {
    return <Loading label="Loading game…" className="p-6 text-sm" />;
  }

  if (profileQ.isError || !profile) {
    // "Not found" is claimed ONLY on a 404 — the API actually looked and said no. With the
    // API unreachable this branch used to render "Game not found: Failed to fetch"
    // (measured on production 2026-09-01), telling the reader their game had been deleted
    // when in fact nothing had been asked. Anything that is not a 404 is a failure to
    // answer, so it gets neutral copy plus a retry.
    const missing = isNotFound(profileQ.error);
    // The API's own 404 detail already reads "game not found: 999999999" — appending it raw
    // rendered "Game not found: game not found: 999999999". notFoundReason() keeps just the
    // appid; same helper NicheDetail uses.
    const reason = notFoundReason(profileQ.error);
    const backToSearch = (
      <Link
        to="/games"
        className="border border-borderstrong px-3 py-1.5 text-xs font-medium text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
      >
        Back to search
      </Link>
    );
    if (!missing) {
      return (
        <BlueprintPanel>
          <ErrorState
            title="Couldn't load this game"
            error={profileQ.error}
            onRetry={() => void profileQ.refetch()}
            action={backToSearch}
          />
        </BlueprintPanel>
      );
    }
    return (
      <BlueprintPanel>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-verdict-serious">Game not found{reason ? `: ${reason}` : "."}</span>
          <Link to="/games" className="text-brand hover:underline">
            Back to search
          </Link>
        </div>
      </BlueprintPanel>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/games" className="text-xs text-ink-muted hover:text-ink-primary">
        ← Back to search
      </Link>

      {/* Header — capsule + facts/tags/credits+socials/badges, unframed (per the 4c mock the
          blueprint treatment belongs to the capsule image and the content panels below, not
          the hero text block itself). */}
      <div className="flex flex-col gap-5 sm:flex-row">
        <BlueprintFrame className="h-32 w-full shrink-0 overflow-hidden sm:h-[86px] sm:w-[184px]">
          {profile.header_image ? (
            <img src={profile.header_image} alt="" className="h-full w-full object-cover" />
          ) : (
            <div
              className="grid h-full w-full place-items-center text-center text-[10px] uppercase tracking-[0.08em] text-ink-muted"
              style={{
                ...CONDENSED,
                backgroundImage:
                  "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 10%, transparent) 0 5px, transparent 5px 10px)",
              }}
            >
              Capsule 616×353
            </div>
          )}
        </BlueprintFrame>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h1 className="text-[32px] leading-[1.12] text-ink-primary">{profile.name ?? `App ${profile.appid}`}</h1>
                <a
                  href={`https://store.steampowered.com/app/${profile.appid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-brand hover:underline"
                >
                  View on Steam ↗
                </a>
              </div>
              {/* The header used to put ALL of this on one wrapping line at one weight: genre
                  badge, date, price, "Indie", "Self-published", catalog provenance, the
                  lifetime badge, "Demo", and the four social icons — ten heterogeneous things
                  competing as equals, so nothing was findable. Split by what each answers, and
                  badges are now spent only on the two that are a SIGNAL rather than a label. */}

              {/* What is this game: when, how much, what kind. An Early Access graduate reads
                  as both of its dates (the rebuilt mart dates a game from its first PUBLIC day),
                  and a $0 price is "Free" only when Steam says so — otherwise "Price unknown". */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
                <span className="inline-flex items-center gap-1" data-testid="launch-dates">
                  {launch.line}
                  {launch.kind !== "unknown" && (
                    <InfoTip
                      label="Launch date"
                      meaning="When the game was first buyable on Steam. For an Early Access game that is the day Early Access opened — its launch — and the 1.0 date is Steam's full release."
                      worked={
                        launch.kind === "ea-graduate"
                          ? `Early Access from ${launch.firstPublic}; 1.0 on ${launch.fullRelease}`
                          : `Released ${launch.firstPublic}`
                      }
                      source={launch.source ?? undefined}
                    />
                  )}
                </span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  {fmtListPrice(profile)}
                  {priceStatus(profile) === "unknown" && (
                    <InfoTip
                      label="Price unknown"
                      meaning="Steam gives no price for this game and doesn't mark it free — delisted, region-locked or not yet priced. Every revenue figure needs a list price, so none is estimated."
                      sentinel="no list price"
                    />
                  )}
                </span>
                {profile.primary_genre && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{profile.primary_genre}</span>
                  </>
                )}
                {profile.is_indie === 1 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Indie</span>
                  </>
                )}
                {/* When WE first saw the game — provenance about our own coverage, not a fact
                    about the game (it read "in catalog since Jul 2026" beside a 2015 release,
                    which looked like a date about the game). The quietest thing here, dropped
                    below `sm`, where it wrapped to a line of its own. */}
                {fmtDay(profile.first_seen) && (
                  <span className="hidden items-center gap-x-2 text-ink-muted sm:inline-flex">
                    <span aria-hidden="true">·</span>
                    <span>First seen by Prospect: {fmtDay(profile.first_seen)}</span>
                  </span>
                )}
              </div>

              {/* Outline accent tags — the game's own top tags, square-cornered accent-300
                  outline per the 4c mock. Reused verbatim (same tags/order) by the "In niches"
                  sidebar panel below, so header and sidebar read as the same set. */}
              {profile.top_tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {profile.top_tags.map((t) => (
                    <span key={t} className="border border-brand px-2 py-0.5 text-[11px] text-brand">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {/* Who made it — with their channels attached to them, instead of floating among
                  unrelated badges where they read as just more chrome. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
                {profile.developers ? (
                  <CreditLinks role="developer" joined={profile.developers} />
                ) : (
                  "Unknown developer"
                )}
                {profile.publishers && profile.publishers !== profile.developers && (
                  <>
                    <span aria-hidden="true">·</span>
                    <CreditLinks role="publisher" joined={profile.publishers} />
                  </>
                )}
                {/* Only when it SAYS something. "Self-published" is a real signal about who
                    carries the risk; "Has a publisher" appended to a line that already names
                    three of them is words for nothing — and on a phone it cost the line an
                    extra wrap. */}
                {profile.self_published === 1 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Self-published</span>
                  </>
                )}
                <SocialLinks
                  x={profile.dev_x_handle}
                  xUrl={profile.dev_x_url}
                  discordUrl={profile.dev_discord_url}
                  youtubeUrl={profile.dev_youtube_url}
                  bluesky={profile.dev_bluesky_handle}
                  blueskyUrl={profile.dev_bluesky_url}
                />
              </div>

              {/* Badges, and only here: a playable demo, and whether the audience survived.
                  Both are findings a reader would act on. The row disappears entirely when
                  neither applies, rather than leaving an empty gutter. */}
              {(profile.has_demo === true ||
                (profile.lifetime_alive === true && profile.lifetime_first_100_month) ||
                (profile.lifetime_alive === false && profile.lifetime_months != null)) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {profile.lifetime_alive === true && profile.lifetime_first_100_month && (
                    <span title="Reached a monthly average of 100+ concurrent players then and still averages 10+ (steamcharts monthly history, top-8k coverage).">
                      <Badge color={CSS_VAR.demand}>
                        Audience alive since {monthName(Number(profile.lifetime_first_100_month.slice(5, 7)))}{" "}
                        {profile.lifetime_first_100_month.slice(0, 4)}
                      </Badge>
                    </span>
                  )}
                  {profile.lifetime_alive === false && profile.lifetime_months != null && (
                    <span title="Audience lifetime: months from the game's first month averaging 100+ concurrent players to its first full month averaging under 10 (steamcharts monthly history, top-8k coverage).">
                      <Badge color={MONO.paper50}>
                        Audience: {fmtMonths(profile.lifetime_months)} (100+ → &lt;10)
                      </Badge>
                    </span>
                  )}
                  {profile.has_demo === true && (
                    <a
                      href={`https://store.steampowered.com/app/${profile.demo_appid ?? profile.appid}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Has a playable demo on Steam (from the game's own store metadata)"
                      className="hover:underline"
                    >
                      <Badge color={CSS_VAR.demand}>Demo</Badge>
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* Actions: "+ Watchlist" (hairline) / "+ Compare" (primary) — right-aligned per
                the 4c mock's header row. */}
            <div className="flex shrink-0 items-center gap-2.5">
              <WatchlistButton appid={profile.appid} name={profile.name} />
              <CompareToggle appid={profile.appid} name={profile.name} />
            </div>
          </div>
          {profile.short_description && (
            <p className="mt-3 line-clamp-2 text-xs text-ink-secondary">{profile.short_description}</p>
          )}
        </div>
      </div>

      {/* Body — 1.7fr main / 1fr sidebar, gap 22px. This IS the §4c mockup composition:
          review-velocity bars, then price history + praise/pan side by side, in the main
          column; Estimates (the accent-300 frame) then In niches in the sidebar. Everything
          the page had before that ISN'T drawn in the mockup — percentile, comparables, the
          Detailed extras, press footprint, etc. — moves to its own full-width stack below,
          under "More on {name}"; nothing is deleted, and every hook/trackEvent stays wired.

          PHONE ORDER (2026-09-23): below lg the two columns dissolve (display: contents) and
          the cards take an explicit order — header, Estimates, the opened drilldown, review
          velocity, then the rest. In DOM order the Estimates card sat ~3,200px down on a
          390px phone, under the velocity chart, the price card and the aspect list; the
          numbers a reader came for were the last thing they reached. From lg up the columns
          are real again and the sidebar stays sticky. */}
      <div className="flex flex-col gap-[22px] lg:grid lg:grid-cols-[1.7fr_1fr] lg:items-start">
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-[22px]">
          <BlueprintPanel
            className="order-3 min-w-0 lg:order-none"
            title="Review velocity since launch"
            action={<span className="kicker text-[11px] text-ink-muted">Monthly</span>}
          >
            {reviewsQ.isLoading && (
              // Reserves exactly what ReviewVelocityBars draws, so the card does not jump.
              <div style={{ height: VELOCITY_BLOCK_HEIGHT }}>
                <Loading className="h-full text-xs" />
              </div>
            )}
            {reviewsQ.isError && (
              <InlineError what="the review history" error={reviewsQ.error} onRetry={() => void reviewsQ.refetch()} />
            )}
            {reviewsQ.data && (
              <ReviewVelocityBars
                points={reviewsQ.data.timeline}
                events={withOneZero(eventsQ.data, profile)}
                asOf={dataAge.asOf}
                launchDate={launch.launchDate}
              />
            )}
          </BlueprintPanel>

          {/* FULL-WIDTH stack, not the mockup's sm:grid-cols-2 pair (changed 2026-08-25):
              pairing "What reviews praise / pan" with Price history squeezed the aspect
              panel into ~a third of the page, and its drill-down excerpts — two prose
              columns inside that third — wrapped at ~25 characters. Unreadable prose loses
              to mockup fidelity; both panels now get the main column's full measure. */}
          <div className="contents lg:grid lg:grid-cols-1 lg:gap-[22px]">
            {/* Price history (GET /api/games/{appid}/price-history ← signals.db, from
                2026-08-24) is a record per Steam price CHANGE, not a daily series: most games
                have one row. PriceHistoryChart owns the states — a sentence for "no change
                since tracking began", a step line on a time axis once the price has moved,
                and the missing / unavailable / not-reached-yet / failed empties. */}
            <BlueprintPanel className="order-4 min-w-0 lg:order-none" title="Price history">
              <PriceHistoryChart appid={appid} priceInitial={profile.price_initial} isFree={profile.is_free} />
            </BlueprintPanel>

            {/* AspectDivergingBars is "What players say about each aspect" — the full
                interactive component this page already had (drilldown into example
                reviews, standout badges, genre-baseline tick), moved here from its old home
                under a "Why it works" tab per §4c, which draws it as "What reviews praise /
                pan" on the main view rather than behind a second tab. */}
            <BlueprintPanel
              className="order-5 min-w-0 lg:order-none"
              title="What reviews praise / pan"
              subtitle={
                teardownQ.data
                  ? teardownQ.data.eligible_reviews
                    ? `${fmtInt(teardownQ.data.n_reviews_sampled)} sampled English reviews · text sentiment around each aspect, from a model trained on game reviews`
                    : "Not enough sampled English reviews for aspect mining on this title"
                  : undefined
              }
            >
              {teardownQ.isLoading && (
                <Loading className="h-24 text-xs" />
              )}
              {teardownQ.isError && (
                <InlineError what="the review aspects" error={teardownQ.error} onRetry={() => void teardownQ.refetch()} />
              )}
              {teardownQ.data && teardownQ.data.eligible_reviews && (
                <AspectDivergingBars appid={appid} aspects={teardownQ.data.review_aspects} />
              )}
              {teardownQ.data && !teardownQ.data.eligible_reviews && (
                <div className="flex h-24 items-center justify-center text-center text-xs text-ink-muted">
                  This game doesn't have enough sampled English reviews with text for aspect mining yet.
                </div>
              )}
            </BlueprintPanel>
          </div>
        </div>

        {/* Sidebar — Estimates (the one accent-300-bordered frame) then In niches. Sticky
            on desktop so it stays visible while the mockup's own main column scrolls. */}
        <div className="contents lg:sticky lg:top-4 lg:flex lg:flex-col lg:gap-[22px]">
          <GameEstimatesPanel
            className="order-1 lg:order-none"
            profile={profile}
            band={benchmarksQ.data?.cited.boxleiter_owners_per_review}
            players={playersQ.data}
            ownersAsOf={ownersAsOfIso}
            selected={selectedMetric}
            onSelect={toggleMetric}
          />

          {inNiches.length > 0 && (
            <BlueprintPanel
              className="order-6 lg:order-none"
              title={
                <span className="inline-flex items-center gap-1.5">
                  In niches
                  <InfoTip term="opportunity_v2" />
                </span>
              }
              subtitle="Opportunity score of the game's top tags, with its four parts (bars) and the supply brake (×) — hover the ⓘ for how each adds up."
            >
              <div className="flex flex-col gap-2.5 text-[13px]">
                {inNiches.map(({ tag, variant, offCut }) => (
                  <div key={tag} className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/niches/tag/${encodeURIComponent(tag)}`}
                        className="min-w-0 truncate text-ink-primary hover:text-brand hover:underline"
                      >
                        {tag}
                      </Link>
                      <span className="ml-auto shrink-0 text-[11px] text-ink-muted">Opportunity</span>
                      <OpportunityBreakdown row={variant} variant="compact" title={`Opportunity score — ${tag}`} className="shrink-0" />
                    </div>
                    {offCut && (
                      <span className="text-[10px] text-ink-muted">
                        {offCut} reviews — the ≥50 default cut isn't built for this niche
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {/* The scores above are the app-default cut, so clicking through to the niche page
                  (which opens on the same cut) shows the SAME number, not a second opinion. */}
              <p className="mt-3 border-t border-chartborder pt-2 text-[10px] text-ink-muted">
                On the default cut: games released in the last 24 months, ≥50 reviews — the cut the niche page opens on.
              </p>
            </BlueprintPanel>
          )}
        </div>

        {selectedMetric && (
          <BlueprintPanel
            className="order-2 min-w-0 lg:order-none lg:col-span-2"
            title={DRILLDOWN_META[selectedMetric].title}
            subtitle={DRILLDOWN_META[selectedMetric].subtitle}
            action={
              <button
                type="button"
                onClick={() => setSelectedMetric(null)}
                aria-label="Close drilldown"
                className="flex h-7 w-7 shrink-0 items-center justify-center text-ink-secondary hover:bg-page hover:text-ink-primary"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            }
          >
            <GameMetricDrilldown
              appid={profile.appid}
              metric={selectedMetric}
              profile={{ total_reviews: profile.total_reviews, live_players: profile.live_players }}
              asOf={dataAge.asOf}
            />
          </BlueprintPanel>
        )}
      </div>

      {/* Below the mockup composition: every section this page already had that §4c doesn't
          draw — percentile, comparables, the Detailed-only deep charts, and (folded in from
          the old "Why it works" tab, now that this page is one continuous view rather than
          two tabs) press footprint, notable coverage and caveats. Kept working verbatim —
          same hooks, same trackEvent calls — just relocated beneath the mockup's own layout
          instead of deleted. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-chartborder pt-4">
        <h4 className="kicker text-[13px] text-ink-primary/80">More on {profile.name ?? "this game"}</h4>
        <ViewToggle
          value={view}
          onChange={(v) => {
            setView(v);
            trackEvent("detail_view_toggle");
          }}
        />
      </div>

      <div className="flex flex-col gap-[22px]">
        {/* RANK VS GENRE (2026-09-23): PercentileMeter floors the rank (a 99.6 is "top 1%",
            never "P100"), explains it with the game's own rank, and a missing rank is a
            dashed rail with no median tick and a reason — the old empty bar with a tick in the
            middle read as P50. The ranks cover games with 50+ reviews (mart_game ranks among
            MIN_REVIEWS_DEFAULT = 50), which the old subtitle called "≥10". */}
        <BlueprintPanel
          title={glossary("percentile_vs_genre").label}
          subtitle={`Where this game sits among ${genreName ?? "catalog"} games with 50+ reviews: P73 = it beats 73% of them`}
        >
          <div className="flex flex-col gap-3">
            {rankRows.map((r) => (
              <PercentileMeter
                key={r.label}
                label={r.label}
                percentile={r.percentile}
                peers={rankPeers}
                color={CSS_VAR.demand}
                sentinel={r.sentinel ?? undefined}
              />
            ))}
          </div>
        </BlueprintPanel>

        {/* The chart-heavy expert cards live under the Detailed toggle; Simple keeps the
            plain-language reads only. */}
        {view === "detailed" && (
          <>
            {/* Two cards used to open this Detailed stack, both removed 2026-09-19 at the
                user's call: "Review timeline" (ReviewsTimelineChart: rating line + reviews-
                per-month bars) once "Review velocity since launch" above carried both series,
                and "Momentum over time" (GameTrendsChart: sampled reviews + avg live players
                with catalog/marketing event markers) as one lifetime chart too many. The
                trends endpoint and its query factory stay: GameMetricDrilldown reads them. */}

            {/* Genre-level benchmark card sits AFTER the game's own timeline — a game
                profile should lead with the game's own story, then the genre yardstick. */}
            <BlueprintPanel
              title="Launch shape — front-loaded vs. slow-burn"
              subtitle="How fast games in this genre earn their first-year reviews (a sales-momentum proxy) — whether to bet on the launch splash or a sustained slow burn."
            >
              {genreCurveQ.data &&
                (() => {
                  // One takeaway, off the same per-week bars drawn below (2026-09-23). The old
                  // callout graded the genre on its day-30 share (">= 60% front-loaded, <= 45%
                  // slow-burn") and called every real genre "Balanced" (they all sit at 46-50%)
                  // beside a chart that looked like a U — neither said what the data says.
                  const summary = launchShapeSummary(genreCurveQ.data.points, genreName);
                  if (!summary) return null;
                  return (
                    <div className="mb-3 flex items-start gap-1.5 border border-chartborder bg-page px-3 py-2 text-xs text-ink-secondary">
                      <p className="min-w-0" data-testid="launch-shape-headline">
                        {summary.headline}
                      </p>
                      <InfoTip term="launch_shape" worked={summary.worked} />
                    </div>
                  );
                })()}
              {genreCurveQ.isLoading && <Loading className="h-40 text-xs" />}
              {genreCurveQ.isError && (
                <InlineError what="the genre's launch curve" error={genreCurveQ.error} onRetry={() => void genreCurveQ.refetch()} />
              )}
              {genreCurveQ.data && <LaunchShapeBars points={genreCurveQ.data.points} height={220} />}
              {genreCurveQ.data && (
                <p className="mt-2 text-[11px] italic text-ink-muted">
                  Genre median across {fmtInt(genreCurveQ.data.points[0]?.n_games ?? 0)} {genreName ?? ""} titles at least a
                  year old — the yardstick for this game&apos;s own month-by-month reviews in Review velocity above.
                </p>
              )}
            </BlueprintPanel>

            <BlueprintPanel title="Language split" subtitle="Share of sampled reviews by language — a localization reference">
              {reviewsQ.isLoading && (
                <Loading className="h-24 text-xs" />
              )}
              {reviewsQ.isError && (
                <InlineError what="the language split" error={reviewsQ.error} onRetry={() => void reviewsQ.refetch()} />
              )}
              {reviewsQ.data && <LanguageSplitChart data={reviewsQ.data.language_split} />}
            </BlueprintPanel>

            <BlueprintPanel title="Playtime">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs text-ink-muted">Total playtime, sampled reviewers (all-time)</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span>
                      <span className="text-ink-muted">P25</span>{" "}
                      <span className="tabular font-medium text-ink-primary">{fmtMinutes(profile.playtime_p25)}</span>
                    </span>
                    <span>
                      <span className="text-ink-muted">P50</span>{" "}
                      <span className="tabular font-medium text-ink-primary">{fmtMinutes(profile.playtime_p50)}</span>
                    </span>
                    <span>
                      <span className="text-ink-muted">P75</span>{" "}
                      <span className="tabular font-medium text-ink-primary">{fmtMinutes(profile.playtime_p75)}</span>
                    </span>
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-ink-muted">Playtime at the time of review</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {reviewsQ.data?.playtime_at_review.map((p) => (
                      <span key={p.pctile}>
                        <span className="text-ink-muted">{p.pctile.toUpperCase()}</span>{" "}
                        <span className="tabular font-medium text-ink-primary">{fmtMinutes(p.value)}</span>
                      </span>
                    ))}
                    {reviewsQ.data && reviewsQ.data.playtime_at_review.length === 0 && (
                      <span className="text-ink-muted">Not enough sampled reviews.</span>
                    )}
                    {reviewsQ.isError && (
                      <InlineError
                        what="playtime at review"
                        error={reviewsQ.error}
                        onRetry={() => void reviewsQ.refetch()}
                        className="w-full"
                      />
                    )}
                  </div>
                </div>
              </div>
            </BlueprintPanel>
          </>
        )}

        <BlueprintPanel
          title="Comparables"
          subtitle={
            comparablesQ.data
              ? `Same genre (${comparablesQ.data.primary_genre ?? "no genre"}) · ${
                  comparablesQ.data.price_band.high <= 0.01
                    ? "free or unknown price, like this game"
                    : `list price ${fmtPrice(Math.max(0, comparablesQ.data.price_band.low))}–${fmtPrice(comparablesQ.data.price_band.high)}`
                } · most alike first, by tag overlap`
              : undefined
          }
        >
          {comparablesQ.isLoading && <Loading label="Loading comparables…" className="py-1 text-xs" />}
          {comparablesQ.isError && (
            <InlineError what="comparable games" error={comparablesQ.error} onRetry={() => void comparablesQ.refetch()} />
          )}
          {comparablesQ.data && comparablesQ.data.items.length === 0 && (
            <EmptyState
              className="py-6"
              title="No comparable titles"
              description="Nothing in this genre/price band matched closely enough to rank."
            />
          )}
          {comparablesQ.data && comparablesQ.data.items.length > 0 && (
            <TableScroll className="border border-chartborder">
              <table className="w-full min-w-[640px] text-xs">
                      {/* Every metric header explains itself (HeaderLabel + the glossary), and Tag
                          overlap works the TOP row's own tags through the Jaccard formula. */}
                      <thead>
                        <tr className="border-b border-chartborder text-left text-ink-muted">
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel label="Game" style={COMPARABLE_HEADER} />
                          </th>
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel label="Year" style={COMPARABLE_HEADER} />
                          </th>
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel term="launch_price" label="Price" style={COMPARABLE_HEADER} />
                          </th>
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel term="reviews" style={COMPARABLE_HEADER} />
                          </th>
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel term="positive_ratio" label="Positive" style={COMPARABLE_HEADER} />
                          </th>
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel
                              term="est_revenue"
                              style={COMPARABLE_HEADER}
                              worked={(() => {
                                const top = comparablesQ.data.items.find((c) => priceStatus(c) === "paid" && c.total_reviews != null);
                                return top && top.est_rev_reviews != null
                                  ? `${top.name ?? `App ${top.appid}`}: ${fmtInt(top.total_reviews)} reviews × 30 × ${fmtPrice(top.price_initial)} = ${fmtUsd(top.est_rev_reviews)}`
                                  : undefined;
                              })()}
                            />
                          </th>
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel term="tag_overlap" style={COMPARABLE_HEADER} worked={tagOverlapWorked(comparablesQ.data.items[0])} />
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparablesQ.data.items.map((c, _i, all) => (
                          <tr
                            key={c.appid}
                            className="cursor-pointer border-b border-chartborder/60 last:border-0 hover:bg-page"
                            onClick={() => navigate(`/games/${c.appid}`)}
                          >
                            <td className="max-w-[200px] truncate px-2 py-1.5 font-medium" title={c.name ?? undefined}>
                              {/* Focusable link so the table is keyboard-reachable; row onClick stays as a
                                  mouse convenience. */}
                              <Link
                                to={`/games/${c.appid}`}
                                onClick={(e) => e.stopPropagation()}
                                className="text-ink-primary hover:text-brand hover:underline"
                              >
                                {c.name ?? `App ${c.appid}`}
                              </Link>
                            </td>
                            <td className="tabular px-2 py-1.5">{c.release_year ?? "—"}</td>
                            <td className="tabular px-2 py-1.5">{fmtListPrice(c)}</td>
                            <td className="tabular px-2 py-1.5">{fmtInt(c.total_reviews)}</td>
                            <td className={clsx("tabular px-2 py-1.5", positiveRatioClass(c.positive_ratio))}>
                              {fmtPct(c.positive_ratio)}
                            </td>
                            <td className="tabular px-2 py-1.5">
                              {priceStatus(c) === "paid" && c.est_rev_reviews != null ? (
                                <span
                                  className="px-1.5 py-0.5"
                                  style={heatStyle(c.est_rev_reviews, ...heatDomain(all, (x) => x.est_rev_reviews))}
                                >
                                  {fmtUsd(c.est_rev_reviews)}
                                </span>
                              ) : (
                                // Free and unknown-price games have no estimate (NULL in the
                                // rebuilt mart) — flagged, never a bare dash or a "$0".
                                <SentinelTag>{priceStatus(c) === "free" ? "free to play" : "no price"}</SentinelTag>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1.5" title={`Shared tags: ${c.shared_tags.join(", ")}`}>
                                <Meter value={c.jaccard * 100} color={CSS_VAR.competition} />
                                <span className="tabular w-9 shrink-0 text-ink-secondary">{Math.round(c.jaccard * 100)}%</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                )}
              </BlueprintPanel>

        {/* THIS GAME'S PRESS FOOTPRINT (2026-09-23). The card used to open with "Where this
            genre gets attention" — the genre's marketing-channel mix — but mart_channel_mix has
            been press-only since the creator channels retired on 2026-08-25, so that half was
            always one "Press 100%" bar under copy still promising YouTube/Reddit/Twitch/X
            creator mentions and an audience-weighted hover that no longer exist. It is gone,
            and so is the "Coverage tone" bar: headline VADER that reads PC Gamer's "Balatro
            review" as negative and tracks a game's NAME more than its coverage (see
            components/NotableCoverageCard.tsx). What is left is what the scrape knows: who
            covered the game, and when. */}
        <BlueprintPanel
          title="Press & attention"
          subtitle="This game's own coverage in the tracked games-press outlets — journalist articles only (Steam News excluded)"
        >
          {teardownQ.isLoading && <Loading className="h-32 text-xs" />}
          {teardownQ.isError && (
            <InlineError what="the press coverage" error={teardownQ.error} onRetry={() => void teardownQ.refetch()} />
          )}
          {teardownQ.data && teardownQ.data.press.total_mentions === 0 && (
            <div className="flex h-24 items-center justify-center text-center text-xs text-ink-muted">
              No press coverage found for this game above the match-confidence floor.
            </div>
          )}
          {teardownQ.data && teardownQ.data.press.total_mentions > 0 && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-secondary">
                <span>
                  <span className="tabular font-medium text-ink-primary">{fmtInt(teardownQ.data.press.total_mentions)}</span>{" "}
                  press mention{teardownQ.data.press.total_mentions === 1 ? "" : "s"} across{" "}
                  <span className="tabular font-medium text-ink-primary">{fmtInt(teardownQ.data.press.n_sources)}</span> outlet
                  {teardownQ.data.press.n_sources === 1 ? "" : "s"}
                  {teardownQ.data.press.first_seen && (
                    <>
                      {" "}· {fmtDay(teardownQ.data.press.first_seen)} – {fmtDay(teardownQ.data.press.last_seen) ?? "?"}
                    </>
                  )}
                </span>
                <InfoTip
                  term="press_mentions"
                  worked={`${fmtInt(teardownQ.data.press.total_mentions)} matched mentions from ${fmtInt(
                    teardownQ.data.press.n_sources,
                  )} outlet${teardownQ.data.press.n_sources === 1 ? "" : "s"}${
                    teardownQ.data.press.first_seen
                      ? `, first ${fmtDay(teardownQ.data.press.first_seen)}, latest ${fmtDay(teardownQ.data.press.last_seen) ?? "unknown"}`
                      : ""
                  }`}
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs text-ink-muted">Mentions by outlet</div>
                  <PressBySourceChart data={teardownQ.data.press.by_source} />
                </div>
                <div>
                  <div className="mb-1 text-xs text-ink-muted">Coverage over time</div>
                  <PressTimelineChart points={teardownQ.data.press.timeline} asOf={dataAge.asOf} />
                </div>
              </div>
            </>
          )}
        </BlueprintPanel>

          {teardownQ.data && teardownQ.data.press.notable.length > 0 && (
            <NotableCoverageCard press={teardownQ.data.press} />
          )}

          {teardownQ.data && pageCaveats(teardownQ.data.caveats).length > 0 && (
            <BlueprintPanel title="Read this with caveats">
              <ul className="flex flex-col gap-1.5 text-xs text-ink-secondary">
                {pageCaveats(teardownQ.data.caveats).map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-ink-muted">·</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </BlueprintPanel>
          )}
      </div>
    </div>
  );
}
