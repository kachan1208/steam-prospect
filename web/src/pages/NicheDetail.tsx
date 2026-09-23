import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Histogram } from "../components/charts/Histogram";
import {
  NicheDistribution,
  type BucketSelection,
  type DistributionBucket,
} from "../components/charts/NicheDistribution";
import { PressTimelineChart } from "../components/charts/PressTimelineChart";
import { SaturationTrend } from "../components/charts/SaturationTrend";
import { TooltipPanel } from "../components/charts/TooltipPanel";
import { OpportunityBreakdown } from "../components/OpportunityBreakdown";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { HeaderLabel } from "../components/ui/HeaderLabel";
import { InfoTip } from "../components/ui/InfoTip";
import { KpiCell } from "../components/ui/KpiCell";
import { Loading } from "../components/ui/Loading";
import { BulletMeter } from "../components/ui/Meter";
import { SentinelTag } from "../components/ui/SentinelTag";
import { hasRevenueFigure, PriceText, RevenueText } from "../components/ui/GameMoney";
import { StatTile } from "../components/ui/StatTile";
import { TableScroll } from "../components/ui/TableScroll";
import { ViewToggle } from "../components/ui/ViewToggle";
import { trackEvent } from "../lib/analytics";
import { useDataAge } from "../lib/dataAge";
import { estimatedUnits } from "../lib/estimates";
import { nicheWatchlistId, toggleNicheWatchlist, useWatchlist, WATCHLIST_CAP } from "../lib/watchlist";
import {
  ApiError,
  errorMessage,
  isNotFound,
  nicheDetailQueryOptions,
  notFoundReason,
  useNicheDetail,
  useNicheDistribution,
  useNicheGames,
  type Dimension,
  type NicheDetail as NicheDetailData,
  type NicheGameRow,
  type NicheGameSortKey,
  type NicheGamesList,
  type NicheGamesParams,
  type NichePlayers,
  type NichePlayersMonthlyPoint,
  type NichePlayersPoint,
  type NicheRow,
  type NicheScope,
  type PressTimelinePoint,
  type Window,
} from "../lib/api";
import {
  axisScale,
  fmtCompact,
  fmtInt,
  fmtMonths,
  fmtPct,
  fmtPrice,
  fmtUsd,
  isFiniteNumber,
  titleCase,
  priceKind,
  PRICE_UNKNOWN_NOTE,
} from "../lib/format";
import { glossary, type GlossaryKey } from "../lib/glossary";
import { heatDomain, heatStyle } from "../lib/heat";
import { fillMonthGaps, partialMonth } from "../lib/monthSeries";
import { downloadCsv, exportNicheGamesCsv } from "../lib/nicheCsv";
import { paidCount, paidOnlyNote, paidStatSentinel, paidWithheld } from "../lib/nichePaid";
import { CSS_VAR } from "../lib/palette";
import { noMarketNote, readPlayersTrend } from "../lib/playersTrend";
import { usePageTitle } from "../lib/usePageTitle";
import { useMinWidth } from "../lib/useMinWidth";
import { useDetailView } from "../lib/viewMode";
import { DEFAULT_NICHE_CUT, findNicheVariant, formatNicheRef, nicheCombinedPath } from "../lib/nicheSelection";
// The headline is the Radar's dossier — same evaluation, same strings, same colour tokens
// as the board's tooltip (see the "the dossier, as the board prints it" block there).
import {
  DOSSIER_LABEL,
  ENTRANT_RATIO_CATALOG_NORM,
  ENTRANT_RATIO_PAR,
  WC_WINNER_TAKE_MOST,
  cutPopulationLabel,
  demandTrendWorked,
  failedCheckClause,
  failedChecks,
  radarBoardAbsence,
  radarDossier,
  radarSector,
  releasesYoyWorked,
} from "../lib/radarVerdict";
import { useDragZoom } from "../lib/useDragZoom";
import { SELECTION_AREA_PROPS, ZoomFrame } from "../components/charts/ZoomFrame";
import { nicheDetailPath } from "../lib/nichePath";

/** The condensed stack the foundation applies to h1–h6 and .kicker (index.css) — used inline
 * for KPI/panel numerals that aren't semantically headings, so they still read as the
 * blueprint identity's display type. */
const CONDENSED = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

/**
 * The niche deep-dive PAGE — the twin of /games/:appid, replacing the old right-hand
 * NicheDetailDrawer. Everything that decides what you see lives in the URL (the cut, the
 * tab, the scope, the distribution bucket selection), so a filtered view is a link you can
 * send — which is the whole reason this stopped being a drawer.
 *
 * READING ORDER (2026-09-23 review — the owner's rules applied top to bottom):
 *   1. the VERDICT, with every check it failed named beside it (never a bullish verdict over
 *      a failing deciding check, never a failure the reader has to go and find);
 *   2. "Read this first" — the red flags — ABOVE the headline numbers, on every width;
 *   3. the headline numbers, each with an ⓘ that works THIS niche's numbers through its
 *      formula, and sentinels (withheld / no data / emerging) marked in place;
 *   4. the Opportunity score WITH its parts (never a lone score).
 * Then the panels, which follow the cut chips; the headline never does (it is the Radar's
 * pinned cut, so a display chip can't move a verdict).
 */

// ---- route + URL contract ----------------------------------------------------------------

// The route pattern + link builder live in lib/nichePath.ts (eager modules — App's route
// table, RadarBoard — must be able to link here without statically importing this whole
// page module, or the route-level code splitting is defeated). Re-exported so the pages
// and tests that always imported them from here keep working.
export { NICHE_ROUTE_PATH, nicheDetailPath } from "../lib/nichePath";
// The partial-year rule moved to the chart that draws it; re-exported for the same reason.
export { partialTrendYear } from "../components/charts/SaturationTrend";

export const GAMES_PAGE_SIZE = 25;

/** Rows in the overview's "Top games" preview. It is a request `limit` now, not a `.slice()`
 * of a fixed top-8 the API happened to ship — see the panel for why. */
export const TOP_GAMES_PANEL_SIZE = 5;

const DIMENSIONS: Dimension[] = ["tag", "genre"];

export type DistMetric = "revenue" | "price";

// The chart owns the selection SHAPE (value edges, not bucket indices — see its own docs);
// this page owns where that selection lives, which is the URL.
export type { BucketSelection, DistributionBucket };

/** Query-string bounds per metric. Named to match the API's own game-list params so the
 * URL you share and the request that serves it read the same. */
const SELECTION_KEYS: Record<DistMetric, readonly [string, string]> = {
  revenue: ["rev_min", "rev_max"],
  price: ["price_min", "price_max"],
};

function readNum(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** A bucket brush is only a filter when BOTH bounds are present and ordered — a half-written
 * URL degrades to "no filter" rather than to a query the API would reject. */
export function readSelection(sp: URLSearchParams, metric: DistMetric): BucketSelection {
  const [minKey, maxKey] = SELECTION_KEYS[metric];
  const min = readNum(sp.get(minKey));
  const max = readNum(sp.get(maxKey));
  if (min === undefined || max === undefined || max <= min) return null;
  return { min, max };
}

/** Fold a chart selection into a COPY of the current query string. Null clears both bounds.
 * Always re-pages to the top: an offset from the old, wider result set would point past the
 * filtered one. */
export function writeSelection(
  sp: URLSearchParams,
  metric: DistMetric,
  selection: BucketSelection,
): URLSearchParams {
  const next = new URLSearchParams(sp);
  const [minKey, maxKey] = SELECTION_KEYS[metric];
  if (selection) {
    next.set(minKey, String(selection.min));
    next.set(maxKey, String(selection.max));
  } else {
    next.delete(minKey);
    next.delete(maxKey);
  }
  next.delete("offset");
  return next;
}

/**
 * THE GAMES SCOPE — indie first (2026-09-23 review: a niche's "top games" led with Monster
 * Hunter Wilds and ELDEN RING NIGHTREIGN, which tell a solo developer nothing about what
 * THEY can earn). The API's scope=indie keeps Steam's Indie-flagged games; unknown flags are
 * left out and counted. Default indie; ?scope=all is the "All games" toggle. Anything else
 * in the URL reads as the default.
 */
export const DEFAULT_SCOPE: NicheScope = "indie";

export function readScope(sp: URLSearchParams): NicheScope {
  return sp.get("scope") === "all" ? "all" : DEFAULT_SCOPE;
}

// The API's request-side sort names (routers/niches.py `_GAME_SORT`), not the row fields.
// Owners is deliberately absent there, so its column header stays inert.
const GAME_SORT_KEYS: NicheGameSortKey[] = ["revenue", "price", "reviews", "release_year", "name"];

/** URL query string → the games request. The two bucket selections are the cross-filter:
 * whatever is brushed on the revenue/price histograms lands here as the rev_min/rev_max and
 * price_min/price_max bounds, so the table below the charts always shows exactly the
 * selected slice — in the page's scope. */
export function readGamesParams(
  sp: URLSearchParams,
  cut: { win: Window; min_reviews: number },
): NicheGamesParams {
  const sortRaw = sp.get("sort") as NicheGameSortKey | null;
  const revenue = readSelection(sp, "revenue");
  const price = readSelection(sp, "price");
  return {
    win: cut.win,
    min_reviews: cut.min_reviews,
    sort: sortRaw && GAME_SORT_KEYS.includes(sortRaw) ? sortRaw : "revenue",
    order: sp.get("order") === "asc" ? "asc" : "desc",
    limit: GAMES_PAGE_SIZE,
    // The API caps offset at 50_000; a hand-edited URL past it would 422 the whole table.
    offset: Math.min(50_000, Math.max(0, Math.floor(readNum(sp.get("offset")) ?? 0))),
    rev_min: revenue?.min,
    rev_max: revenue?.max,
    price_min: price?.min,
    price_max: price?.max,
    scope: readScope(sp),
  };
}

export function selectionLabel(metric: DistMetric, selection: NonNullable<BucketSelection>): string {
  const fmt = metric === "revenue" ? fmtUsd : fmtPrice;
  return `${metric === "revenue" ? "Revenue" : "Price"} ${fmt(selection.min)} – ${fmt(selection.max)}`;
}

/**
 * Which scope a games response ACTUALLY applied. An API that predates `scope` ignores the
 * param and serves every game without saying so — the page then says "all games" (and why),
 * never labels them indie.
 */
export function appliedScope(requested: NicheScope, res: Pick<NicheGamesList, "scope"> | undefined): {
  scope: NicheScope;
  unsupported: boolean;
} {
  if (!res) return { scope: requested, unsupported: false };
  if (res.scope === undefined) return { scope: "all", unsupported: requested === "indie" };
  return { scope: res.scope, unsupported: false };
}

/** "Last 24 months · ≥50 reviews" — a cut chip's label, the same words every count uses. */
function variantLabel(v: Pick<NicheRow, "window" | "min_reviews">): string {
  const s = cutPopulationLabel(v.window, v.min_reviews);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TIER_HINT: Record<string, string> = {
  micro: "buildable game concept",
  theme: "setting/aesthetic — attach it to a game type",
  umbrella: "genre container, not a buildable niche",
  meta: "reception tag, never buildable",
  genre: "Steam genre",
};

/** The tier badge in plain words (2026-09-23 review: "micro tier" / "umbrella" were jargon).
 * Same vocabulary as the Niche Finder's tier chips. */
const TIER_BADGE: Record<string, string> = {
  micro: "game type",
  theme: "theme",
  umbrella: "broad genre",
  meta: "review tag",
  genre: "Steam genre",
};

/** The Est. revenue ⓘ, plus what its "Price unknown" sentinel means — the same note every
 * other games table carries (lib/format.ts PRICE_UNKNOWN_NOTE). */
const EST_REVENUE_NOTES = `${glossary("est_revenue").notes ?? ""} ${PRICE_UNKNOWN_NOTE}`.trim();

/** The falsification rules from the growth-gate work, rendered as read-this-first flags:
 * a niche that LOOKS open can be a market in decline, a hits-only market, or not solo-
 * buildable — each check names the trap before the shiny score gets believed. */
function declineFlags(v: NicheRow, players: NichePlayers | null): { serious: boolean; text: string }[] {
  const flags: { serious: boolean; text: string }[] = [];
  if (v.saturation_yoy != null && v.saturation_yoy < -0.05) {
    flags.push({
      serious: v.saturation_yoy < -0.15,
      text: `Release pipeline shrinking ${fmtPct(Math.abs(v.saturation_yoy))}/yr — "low competition" here is everyone leaving, not an open market.`,
    });
  }
  // The same par the verdict trace's newcomer row uses — it moves with the constant's re-fit.
  if (v.entrant_ratio != null && v.entrant_ratio < ENTRANT_RATIO_PAR) {
    flags.push({
      serious: v.entrant_ratio < 0.7,
      text: `Recent entrants earn ${v.entrant_ratio.toFixed(2)}× the back catalog's median (catalog norm ~${ENTRANT_RATIO_CATALOG_NORM}×) — newcomers underearn here.`,
    });
  }
  if (v.winner_concentration != null && v.winner_concentration > WC_WINNER_TAKE_MOST) {
    flags.push({
      serious: false,
      text: `Winner-take-most: the top 5% of titles hold ${fmtPct(v.winner_concentration)} of revenue — expect the median outcome, not the hits.`,
    });
  }
  const paid = paidCount(v);
  if (v.median_rev == null && paid !== null && paidWithheld(v)) {
    flags.push({
      serious: true,
      text: `Only ${fmtInt(paid)} of its ${fmtInt(v.n_games)} games sell for a price — too few to estimate what a paid game earns here, so every revenue figure is withheld. Most of this niche is free-to-play or unpriced.`,
    });
  }
  if (v.solo_viability != null && v.solo_viability < 0.8) {
    flags.push({
      serious: v.solo_viability < 0.6,
      // "Most niches: 95–99%" — the catalog median is 97.5%; this said "norm ~90%", which is
      // the bottom tenth of the catalog, not its norm (see radarVerdict.ts).
      text: `Leans multiplayer: only ${fmtPct(v.solo_viability)} of its games can be played single-player (most niches: 95–99%) — netcode, servers and a live player base come with it.`,
    });
  }
  if (v.lifetime_survival_12m != null && v.lifetime_survival_12m < 0.5) {
    flags.push({
      serious: true,
      text: "Short-lived niche: fewer than half of its 100+-player games still hold 10+ a year later.",
    });
  }
  const trend = readPlayersTrend(players);
  const own = players?.players_trend_7d_pct;
  const rel = players?.players_trend_7d_rel_pct;
  if (isFiniteNumber(own)) {
    if (trend.hasMarket && isFiniteNumber(rel) && rel < -10) {
      flags.push({
        serious: false,
        text: `Live players ${trend.value} this week ${trend.vsMarket} — the niche trailed the whole market.`,
      });
    } else if (!trend.hasMarket && own < -10) {
      flags.push({
        serious: false,
        text: `Live players down ${Math.abs(own).toFixed(1)}% vs the prior 7 days, counting games measured in both weeks — a Steam-wide week can move every niche, so check the market before reading it as decline.`,
      });
    }
  }
  return flags;
}

function PlayersSeriesChart({ points }: { points: NichePlayersPoint[] }) {
  const zoom = useDragZoom(points, "date");
  if (points.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
        No daily series yet — fewer than 10 of this niche's games have been measured.
      </div>
    );
  }
  const y = axisScale(Math.max(0, ...points.map((p) => p.total_players ?? 0)), "count");
  return (
    <ZoomFrame zoomed={zoom.zoomed} dragging={zoom.dragging} outOfRange={zoom.outOfRange} onReset={zoom.reset}>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={zoom.data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} {...zoom.handlers}>
          <CartesianGrid stroke="var(--gridline)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(v: string) => v.slice(5)}
            interval="preserveStartEnd"
            minTickGap={24}
            tickLine={false}
            axisLine={{ stroke: "var(--baseline)" }}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            ticks={y.ticks}
            interval={0}
            domain={y.domain}
            tickFormatter={(v: number) => y.format(v)}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: "var(--baseline)" }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as NichePlayersPoint;
              return (
                <TooltipPanel
                  title={String(label)}
                  rows={[
                    { label: "Total players", value: fmtCompact(p.total_players), color: CSS_VAR.demand },
                    {
                      label: `Measured that day (${fmtInt(p.n_games_measured)} games)`,
                      value: p.measured_players != null ? fmtCompact(p.measured_players) : "—",
                      color: CSS_VAR.competition,
                    },
                  ]}
                />
              );
            }}
          />
          <Line
            type="linear"
            dataKey="total_players"
            stroke={CSS_VAR.demand}
            strokeWidth={2}
            dot={points.length <= 45 ? { r: 2.5, fill: CSS_VAR.demand, strokeWidth: 0 } : false}
          />
          {zoom.selection && <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} {...SELECTION_AREA_PROPS} />}
        </LineChart>
      </ResponsiveContainer>
    </ZoomFrame>
  );
}

/**
 * The niche's monthly press timeline as the SHARED press chart reads it (2026-09-23). This
 * page used to carry its own copy of PressTimelineChart (NichePressChart) that drew the
 * mart's SPARSE months on a category axis, so a month without coverage vanished and two bars
 * a year apart sat side by side as if consecutive. The months are filled with zeros first.
 */
export function nichePressTimeline(points: readonly { month: string; n_articles: number }[]): PressTimelinePoint[] {
  return fillMonthGaps(
    points.map((p) => ({ period: p.month, n_mentions: p.n_articles })),
    (p) => p.period,
    (period) => ({ period, n_mentions: 0 }),
  );
}

/** A revenue figure, or the reason it has none ("withheld" on the rebuilt mart). */
function usdOrWhy(row: NicheRow, value: number | null | undefined): string {
  if (isFiniteNumber(value)) return fmtUsd(value);
  return paidWithheld(row) ? "withheld" : "no data";
}

// ---- page --------------------------------------------------------------------------------

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "games", label: "Games & distribution" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** "Indie games | All games" — one control, one URL param (?scope=all), used by the overview
 * panel and the games tab alike. */
function ScopeToggle({ scope, onChange }: { scope: NicheScope; onChange: (s: NicheScope) => void }) {
  const opts: { v: NicheScope; label: string; title: string }[] = [
    {
      v: "indie",
      label: "Indie games",
      title: "Only games the developer tagged Indie on Steam — the comparables a small team can learn from",
    },
    { v: "all", label: "All games", title: "Every game in the niche, big publishers included" },
  ];
  return (
    <div className="inline-flex border border-ink-primary/25" role="group" aria-label="Which games to list">
      {opts.map((o, i) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={scope === o.v}
          onClick={() => onChange(o.v)}
          title={o.title}
          className={clsx(
            "px-2.5 py-1 text-[11px] font-medium transition-colors",
            i > 0 && "border-l border-ink-primary/25",
            scope === o.v ? "bg-brand text-brand-fg" : "text-ink-muted hover:text-ink-secondary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "150 indie games · last 24 months · ≥50 reviews · 13 with an unknown indie flag left out"
 * — every list says which games it counts. */
function ScopeLine({
  total,
  scope,
  unsupported,
  nScopeUnknown,
  population,
  filtered,
}: {
  total: number | null;
  scope: NicheScope;
  unsupported: boolean;
  nScopeUnknown: number | null | undefined;
  population: string;
  filtered?: boolean;
}) {
  return (
    <span className="text-[11px] text-ink-muted" data-testid="games-scope-line">
      {total != null ? `${fmtInt(total)} ${scope === "indie" ? "indie " : ""}game${total === 1 ? "" : "s"}` : "Games"}
      {" · "}
      {population}
      {filtered ? " · in the selected buckets" : ""}
      {scope === "indie" && nScopeUnknown != null && nScopeUnknown > 0 && (
        <> · {fmtInt(nScopeUnknown)} with an unknown indie flag left out</>
      )}
      {unsupported && (
        <>
          {" "}
          <SentinelTag>all games — indie filter not in this data build</SentinelTag>
        </>
      )}
    </span>
  );
}

export default function NicheDetail() {
  const { dimension: dimensionParam, key: keyParam } = useParams<{ dimension: string; key: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [view, setView] = useDetailView();
  const dataAge = useDataAge();
  const wide = useMinWidth(640);
  // Persisted since lib/watchlist.ts landed — the earlier local-only toggle was honest about
  // not saving, but it left the Watchlist page unreachable in practice: nothing could put an
  // entry into it. Same versioned-localStorage store the Watchlist page reads.
  const watchlistEntries = useWatchlist();

  const dimension = DIMENSIONS.includes(dimensionParam as Dimension) ? (dimensionParam as Dimension) : null;
  // React Router has already decoded the segment (and restored an escaped "/"), so this is
  // the niche key exactly as the finder linked it.
  const nicheKey = keyParam ?? null;
  // The niche key is in the route, so the title is right from the first paint.
  usePageTitle(nicheKey);
  const watchlisted =
    dimension != null &&
    nicheKey != null &&
    watchlistEntries.some((e) => e.id === nicheWatchlistId(dimension, nicheKey));

  const tab: TabKey = searchParams.get("tab") === "games" ? "games" : "overview";
  // DEFAULT_NICHE_CUT is the single definition of "no override" — shared with the finder and
  // with GameProfile's "In niches" rail, so a score quoted there is this page's score.
  const urlWindow: Window = searchParams.get("win") === "all" ? "all" : DEFAULT_NICHE_CUT.win;
  const urlMinReviews = readNum(searchParams.get("min_reviews")) ?? DEFAULT_NICHE_CUT.min_reviews;
  const scope = readScope(searchParams);

  const detailQ = useNicheDetail(dimension ?? "tag", dimension ? nicheKey : null);
  const detail = detailQ.data;
  // Drag-to-zoom for the full-history players line, inlined in this render. Its hook lives up
  // here, above every early return below, because a hook that runs only on the loaded frame
  // changes hook order between renders.
  const playersMonthlyZoom = useDragZoom(detail?.players?.monthly ?? [], "month");

  // TAG ALIASES (2026-09-23). Steam renamed or merged some tag spellings ("Rogue-like" →
  // "Roguelike"), and the mart serves an old spelling as its canonical niche with alias_of
  // set. The URL is REPLACED with the canonical key (no history entry for the old spelling —
  // nobody should go "back" to it), the answer is seeded into the canonical key's cache entry
  // so the swap doesn't refetch, and a one-line note says what happened.
  const aliasFrom = (location.state as { aliasFrom?: string } | null)?.aliasFrom ?? null;
  useEffect(() => {
    if (!dimension || !nicheKey || !detail?.alias_of) return;
    const canonical = detail.canonical_key ?? detail.alias_of;
    if (!canonical || canonical === nicheKey) return;
    queryClient.setQueryData(nicheDetailQueryOptions(dimension, canonical).queryKey, detail);
    navigate(
      { pathname: nicheDetailPath(dimension, canonical), search: location.search },
      { replace: true, state: { aliasFrom: detail.requested_key ?? nicheKey } },
    );
  }, [detail, dimension, nicheKey, navigate, location.search, queryClient]);

  // The cut shown is whatever the URL asks for, falling back to the nearest materialized
  // variant — the mart only builds a handful of (window × min_reviews) combinations.
  const activeVariant = useMemo<NicheRow | null>(() => {
    const variants = detail?.variants ?? [];
    return (
      variants.find((v) => v.window === urlWindow && v.min_reviews === urlMinReviews) ??
      variants.find((v) => v.window === urlWindow) ??
      variants[0] ??
      null
    );
  }, [detail, urlWindow, urlMinReviews]);

  const cut = useMemo(
    () => ({
      win: (activeVariant?.window as Window | undefined) ?? urlWindow,
      min_reviews: activeVariant?.min_reviews ?? urlMinReviews,
    }),
    [activeVariant, urlWindow, urlMinReviews],
  );

  // THE HEADLINE READS THE RADAR'S CUT, NOT THE CHIPS' (2026-09-09). The board pins its
  // stats cut (24m × ≥50 — DEFAULT_NICHE_CUT, the same object) because a verdict that moves
  // when a display chip is clicked is not a verdict (Radar.tsx's BOARD_WINDOW doc). The
  // dossier strip below inherits that rule: it is judged on this variant whatever chip is
  // lit, and the caption under it says so. The chips keep driving everything under them
  // (top games, distributions, the games table). Exact match on BOTH axes, never a near
  // miss — a near miss is a different population (lib/nicheSelection.ts).
  const radarVariant = useMemo<NicheRow | null>(
    () => findNicheVariant(detail?.variants, DEFAULT_NICHE_CUT) ?? null,
    [detail],
  );

  const gamesParams = useMemo(() => readGamesParams(searchParams, cut), [searchParams, cut]);
  const revenueSelection = readSelection(searchParams, "revenue");
  const priceSelection = readSelection(searchParams, "price");
  const hasSelection = revenueSelection !== null || priceSelection !== null;

  // The drill-down endpoints only exist after a mart rebuild; both are scoped to the games
  // tab so the overview never waits on them.
  const onGamesTab = tab === "games";
  const gamesQ = useNicheGames(dimension ?? "tag", dimension && onGamesTab ? nicheKey : null, gamesParams);
  // The overview's "Top games" panel reads the SAME cut-aware endpoint as the games tab's
  // table — see the panel itself for the measurement that forced it. It asks for the cut and
  // the scope ONLY: no rev_min/price_min, because this panel is "the niche's biggest games at
  // this cut", not the histogram-brushed slice (the brush belongs to the table below).
  const topGamesParams = useMemo<NicheGamesParams>(
    () => ({
      win: cut.win,
      min_reviews: cut.min_reviews,
      sort: "revenue",
      order: "desc",
      limit: TOP_GAMES_PANEL_SIZE,
      offset: 0,
      scope,
    }),
    [cut, scope],
  );
  const topGamesQ = useNicheGames(dimension ?? "tag", dimension && !onGamesTab ? nicheKey : null, topGamesParams);
  const distParams = useMemo(() => ({ ...cut, scope }), [cut, scope]);
  const revenueDistQ = useNicheDistribution(dimension ?? "tag", dimension && onGamesTab ? nicheKey : null, "revenue", distParams);
  const priceDistQ = useNicheDistribution(dimension ?? "tag", dimension && onGamesTab ? nicheKey : null, "price", distParams);

  useEffect(() => {
    if (dimension && nicheKey) trackEvent("niche_open");
  }, [dimension, nicheKey]);

  const patch = useCallback(
    (next: URLSearchParams) => {
      // PUSH, not replace (2026-09-23): a tab, a sort, a page, a cut or a brushed bucket is a
      // step the reader took, and Back should undo it — the /games convention. With replace,
      // Back left the page entirely from three tabs deep. (The alias redirect above is the
      // one replace: the old spelling is not a place anyone should go back to.)
      setSearchParams(next);
    },
    [setSearchParams],
  );

  const setParam = useCallback(
    (updates: Record<string, string | number | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      patch(next);
    },
    [searchParams, patch],
  );

  const setScope = useCallback(
    (s: NicheScope) => setParam({ scope: s === DEFAULT_SCOPE ? null : s, offset: null }),
    [setParam],
  );

  const onSelectionChange = useCallback(
    (metric: DistMetric, selection: BucketSelection) => {
      patch(writeSelection(searchParams, metric, selection));
      trackEvent("niche_filter_apply");
    },
    [searchParams, patch],
  );

  const onGameSort = useCallback(
    (col: NicheGameSortKey) => {
      if (gamesParams.sort === col) {
        setParam({ order: gamesParams.order === "desc" ? "asc" : "desc", offset: null });
      } else {
        setParam({ sort: col, order: col === "name" ? "asc" : "desc", offset: null });
      }
    },
    [gamesParams.sort, gamesParams.order, setParam],
  );

  // ---- CSV: THIS cut's games (see lib/nicheCsv.ts for why it is built here) ---------------
  const [csv, setCsv] = useState<{ status: "idle" | "busy" | "done" | "error"; message?: string }>({ status: "idle" });
  const exportCsv = useCallback(async () => {
    if (!dimension || !nicheKey) return;
    setCsv({ status: "busy" });
    try {
      const { limit: _limit, offset: _offset, ...params } = gamesParams;
      const res = await exportNicheGamesCsv(dimension, nicheKey, params);
      downloadCsv(res.filename, res.csv);
      trackEvent("niche_export_csv");
      setCsv({
        status: "done",
        message: res.truncated
          ? `Exported the first ${fmtInt(res.rows)} of ${fmtInt(res.total)} games.`
          : `Exported ${fmtInt(res.rows)} ${res.scope === "indie" ? "indie " : ""}game${res.rows === 1 ? "" : "s"}.`,
      });
    } catch (e) {
      setCsv({ status: "error", message: `Export failed — ${errorMessage(e)}` });
    }
  }, [dimension, nicheKey, gamesParams]);

  // ---- guard rails (same shapes as GameProfile's invalid-appid / not-found states) --------

  if (!dimension || !nicheKey) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-verdict-serious">Invalid niche URL — the dimension must be “tag” or “genre”.</span>
          <Link to="/niches" className="text-series-1 hover:underline">
            Back to the Niche Finder
          </Link>
        </div>
      </Card>
    );
  }

  if (detailQ.isLoading) {
    return <Loading label="Loading niche…" className="p-6 text-sm" />;
  }

  if (detailQ.isError || !detail || !activeVariant) {
    const backToFinder = (
      <Link
        to="/niches"
        className="border border-borderstrong px-3 py-1.5 text-xs font-medium text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
      >
        Back to the Niche Finder
      </Link>
    );
    // Only a 404 means the niche is genuinely absent. With the API unreachable this branch
    // rendered "Niche not found: Failed to fetch" (measured on production 2026-09-01) —
    // the same lie GameProfile told, and the reason both now gate the copy on isNotFound().
    if (!isNotFound(detailQ.error)) {
      return (
        <Card>
          <ErrorState
            title="Couldn't load this niche"
            error={detailQ.error}
            onRetry={() => void detailQ.refetch()}
            action={backToFinder}
          />
        </Card>
      );
    }
    // The API's own 404 detail already reads "niche not found: tag/Foo" — don't stutter it.
    const reason = notFoundReason(detailQ.error);
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-verdict-serious">Niche not found{reason ? `: ${reason}` : "."}</span>
          <Link to="/niches" className="text-series-1 hover:underline">
            Back to the Niche Finder
          </Link>
        </div>
      </Card>
    );
  }

  const players = detail.players ?? null;
  const tier = detail.tier ?? activeVariant.tier;
  // The dossier's row: the Radar's cut when the mart scored this niche there, else the
  // selected cut — and the caption names the fallback, because "judged on a different
  // population than the board" is exactly the kind of silent substitution this page exists
  // to avoid. The "Read this first" flags argue with the verdict directly above them, so
  // they read the SAME row.
  const dossierVariant = radarVariant ?? activeVariant;
  const dossier = radarDossier(dossierVariant);
  const failed = failedChecks(dossier.verdict.checks);
  const absence = radarBoardAbsence({ dimension, tier, solo_viability: dossierVariant.solo_viability });
  const flags = declineFlags(dossierVariant, players);
  // The inverse of the board dossier's "Open deep dive →": select this niche on the board,
  // in its own class, with the singleplayer lens opened if that is what hides it there. The
  // id is the board's own "dimension:key" (Radar.tsx handleSelect / RadarBoard's pool lookup).
  const radarHref = (() => {
    const sp = new URLSearchParams();
    const sector = radarSector(dimension, tier);
    if (sector !== null && sector !== "micro") sp.set("class", sector);
    if (sector !== null && absence !== null) sp.set("solo", "off");
    sp.set("niche", formatNicheRef({ dimension, key: nicheKey }));
    return `/radar?${sp.toString()}`;
  })();

  const cutLabel = cutPopulationLabel(cut.win, cut.min_reviews);
  const dossierCutLabel = cutPopulationLabel(dossierVariant.window, dossierVariant.min_reviews);
  const totalPlayersNow = players?.total_players_now ?? activeVariant.total_players_now;
  const playersRow = players ?? {
    players_trend_7d_pct: activeVariant.players_trend_7d_pct,
    players_trend_7d_market_pct: activeVariant.players_trend_7d_market_pct,
    players_trend_7d_rel_pct: activeVariant.players_trend_7d_rel_pct,
  };
  const playersTrend = readPlayersTrend(playersRow);
  const dossierPaid = paidCount(dossierVariant);
  const dossierPaidNote = paidOnlyNote(dossierVariant);

  // /niches/.../games carries live_players per row (routers/niches.py `_GAME_SELECT`), which
  // is what killed the old players.distribution.top_games join here: that list is the top 8
  // BY PLAYERS, so every row outside it fell through to "—" while /games/:appid printed the
  // number. Same fact, two answers — the join was a ranked list being used as a lookup table.
  const topGames = topGamesQ.data?.items ?? [];
  // The cut-aware top games for the overview panel. Falls back to the cut-INDEPENDENT
  // representative_games (mart_niche_top) only when the games data isn't there — and says so
  // in the panel when it does, because that list is a different population.
  const topScope = appliedScope(scope, topGamesQ.data);
  const topGamesDegraded =
    !topGamesQ.isLoading && (topGamesQ.isError || (topGames.length === 0 && topScope.scope === "all"));

  const gamesUnavailable =
    gamesQ.isError ||
    // A degraded (but 200) response: the mart answered, with nothing in it and no filter to
    // explain the emptiness.
    (!!gamesQ.data && gamesQ.data.total === 0 && !hasSelection && appliedScope(scope, gamesQ.data).scope === "all");
  const gamesErrorStatus = gamesQ.error instanceof ApiError ? gamesQ.error.status : null;
  const gamesScope = appliedScope(scope, gamesQ.data);

  const revenueBuckets = revenueDistQ.data?.buckets ?? [];
  const priceBuckets = priceDistQ.data?.buckets ?? [];
  // Degraded = the endpoint errored, or answered 200 with nothing in it. Both mean "the per-
  // game data for this cut isn't ready yet", and both are honest states, not spinners.
  const revenueDistDegraded = revenueDistQ.isError || (!revenueDistQ.isLoading && revenueBuckets.length === 0);
  const priceDistDegraded = priceDistQ.isError || (!priceDistQ.isLoading && priceBuckets.length === 0);
  const bucketTotal = (buckets: DistributionBucket[]) => buckets.reduce((sum, b) => sum + b.count, 0);
  const revenueTotalGames = revenueDistQ.data?.n_games ?? bucketTotal(revenueBuckets);
  const priceTotalGames = priceDistQ.data?.n_games ?? bucketTotal(priceBuckets);

  const rangeStart = gamesQ.data && gamesQ.data.total > 0 ? gamesParams.offset + 1 : 0;
  const rangeEnd = gamesQ.data ? Math.min(gamesParams.offset + GAMES_PAGE_SIZE, gamesQ.data.total) : 0;

  const pressPoints = detail.press ? nichePressTimeline(detail.press.timeline) : [];
  const pressPartial = partialMonth(
    pressPoints.map((p) => p.period),
    dataAge.asOf,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            {/* No trailing separator: the niche name is the <h1> BELOW this line, not the
                next crumb on it — /niches/combined already ends its trail on the last crumb. */}
            <div className="text-[11px] text-ink-primary/55">
              <Link to="/niches" className="hover:text-ink-primary">
                Niches
              </Link>
              {" / "}
              {titleCase(dimension)}
            </div>
            <h1 className="mt-0.5 truncate text-[28px] text-ink-primary sm:text-[32px]">{nicheKey}</h1>
            {aliasFrom && aliasFrom !== nicheKey && (
              <p className="mt-1 text-[12px] text-ink-secondary" data-testid="alias-note">
                &lsquo;{aliasFrom}&rsquo; is now &lsquo;{nicheKey}&rsquo; on Steam — the two spellings are merged into
                this one niche.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tier && (
                <span
                  title={TIER_HINT[tier] ?? tier}
                  className="border border-brand px-2 py-0.5 text-[11px] font-medium text-brand"
                >
                  {TIER_BADGE[tier] ?? tier}
                </span>
              )}
              <span className="border border-ink-primary/30 px-2 py-0.5 text-[11px] font-medium text-ink-primary/65">
                panels: {cutLabel}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void exportCsv()}
                disabled={csv.status === "busy"}
                data-testid="export-csv"
                title={`Download this cut's ${scope === "indie" ? "indie " : ""}games (${cutLabel}${
                  hasSelection ? ", in the selected revenue/price buckets" : ""
                }) as a CSV — the same list the Games table shows`}
                className="text-[11px] font-medium text-ink-muted transition-colors hover:text-ink-primary disabled:opacity-60"
              >
                {csv.status === "busy" ? "Exporting…" : "Export these games (CSV)"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const r = toggleNicheWatchlist(dimension, nicheKey, nicheKey);
                  if (r === "full") window.alert(`Watchlist is full (${WATCHLIST_CAP} items).`);
                  else trackEvent("view_save");
                }}
                aria-pressed={watchlisted}
                title={watchlisted ? "Remove from watchlist" : "Track this niche on the Watchlist page"}
                className="border border-ink-primary/35 px-3 py-1.5 text-xs font-medium text-ink-primary transition-colors hover:bg-ink-primary/[0.08]"
              >
                {watchlisted ? "✓ Watchlisted" : "+ Watchlist"}
              </button>
              <Link
                to={nicheCombinedPath([{ dimension, key: nicheKey }], "intersect", cut)}
                className="bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition-colors hover:bg-brand-hover"
              >
                Combine with…
              </Link>
            </div>
            {csv.message && (
              <span
                role="status"
                data-testid="export-csv-status"
                className={clsx("text-[11px]", csv.status === "error" ? "text-status-serious" : "text-ink-muted")}
              >
                {csv.message}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* THE HEADLINE IS THE RADAR'S DOSSIER (2026-09-09), read top to bottom in the owner's
          order (2026-09-23): the verdict and every check it FAILED; the red flags; the
          headline numbers, each explaining itself with this niche's own numbers; the
          Opportunity score WITH its parts. Judged at the board's pinned cut (radarVariant)
          whatever chip is lit below. */}
      <section aria-label="Radar dossier" data-testid="radar-dossier" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="kicker text-[11px] text-ink-primary/55">Verdict</span>
          {/* The chip: the board's swatch + legend word, in the board's ring colour. Colour
              is reinforcement (the word always rides with it), exactly as on the board. */}
          <span
            data-testid="radar-verdict-chip"
            data-verdict={dossier.verdict.ring}
            title={dossier.verdict.reason}
            className="inline-flex items-center gap-2 border px-2.5 py-1 leading-none text-ink-primary"
            style={{
              fontFamily: CONDENSED,
              fontWeight: 600,
              fontSize: 20,
              borderColor: dossier.color,
              backgroundColor: `color-mix(in srgb, ${dossier.color} 14%, transparent)`,
            }}
          >
            <span className="inline-block h-2 w-2 shrink-0" style={{ backgroundColor: dossier.color }} aria-hidden />
            {dossier.verdictLabel}
          </span>
          <span className="text-[13px] text-ink-secondary">{dossier.verdict.reason}</span>
          <InfoTip term="radar_verdict" />
          <span className="tabular ml-auto inline-flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-muted">
            <a href="#opportunity-breakdown" className="transition-colors hover:text-ink-primary" data-testid="opportunity-link">
              {DOSSIER_LABEL.opportunity} <span className="text-ink-primary">{dossier.opportunity}</span> — how it adds
              up ↓
            </a>
            <span aria-hidden>·</span>
            <span>
              {DOSSIER_LABEL.singleplayer} <span className="text-ink-primary">{dossier.singleplayerShare}</span>
            </span>
          </span>
          <Link to={radarHref} className="text-[12px] font-medium text-brand transition-colors hover:text-brand-hover">
            See on the Radar →
          </Link>
        </div>

        {/* Every failed check, named where the verdict is read — deciding checks first (the
            ones that kept it off "Enter now"), then the warning signs that never move the
            ring. A reader should never have to open the Radar to learn why. */}
        {failed.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-[12px] text-ink-secondary" data-testid="verdict-failed-checks">
            {failed.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-1.5">
                <span aria-hidden className="text-[11px]" style={{ color: "var(--verdict-crowded)" }}>
                  ✕
                </span>
                <span className="kicker text-[10px] text-ink-muted">{c.decides ? "Fails" : "Warning sign"}</span>
                <span className="text-ink-primary">{failedCheckClause(c)}</span>
                <span className="text-ink-muted">— {c.note}</span>
              </li>
            ))}
          </ul>
        )}

        {/* READ THIS FIRST — ABOVE the headline numbers (2026-09-23; it sat below them, and
            on a phone five tall tiles pushed it off the first two screens). It carries the
            counter-argument to the verdict just above it, so it is read before any number
            that could flatter the niche. */}
        <Card title="Read this first" className="!p-4">
          {flags.length > 0 ? (
            <div className="flex flex-col gap-1.5" data-testid="read-this-first">
              {flags.map((f) => (
                <div key={f.text} className="flex items-start gap-2 text-xs text-ink-secondary">
                  <span
                    aria-hidden
                    className={clsx(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      f.serious
                        ? "bg-[var(--text-primary)]"
                        : "bg-[color-mix(in_srgb,var(--text-primary)_50%,transparent)]",
                    )}
                  />
                  {f.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-ink-secondary" data-testid="read-this-first">
              No red flags at this cut — the release pipeline, newcomer earnings, revenue concentration, singleplayer
              share and live players all read normal.
            </div>
          )}
        </Card>

        {/* 5 equal cells, 1px gaps that read as the rules (gap = paper-20% background showing
            through, cells = the ground colour) — the §4b KPI-strip construction. */}
        <div className="grid grid-cols-1 gap-px border border-ink-primary/20 bg-ink-primary/20 sm:grid-cols-2 lg:grid-cols-5">
          {/* Demand. An emerging niche never headlines its % (the board's rule — its base is
              near zero by construction), so the tile says "emerging" and carries the volume. */}
          <KpiCell
            term="demand_trend_24m_pct"
            valueClassName={
              !dossier.emerging && dossierVariant.demand_trend_24m_pct != null && dossierVariant.demand_trend_24m_pct >= 0
                ? "text-brand"
                : undefined
            }
            value={
              dossier.emerging ? (
                <span title={dossier.demand24m}>emerging</span>
              ) : dossierVariant.demand_trend_24m_pct != null ? (
                dossier.demand24m
              ) : (
                // At the strip's 38px numeral "no demand data" truncates; a smaller size fits.
                <span className="text-[22px]">{dossier.demand24m}</span>
              )
            }
            worked={
              dossier.emerging
                ? undefined
                : (demandTrendWorked(
                    dossierVariant.reviews_24m,
                    dossierVariant.reviews_prev_24m,
                    dossierVariant.demand_trend_24m_pct,
                  ) ?? undefined)
            }
            sentinel={
              dossier.emerging
                ? {
                    tag: "emerging",
                    detail:
                      "No comparable demand base: this tag's earlier games were never tagged with it, so its prior 24 months are near zero by construction and a % would be the label's age, not growth. It is judged on its absolute review volume instead.",
                  }
                : dossierVariant.demand_trend_24m_pct == null
                  ? {
                      tag: "no data",
                      detail: "No prior-window baseline, so no trend — the Enter now and Declining verdicts are unreachable.",
                    }
                  : undefined
            }
            footnoteWrap
            footnote={
              dossier.emerging
                ? `judged on absolute volume${dossier.reviews24m ? `: ${dossier.reviews24m} reviews in the last 24 months` : ""}`
                : dossierVariant.demand_trend_24m_pct != null
                  ? dossierVariant.reviews_24m != null && dossierVariant.reviews_prev_24m != null
                    ? `${fmtCompact(dossierVariant.reviews_24m)} reviews in the last 24 months vs ${fmtCompact(
                        dossierVariant.reviews_prev_24m,
                      )} in the 24 before`
                    : "last 24 months vs the 24 before"
                  : "no prior-window baseline — the enter/declining verdicts are unreachable"
            }
          />
          {/* Releases. The footnote states THIS number's own basis: saturation_yoy compares
              two FULL CALENDAR YEARS over every member of the niche with no review floor —
              so the counts printed are the ones the % divides, never n_recent (a 24m AND
              review-floored count; Trading Card Game once read "▲ +4% / 38 released in the
              last 24m" against a 124-vs-119 truth). */}
          <KpiCell
            term="saturation_yoy"
            value={dossier.releasesYoy}
            worked={
              releasesYoyWorked(dossierVariant.n_recent_year, dossierVariant.n_prior_year, dossierVariant.saturation_yoy) ??
              undefined
            }
            sentinel={dossierVariant.saturation_yoy == null ? "no data" : undefined}
            footnoteWrap
            footnote={
              dossierVariant.n_recent_year != null && dossierVariant.n_prior_year != null ? (
                <>
                  {fmtInt(dossierVariant.n_recent_year)} released last full year vs {fmtInt(dossierVariant.n_prior_year)}{" "}
                  the year before
                  <span className="mt-0.5 block text-ink-primary/45">
                    Whole niche, every review count — this tile ignores the window and review-floor controls above.
                  </span>
                </>
              ) : (
                "year-over-year release counts unavailable"
              )
            }
          />
          <KpiCell
            term="p90_rev"
            value={dossier.p90Revenue}
            worked={
              isFiniteNumber(dossierVariant.p90_rev)
                ? `90th percentile of Est. revenue across the ${fmtInt(dossierPaid ?? dossierVariant.n_games)}${
                    dossierPaid !== null ? " paid" : ""
                  } games (${dossierCutLabel}) = ${fmtUsd(dossierVariant.p90_rev)}`
                : undefined
            }
            sentinel={paidStatSentinel(dossierVariant, dossierVariant.p90_rev)}
            footnoteWrap
            footnote={`median ${usdOrWhy(dossierVariant, dossierVariant.median_rev)}${dossierPaidNote ? ` · ${dossierPaidNote}` : ""}`}
          />
          <KpiCell
            term="n_games"
            value={dossier.games}
            worked={
              dossierPaid !== null
                ? `${fmtInt(dossierVariant.n_games)} games (${dossierCutLabel}) = ${fmtInt(dossierPaid)} paid + ${fmtInt(
                    dossierVariant.n_free ?? 0,
                  )} free + ${fmtInt(dossierVariant.n_price_unknown ?? 0)} with no known price`
                : `${fmtInt(dossierVariant.n_games)} games released in the ${dossierCutLabel.replace(" · ", " with ")}`
            }
            footnoteWrap
            footnote={`${dossierCutLabel} — the Radar's cut`}
          />
          {/* The live-player marts are keyed by (dimension, key, date) ONLY — no window and no
              review-floor dimension — so this pair of numbers is identical under all six
              cuts, and its panel of measured games matches none of them. The tile states its
              own population instead of pretending to answer the controls. Since 2026-09-23
              it also reads the trend against the MARKET when the data carries it. */}
          <KpiCell
            term={playersTrend.hasMarket ? "players_trend_7d_vs_market" : "players_trend_7d_pct"}
            label="7-day players trend"
            valueClassName={playersTrend.up ? "text-brand" : undefined}
            value={playersTrend.value ?? "—"}
            worked={playersTrend.worked ?? undefined}
            info={playersTrend.hasMarket ? undefined : { notes: noMarketNote() }}
            sentinel={playersTrend.value === null ? "no data" : undefined}
            footnoteWrap
            footnote={
              totalPlayersNow == null && playersTrend.value === null ? (
                "games measured in both weeks"
              ) : (
                <>
                  {playersTrend.vsMarket && (
                    <span className="block text-ink-primary/80" data-testid="players-vs-market">
                      {playersTrend.vsMarket}
                    </span>
                  )}
                  {totalPlayersNow != null ? `${fmtCompact(totalPlayersNow)} playing now` : "games measured in both weeks"}
                  <span className="mt-0.5 block text-ink-primary/45">
                    Every measured game in the niche
                    {players?.n_games_panel != null ? ` (${fmtInt(players.n_games_panel)})` : ""} — this tile ignores the
                    window and review-floor controls above.
                  </span>
                </>
              )
            }
          />
        </div>

        {/* The one caption that makes the strip readable left to right: which population it
            is judged on (the board's), that the chips below do NOT move it, and — when the
            board would not draw this niche at all — why. */}
        <p className="text-[11px] text-ink-muted">
          The Radar&rsquo;s dossier, judged at the board&rsquo;s own cut — last 24 months · ≥50 reviews — whichever
          cut the chips below select; the panels below follow the chips.
          {radarVariant === null &&
            " This niche isn't scored at that cut (fewer than 30 qualifying games there), so the verdict is judged on the selected cut instead."}
          {absence !== null && ` ${absence}`}
        </p>

        {/* NEVER A LONE SCORE (owner rule): the score above is one click from this, the
            blend the mart actually computes — each part, its weight, its points, the supply
            brake — worked through with this niche's own numbers. */}
        {/* px-2 below sm: at 390px the breakdown's four columns need every pixel, and the
            wider padding pushed its Points column behind the scroller's fade. */}
        <div id="opportunity-breakdown" className="scroll-mt-20 border border-ink-primary/20 px-2 py-3 sm:px-4">
          <OpportunityBreakdown row={dossierVariant} title={`How the Opportunity score adds up — ${dossierCutLabel}`} />
          <p className="mt-2 text-[11px] text-ink-muted">
            The score ranks niches; the verdict above is the call. A high score never overrides a failed check.
          </p>
        </div>
      </section>

      {/* The materialized cuts, as links — under the dossier and the flags (2026-09-09): the
          headline above is pinned to the Radar's cut and does not follow these chips;
          everything from here down (top games, distributions, the games table) does. The cut
          is URL state, so a shared link opens on the same population the sender was reading. */}
      {detail.variants.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-ink-muted">Panels below read</span>
          {detail.variants.map((v) => {
            const active = v.window === cut.win && v.min_reviews === cut.min_reviews;
            return (
              <button
                key={`${v.window}-${v.min_reviews}`}
                type="button"
                aria-pressed={active}
                onClick={() => setParam({ win: v.window, min_reviews: v.min_reviews, offset: null })}
                title={`${fmtInt(v.n_games)} games in this cut`}
                className={clsx(
                  "border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  active ? "border-brand text-brand" : "border-ink-primary/20 text-ink-muted hover:text-ink-secondary",
                )}
              >
                {variantLabel(v)}
              </button>
            );
          })}
        </div>
      )}

      {/* Plain toggled buttons, not ARIA tabs — same call as GameProfile: half a tab widget
          is worse for screen readers than honest pressed-state buttons. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" aria-label="Niche sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
              onClick={() => setParam({ tab: t.key === "overview" ? null : t.key })}
              className={clsx(
                "border px-3 py-1.5 text-xs font-medium transition-colors",
                tab === t.key
                  ? "border-brand bg-brand-tint text-ink-primary"
                  : "border-chartborder text-ink-muted hover:text-ink-secondary",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "overview" && (
          <ViewToggle
            value={view}
            onChange={(v) => {
              setView(v);
              trackEvent("detail_view_toggle");
            }}
          />
        )}
      </div>

      {tab === "overview" && (
        <>
          {/* Releases and revenue, by year — two aligned small multiples, each with its own
              takeaway (components/charts/SaturationTrend.tsx). This replaced a dual-axis
              chart whose caption had to apologise that "where the lines cross means nothing". */}
          <div className="blueprint relative border-ink-primary/25 px-6 py-5">
            <i className="bp-corner" />
            <h3 className="mb-3 text-ink-primary">Releases and revenue, by year</h3>
            <SaturationTrend points={detail.saturation_trend} asOf={dataAge.asOf} />
          </div>

          {/* Top games in the niche — the top five OF THIS CUT AND SCOPE, off the same
              /niches/:dimension/:key/games endpoint the Games & distribution table reads.
              It used to render detail.representative_games, i.e. mart_niche_top: ONE
              cut-independent top-8 per (dimension, key), under a header that named the cut —
              on tag/Souls-like at 24m/≥50 its top row was 5.24× the cut's real top game.
              Indie-first since 2026-09-23 (see DEFAULT_SCOPE). */}
          <TopGamesPanel
            wide={wide}
            loading={topGamesQ.isLoading}
            degraded={topGamesDegraded}
            games={
              topGamesDegraded
                ? detail.representative_games.slice(0, TOP_GAMES_PANEL_SIZE).map((g) => ({
                    appid: g.appid,
                    name: g.name,
                    release_year: g.release_year,
                    price_initial: g.price_initial,
                    is_free: g.is_free,
                    est_revenue: g.est_rev_reviews,
                    total_reviews: g.total_reviews,
                    owners_est: null,
                    positive_ratio: g.positive_ratio,
                    header_image: g.header_image,
                    // mart_niche_top carries no CCU column, and the fallback must not reach
                    // back into players.distribution.top_games for it — that is a top-8-BY-
                    // PLAYERS ranking, and using it as a lookup is what made one fact read two
                    // ways.
                    live_players: null,
                  }))
                : topGames
            }
            fallbackEmpty={detail.representative_games.length === 0}
            cutLabel={cutLabel}
            scope={scope}
            applied={topScope}
            total={topGamesQ.data?.total ?? null}
            nScopeUnknown={topGamesQ.data?.n_scope_unknown}
            onScope={setScope}
            onSeeAll={() => setParam({ tab: "games" })}
          />

          {/* The chart-heavy expert cards live under the Detailed toggle; Simple keeps the
              plain-language reads (verdict, flags, headline numbers, the score's parts). */}
          {view === "detailed" && (
            <>
              {/* Everything in this card comes from the mart_niche_players family, keyed by
                  (dimension, key, date) with NO window/review-floor dimension — it answers for
                  one fixed panel while the controls at the top of the page move. Said once, in
                  the subtitle. No clock time: a schedule is true for one deployment only; the
                  data's age is what a reader needs (lib/dataAge.ts). */}
              <Card
                title="Live players — is this niche hot right now"
                subtitle={`Each game's latest nightly point sample${
                  dataAge.asOfLabel ? ` (data as of ${dataAge.asOfLabel})` : ""
                }, not its daily peak; a capture carries forward up to 7 days so the capture rotation doesn't read as audience dips. Whole measured niche: this card ignores the window and review-floor controls above.`}
              >
                <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile
                    term="niche_players_now"
                    value={players?.total_players_now != null ? fmtCompact(players.total_players_now) : "—"}
                    sentinel={players?.total_players_now == null ? "no data" : undefined}
                    sub={
                      players?.n_games_panel != null ? (
                        <>
                          {fmtInt(players.n_games_panel)} games measured
                          <span className="mt-0.5 block text-ink-muted">whole niche, not the selected cut</span>
                        </>
                      ) : undefined
                    }
                  />
                  <StatTile
                    term={playersTrend.hasMarket ? "players_trend_7d_vs_market" : "players_trend_7d_pct"}
                    label="7-day players trend"
                    // Trend verdict → mono steel (up = accent, down recedes to muted ink).
                    valueClassName={playersTrend.up == null ? undefined : playersTrend.up ? "text-brand" : "text-ink-muted"}
                    value={playersTrend.value ?? "—"}
                    worked={playersTrend.worked ?? undefined}
                    info={playersTrend.hasMarket ? undefined : { notes: noMarketNote() }}
                    sentinel={playersTrend.value === null ? "no data" : undefined}
                    sub={playersTrend.vsMarket ?? "games measured in both weeks · no market figure yet"}
                  />
                  <StatTile
                    term="players_coverage"
                    value={players?.players_coverage != null ? fmtPct(players.players_coverage) : "—"}
                    sentinel={players?.players_coverage == null ? "no data" : undefined}
                    sub="measured in the last 2 days"
                  />
                </div>
                <PlayersSeriesChart points={players?.series ?? []} />

                {(players?.monthly?.length ?? 0) >= 6 && (
                  <div className="mt-4">
                    <div className="mb-1 text-xs text-ink-muted">
                      Niche audience over the years — summed monthly average players
                    </div>
                    <ZoomFrame
                      zoomed={playersMonthlyZoom.zoomed}
                      dragging={playersMonthlyZoom.dragging}
                      outOfRange={playersMonthlyZoom.outOfRange}
                      onReset={playersMonthlyZoom.reset}
                    >
                      <ResponsiveContainer width="100%" height={150}>
                        <LineChart
                          data={playersMonthlyZoom.data}
                          margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
                          {...playersMonthlyZoom.handlers}
                        >
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
                          {(() => {
                            const y = axisScale(
                              Math.max(0, ...(players?.monthly ?? []).map((p) => p.avg_players_sum ?? 0)),
                              "count",
                            );
                            return (
                              <YAxis
                                tick={{ fontSize: 10 }}
                                ticks={y.ticks}
                                interval={0}
                                domain={y.domain}
                                tickFormatter={(v: number) => y.format(v)}
                                tickLine={false}
                                axisLine={false}
                                width={44}
                              />
                            );
                          })()}
                          <Tooltip
                            cursor={{ stroke: "var(--baseline)" }}
                            content={({ active, payload, label }) => {
                              if (!active || !payload || payload.length === 0) return null;
                              const p = payload[0].payload as NichePlayersMonthlyPoint;
                              return (
                                <TooltipPanel
                                  title={String(label).slice(0, 7)}
                                  rows={[
                                    {
                                      label: "Avg players (sum)",
                                      value: fmtCompact(p.avg_players_sum),
                                      color: CSS_VAR.demand,
                                    },
                                    { label: "Games measured", value: fmtInt(p.n_games_measured) },
                                  ]}
                                />
                              );
                            }}
                          />
                          <Line type="linear" dataKey="avg_players_sum" stroke={CSS_VAR.demand} strokeWidth={2} dot={false} />
                          {playersMonthlyZoom.selection && (
                            <ReferenceArea
                              x1={playersMonthlyZoom.selection.x1}
                              x2={playersMonthlyZoom.selection.x2}
                              {...SELECTION_AREA_PROPS}
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </ZoomFrame>
                    <p className="mt-1 text-[11px] italic text-ink-muted">
                      Historical monthly averages via steamcharts.com, summed over the niche's measured games — covers
                      the top ~8k games by reviews only, so this is the niche's HEAD, and rising coverage over the years
                      is partly new games entering measurement.
                    </p>
                  </div>
                )}

                {players?.distribution && players.distribution.top_games.length > 0 && (
                  <div className="mt-4">
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                      <div className="text-xs text-ink-muted">Who holds the players — right now</div>
                      <div className="text-xs text-ink-secondary">
                        typical game: <b className="tabular">{fmtCompact(players.distribution.median_players_now)}</b>{" "}
                        online
                        {players.distribution.players_top5_share != null && (
                          <>
                            {" "}
                            · the top 5 games hold{" "}
                            <b className="tabular text-verdict-serious">{fmtPct(players.distribution.players_top5_share)}</b>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {players.distribution.top_games.slice(0, 5).map((g) => (
                        <div key={g.appid} className="flex items-center gap-2 text-xs">
                          <Link
                            to={`/games/${g.appid}`}
                            className="w-40 shrink-0 truncate font-medium text-ink-primary hover:text-brand"
                            title={g.name ?? undefined}
                          >
                            {g.name ?? `App ${g.appid}`}
                          </Link>
                          <div className="relative h-3 flex-1 overflow-hidden rounded bg-surface2">
                            <span
                              className="absolute inset-y-0 left-0 rounded"
                              style={{ width: `${Math.max(1, (g.share ?? 0) * 100)}%`, backgroundColor: CSS_VAR.demand }}
                            />
                          </div>
                          <span className="tabular w-24 shrink-0 text-right text-ink-secondary">
                            {fmtCompact(g.players)} · {fmtPct(g.share)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {players.distribution.histogram.length > 0 && (
                      <div className="mt-3">
                        <div className="mb-1 text-[11px] text-ink-muted">
                          Concurrent players across {fmtInt(players.distribution.n_games_now)} games in the niche (log scale)
                        </div>
                        <Histogram buckets={players.distribution.histogram} color={CSS_VAR.competition} xKind="count" height={140} />
                      </div>
                    )}
                  </div>
                )}

                {(activeVariant.lifetime_survival_12m != null || activeVariant.lifetime_median_dead_months != null) && (
                  <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                    <div className="inline-flex items-center gap-1 text-xs text-ink-muted">
                      How long games live here
                      <InfoTip term="lifetime_survival_12m" />
                    </div>
                    <div className="text-xs text-ink-secondary">
                      {activeVariant.lifetime_survival_12m != null && (
                        <>
                          alive a year after reaching 100+ players:{" "}
                          <b className="tabular">{fmtPct(activeVariant.lifetime_survival_12m)}</b>
                        </>
                      )}
                      {activeVariant.lifetime_survival_12m != null && activeVariant.lifetime_median_dead_months != null && " · "}
                      {activeVariant.lifetime_median_dead_months != null && (
                        <>
                          dead ones lasted ~<b className="tabular">{fmtMonths(activeVariant.lifetime_median_dead_months)}</b>
                        </>
                      )}
                    </div>
                  </div>
                )}
                <p className="mt-2 text-[11px] italic text-ink-muted">
                  Totals are dominated by the niche's biggest games — a big number says people play the hits, not that a
                  new entrant gets players.
                </p>
              </Card>

              <RevenueCard variant={activeVariant} variants={detail.variants} cutLabel={cutLabel} ownersAsOf={detail.owners_as_of ?? null} />

              <HitRatesCard detail={detail} variant={activeVariant} cut={cut} />

              {detail.themes.length > 0 && (
                <Card
                  title="What players praise & complain about"
                  subtitle="Review aspects pooled across the niche (vote-weighted). A complaint the whole niche shares is a quality-gap opening; a praise pillar is the bar to clear."
                >
                  <TableScroll className="rounded-card border border-chartborder">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead>
                        <tr className="border-b border-chartborder text-left text-ink-muted">
                          <th className="px-2 py-1.5 font-medium">Aspect</th>
                          <th className="px-2 py-1.5 font-medium">Praise</th>
                          <th className="px-2 py-1.5 font-medium">Complaints</th>
                          <th
                            className="px-2 py-1.5 font-medium"
                            title="Praise share vs the whole catalog's for this aspect, in percentage points"
                          >
                            Praise vs catalog
                          </th>
                          <th className="px-2 py-1.5 font-medium">Mentions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.themes.map((t) => (
                          <tr key={t.aspect} className="border-b border-chartborder/60 last:border-0">
                            <td className="px-2 py-1.5 font-medium text-ink-primary">{t.aspect}</td>
                            {/* Aspect sentiment is mono steel per the handoff — red/green stays
                                reserved for real error/status states, not data verdicts. */}
                            <td className="tabular px-2 py-1.5 text-brand">{fmtPct(t.praise_share)}</td>
                            <td className="tabular px-2 py-1.5 text-ink-muted">{fmtPct(t.complaint_share)}</td>
                            <td
                              className={clsx(
                                "tabular px-2 py-1.5",
                                (t.praise_delta_vs_catalog ?? 0) >= 0 ? "text-brand" : "text-ink-muted",
                              )}
                            >
                              {t.praise_delta_vs_catalog != null
                                ? `${t.praise_delta_vs_catalog >= 0 ? "+" : "−"}${Math.abs(t.praise_delta_vs_catalog * 100).toFixed(1)} pts`
                                : "—"}
                            </td>
                            <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtCompact(t.total_mentions)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                </Card>
              )}

              {detail.press && pressPoints.length > 0 && (
                <Card
                  title="Press coverage"
                  subtitle={`${fmtInt(detail.press.total_articles)} dated press mentions of this niche's games, by month (a month with none shows as zero) — journalist coverage only, Steam News excluded.`}
                >
                  {/* The shared press chart, on a gap-free month series (see
                      nichePressTimeline) — this page's own copy of it is gone. */}
                  <PressTimelineChart points={pressPoints} />
                  {pressPartial && (
                    <p className="mt-1 text-[11px] text-ink-muted" data-testid="press-partial-month">
                      {pressPartial} is the current month — its bar holds only the days up to{" "}
                      {dataAge.asOfLabel ?? "the data's date"}.
                    </p>
                  )}
                  {detail.press.top_outlets.length > 0 && (
                    <TableScroll className="mt-3 rounded-card border border-chartborder">
                      <table className="w-full min-w-[420px] text-xs">
                        <thead>
                          <tr className="border-b border-chartborder text-left text-ink-muted">
                            <th className="px-2 py-1.5 font-medium">Top outlets</th>
                            <th className="px-2 py-1.5 font-medium">Articles</th>
                            <th className="px-2 py-1.5 font-medium">Games covered</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.press.top_outlets.slice(0, 10).map((o) => (
                            <tr key={o.source} className="border-b border-chartborder/60 last:border-0">
                              <td className="px-2 py-1.5 font-medium text-ink-primary">{o.source}</td>
                              <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtInt(o.n_articles)}</td>
                              <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtInt(o.n_games_covered)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableScroll>
                  )}
                  <p className="mt-2 text-[11px] italic text-ink-muted">
                    Fuzzy-matched with a confidence floor. Press follows games that are already notable — read this as
                    the niche's visibility and who to pitch, not as what caused the sales.
                  </p>
                </Card>
              )}
            </>
          )}
        </>
      )}

      {tab === "games" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-ink-muted">List</span>
            <ScopeToggle scope={scope} onChange={setScope} />
            <span className="text-[11px] text-ink-muted">
              {scope === "indie"
                ? "Steam-Indie-flagged games only — the comparables a small team can learn from."
                : "Every game in the niche, big publishers included."}
            </span>
          </div>

          {hasSelection && (
            <div className="flex flex-wrap items-center gap-2 rounded-card border border-brand bg-brand-tint px-3 py-2 text-xs">
              <span className="font-medium text-ink-primary">Filtered by</span>
              {revenueSelection && (
                <button
                  type="button"
                  onClick={() => onSelectionChange("revenue", null)}
                  title="Clear the revenue bucket filter"
                  className="inline-flex items-center gap-1.5 rounded-full border border-chartborder bg-surface px-2 py-0.5 text-ink-secondary transition-colors hover:text-ink-primary"
                >
                  {selectionLabel("revenue", revenueSelection)}
                  <span aria-hidden>✕</span>
                </button>
              )}
              {priceSelection && (
                <button
                  type="button"
                  onClick={() => onSelectionChange("price", null)}
                  title="Clear the price bucket filter"
                  className="inline-flex items-center gap-1.5 rounded-full border border-chartborder bg-surface px-2 py-0.5 text-ink-secondary transition-colors hover:text-ink-primary"
                >
                  {selectionLabel("price", priceSelection)}
                  <span aria-hidden>✕</span>
                </button>
              )}
              <span className="ml-auto text-[11px] text-ink-secondary">
                This filter lives in the URL — copy the address bar to share exactly this slice.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card
              title="Revenue distribution"
              subtitle={`Every ${scope === "indie" ? "indie " : ""}game in this cut (${cutLabel}) with a price, bucketed by estimated lifetime revenue (log scale) — free and unknown-price games have no revenue estimate, so they are not in it${
                scope === "all" && activeVariant.n_free != null
                  ? ` (${paidOnlyNote(activeVariant)?.replace(/^paid games only — /, "").replace(/^excludes /, "") ?? "none left out"})`
                  : ""
              }. Select buckets to filter the table below.`}
            >
              {revenueDistDegraded ? (
                // Not a blank card: the niche detail already carries a (static, non-brushable)
                // revenue histogram, so the revenue SHAPE survives the rebuild window — only
                // the click-to-filter interaction is missing.
                <>
                  <Histogram buckets={detail.revenue_histogram} color={CSS_VAR.demand} xKind="usd" height={200} />
                  <DegradedNote
                    what="Bucket filtering"
                    status={revenueDistQ.error instanceof ApiError ? revenueDistQ.error.status : null}
                    extra="Showing the niche's all-time revenue spread (games with ≥50 reviews, every game regardless of the indie filter) meanwhile — the shape, without the click-to-filter."
                  />
                </>
              ) : (
                <NicheDistribution
                  metric="revenue"
                  buckets={revenueBuckets}
                  selection={revenueSelection}
                  onSelectionChange={(s) => onSelectionChange("revenue", s)}
                  loading={revenueDistQ.isLoading || revenueDistQ.isFetching}
                  totalGames={revenueTotalGames}
                />
              )}
            </Card>

            <Card
              title="Price distribution"
              subtitle={`Launch price across the cut's ${scope === "indie" ? "indie " : ""}games — where the field actually prices, and where it doesn't.`}
            >
              {priceDistDegraded ? (
                // No static price histogram exists, so this one really has nothing to fall
                // back to — say so plainly instead of an empty box.
                <div className="flex h-[240px] flex-col items-center justify-center gap-1 px-4 text-center">
                  <span className="text-xs text-ink-muted">No price distribution for this cut yet.</span>
                  <DegradedNote what="The price histogram" status={priceDistQ.error instanceof ApiError ? priceDistQ.error.status : null} />
                </div>
              ) : (
                <NicheDistribution
                  metric="price"
                  buckets={priceBuckets}
                  selection={priceSelection}
                  onSelectionChange={(s) => onSelectionChange("price", s)}
                  loading={priceDistQ.isLoading || priceDistQ.isFetching}
                  totalGames={priceTotalGames}
                />
              )}
            </Card>
          </div>

          <Card
            title="Games in this niche"
            subtitle={
              gamesQ.data && !gamesUnavailable ? (
                <ScopeLine
                  total={gamesQ.data.total}
                  scope={gamesScope.scope}
                  unsupported={gamesScope.unsupported}
                  nScopeUnknown={gamesQ.data.n_scope_unknown}
                  population={cutLabel}
                  filtered={hasSelection}
                />
              ) : undefined
            }
          >
            {gamesQ.isLoading && <div className="text-xs text-ink-muted">Loading games…</div>}

            {gamesUnavailable && (
              <>
                <DegradedNote
                  what="The full, filterable game list"
                  status={gamesErrorStatus}
                  extra={
                    detail.representative_games.length > 0
                      ? "Showing the niche's biggest games all-time (every game, any review count) meanwhile."
                      : undefined
                  }
                />
                {detail.representative_games.length > 0 && (
                  <TableScroll className="mt-3 rounded-card border border-chartborder">
                    <table className="w-full min-w-[640px] text-xs">
                      <thead>
                        <tr className="border-b border-chartborder text-left text-ink-muted">
                          <th className="px-2 py-1.5 font-medium">#</th>
                          <th className="px-2 py-1.5 font-medium">Game</th>
                          <th className="px-2 py-1.5 font-medium">Year</th>
                          <th className="px-2 py-1.5 font-medium">Price</th>
                          {/* The same fix as the live table: units from the revenue's own
                              estimator, so the row multiplies out. */}
                          <th className="px-2 py-1.5 font-medium">
                            <HeaderLabel term="units" label="Est. units" style={{ fontSize: 11, fontWeight: 500 }} />
                          </th>
                          <th className="px-2 py-1.5 font-medium">Reviews</th>
                          <th className="px-2 py-1.5 font-medium">Positive</th>
                          <th className="px-2 py-1.5 font-medium">Est. revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.representative_games.map((g) => (
                          <tr
                            key={g.appid}
                            className="cursor-pointer border-b border-chartborder/60 last:border-0 hover:bg-page"
                            onClick={() => navigate(`/games/${g.appid}`)}
                          >
                            <td className="tabular px-2 py-1.5 text-ink-muted">{g.rank_in_niche}</td>
                            <td className="max-w-[200px] truncate px-2 py-1.5 font-medium" title={g.name ?? undefined}>
                              <Link
                                to={`/games/${g.appid}`}
                                onClick={(e) => e.stopPropagation()}
                                className="text-ink-primary hover:text-brand hover:underline"
                              >
                                {g.name ?? `App ${g.appid}`}
                              </Link>
                            </td>
                            <td className="tabular px-2 py-1.5">{g.release_year ?? "—"}</td>
                            <td className="tabular px-2 py-1.5">
                              <PriceText row={g} />
                            </td>
                            <td className="tabular px-2 py-1.5">
                              {fmtCompact(estimatedUnits(g.est_rev_reviews, g.price_initial, g.total_reviews))}
                            </td>
                            <td className="tabular px-2 py-1.5">{fmtInt(g.total_reviews)}</td>
                            <td className="tabular px-2 py-1.5">{fmtPct(g.positive_ratio)}</td>
                            <td className="tabular px-2 py-1.5">
                              <RevenueText row={g} value={g.est_rev_reviews} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                )}
              </>
            )}

            {!gamesUnavailable && gamesQ.data && gamesQ.data.items.length === 0 && (
              <EmptyState
                className="py-6"
                title={hasSelection ? "No games match the selected buckets" : `No ${scope === "indie" ? "indie " : ""}games in this cut`}
                description={
                  hasSelection
                    ? "Every game in this niche falls outside the brushed revenue/price range."
                    : "Switch the list to All games to see the whole niche."
                }
                action={
                  hasSelection ? (
                    <button
                      type="button"
                      onClick={() => {
                        patch(writeSelection(writeSelection(searchParams, "revenue", null), "price", null));
                        trackEvent("niche_filter_apply");
                      }}
                      className="rounded-md border border-chartborder px-2.5 py-1 text-xs font-medium text-ink-secondary transition-colors hover:border-brand hover:text-brand"
                    >
                      Clear filters
                    </button>
                  ) : scope === "indie" ? (
                    <button
                      type="button"
                      onClick={() => setScope("all")}
                      className="rounded-md border border-chartborder px-2.5 py-1 text-xs font-medium text-ink-secondary transition-colors hover:border-brand hover:text-brand"
                    >
                      Show all games
                    </button>
                  ) : undefined
                }
              />
            )}

            {!gamesUnavailable && gamesQ.data && gamesQ.data.items.length > 0 && (
              <>
                <TableScroll
                  className={clsx("rounded-card border border-chartborder", gamesQ.isFetching && "opacity-90 transition-opacity")}
                >
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className="border-b border-chartborder text-left text-ink-muted">
                        <th className="px-2 py-1.5">
                          <GamesHeader label="Game" col="name" params={gamesParams} onSort={onGameSort} />
                        </th>
                        <th className="px-2 py-1.5">
                          <GamesHeader label="Year" col="release_year" params={gamesParams} onSort={onGameSort} />
                        </th>
                        <th className="px-2 py-1.5">
                          <GamesHeader label="Price" term="launch_price" col="price" params={gamesParams} onSort={onGameSort} />
                        </th>
                        <th className="px-2 py-1.5">
                          <GamesHeader label="Reviews" term="reviews" col="reviews" params={gamesParams} onSort={onGameSort} />
                        </th>
                        {/* Units, NOT SteamSpy owners. This row prints a price, a copy count and
                            a revenue side by side, so the copy count has to be the one that
                            closes the arithmetic a reader does ACROSS the row: est. revenue ÷
                            launch price, exactly (lib/estimates.ts). It used to be owners_mid
                            beside est_rev_reviews — two estimators in one row, so Path of Exile 2
                            read $5.77 a copy against a $29.99 price. Not in the API's sort
                            whitelist, so an inert header — and at a fixed price units rank
                            exactly like Est. revenue, which is sortable. */}
                        <th className="px-2 py-1.5">
                          <GamesHeader label="Est. units" term="units" params={gamesParams} onSort={onGameSort} />
                        </th>
                        <th className="px-2 py-1.5">
                          <GamesHeader
                            label="Est. revenue"
                            term="est_revenue"
                            notes={EST_REVENUE_NOTES}
                            col="revenue"
                            params={gamesParams}
                            onSort={onGameSort}
                          />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {gamesQ.data.items.map((g, _i, all) => (
                        <tr
                          key={g.appid}
                          className="cursor-pointer border-b border-chartborder/60 last:border-0 hover:bg-page"
                          onClick={() => navigate(`/games/${g.appid}`)}
                        >
                          <td className="max-w-[220px] truncate px-2 py-1.5 font-medium" title={g.name ?? undefined}>
                            {/* Focusable link so the table is keyboard-reachable; the row
                                onClick stays as a mouse convenience. */}
                            <Link
                              to={`/games/${g.appid}`}
                              onClick={(e) => e.stopPropagation()}
                              className="text-ink-primary hover:text-brand hover:underline"
                            >
                              {g.name ?? `App ${g.appid}`}
                            </Link>
                          </td>
                          <td className="tabular px-2 py-1.5">{g.release_year ?? "—"}</td>
                          <td className="tabular px-2 py-1.5">
                            <PriceText row={g} />
                          </td>
                          <td className="tabular px-2 py-1.5">{fmtInt(g.total_reviews)}</td>
                          <td className="tabular px-2 py-1.5">
                            {fmtCompact(estimatedUnits(g.est_revenue, g.price_initial, g.total_reviews))}
                          </td>
                          <td className="tabular px-2 py-1.5">
                            {hasRevenueFigure(g, g.est_revenue) ? (
                              <span
                                className="rounded px-1.5 py-0.5"
                                style={heatStyle(g.est_revenue, ...heatDomain(all, (x) => x.est_revenue))}
                              >
                                <RevenueText row={g} value={g.est_revenue} />
                              </span>
                            ) : (
                              <RevenueText row={g} value={g.est_revenue} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
                <div className="mt-2 flex items-center justify-between text-xs text-ink-muted">
                  <span>
                    {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {gamesQ.data.total.toLocaleString()}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={gamesParams.offset === 0}
                      onClick={() => setParam({ offset: Math.max(0, gamesParams.offset - GAMES_PAGE_SIZE) || null })}
                      className="rounded-lg border border-chartborder bg-surface px-3 py-1 font-medium text-ink-secondary shadow-xs transition-colors hover:text-ink-primary disabled:pointer-events-none disabled:opacity-40"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      disabled={gamesParams.offset + GAMES_PAGE_SIZE >= gamesQ.data.total}
                      onClick={() => setParam({ offset: gamesParams.offset + GAMES_PAGE_SIZE })}
                      className="rounded-lg border border-chartborder bg-surface px-3 py-1 font-medium text-ink-secondary shadow-xs transition-colors hover:text-ink-primary disabled:pointer-events-none disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/** A games-table header: the column name (sortable when the API can sort it) plus the ⓘ. */
function GamesHeader({
  label,
  term,
  notes,
  col,
  params,
  onSort,
}: {
  label: string;
  term?: GlossaryKey;
  /** Replaces the glossary's notes paragraph (the Est. revenue column adds the price-unknown
   * sentinel's meaning). */
  notes?: string;
  col?: NicheGameSortKey;
  params: NicheGamesParams;
  onSort: (col: NicheGameSortKey) => void;
}) {
  return (
    <HeaderLabel
      label={label}
      term={term}
      info={notes ? { notes } : undefined}
      sort={col ? { col, active: params.sort === col, order: params.order, onSort } : undefined}
      style={{ fontFamily: CONDENSED, fontSize: 11, letterSpacing: ".06em", fontWeight: 600 }}
    />
  );
}

/**
 * The overview's top games — a table on a wide screen, cards below 640px (2026-09-23: at
 * 390px the six fixed columns scrolled inside a 340px box and only the thumbnail and the
 * name were visible). Indie-first, with the scope and its population stated.
 */
function TopGamesPanel({
  wide,
  loading,
  degraded,
  games,
  fallbackEmpty,
  cutLabel,
  scope,
  applied,
  total,
  nScopeUnknown,
  onScope,
  onSeeAll,
}: {
  wide: boolean;
  loading: boolean;
  degraded: boolean;
  games: NicheGameRow[];
  fallbackEmpty: boolean;
  cutLabel: string;
  scope: NicheScope;
  applied: { scope: NicheScope; unsupported: boolean };
  total: number | null;
  nScopeUnknown: number | null | undefined;
  onScope: (s: NicheScope) => void;
  onSeeAll: () => void;
}) {
  const shownScope = degraded ? "all" : applied.scope;
  return (
    <div className="blueprint relative border-ink-primary/25" data-testid="top-games-panel">
      <i className="bp-corner" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-5 pb-2.5 pt-3.5">
        <h3 className="text-ink-primary">Top {shownScope === "indie" ? "indie " : ""}games in the niche</h3>
        <ScopeToggle scope={scope} onChange={onScope} />
        <button type="button" onClick={onSeeAll} className="ml-auto text-xs font-medium text-brand hover:underline">
          {total != null && !degraded
            ? `All ${fmtInt(total)} ${shownScope === "indie" ? "indie " : ""}game${total === 1 ? "" : "s"} →`
            : "All games →"}
        </button>
        <div className="basis-full">
          {!degraded && (
            <ScopeLine
              total={total}
              scope={applied.scope}
              unsupported={applied.unsupported}
              nScopeUnknown={nScopeUnknown}
              population={cutLabel}
            />
          )}
        </div>
      </div>
      {loading ? (
        <div className="border-t border-ink-primary/20 px-5 py-6 text-center text-xs text-ink-muted">Loading top games…</div>
      ) : degraded && fallbackEmpty ? (
        <div className="border-t border-ink-primary/20 px-5 py-6 text-center text-xs text-ink-muted">No games for this cut yet.</div>
      ) : !degraded && games.length === 0 ? (
        <div className="border-t border-ink-primary/20 px-5 py-6 text-center text-xs text-ink-muted">
          No {scope === "indie" ? "indie " : ""}games in this cut.{" "}
          {scope === "indie" && (
            <button type="button" onClick={() => onScope("all")} className="font-medium text-brand hover:underline">
              Show all games
            </button>
          )}
        </div>
      ) : (
        <>
          {/* The per-cut list needs data that lands on a nightly REBUILD, so for a few hours
              after a deploy there is none. Falling back to the niche's overall top list is
              still the best list we have — but it is a different population, so it says so. */}
          {degraded && (
            <div className="border-t border-ink-primary/20 px-5 py-2 text-[11px] leading-snug text-ink-primary/50">
              The per-cut list isn’t ready yet (it is rebuilt a few hours after each data update) — these are the
              niche’s biggest games all-time at every review count, not the {cutLabel} cut, and not filtered to indie.
            </div>
          )}
          {wide ? <TopGamesTable games={games} /> : <TopGamesCards games={games} />}
        </>
      )}
    </div>
  );
}

function GameThumb({ src }: { src: string | null | undefined }) {
  return src ? (
    <img src={src} alt="" className="h-[26px] w-full object-cover" loading="lazy" />
  ) : (
    <span
      aria-hidden
      className="block h-[26px] w-full"
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 12%, transparent), color-mix(in srgb, var(--text-primary) 12%, transparent) 4px, transparent 4px, transparent 8px)",
      }}
    />
  );
}

/** "95.3% positive · 276,249 reviews" — a reviews cell that says what both numbers are. */
export function reviewsText(g: Pick<NicheGameRow, "positive_ratio" | "total_reviews">): string {
  return `${fmtPct(g.positive_ratio)} positive · ${fmtInt(g.total_reviews)} reviews`;
}

function TopGamesTable({ games }: { games: NicheGameRow[] }) {
  const COLS = "grid grid-cols-[60px_2fr_.8fr_1fr_1.6fr_1fr] items-center gap-3.5";
  return (
    <TableScroll>
      <div className="min-w-[680px]">
        <div className={clsx(COLS, "border-t border-ink-primary/20 px-5 py-2.5")}>
          <span />
          <span className="kicker text-[11px] text-ink-primary/55">Game</span>
          <span className="kicker text-[11px] text-ink-primary/55">Released</span>
          <span className="kicker inline-flex items-center gap-1 text-[11px] text-ink-primary/55">
            Est. revenue <InfoTip term="est_revenue" notes={EST_REVENUE_NOTES} />
          </span>
          <span className="kicker inline-flex items-center gap-1 text-[11px] text-ink-primary/55">
            Reviews <InfoTip term="positive_ratio" />
          </span>
          <span className="kicker inline-flex items-center gap-1 text-[11px] text-ink-primary/55">
            Players now <InfoTip term="players_now" />
          </span>
        </div>
        {games.map((g) => (
          <Link
            key={g.appid}
            to={`/games/${g.appid}`}
            className={clsx(COLS, "border-t border-ink-primary/10 px-5 py-2.5 text-sm transition-colors hover:bg-ink-primary/[0.04]")}
          >
            <GameThumb src={g.header_image} />
            <span className="truncate font-medium text-ink-primary">{g.name ?? `App ${g.appid}`}</span>
            <span className="tabular text-ink-primary/70">{g.release_year ?? "—"}</span>
            <span className="tabular text-ink-primary/70">
              <RevenueText row={g} value={g.est_revenue} />
            </span>
            <span className="tabular text-ink-primary/70">{reviewsText(g)}</span>
            {/* Per-row live CCU from the games list — the same column /api/games/{appid}
                serves, not a rank-8 leaderboard join. A game outside the capture says so. */}
            <span className="tabular text-brand">
              {g.live_players != null ? fmtCompact(g.live_players) : <SentinelTag>not measured</SentinelTag>}
            </span>
          </Link>
        ))}
      </div>
    </TableScroll>
  );
}

function TopGamesCards({ games }: { games: NicheGameRow[] }) {
  return (
    <ul className="flex flex-col" data-testid="top-games-cards">
      {games.map((g) => (
        <li key={g.appid} className="border-t border-ink-primary/10">
          <Link to={`/games/${g.appid}`} className="flex gap-3 px-4 py-3 transition-colors hover:bg-ink-primary/[0.04]">
            <span className="w-[72px] shrink-0 pt-0.5">
              <GameThumb src={g.header_image} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-ink-primary">{g.name ?? `App ${g.appid}`}</span>
              <span className="tabular text-[12px] text-ink-secondary">
                {g.release_year ?? "—"} · <RevenueText row={g} value={g.est_revenue} />
                {priceKind(g) === "paid" && g.est_revenue != null ? " est. revenue" : ""}
              </span>
              <span className="tabular text-[12px] text-ink-muted">
                {reviewsText(g)}
                {g.live_players != null ? ` · ${fmtCompact(g.live_players)} playing now` : ""}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Median / top-25% / top-10% revenue, market size, newcomer earnings and singleplayer share,
 * each with its glossary ⓘ and — where the row carries the inputs — its own numbers worked
 * through the formula. Plain labels: "P25/P75/P90" and "market size p52" were the review's
 * jargon. Revenue figures count PAID games only and are withheld below 30 of them.
 */
function RevenueCard({
  variant,
  variants,
  cutLabel,
  ownersAsOf,
}: {
  variant: NicheRow;
  variants: NicheRow[];
  cutLabel: string;
  ownersAsOf: string | null;
}) {
  const paid = paidCount(variant);
  const note = paidOnlyNote(variant);
  const basis = `${fmtInt(paid ?? variant.n_games)}${paid !== null ? " paid" : ""} games`;
  const pctWorked = (p: number, value: number | null | undefined) =>
    isFiniteNumber(value) ? `${p}th percentile of Est. revenue across ${basis} = ${fmtUsd(value)}` : undefined;
  // Newcomer earnings = median revenue of the last-24-month games ÷ the whole back catalog's
  // median AT THE SAME REVIEW FLOOR — both medians are served as the two windows' own rows,
  // so the ratio can be worked when they reproduce it.
  const recent = findNicheVariant(variants, { win: "24m", min_reviews: variant.min_reviews });
  const all = findNicheVariant(variants, { win: "all", min_reviews: variant.min_reviews });
  const er = variant.entrant_ratio;
  let erWorked: string | undefined;
  if (recent?.median_rev != null && all?.median_rev != null && all.median_rev > 0 && er != null) {
    const rec = recent.median_rev / all.median_rev;
    if (Math.abs(rec - er) <= 0.006)
      erWorked = `${fmtUsd(recent.median_rev)} (median, games from the last 24 months) ÷ ${fmtUsd(all.median_rev)} (median, all games, same review floor) = ${rec.toFixed(2)}×`;
  }
  const solo = variant.solo_viability;
  const n = variant.n_games;
  return (
    <Card
      title="Revenue spread and entry economics"
      subtitle={`Estimated lifetime GROSS per game — reviews × 30 owners-per-review × launch price, one flat ratio, not fitted per genre — before Steam's cut, refunds and discounts. ${cutLabel}${
        note ? `; ${note}` : ""
      }.`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          term="median_rev"
          value={fmtUsd(variant.median_rev)}
          sub="the typical outcome"
          worked={pctWorked(50, variant.median_rev)}
          sentinel={paidStatSentinel(variant, variant.median_rev)}
        />
        <StatTile
          term="p75_rev"
          value={fmtUsd(variant.p75_rev)}
          sub="a good-but-not-exceptional outcome"
          worked={pctWorked(75, variant.p75_rev)}
          sentinel={paidStatSentinel(variant, variant.p75_rev)}
        />
        <StatTile
          term="p90_rev"
          value={fmtUsd(variant.p90_rev)}
          sub="what the successful tail earns"
          worked={pctWorked(90, variant.p90_rev)}
          sentinel={paidStatSentinel(variant, variant.p90_rev)}
        />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          term="total_owners"
          value={fmtCompact(variant.total_owners)}
          sentinel={variant.total_owners == null ? "no data" : undefined}
          sub={
            <>
              {variant.market_size != null
                ? `market size rank ${Math.round(variant.market_size)} of 100 — bigger than ${Math.round(variant.market_size)}% of niches`
                : "market size rank unknown"}
              {ownersAsOf && <span className="mt-0.5 block text-ink-muted">SteamSpy snapshot of {ownersAsOf}</span>}
            </>
          }
        />
        <StatTile
          term="entrant_ratio"
          value={er != null ? `${er.toFixed(2)}×` : "—"}
          sub={`vs ~${ENTRANT_RATIO_CATALOG_NORM}× catalog norm — below it, newcomers underearn`}
          worked={erWorked}
          sentinel={er == null ? paidStatSentinel(variant, er) : undefined}
        />
        <StatTile
          term="singleplayer_share"
          value={fmtPct(solo)}
          sub="most niches: 95–99% — under 80% leans multiplayer"
          worked={
            solo != null && n > 0 ? `≈ ${fmtInt(Math.round(solo * n))} of ${fmtInt(n)} games playable single-player = ${fmtPct(solo)}` : undefined
          }
          sentinel={solo == null ? "no data" : undefined}
        />
      </div>
    </Card>
  );
}

/**
 * Hit rates against MATCHING benchmarks (2026-09-23). The ≥$200K and ≥$500K meters used to
 * carry the catalog's ≥$100K rate as their tick — a lower bar, so every niche looked like it
 * beat the "benchmark". The tick is now the SAME bar for this niche's headline population
 * (all time · ≥50 reviews, `hit_rates`), labelled with that cut — or, when the niche is too
 * small for it, with the fallback cut the API reports (`hit_rates_cut.fallback`), flagged.
 * The catalog's ≥$100K figure stays as a line of context, never as a tick on another bar.
 */
function HitRatesCard({
  detail,
  variant,
  cut,
}: {
  detail: NicheDetailData;
  variant: NicheRow;
  cut: { win: Window; min_reviews: number };
}) {
  const hc = detail.hit_rates_cut;
  const headLabel = hc ? cutPopulationLabel(hc.window, hc.min_reviews) : "all time · ≥50 reviews";
  // A tick equal to the value itself says nothing: drop it when the selected cut IS the
  // headline cut.
  const sameCut = hc ? hc.window === cut.win && hc.min_reviews === cut.min_reviews : cut.win === "all" && cut.min_reviews === 50;
  const paid = paidCount(variant);
  const base = paid ?? variant.n_games;
  const cutLabel = cutPopulationLabel(cut.win, cut.min_reviews);
  const worked = (rate: number | null, bar: string) =>
    rate != null && base > 0
      ? `≈ ${fmtInt(Math.round(rate * base))} of ${fmtInt(base)}${paid !== null ? " paid" : ""} games (${cutLabel}) earn over ${bar} = ${fmtPct(rate)}`
      : undefined;
  const tick = (value: number | null | undefined) => (sameCut || value == null ? undefined : value);
  const tickLabel = (value: number | null | undefined) =>
    sameCut || value == null ? undefined : `this niche, ${headLabel}: ${fmtPct(value)}`;
  return (
    <Card
      title="Hit rates — how often a game here earns real money"
      subtitle={`Share of the cut's ${paid !== null ? "paid " : ""}games (${cutLabel}) clearing each revenue bar${
        sameCut ? "" : `; the tick is the same bar for this niche ${headLabel}`
      }.`}
    >
      <div className="flex flex-col gap-3">
        <BulletMeter
          term="hit_rate_200k"
          value={variant.hit_rate_200k}
          benchmark={tick(detail.hit_rates.hit_rate_200k)}
          benchmarkLabel={tickLabel(detail.hit_rates.hit_rate_200k)}
          color={CSS_VAR.demand}
          valueLabel={fmtPct(variant.hit_rate_200k)}
          worked={worked(variant.hit_rate_200k, "$200K")}
          sentinel={paidStatSentinel(variant, variant.hit_rate_200k)}
        />
        <BulletMeter
          term="hit_rate_500k"
          value={variant.hit_rate_500k}
          benchmark={tick(detail.hit_rates.hit_rate_500k)}
          benchmarkLabel={tickLabel(detail.hit_rates.hit_rate_500k)}
          color={CSS_VAR.demand}
          valueLabel={fmtPct(variant.hit_rate_500k)}
          worked={worked(variant.hit_rate_500k, "$500K")}
          sentinel={paidStatSentinel(variant, variant.hit_rate_500k)}
        />
        <BulletMeter
          term="beatable_share"
          label="Beatable share (weakly reviewed or thin games)"
          value={variant.beatable_share}
          color={CSS_VAR.qualityGap}
          valueLabel={fmtPct(variant.beatable_share)}
          worked={
            variant.beatable_share != null && variant.n_games > 0
              ? `≈ ${fmtInt(Math.round(variant.beatable_share * variant.n_games))} of ${fmtInt(variant.n_games)} games under 80% positive, under 50 reviews or unrated = ${fmtPct(variant.beatable_share)}`
              : undefined
          }
          sentinel={variant.beatable_share == null ? "no data" : undefined}
        />
        <BulletMeter
          term="winner_concentration"
          value={variant.winner_concentration}
          benchmark={WC_WINNER_TAKE_MOST}
          benchmarkLabel={`${fmtPct(WC_WINNER_TAKE_MOST, 0)} — above it the niche is winner-take-most`}
          color={CSS_VAR.competition}
          valueLabel={fmtPct(variant.winner_concentration)}
          sentinel={paidStatSentinel(variant, variant.winner_concentration)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted" data-testid="hit-rates-cut">
        {hc?.fallback ? (
          <>
            <span>Ticks:</span>
            <SentinelTag>{headLabel} — too few games for the all-time ≥50-review cut</SentinelTag>
          </>
        ) : !sameCut ? (
          <span>Ticks: this niche, {headLabel}.</span>
        ) : null}
        <span>For scale: about 8.5% of all Steam releases clear $100K (cited, first-year, all releases).</span>
      </div>
    </Card>
  );
}

/**
 * The honest degraded-state line. The per-game niche data is rebuilt a few hours after each
 * data update, and until then these panels legitimately have nothing — saying so beats an
 * infinite spinner or a silent empty table. (Plain words: this used to name internal table
 * names and HTTP status codes.)
 */
function DegradedNote({ what, status, extra }: { what: string; status: number | null; extra?: ReactNode }) {
  const because =
    status === 422
      ? " — this window and review floor aren't built for it yet; try another cut above"
      : status === 404
        ? " — nothing for this cut yet"
        : "";
  return (
    <p className="mt-2 text-[11px] text-ink-muted">
      {what} needs the per-game data for this niche, which is rebuilt a few hours after each data update{because}.
      {extra ? <> {extra}</> : null} Everything else on this page is live.
    </p>
  );
}
