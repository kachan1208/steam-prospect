import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AspectDivergingBars } from "../components/charts/AspectDivergingBars";
import { ChannelShareBars } from "../components/charts/ChannelShareBars";
import { GameMetricDrilldown, DRILLDOWN_META, type DrilldownMetric, type OwnersPerReview } from "../components/charts/GameMetricDrilldown";
import { LanguageSplitChart } from "../components/charts/LanguageSplitChart";
import { LaunchShapeBars } from "../components/charts/LaunchShapeBars";
import { PressBySourceChart } from "../components/charts/PressBySourceChart";
import { PressTimelineChart } from "../components/charts/PressTimelineChart";
import { PriceHistoryChart } from "../components/charts/PriceHistoryChart";
import { ReviewsTimelineChart } from "../components/charts/ReviewsTimelineChart";
import { TooltipPanel, type TooltipRow } from "../components/charts/TooltipPanel";
import { GameTrendsChart } from "../components/charts/GameTrendsChart";
import { NotableCoverageCard } from "../components/NotableCoverageCard";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { Loading } from "../components/ui/Loading";
import { SocialLinks } from "../components/ui/SocialLinks";
import { TableScroll } from "../components/ui/TableScroll";
import { Meter, BulletMeter } from "../components/ui/Meter";
import { ViewToggle } from "../components/ui/ViewToggle";
import { trackEvent } from "../lib/analytics";
import { gameWatchlistId, toggleGameWatchlist, useWatchlist, WATCHLIST_CAP } from "../lib/watchlist";
import {
  notFoundReason,
  useGameChannelMix,
  useGameComparables,
  useGameEvents,
  useGameProfile,
  useGameReviewsSummary,
  useGameTeardown,
  useLaunchCurve,
  useMarketBenchmarks,
  useNicheDetail,
  type GameEvent,
  type ReviewTimelinePoint,
} from "../lib/api";
import { COMPARE_CAP, toggleCompare, useCompareList } from "../lib/compareList";
import { splitEntities } from "../lib/entities";
import { estimatedUnits } from "../lib/estimates";
import { DEFAULT_NICHE_CUT, findNicheVariant } from "../lib/nicheSelection";
import { fmtAxisCompact, fmtCompact, fmtInt, fmtMinutes, fmtMonths, fmtPct, fmtPrice, fmtRevenue, fmtUsd, monthName } from "../lib/format";
import { heatDomain, heatStyle, positiveRatioClass } from "../lib/heat";
import { markerMonths } from "../lib/notable";
import { CSS_VAR, MONO} from "../lib/palette";
import { usePageTitle } from "../lib/usePageTitle";
import { useDetailView } from "../lib/viewMode";

const CONDENSED: CSSProperties = { fontFamily: '"Barlow Condensed", "Barlow", system-ui, sans-serif' };

/** "Review velocity since launch" bars (§4c) are muted accent-400 at the mockup's exact
 * 55% alpha (`rgba(148,188,227,.55)` in the mockup's inline SVG == #94bce3 == --accent-400),
 * not a paper alpha — the one mark on this page that isn't on the demand/competition mono
 * language in lib/palette.ts, kept local since that file is foundation-owned. */
const BAR_MUTED = "color-mix(in srgb, var(--accent-400) 55%, transparent)";

/** DuckDB TIMESTAMP strings ("2017-03-06 23:59:53" / "...53.255353") -> "2017-03-06". */
function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : "—";
}

/** ReviewTimelinePoint.period is "YYYY-MM" -> "Jul 2026", for chart tooltips/captions. */
function monthLabel(period: string): string {
  const m = Number(period.slice(5, 7));
  const y = period.slice(0, 4);
  return m >= 1 && m <= 12 ? `${monthName(m)} ${y}` : period;
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

/** One row of the sidebar Estimates panel — label left / condensed value right, doubling as
 * the click target for the metric drilldown when `onClick` is given (same tiles → chart
 * convention the old StatTile grid used, just laid out as list rows per the 4c mock). */
function EstimateRow({
  label,
  value,
  valueClassName,
  sub,
  onClick,
  active,
  help,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  sub?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  help?: string;
}) {
  const interactive = onClick !== undefined;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? (active ?? false) : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      title={help}
      className={clsx(interactive && "-mx-1 cursor-pointer px-1 py-0.5 transition-colors hover:bg-page", active && "bg-brand-tint")}
    >
      <div className="flex items-baseline gap-3">
        <span className="text-[13.5px] text-ink-secondary">
          {label}
          {help && <span aria-hidden className="ml-1 text-[10px] text-ink-muted/70">ⓘ</span>}
        </span>
        <span className={clsx("ml-auto shrink-0 text-[17px] font-semibold", valueClassName ?? "text-ink-primary")} style={CONDENSED}>
          {value}
        </span>
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}

/**
 * "Review velocity since launch" (§4c main chart) — the mockup draws this as bars, not the
 * line ReviewsTimelineChart already renders elsewhere on this page ("Reviews per month").
 * Rebuilt locally on raw recharts primitives (rather than restyling ReviewsTimelineChart.tsx
 * in place, or extending TimingBars.tsx — both live under components/charts/*, owned by
 * another agent for this rebuild) so it can match the mockup's two-tone bar language exactly:
 * every bar muted BAR_MUTED, one bar lifted to full accent-300.
 *
 * The mockup's data is illustrative WEEKLY bars; the real timeline this page has (from
 * useGameReviewsSummary, shared with ReviewsTimelineChart) is Steam's full-history MONTHLY
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
 */
function ReviewVelocityBars({
  points,
  eventMarker,
  events,
}: {
  points: ReviewTimelinePoint[];
  eventMarker?: { period: string; label: string };
  events?: GameEvent[];
}) {
  if (points.length === 0) {
    return (
      <div className="flex h-[150px] items-center justify-center text-center text-xs text-ink-muted">
        No full review history for this title yet — the timeline only charts complete data.
      </div>
    );
  }

  const peak = points.reduce((best, p) => (p.n_reviews > best.n_reviews ? p : best), points[0]);

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
  // One shared gate for the plumb lines (see lib/notable.ts markerMonths): adaptive
  // spike/drop detection so small/mid games mark too, a sparse-events fallback, a 14-line
  // readability cap, and the release always drawn. Spike months are marked event or not —
  // CS2's real inflections (2019 operations, the 2023-03 CS2 announcement, the 2023-09
  // release) predate our article scrape, so gating lines on having an event erased them
  // all. Every month's events stay readable in the tooltip regardless.
  const releaseMonth = (events ?? []).find((e) => e.kind === "release")?.event_date.slice(0, 7);
  const eventMonths = [
    ...markerMonths(
      points.map((p) => ({ period: p.period, value: p.n_reviews })),
      eventsByMonth.keys(),
      releaseMonth,
    ),
  ].sort();

  return (
    <div>
      <ResponsiveContainer width="100%" height={150}>
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
            tickFormatter={(v: number) => fmtAxisCompact(v)}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
          />
          {eventMarker && (
            <ReferenceLine
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
          {eventMonths.map((month) => (
            <ReferenceLine
              key={`ev-${month}`}
              x={month}
              stroke="var(--text-muted)"
              strokeDasharray="2 5"
              strokeOpacity={month === releaseMonth ? 0.9 : 0.5}
              label={
                month === releaseMonth
                  ? { value: "Released", position: "top", fill: "var(--text-muted)", fontSize: 9 }
                  : undefined
              }
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
              for (const e of eventsByMonth.get(String(label)) ?? []) {
                const t = e.title.length > 60 ? `${e.title.slice(0, 57)}…` : e.title;
                rows.push({ label: e.kind.charAt(0).toUpperCase() + e.kind.slice(1), value: t, color: "var(--text-muted)" });
              }
              return <TooltipPanel title={monthLabel(String(label))} rows={rows} />;
            }}
          />
          <Bar dataKey="n_reviews" radius={[2, 2, 0, 0]} maxBarSize={28}>
            {points.map((p) => (
              <Cell key={p.period} fill={p.period === peak.period ? "var(--brand)" : BAR_MUTED} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-2 text-[11px] italic text-ink-muted">
        Highlighted: {monthLabel(peak.period)} — the highest-volume month of reviews since launch.
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
  // The game's own name once it lands; the app default holds until then (never
  // "undefined — Prospect"), so a history entry reads as the game you looked at.
  usePageTitle(profileQ.data?.name);
  const teardownQ = useGameTeardown(validAppid ? appid : null);
  const channelMixQ = useGameChannelMix(validAppid ? appid : null);

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
        opp: variant?.opportunity_v2 ?? null,
        // null on the default cut (nothing to disclose); the actual cut otherwise.
        offCut: exact || !variant ? null : `${variant.window === "24m" ? "24m" : "all-time"} · ≥${variant.min_reviews}`,
      };
    })
    .filter((e) => e.opp !== null);

  const profile = profileQ.data;

  const revenueRange = useMemo(() => {
    const bx = benchmarksQ.data?.cited.boxleiter_owners_per_review;
    if (!profile || !bx || profile.total_reviews === null || profile.price_initial === null) return null;
    const r = profile.total_reviews;
    const p = profile.price_initial;
    return { low: r * bx.min * p, mid: profile.est_rev_reviews ?? r * bx.mid * p, high: r * bx.max * p };
  }, [profile, benchmarksQ.data]);

  // The revenue figure actually PRINTED in the Estimates panel, and the unit count that goes
  // with it. Both are the reviews-based (Boxleiter) estimator, so revenue ÷ list price === units
  // exactly — see lib/estimates.ts for why that estimator and not the owners one. Before this,
  // the panel printed reviews-based revenue against the owners-based `owners_mid`: Hollow Knight
  // showed $251.5M over 7.5M units at a $14.99 price, $33.53 a copy, against a footnote that
  // spells out the division. owners_mid is still shown, one line down, named as the other method.
  const estRevenue = revenueRange ? revenueRange.mid : profile?.est_rev_reviews ?? null;
  const estUnits = useMemo(
    () =>
      estimatedUnits(
        estRevenue,
        profile?.price_initial,
        profile?.total_reviews,
        // Only the cited benchmark ratio — never the owners-derived fallback below, which would
        // put the owners estimator back into the pair through the free-to-play branch.
        benchmarksQ.data?.cited.boxleiter_owners_per_review.mid ?? null,
      ),
    [estRevenue, profile?.price_initial, profile?.total_reviews, benchmarksQ.data],
  );

  // Owners-per-review ratio for the Owners/Revenue drilldowns — same source + fallback the
  // Owners/Revenue rows themselves imply: the cited Boxleiter mid when benchmarks are
  // loaded, else this game's own owners_mid/total_reviews ratio if both are known.
  const ownersPerReview = useMemo<OwnersPerReview | null>(() => {
    const bx = benchmarksQ.data?.cited.boxleiter_owners_per_review;
    if (bx) return { value: bx.mid, source: "benchmark" };
    if (profile?.owners_mid != null && profile.total_reviews) {
      return { value: profile.owners_mid / profile.total_reviews, source: "game" };
    }
    return null;
  }, [profile, benchmarksQ.data]);

  function toggleMetric(metric: DrilldownMetric) {
    setSelectedMetric((cur) => (cur === metric ? null : metric));
  }

  if (!validAppid) {
    return (
      <BlueprintPanel>
        <div className="py-8 text-center text-sm text-verdict-serious">Invalid game ID in the URL.</div>
      </BlueprintPanel>
    );
  }

  if (profileQ.isLoading) {
    return <Loading label="Loading game…" className="p-6 text-sm" />;
  }

  if (profileQ.isError || !profile) {
    // The API's own 404 detail already reads "game not found: 999999999" — appending it raw
    // rendered "Game not found: game not found: 999999999". notFoundReason() keeps just the
    // appid (or the real message for a non-404 failure); same helper NicheDetail uses.
    const reason = notFoundReason(profileQ.error);
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

              {/* What is this game: when, how much, what kind. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
                <span>{profile.release_date ?? "Release date unknown"}</span>
                <span aria-hidden="true">·</span>
                <span>{fmtPrice(profile.price_initial)}</span>
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
                    about the game, so it is the quietest thing here and it is dropped below
                    `sm`. On a phone it otherwise wrapped to a line of its own led by an
                    orphaned separator, spending a whole row on the least useful item. */}
                {profile.first_seen && !Number.isNaN(Date.parse(profile.first_seen)) && (
                  <span
                    className="hidden items-center gap-x-2 text-ink-muted sm:inline-flex"
                    title={`First seen in our catalog: ${profile.first_seen}`}
                  >
                    <span aria-hidden="true">·</span>
                    <span>
                      in catalog since{" "}
                      {new Date(profile.first_seen).toLocaleDateString(undefined, { year: "numeric", month: "short" })}
                    </span>
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
          under "More on {name}"; nothing is deleted, and every hook/trackEvent stays wired. */}
      <div className="grid grid-cols-1 gap-[22px] lg:grid-cols-[1.7fr_1fr] lg:items-start">
        <div className="flex min-w-0 flex-col gap-[22px]">
          <BlueprintPanel
            title="Review velocity since launch"
            action={<span className="kicker text-[11px] text-ink-muted">Monthly</span>}
          >
            {reviewsQ.isLoading && (
              <Loading className="h-[150px] text-xs" />
            )}
            {reviewsQ.data && <ReviewVelocityBars points={reviewsQ.data.timeline} events={eventsQ.data} />}
          </BlueprintPanel>

          {/* FULL-WIDTH stack, not the mockup's sm:grid-cols-2 pair (changed 2026-08-25):
              pairing "What reviews praise / pan" with Price history squeezed the aspect
              panel into ~a third of the page, and its drill-down excerpts — two prose
              columns inside that third — wrapped at ~25 characters. Unreadable prose loses
              to mockup fidelity; both panels now get the main column's full measure. */}
          <div className="grid grid-cols-1 gap-[22px]">
            {/* Price history went live 2026-08-24 (GET /api/games/{appid}/price-history ←
                signals.db daily US snapshots), so this is a real series now — days deep and
                growing daily. PriceHistoryChart owns the honest thin-data states (dots for
                1-2 points, step line at 3+, F2P / no-snapshots messaging). */}
            <BlueprintPanel title="Price history">
              <PriceHistoryChart appid={appid} priceInitial={profile.price_initial} />
            </BlueprintPanel>

            {/* AspectDivergingBars is "What players say about each aspect" — the full
                interactive component this page already had (drilldown into example
                reviews, standout badges, genre-baseline tick), moved here from its old home
                under a "Why it works" tab per §4c, which draws it as "What reviews praise /
                pan" on the main view rather than behind a second tab. */}
            <BlueprintPanel
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
                <div className="text-xs text-verdict-serious">
                  Failed to load review aspects{teardownQ.error instanceof Error ? `: ${teardownQ.error.message}` : "."}
                </div>
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
        <div className="flex flex-col gap-[22px] lg:sticky lg:top-4">
          <BlueprintFrame accent className="flex flex-col gap-2.5 px-[22px] py-[18px]">
            <div className="kicker text-[11px] text-brand">Estimates</div>
            <div className="flex flex-col gap-2.5">
              <EstimateRow
                label="Gross revenue"
                // The ratio is a FLAT 30 here, not genre-fitted, and the copy has to say the
                // arithmetic it actually does: mart_game's est_rev_reviews is
                // total_reviews × 30 × price_initial (etl/build_marts.py:1331) and the low/high
                // are the same reviews × price at the 20 and 55 ends of the cited band
                // (/api/market/benchmarks cited.boxleiter_owners_per_review {20, 30, 55}).
                // Checked on the live API: Hollow Knight 559,257 × 30 × $14.99 = $251,497,872.9,
                // exactly est_rev_reviews. Genre-fitted multipliers DO exist in the mart
                // (benchmarks.boxleiter_by_genre — Action slope 26.1, median 107.0) and the MCP
                // /api/estimate path uses them, but nothing on this panel does. Fix the words,
                // never the estimator: est_rev_reviews is the spine of /compare, comparables,
                // mart_niche.median_rev and mart_market.
                help="Estimated lifetime GROSS revenue: reviews × 30 owners-per-review × launch price. 30 is the Boxleiter MID applied flat to every game, not fitted per genre; the low–high range swaps in the 20 and 55 ends of the same cited band. An estimate with real error bars. Not net of Steam's cut, refunds or discounts."
                value={fmtRevenue(estRevenue, profile.price_initial === 0)}
                sub={
                  profile.price_initial === 0
                    ? "Free-to-play — no box revenue at $0 price"
                    : revenueRange
                      ? `${fmtUsd(revenueRange.low)} – ${fmtUsd(revenueRange.high)}`
                      : undefined
                }
                onClick={() => toggleMetric("revenue")}
                active={selectedMetric === "revenue"}
              />
              <EstimateRow
                label="Units sold"
                help="Estimated copies sold on the SAME reviews-based (Boxleiter) estimator as Gross revenue above — reviews × owners-per-review — so gross revenue ÷ launch price lands exactly here. The owners-based (SteamSpy bucket) estimate is a different method and is shown separately below the figure. Owned ≠ played ≠ paid full price."
                value={fmtCompact(estUnits)}
                sub={
                  <>
                    {profile.price_initial != null && profile.price_initial > 0 && estRevenue != null
                      ? `${fmtUsd(estRevenue)} ÷ ${fmtPrice(profile.price_initial)} launch price`
                      : "reviews × owners-per-review — no box revenue to divide at $0"}
                    {profile.owners_mid != null && (
                      <> · owners-based estimate: {fmtCompact(profile.owners_mid)} (different method)</>
                    )}
                  </>
                }
                onClick={() => toggleMetric("owners")}
                active={selectedMetric === "owners"}
              />
              <EstimateRow
                label="Reviews"
                help="The game's true Steam review count and positive share. Below ~80% positive starts costing visibility (Steam's 'Mostly Positive' threshold)."
                value={
                  <span className={positiveRatioClass(profile.positive_ratio)}>
                    {fmtInt(profile.total_reviews)} · {fmtPct(profile.positive_ratio)}
                  </span>
                }
                sub={[
                  `${fmtInt(profile.n_reviews_trailing_30d)} sampled in trailing 30d`,
                  profile.metacritic_score
                    ? profile.metacritic_url
                      ? undefined // link rendered separately below to stay clickable
                      : `Metacritic ${profile.metacritic_score}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onClick={() => toggleMetric("reviews")}
                active={selectedMetric === "reviews"}
              />
              {profile.metacritic_score && profile.metacritic_url && (
                <a
                  href={profile.metacritic_url}
                  target="_blank"
                  rel="noreferrer"
                  className="-mt-2 text-[11px] text-ink-muted hover:text-brand hover:underline"
                >
                  Metacritic {profile.metacritic_score}
                </a>
              )}
              <EstimateRow
                label="Players now"
                help="Concurrent players at our last nightly capture (~21-22:00 UTC) — a point sample, NOT the daily peak. Click for the daily history."
                value={profile.live_players != null ? fmtCompact(profile.live_players) : "—"}
                valueClassName="text-brand"
                sub={
                  [
                    profile.players_trend_7d_pct != null
                      ? `${profile.players_trend_7d_pct >= 0 ? "+" : ""}${profile.players_trend_7d_pct.toFixed(1)}% vs prior 7d`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                onClick={() => toggleMetric("live_players")}
                active={selectedMetric === "live_players"}
              />
            </div>
            <div className="mt-1 border-t border-chartborder pt-2.5 text-[11px] text-ink-muted">
              Gross revenue = reviews × 30 owners-per-review × launch price, lifetime — one flat catalog-wide ratio
              (the Boxleiter mid), not fitted per genre; the low–high range swaps in 20 and 55. Units sold is
              that same estimate before the price multiply, so gross revenue ÷ launch price = units exactly. The
              owners-based (SteamSpy bucket) figure noted beside it is a separate method, not the partner of this
              revenue. Reviews are a point-in-time read from the catalog, not verified sales data.
            </div>
          </BlueprintFrame>

          {inNiches.length > 0 && (
            <BlueprintPanel title="In niches">
              <div className="flex flex-col gap-2.5 text-[13px]">
                {inNiches.map(({ tag, opp, offCut }) => (
                  <div key={tag} className="flex flex-col">
                    <div className="flex items-baseline gap-2">
                      <Link
                        to={`/niches/tag/${encodeURIComponent(tag)}`}
                        className="min-w-0 truncate text-ink-primary hover:text-brand hover:underline"
                      >
                        {tag}
                      </Link>
                      <span className={clsx("ml-auto shrink-0 tabular", (opp as number) >= 70 ? "text-brand" : "text-ink-secondary")}>
                        opp {(opp as number).toFixed(1)}
                      </span>
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
                Opportunity v2 on the default cut: last 24 months, ≥50 reviews.
              </p>
            </BlueprintPanel>
          )}
        </div>
      </div>

      {selectedMetric && (
        <BlueprintPanel
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
            profile={{
              price_initial: profile.price_initial,
              total_reviews: profile.total_reviews,
              // The HEADLINE units the Estimates panel prints, not owners_mid: the owners curve
              // is cumulative reviews × owners-per-review, and its caption claims it "trends
              // toward the headline estimate" — true only if the headline is the same estimator.
              units_headline: estUnits,
              live_players: profile.live_players,
            }}
            ownersPerReview={ownersPerReview}
          />
        </BlueprintPanel>
      )}

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
        <BlueprintPanel
          title="Percentile vs. genre"
          subtitle={`Rank within ${profile.primary_genre ?? "its genre"} among titles with ≥10 reviews`}
        >
          <div className="flex flex-col gap-3">
            <BulletMeter
              label="Revenue"
              value={profile.rev_pct_in_genre !== null ? profile.rev_pct_in_genre / 100 : null}
              benchmark={0.5}
              benchmarkLabel="Genre median (P50)"
              color={CSS_VAR.demand}
              valueLabel={profile.rev_pct_in_genre !== null ? `P${Math.round(profile.rev_pct_in_genre)}` : "—"}
            />
            <BulletMeter
              label="Review count"
              value={profile.reviews_pct_in_genre !== null ? profile.reviews_pct_in_genre / 100 : null}
              benchmark={0.5}
              benchmarkLabel="Genre median (P50)"
              color={CSS_VAR.demand}
              valueLabel={profile.reviews_pct_in_genre !== null ? `P${Math.round(profile.reviews_pct_in_genre)}` : "—"}
            />
            <BulletMeter
              label="Owners"
              value={profile.owners_pct_in_genre !== null ? profile.owners_pct_in_genre / 100 : null}
              benchmark={0.5}
              benchmarkLabel="Genre median (P50)"
              color={CSS_VAR.demand}
              valueLabel={profile.owners_pct_in_genre !== null ? `P${Math.round(profile.owners_pct_in_genre)}` : "—"}
            />
          </div>
          {/* Keyed on price, not is_free — fmtRevenue's R6-Siege case: is_free can be set on
              titles with a real price and real revenue. */}
          {profile.price_initial === 0 && (
            <p className="mt-3 text-[11px] italic text-ink-muted">
              Revenue percentile isn't meaningful for free-to-play titles (box revenue is $0 at price $0) — read
              review-count and owners percentile instead.
            </p>
          )}
        </BlueprintPanel>

        {/* The chart-heavy expert cards live under the Detailed toggle; Simple keeps the
            plain-language reads only. */}
        {view === "detailed" && (
          <>
            <BlueprintPanel
              title="Review timeline"
              subtitle="From the sampled reviews table (not Steam's full review count) — a recency-biased sample for older/popular titles"
            >
              {reviewsQ.isLoading && (
                <Loading className="h-40 text-xs" />
              )}
              {reviewsQ.data && <ReviewsTimelineChart points={reviewsQ.data.timeline} appid={appid} />}
            </BlueprintPanel>

            <BlueprintPanel
              title="Momentum over time"
              subtitle="Monthly review velocity, live players, Twitch viewers, and creator mentions — the signals Prospect tracks over time (CCU/Twitch thicken as snapshots accumulate)"
            >
              <GameTrendsChart appid={profile.appid} />
            </BlueprintPanel>

            {/* Genre-level benchmark card sits AFTER the game's own timeline/momentum — a game
                profile should lead with the game's own story, then the genre yardstick. */}
            <BlueprintPanel
              title="Launch shape — front-loaded vs. slow-burn"
              subtitle="How fast games in this genre earn their first-year reviews (a sales-momentum proxy) — tells you whether to bet on a big launch splash or a sustained slow-burn."
            >
              {genreCurveQ.data &&
                (() => {
                  const pts = genreCurveQ.data.points;
                  const at = (d: number) => pts.find((p) => p.day === d)?.median_cum_fraction ?? null;
                  const d30 = at(30);
                  if (d30 == null) return null;
                  const d7 = at(7);
                  const d30pct = Math.round(d30 * 100);
                  const d7pct = d7 != null ? Math.round(d7 * 100) : null;
                  const shape = d30pct >= 60 ? "Front-loaded" : d30pct <= 45 ? "Slow-burn" : "Balanced";
                  const note =
                    shape === "Front-loaded"
                      ? "sales cluster at launch — the launch splash matters most here."
                      : shape === "Slow-burn"
                        ? "sales keep accruing all year — sustained marketing and updates pay off."
                        : "there's a launch spike, but the long tail keeps building — both matter.";
                  const genreLabel =
                    profile.primary_genre && profile.primary_genre !== "__all__" ? profile.primary_genre : "These";
                  return (
                    <div className="mb-3 border border-chartborder bg-page px-3 py-2 text-xs text-ink-secondary">
                      <span className="font-semibold text-ink-primary">{shape}.</span> {genreLabel} games land{" "}
                      <span className="font-semibold text-ink-primary">~{d30pct}%</span> of first-year reviews in the first
                      30 days{d7pct != null ? ` (${d7pct}% in week one)` : ""} — {note}
                    </div>
                  );
                })()}
              {genreCurveQ.isLoading && (
                <Loading className="h-40 text-xs" />
              )}
              {genreCurveQ.data && <LaunchShapeBars points={genreCurveQ.data.points} height={220} />}
              {genreCurveQ.data && (
                <p className="mt-2 text-[11px] italic text-ink-muted">
                  Share of first-year reviews earned in each window after launch — genre median across{" "}
                  {(genreCurveQ.data.points[0]?.n_games ?? 0).toLocaleString()} {profile.primary_genre &&
                    profile.primary_genre !== "__all__"
                    ? profile.primary_genre
                    : ""}{" "}
                  titles — a benchmark for this title's own month-by-month trajectory, shown on the Momentum card above.
                </p>
              )}
            </BlueprintPanel>

            {/* Genre-level like Launch shape above: the channel mix is a property of the genre
                (per-game channel data is too sparse), so it sits with the genre yardsticks. Hidden
                entirely (no empty card) when the genre has no channel rows or the mart predates
                the channel-mix ETL — same pattern as NotableCoverageCard below. */}
            {channelMixQ.data && channelMixQ.data.channels.length > 0 && (
              <BlueprintPanel
                title="Where this genre gets attention"
                subtitle={`Marketing-channel mix for ${channelMixQ.data.genre} — each channel's share of tracked coverage (press articles + YouTube/Reddit/Twitch/X creator mentions), a genre-level read, not this game's own footprint`}
              >
                <ChannelShareBars channels={channelMixQ.data.channels} />
                <p className="mt-3 text-[11px] italic text-ink-muted">
                  One press article = one creator mention = one unit of volume. Hover a channel for its audience-weighted
                  share — that read skews almost entirely toward big-subscriber channels, since a creator mention counts
                  their whole audience while a press article counts 1.
                </p>
              </BlueprintPanel>
            )}

            <BlueprintPanel title="Language split" subtitle="Share of sampled reviews by language — a localization reference">
              {reviewsQ.isLoading && (
                <Loading className="h-24 text-xs" />
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
              ? `Same genre (${comparablesQ.data.primary_genre ?? "—"}) · price band ${fmtPrice(
                  comparablesQ.data.price_band.low,
                )}–${fmtPrice(comparablesQ.data.price_band.high)} · ranked by tag overlap (on-demand, not precomputed)`
              : undefined
          }
        >
          {comparablesQ.isLoading && <Loading label="Loading comparables…" className="py-1 text-xs" />}
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
                      <thead>
                        <tr className="border-b border-chartborder text-left text-ink-muted">
                          <th className="px-2 py-1.5 font-medium">Game</th>
                          <th className="px-2 py-1.5 font-medium">Year</th>
                          <th className="px-2 py-1.5 font-medium">Price</th>
                          <th className="px-2 py-1.5 font-medium">Reviews</th>
                          <th className="px-2 py-1.5 font-medium">Positive</th>
                          <th className="px-2 py-1.5 font-medium">Est. revenue</th>
                          <th className="px-2 py-1.5 font-medium">Tag overlap</th>
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
                            <td className="tabular px-2 py-1.5">{fmtPrice(c.price_initial)}</td>
                            <td className="tabular px-2 py-1.5">{fmtInt(c.total_reviews)}</td>
                            <td className={clsx("tabular px-2 py-1.5", positiveRatioClass(c.positive_ratio))}>
                              {fmtPct(c.positive_ratio)}
                            </td>
                            <td className="tabular px-2 py-1.5">
                              <span
                                className="px-1.5 py-0.5"
                                style={heatStyle(c.est_rev_reviews, ...heatDomain(all, (x) => x.est_rev_reviews))}
                              >
                                {fmtRevenue(c.est_rev_reviews, c.price_initial === 0)}
                              </span>
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1.5" title={c.shared_tags.join(", ")}>
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

        <BlueprintPanel
          title="Press footprint"
          subtitle={
              teardownQ.data && teardownQ.data.press.total_mentions > 0
                ? `${fmtInt(teardownQ.data.press.total_mentions)} filtered mentions across ${teardownQ.data.press.n_sources} outlet${
                    teardownQ.data.press.n_sources === 1 ? "" : "s"
                  }${
                    teardownQ.data.press.first_seen
                      ? ` · ${dateOnly(teardownQ.data.press.first_seen)} – ${dateOnly(teardownQ.data.press.last_seen)}`
                      : ""
                  } · journalist coverage only (Steam News excluded)`
                : undefined
            }
          >
            {teardownQ.isLoading && (
              <Loading className="h-32 text-xs" />
            )}
            {teardownQ.data && teardownQ.data.press.total_mentions === 0 && (
              <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
                No press coverage found for this game above the match-confidence floor.
              </div>
            )}
            {teardownQ.data && teardownQ.data.press.total_mentions > 0 && (
              <>
                {teardownQ.data.press.press_pos_share != null &&
                  (() => {
                    const p = teardownQ.data.press;
                    const posPct = (p.press_pos_share as number) * 100;
                    const mc = p.mean_compound;
                    return (
                      <div className="mb-4">
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                          <span className="text-ink-muted">Coverage tone (headlines &amp; summaries)</span>
                          {/* The share is positive / (positive + negative) — the base printed
                              beside it has to be that same base, not n_scored_articles, or the
                              division a reader does on the line below fails (Hollow Knight:
                              58/12/31, so 83% is 58/70 and NOT 58/101). */}
                          <span className="tabular shrink-0 text-ink-secondary">
                            {fmtPct(p.press_pos_share, 0)} positive of {fmtInt(p.n_pos_articles + p.n_neg_articles)} rated
                          </span>
                        </div>
                        <div
                          className="relative h-3 bg-page"
                          title={`${p.n_pos_articles} positive / ${p.n_neg_articles} negative${
                            p.n_neutral_articles ? ` (${p.n_neutral_articles} neutral excluded)` : ""
                          } of ${p.n_scored_articles} scored articles`}
                        >
                          <div className="absolute inset-y-0 left-0" style={{ width: `${posPct}%`, backgroundColor: CSS_VAR.praise }} />
                          <div
                            className="absolute inset-y-0 right-0"
                            style={{ width: `${100 - posPct}%`, backgroundColor: CSS_VAR.complaint }}
                          />
                          <div className="absolute inset-y-0 w-[2px] bg-page" style={{ left: `calc(${posPct}% - 1px)` }} />
                        </div>
                        <div className="mt-1 text-[11px] text-ink-muted">
                          {fmtInt(p.n_pos_articles)} positive · {fmtInt(p.n_neg_articles)} negative
                          {p.n_neutral_articles > 0 && (
                            <> · {fmtInt(p.n_neutral_articles)} neutral (excluded from the share)</>
                          )}
                          {typeof mc === "number" && (
                            <>
                              {" · "}mean <span className="tabular">{mc >= 0 ? "+" : ""}{mc.toFixed(2)}</span>
                            </>
                          )}{" "}
                          · VADER on headlines/summaries (coarse — an outlet's framing, not a verdict)
                        </div>
                      </div>
                    );
                  })()}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs text-ink-muted">Mentions by outlet</div>
                    <PressBySourceChart data={teardownQ.data.press.by_source} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-ink-muted">Coverage over time</div>
                    <PressTimelineChart points={teardownQ.data.press.timeline} />
                  </div>
                </div>
              </>
            )}
          </BlueprintPanel>

          {teardownQ.data && teardownQ.data.press.notable.length > 0 && (
            <NotableCoverageCard press={teardownQ.data.press} />
          )}

          {teardownQ.data && teardownQ.data.caveats.length > 0 && (
            <BlueprintPanel title="Read this with caveats">
              <ul className="flex flex-col gap-1.5 text-xs text-ink-secondary">
                {teardownQ.data.caveats.map((c, i) => (
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
