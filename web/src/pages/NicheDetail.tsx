import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Histogram } from "../components/charts/Histogram";
import {
  NicheDistribution,
  type BucketSelection,
  type DistributionBucket,
} from "../components/charts/NicheDistribution";
import { SaturationTrend } from "../components/charts/SaturationTrend";
import { TooltipPanel } from "../components/charts/TooltipPanel";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { KpiCell } from "../components/ui/KpiCell";
import { Loading } from "../components/ui/Loading";
import { BulletMeter } from "../components/ui/Meter";
import { StatTile } from "../components/ui/StatTile";
import { ViewToggle } from "../components/ui/ViewToggle";
import { trackEvent } from "../lib/analytics";
import { estimatedUnits } from "../lib/estimates";
import { nicheWatchlistId, toggleNicheWatchlist, useWatchlist, WATCHLIST_CAP } from "../lib/watchlist";
import {
  ApiError,
  nicheExportCsvUrl,
  notFoundReason,
  useMarketBenchmarks,
  useNicheDetail,
  useNicheDistribution,
  useNicheGames,
  type Dimension,
  type NicheGameSortKey,
  type NicheGamesParams,
  type NichePlayers,
  type NichePlayersMonthlyPoint,
  type NichePlayersPoint,
  type NichePressPoint,
  type NicheRow,
  type TrendPoint,
  type Window,
} from "../lib/api";
import { fmtAxisCompact, fmtCompact, fmtInt, fmtMonths, fmtPct, fmtPrice, fmtRevenue, fmtSigned, fmtUsd, titleCase } from "../lib/format";
import { heatDomain, heatStyle } from "../lib/heat";
import { CSS_VAR } from "../lib/palette";
import { usePageTitle } from "../lib/usePageTitle";
import { useDetailView } from "../lib/viewMode";
import { DEFAULT_NICHE_CUT, nicheCombinedPath } from "../lib/nicheSelection";

/** The condensed stack the foundation applies to h1–h6 and .kicker (index.css) — used inline
 * for KPI/panel numerals that aren't semantically headings, so they still read as the
 * blueprint identity's display type. */
const CONDENSED = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

/**
 * The niche deep-dive PAGE — the twin of /games/:appid, replacing the old right-hand
 * NicheDetailDrawer. Everything that decides what you see lives in the URL (the cut, the
 * tab, the distribution bucket selection), so a filtered view is a link you can send —
 * which is the whole reason this stopped being a drawer.
 *
 * Structure deliberately mirrors GameProfile.tsx: back link → identity card → a row of
 * StatTiles → tab pills + the shared Simple/Detailed ViewToggle → Cards.
 */

// ---- route + URL contract ----------------------------------------------------------------

// The route pattern + link builder moved to lib/nichePath.ts (eager modules — App's route
// table, RadarBoard — must be able to link here without statically importing this whole
// page module, or the route-level code splitting is defeated). Re-exported so the pages
// and tests that always imported them from here keep working.
export { NICHE_ROUTE_PATH, nicheDetailPath } from "../lib/nichePath";

export const GAMES_PAGE_SIZE = 25;

/** Rows in the overview's "Top games in the niche" preview. It is a request `limit` now, not
 * a `.slice()` of a fixed top-8 the API happened to ship — see the panel for why. */
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

// The API's request-side sort names (routers/niches.py `_GAME_SORT`), not the row fields.
// Owners is deliberately absent there, so its column header stays inert.
const GAME_SORT_KEYS: NicheGameSortKey[] = ["revenue", "price", "reviews", "release_year", "name"];

/** URL query string → the games request. The two bucket selections are the cross-filter:
 * whatever is brushed on the revenue/price histograms lands here as the rev_min/rev_max and
 * price_min/price_max bounds, so the table below the charts always shows exactly the
 * selected slice. */
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
  };
}

export function selectionLabel(metric: DistMetric, selection: NonNullable<BucketSelection>): string {
  const fmt = metric === "revenue" ? fmtUsd : fmtPrice;
  return `${metric === "revenue" ? "Revenue" : "Price"} ${fmt(selection.min)} – ${fmt(selection.max)}`;
}

// ---- ported from NicheDetailDrawer -------------------------------------------------------

function variantLabel(v: NicheRow): string {
  return `${v.window === "24m" ? "Last 24m" : "All-time"} · ≥${v.min_reviews} reviews`;
}

const TIER_HINT: Record<string, string> = {
  micro: "buildable game concept",
  theme: "setting/aesthetic — attach it to a micro-genre",
  umbrella: "genre container, not a buildable niche",
  meta: "reception tag, never buildable",
  genre: "Steam genre",
};

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
  if (v.entrant_ratio != null && v.entrant_ratio < 1) {
    flags.push({
      serious: v.entrant_ratio < 0.7,
      text: `Recent entrants earn ${v.entrant_ratio.toFixed(2)}× the back catalog's median (catalog norm ~1.08) — newcomers underearn here.`,
    });
  }
  if (v.winner_concentration != null && v.winner_concentration > 0.85) {
    flags.push({
      serious: false,
      text: `Winner-take-most: the top 5% of titles hold ${fmtPct(v.winner_concentration)} of revenue — expect the median outcome, not the hits.`,
    });
  }
  if (v.solo_viability != null && v.solo_viability < 0.8) {
    flags.push({
      serious: v.solo_viability < 0.6,
      text: `Leans multiplayer (${fmtPct(v.solo_viability)} of games playable single-player; norm ~90%) — netcode, servers and a live player base are table stakes.`,
    });
  }
  if (v.lifetime_survival_12m != null && v.lifetime_survival_12m < 0.5) {
    flags.push({
      serious: true,
      text: "Short-lived niche: fewer than half of its 100+-player games still hold 10+ a year later.",
    });
  }
  if (players?.players_trend_7d_pct != null && players.players_trend_7d_pct < -10) {
    flags.push({
      serious: false,
      text: `Live players down ${Math.abs(players.players_trend_7d_pct).toFixed(1)}% vs the prior 7 days (same-panel).`,
    });
  }
  return flags;
}

function PlayersSeriesChart({ points }: { points: NichePlayersPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-ink-muted">
        No daily series yet — fewer than 10 of this niche's games have been measured.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={150}>
      <LineChart data={points} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
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
          tickFormatter={(v: number) => fmtAxisCompact(v)}
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
                    label: `Measured same-day (${fmtInt(p.n_games_measured)} games)`,
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
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Monthly press-mention volume for the niche — same single-hue count-per-period bar shape
 * (and same aqua hue) as the game page's PressTimelineChart, since both slice the identical
 * underlying metric (journalist press mentions), just per game vs. pooled per niche. */
function NichePressChart({ points }: { points: NichePressPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 10 }}
          interval="preserveStartEnd"
          minTickGap={24}
          tickLine={false}
          axisLine={{ stroke: "var(--baseline)" }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => fmtInt(v)}
          tickLine={false}
          axisLine={false}
          width={36}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: "var(--gridline)", opacity: 0.5 }}
          content={({ active, payload, label }) => {
            if (!active || !payload || payload.length === 0) return null;
            const p = payload[0].payload as NichePressPoint;
            return (
              <TooltipPanel
                title={String(label)}
                rows={[{ label: "Articles", value: fmtInt(p.n_articles), color: CSS_VAR.competition }]}
              />
            );
          }}
        />
        <Bar dataKey="n_articles" fill={CSS_VAR.competition} radius={[4, 4, 0, 0]} maxBarSize={20} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---- page --------------------------------------------------------------------------------

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "games", label: "Games & distribution" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** Sortable header for the games table — same click-to-sort/arrow affordance as the Niche
 * Finder's SortLabel, scaled down to this table's type ramp. */
function GameSortLabel({
  label,
  col,
  active,
  order,
  onSort,
  className,
}: {
  label: string;
  col: NicheGameSortKey;
  active: boolean;
  order: "asc" | "desc";
  onSort: (col: NicheGameSortKey) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      title={`Sort by ${label}`}
      className={clsx(
        "group inline-flex items-center gap-1 font-medium transition-colors",
        active ? "text-ink-primary" : "text-ink-muted hover:text-ink-secondary",
        className,
      )}
    >
      {label}
      <span
        aria-hidden
        className={clsx("text-[10px] leading-none", active ? "opacity-100" : "opacity-0 group-hover:opacity-40")}
      >
        {active ? (order === "desc" ? "↓" : "↑") : "↕"}
      </span>
    </button>
  );
}

export default function NicheDetail() {
  const { dimension: dimensionParam, key: keyParam } = useParams<{ dimension: string; key: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [view, setView] = useDetailView();
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

  const detailQ = useNicheDetail(dimension ?? "tag", dimension ? nicheKey : null);
  const benchmarksQ = useMarketBenchmarks();
  const detail = detailQ.data;

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

  const gamesParams = useMemo(() => readGamesParams(searchParams, cut), [searchParams, cut]);
  const revenueSelection = readSelection(searchParams, "revenue");
  const priceSelection = readSelection(searchParams, "price");
  const hasSelection = revenueSelection !== null || priceSelection !== null;

  // The two new endpoints only exist after a mart rebuild; both are scoped to the games tab
  // so the overview never waits on them.
  const onGamesTab = tab === "games";
  const gamesQ = useNicheGames(dimension ?? "tag", dimension && onGamesTab ? nicheKey : null, gamesParams);
  // The overview's "Top games in the niche" panel reads the SAME cut-aware endpoint as the
  // games tab's table — see the panel itself for the measurement that forced it. It asks for
  // the cut ONLY: no rev_min/price_min, because this panel is "the niche's biggest games at
  // this cut", not the histogram-brushed slice (the brush belongs to the table below).
  const topGamesParams = useMemo<NicheGamesParams>(
    () => ({
      win: cut.win,
      min_reviews: cut.min_reviews,
      sort: "revenue",
      order: "desc",
      limit: TOP_GAMES_PANEL_SIZE,
      offset: 0,
    }),
    [cut],
  );
  const topGamesQ = useNicheGames(dimension ?? "tag", dimension && !onGamesTab ? nicheKey : null, topGamesParams);
  const revenueDistQ = useNicheDistribution(dimension ?? "tag", dimension && onGamesTab ? nicheKey : null, "revenue", cut);
  const priceDistQ = useNicheDistribution(dimension ?? "tag", dimension && onGamesTab ? nicheKey : null, "price", cut);

  useEffect(() => {
    if (dimension && nicheKey) trackEvent("niche_open");
  }, [dimension, nicheKey]);

  const patch = useCallback(
    (next: URLSearchParams) => {
      // replace, not push: brushing a histogram or flipping a cut shouldn't bury the Niche
      // Finder under a dozen history entries. The URL still fully describes the view, which
      // is what makes it linkable.
      setSearchParams(next, { replace: true });
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

  // ---- guard rails (same shapes as GameProfile's invalid-appid / not-found states) --------

  if (!dimension || !nicheKey) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <span className="text-verdict-serious">
            Invalid niche URL — the dimension must be “tag” or “genre”.
          </span>
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
    // The API's own 404 detail already reads "niche not found: tag/Foo" — don't stutter it.
    // Shared with GameProfile, which had the same 404 shape and NOT the same regex (it
    // rendered "Game not found: game not found: 999999999" until this moved into lib/api).
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
  const flags = declineFlags(activeVariant, players);
  const tier = detail.tier ?? activeVariant.tier;
  const catalogHitRateBenchmark = benchmarksQ.data?.cited.pct_new_releases_over_100k;
  const csvUrl = nicheExportCsvUrl({
    dimension,
    window: cut.win,
    min_reviews: cut.min_reviews,
    q: nicheKey,
    limit: 200,
  });

  const totalPlayersNow = players?.total_players_now ?? activeVariant.total_players_now;
  const playersTrend = players?.players_trend_7d_pct ?? activeVariant.players_trend_7d_pct;
  // /niches/.../games now carries live_players per row (routers/niches.py `_GAME_SELECT`),
  // which is what killed the old players.distribution.top_games join here: that list is the
  // top 8 BY PLAYERS, so every row outside it fell through to "—". DARK SOULS III, Sekiro
  // and Clair Obscur each printed "—" in this panel while /games/374320, /games/814380 and
  // /games/1903340 printed 3,849 / 2,716 / 6,453 for the same moment. Same fact, two
  // answers — the join was a ranked list being used as a lookup table.
  const hasP90Trend = detail.saturation_trend.some((p) => p.p90_rev != null);
  // The cut-aware top games for the overview panel. Falls back to the cut-INDEPENDENT
  // representative_games (mart_niche_top) only when the games mart isn't there — and says so
  // in the panel when it does, because that list is a different population.
  const topGames = topGamesQ.data?.items ?? [];
  const topGamesDegraded = !topGamesQ.isLoading && (topGamesQ.isError || topGames.length === 0);

  const gamesUnavailable =
    gamesQ.isError ||
    // A degraded (but 200) response: the mart answered, with nothing in it and no filter to
    // explain the emptiness.
    (!!gamesQ.data && gamesQ.data.total === 0 && !hasSelection);
  const gamesErrorStatus = gamesQ.error instanceof ApiError ? gamesQ.error.status : null;

  const revenueBuckets = revenueDistQ.data?.buckets ?? [];
  const priceBuckets = priceDistQ.data?.buckets ?? [];
  // Degraded = the endpoint errored, or answered 200 with nothing in it. Both mean "the mart
  // hasn't been rebuilt for this cut yet", and both are honest states, not spinners.
  const revenueDistDegraded = revenueDistQ.isError || (!revenueDistQ.isLoading && revenueBuckets.length === 0);
  const priceDistDegraded = priceDistQ.isError || (!priceDistQ.isLoading && priceBuckets.length === 0);
  const bucketTotal = (buckets: DistributionBucket[]) => buckets.reduce((sum, b) => sum + b.count, 0);
  const revenueTotalGames = revenueDistQ.data?.n_games ?? bucketTotal(revenueBuckets);
  const priceTotalGames = priceDistQ.data?.n_games ?? bucketTotal(priceBuckets);

  const rangeStart = gamesQ.data && gamesQ.data.total > 0 ? gamesParams.offset + 1 : 0;
  const rangeEnd = gamesQ.data ? Math.min(gamesParams.offset + GAMES_PAGE_SIZE, gamesQ.data.total) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] text-ink-primary/55">
              <Link to="/niches" className="hover:text-ink-primary">
                Niches
              </Link>
              {" / "}
              {titleCase(dimension)} /
            </div>
            <h1 className="mt-0.5 truncate text-[28px] text-ink-primary sm:text-[32px]">{nicheKey}</h1>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tier && (
                <span
                  title={TIER_HINT[tier] ?? tier}
                  className="border border-brand px-2 py-0.5 text-[11px] font-medium text-brand"
                >
                  {tier} tier
                </span>
              )}
              <span className="border border-ink-primary/30 px-2 py-0.5 text-[11px] font-medium text-ink-primary/65">
                window {cut.win === "all" ? "all-time" : "24m"}
              </span>
              <span className="border border-ink-primary/30 px-2 py-0.5 text-[11px] font-medium text-ink-primary/65">
                {cut.min_reviews > 0 ? `≥${cut.min_reviews} reviews` : "all games"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <a
              href={csvUrl}
              onClick={() => trackEvent("niche_export_csv")}
              className="text-[11px] font-medium text-ink-muted transition-colors hover:text-ink-primary"
            >
              Export CSV
            </a>
            <button
              type="button"
              onClick={() => {
                if (!dimension || !nicheKey) return;
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
        </div>

        {/* The materialized cuts, as links: the cut is URL state, so a shared link opens on
            the same population the sender was reading. */}
        {detail.variants.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {detail.variants.map((v) => {
              const active = v.window === cut.win && v.min_reviews === cut.min_reviews;
              return (
                <button
                  key={`${v.window}-${v.min_reviews}`}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setParam({ win: v.window, min_reviews: v.min_reviews, offset: null })}
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
      </div>

      {/* 4 equal cells, 1px gaps that read as the rules (gap = paper-20% background showing
          through, cells = the ground colour) — the exact §4b KPI-strip construction. */}
      <div className="grid grid-cols-1 gap-px border border-ink-primary/20 bg-ink-primary/20 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCell
          label="Opportunity v2"
          valueClassName="text-brand"
          value={fmtCompact(activeVariant.opportunity_v2)}
          footnote={
            activeVariant.supply_brake != null
              ? `after supply brake ×${activeVariant.supply_brake.toFixed(2)}`
              : undefined
          }
        />
        {/* §4b specs "Demand / 90d" as a review-velocity trend, which no endpoint serves at
            that horizon (the mart's demand trend is demand_trend_24m_pct — a 24-month
            structural read, deliberately not a 90-day one) — used the real 7-day, same-panel
            PLAYERS trend instead of inventing a 90-day review-velocity number. */}
        {/* Same disclosure problem as Saturation YoY next door, and the same fix. The live-
            player marts are keyed by (dimension, key, date) ONLY — mart_players.sql's panel
            is "niche members with >=50 reviews that the CCU collector has ever measured",
            with no window and no review-floor dimension to filter on — so this pair of
            numbers is identical under all six cuts. Live API, tag/Souls-like: 207.0K playing
            now over n_games_panel = 798 games, which matches NONE of the six selectable cuts
            (624 / 223 / 177 / 1841 / 739 / 584). Four of the eight biggest contributors are
            outside the 223-game 24m/>=50 cut the header names — ELDEN RING 32,145 (15.53%),
            Where Winds Meet 10,446, Wuthering Waves 9,212, Black Myth 8,392 — 60,195 players
            together, 29.1% of the 207,006 shown. A cut-scoped sum is NOT available to invent
            here either: the 7-day trend that is this tile's actual VALUE needs both windows'
            per-game averages, and only the ratio survives into the marts. So the tile does
            what the saturation tile does — states its own population instead of pretending
            to answer the controls. */}
        <KpiCell
          label="Players / 7d"
          valueClassName={playersTrend != null && playersTrend >= 0 ? "text-brand" : undefined}
          value={
            playersTrend != null
              ? `${playersTrend >= 0 ? "▲" : "▼"} ${playersTrend >= 0 ? "+" : ""}${playersTrend.toFixed(1)}%`
              : "—"
          }
          footnoteWrap
          footnote={
            // No figure at all -> nothing to disown; keep the bare basis line.
            totalPlayersNow == null && playersTrend == null ? (
              "same-panel vs prior 7d"
            ) : (
              <>
                {totalPlayersNow != null ? `${fmtCompact(totalPlayersNow)} playing now` : "same-panel vs prior 7d"}
                <span className="mt-0.5 block text-ink-primary/45">
                  Every measured game in the niche
                  {players?.n_games_panel != null ? ` (${fmtInt(players.n_games_panel)})` : ""} — this tile ignores the
                  window and review-floor controls above.
                </span>
              </>
            )
          }
        />
        <KpiCell
          label="P90 revenue"
          value={activeVariant.p90_rev != null ? fmtUsd(activeVariant.p90_rev) : "—"}
          footnote={`median ${fmtUsd(activeVariant.median_rev)} · ${fmtInt(activeVariant.n_games)} scored games`}
        />
        <KpiCell
          label="Saturation YoY"
          value={
            activeVariant.saturation_yoy != null
              ? `${activeVariant.saturation_yoy >= 0 ? "▲" : "▼"} ${fmtSigned(activeVariant.saturation_yoy, 0)}`
              : "—"
          }
          // The footnote must state THIS number's own basis. It used to read
          // "<n_recent> released in the last 24m", which is a different figure entirely:
          // n_recent counts the rolling 24 months AND applies the min-reviews cut, while
          // saturation_yoy compares two FULL CALENDAR YEARS over every member of the niche
          // with no review floor (mart_niche.sql's `sat` CTE). Trading Card Game showed
          // "▲ +4% / 38 released in the last 24m" — but the +4% is 124 in the last full year
          // against 119 the year before, a 243-game base. Reading it as "38 games, up 4%"
          // makes a solid number look like noise, and on a genuinely small niche it would
          // make noise look solid.
          //
          // The counts and the percentage now share a population, but that population is not
          // the one the rest of the row uses: it is the WHOLE niche, and it is the same three
          // numbers at every (window x review-floor) the controls above offer. The tile next
          // door moves 624 -> 223 -> 177 -> 739 as you click those controls while this one
          // never budges, so the tile has to disown them itself — a reader must not need to
          // know mart_niche.sql to read the KPI row left to right. Cut-independence is the
          // mart's deliberate design (one saturation figure per dimension+key); disclosing it
          // is presentation's job.
          //
          // "this tile ALONE ignores…" until 2026-09-01: the Players / 7d cell two places
          // left turned out to be cut-independent too (its marts have no window/floor key at
          // all — 798 measured games against the row's 223), so it now carries the same
          // sentence and "alone" stopped being true.
          footnoteWrap
          footnote={
            activeVariant.n_recent_year != null && activeVariant.n_prior_year != null ? (
              <>
                {fmtInt(activeVariant.n_recent_year)} released last full year vs{" "}
                {fmtInt(activeVariant.n_prior_year)} the year before
                <span className="mt-0.5 block text-ink-primary/45">
                  Whole niche, every review count — this tile ignores the window and review-floor controls above.
                </span>
              </>
            ) : (
              "year-over-year release counts unavailable"
            )
          }
        />
      </div>

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

      {/* §4b's composition ends at the "Top games" table below — everything the app carries
          beyond that mockup (this bearish-flags read, the Detailed-view cards, and the whole
          Games & distribution tab) sits AFTER it rather than interleaved above it. */}
      {tab === "overview" && (
        <>
          <div className="flex flex-col gap-[22px] lg:flex-row lg:items-stretch">
            {/* Demand vs pipeline. §4b specs a 24-month MONTHLY two-series chart (review
                velocity vs releases); no endpoint here carries that granularity — the only
                real releases-vs-demand series in the mart is yearly (saturation_trend, already
                the "Saturation trend" card below). Reused that same real data/hook in the new
                two-line visual language rather than a monthly figure the API doesn't serve. */}
            <div className="blueprint relative flex-[1.6] border-ink-primary/25 px-6 py-5">
              <i className="bp-corner" />
              <div className="mb-3.5 flex items-baseline gap-4">
                <h3 className="text-ink-primary">Demand vs. pipeline, by year</h3>
                <div className="ml-auto flex gap-4 text-[11px] text-ink-primary/60">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-[2px] w-3.5 bg-brand" aria-hidden />
                    {hasP90Trend ? "P90 revenue" : "Median revenue"}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-[2px] w-3.5 bg-ink-primary/45" aria-hidden />
                    Releases
                  </span>
                </div>
              </div>
              {detail.saturation_trend.length === 0 ? (
                <div className="flex h-[180px] items-center justify-center text-xs text-ink-muted">
                  No yearly trend for this niche.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={detail.saturation_trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--gridline)" vertical={false} />
                    <XAxis
                      dataKey="year"
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: "var(--baseline)" }}
                    />
                    <YAxis yAxisId="revenue" hide domain={["auto", "auto"]} />
                    <YAxis yAxisId="releases" orientation="right" hide domain={[0, "auto"]} />
                    <Tooltip
                      cursor={{ stroke: "var(--baseline)" }}
                      content={({ active, payload, label }) => {
                        if (!active || !payload || payload.length === 0) return null;
                        const p = payload[0].payload as TrendPoint;
                        return (
                          <TooltipPanel
                            title={String(label)}
                            rows={[
                              {
                                label: hasP90Trend ? "P90 revenue" : "Median revenue",
                                value: fmtUsd(hasP90Trend ? (p.p90_rev ?? null) : p.median_rev),
                                color: "var(--brand)",
                              },
                              { label: "Releases", value: fmtCompact(p.n_releases) },
                            ]}
                          />
                        );
                      }}
                    />
                    <Line
                      yAxisId="revenue"
                      type="linear"
                      dataKey={hasP90Trend ? "p90_rev" : "median_rev"}
                      stroke="var(--brand)"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls
                    />
                    <Line
                      yAxisId="releases"
                      type="linear"
                      dataKey="n_releases"
                      stroke="color-mix(in srgb, var(--text-primary) 45%, transparent)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Why the headline score — one weighted 4px bar per sub-score, in the same
                §4b bar+footnote layout. These ARE the four terms mart_niche blends (see
                its "opportunity_v2 REBUILT" header), so the card takes the score apart
                into the four claims it makes rather than restating one number. Marts that
                predate the 2026-08-31 rebuild serve them as undefined and the footnote
                below falls back to a plain description. */}
            <div className="blueprint relative flex flex-[1] flex-col gap-3.5 border-ink-primary/25 px-6 py-5">
              <i className="bp-corner" />
              <h3 className="text-ink-primary">Why {fmtCompact(activeVariant.opportunity_v2)}</h3>
              <div className="flex flex-col gap-2.5 text-[13px]">
                {(
                  [
                    { label: "Momentum", value: activeVariant.momentum ?? null, weight: 0.4, positive: true },
                    { label: "Market pull", value: activeVariant.market_pull ?? null, weight: 0.22, positive: true },
                    { label: "Revenue spread", value: activeVariant.revenue_spread ?? null, weight: 0.2, positive: true },
                    { label: "Quality gap", value: activeVariant.quality_gap, weight: 0.18, positive: true },
                  ] as const
                ).map((b) => {
                  const pct = b.value == null ? 0 : Math.max(0, Math.min(100, b.value));
                  return (
                    <div key={b.label}>
                      <div className="mb-1 flex text-ink-primary">
                        <span>{b.label}</span>
                        <span className={clsx("tabular ml-auto", b.positive ? "text-brand" : "text-ink-primary/70")}>
                          {b.value != null ? b.value.toFixed(0) : "—"} × {b.weight >= 0 ? b.weight.toFixed(2) : `−${Math.abs(b.weight).toFixed(2)}`}
                        </span>
                      </div>
                      <div className="h-1 bg-ink-primary/15">
                        <div
                          className={clsx("h-full", b.positive ? "bg-brand" : "bg-ink-primary/50")}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="tabular mt-auto border-t border-ink-primary/20 pt-3 text-[12px] text-ink-primary/65">
                {activeVariant.supply_brake != null
                  ? (() => {
                      const terms: [string, number | null | undefined, number][] = [
                        ["momentum", activeVariant.momentum, 0.4],
                        ["market pull", activeVariant.market_pull, 0.22],
                        ["revenue spread", activeVariant.revenue_spread, 0.2],
                        ["quality gap", activeVariant.quality_gap, 0.18],
                      ];
                      const live = terms.filter(([, n]) => n != null);
                      const skipped = terms.filter(([, n]) => n == null).map(([l]) => l);
                      // The blend RENORMALISES over the terms that exist — the divisor has
                      // to be printed, or the products visibly fall short of the score.
                      const liveWeight = live.reduce((a, [, , w]) => a + w, 0);
                      return (
                        <>
                          {live.map(([, n, w]) => `${w.toFixed(2)}×${n!.toFixed(1)}`).join(" + ")}
                          {skipped.length > 0 &&
                            ` ÷ ${liveWeight.toFixed(2)} (${skipped.join(" + ")} — no comparable reading, skipped rather than counted as 0)`}
                          {` → × supply brake ${activeVariant.supply_brake!.toFixed(2)} = `}
                          <strong className="text-brand">{fmtCompact(activeVariant.opportunity_v2)}</strong>
                          {activeVariant.beatable_share != null && (
                            <>. {fmtPct(activeVariant.beatable_share)} of incumbents are thin or weak — beatable.</>
                          )}
                        </>
                      );
                    })()
                  : "This mart predates the score breakdown — rebuild the marts to see the sub-scores."}
              </div>
            </div>
          </div>

          {/* Top games in the niche — the top five OF THIS CUT, off the same
              /niches/:dimension/:key/games endpoint the Games & distribution table reads.
              It used to render detail.representative_games, i.e. mart_niche_top: ONE
              cut-independent top-8 per (dimension, key), under a header that names the cut.
              Live API, tag/Souls-like at win=24m min_reviews=50 (header: "window 24m · ≥50
              reviews", tile: "223 scored games") it listed Black Myth $2.2B and ELDEN RING
              $2.1B — appids 2358720 and 1245620, neither of which is in those 223 at all:
              ask that cut for its own top by revenue desc and the first row back is Clair
              Obscur, which those two would outrank 5:1 if they were members. So the cut's
              real top game is Clair Obscur at $414.3M, and the panel's
              top-1 read 5.24x the truth and its top-5 sum 4.82x, and the same five rows were
              served under all six selectable cuts — only the "All N →" label moved. The
              games tab's table was already right (Clair Obscur, Silksong, NIGHTREIGN, PoE2,
              Stellar Blade); this panel now shares its data path, so the two surfaces cannot
              disagree again. */}
          <div className="blueprint relative border-ink-primary/25">
            <i className="bp-corner" />
            <div className="flex items-baseline gap-2 px-5 pb-2.5 pt-3.5">
              <h3 className="text-ink-primary">Top games in the niche</h3>
              <button
                type="button"
                onClick={() => setParam({ tab: "games" })}
                className="ml-auto text-xs font-medium text-brand hover:underline"
              >
                All {fmtInt(activeVariant.n_games)} →
              </button>
            </div>
            {topGamesQ.isLoading ? (
              <div className="border-t border-ink-primary/20 px-5 py-6 text-center text-xs text-ink-muted">
                Loading top games…
              </div>
            ) : topGamesDegraded && detail.representative_games.length === 0 ? (
              <div className="border-t border-ink-primary/20 px-5 py-6 text-center text-xs text-ink-muted">
                No games for this cut yet.
              </div>
            ) : (
              // Six fixed columns don't reflow at phone widths — scroll horizontally instead
              // of squeezing them (same convention as the Games & distribution tab's table).
              <div className="overflow-x-auto">
                <div className="min-w-[640px]">
                  {/* The game mart only lands on a nightly REBUILD, so for a few hours after
                      a deploy there is no cut-aware list. Falling back to mart_niche_top is
                      still the best list we have — but it is the population this panel was
                      just fixed for showing silently, so in that state it has to say so. */}
                  {topGamesDegraded && (
                    <div className="border-t border-ink-primary/20 px-5 py-2 text-[11px] leading-snug text-ink-primary/50">
                      The per-cut list needs the nightly game mart, which hasn’t landed yet — these are the niche’s
                      biggest games all-time at every review count, not the {variantLabel(activeVariant).toLowerCase()}{" "}
                      cut.
                    </div>
                  )}
                  <div className="grid grid-cols-[60px_2fr_1fr_1fr_1fr_1fr] items-center gap-3.5 border-t border-ink-primary/20 px-5 py-2.5">
                    <span />
                    <span className="kicker text-[11px] text-ink-primary/55">Game</span>
                    <span className="kicker text-[11px] text-ink-primary/55">Released</span>
                    <span className="kicker text-[11px] text-ink-primary/55">Est. revenue</span>
                    <span className="kicker text-[11px] text-ink-primary/55">Reviews</span>
                    <span className="kicker text-[11px] text-ink-primary/55">Players now</span>
                  </div>
                  {(topGamesDegraded
                    ? detail.representative_games.slice(0, TOP_GAMES_PANEL_SIZE).map((g) => ({
                        appid: g.appid,
                        name: g.name,
                        release_year: g.release_year,
                        price_initial: g.price_initial,
                        est_revenue: g.est_rev_reviews,
                        positive_ratio: g.positive_ratio,
                        total_reviews: g.total_reviews,
                        header_image: g.header_image,
                        // mart_niche_top carries no CCU column, and the fallback must not
                        // reach back into players.distribution.top_games for it — that is a
                        // top-8-BY-PLAYERS ranking, and using it as a lookup is precisely
                        // what made DARK SOULS III read "—" here and 3,849 on /games/374320.
                        live_players: null as number | null,
                      }))
                    : topGames
                  ).map((g) => (
                    <Link
                      key={g.appid}
                      to={`/games/${g.appid}`}
                      className="grid grid-cols-[60px_2fr_1fr_1fr_1fr_1fr] items-center gap-3.5 border-t border-ink-primary/10 px-5 py-2.5 text-sm transition-colors hover:bg-ink-primary/[0.04]"
                    >
                      {g.header_image ? (
                        <img src={g.header_image} alt="" className="h-[26px] w-full object-cover" loading="lazy" />
                      ) : (
                        <span
                          aria-hidden
                          className="h-[26px] w-full"
                          style={{
                            backgroundImage:
                              "repeating-linear-gradient(45deg, color-mix(in srgb, var(--text-primary) 12%, transparent), color-mix(in srgb, var(--text-primary) 12%, transparent) 4px, transparent 4px, transparent 8px)",
                          }}
                        />
                      )}
                      <span className="truncate font-medium text-ink-primary">{g.name ?? `App ${g.appid}`}</span>
                      <span className="tabular text-ink-primary/70">{g.release_year ?? "—"}</span>
                      <span className="tabular text-ink-primary/70">
                        {fmtRevenue(g.est_revenue, g.price_initial === 0)}
                      </span>
                      <span className="tabular text-ink-primary/70">
                        {fmtPct(g.positive_ratio)} · {fmtInt(g.total_reviews)}
                      </span>
                      {/* Per-row live CCU from the game mart — the same column /api/games/
                          {appid} serves, not a rank-8 leaderboard join. */}
                      <span className="tabular text-brand">
                        {g.live_players != null ? fmtCompact(g.live_players) : "—"}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Not part of §4b — the app's pre-existing bearish-read card, kept but moved below
              the mockup's own composition (header/KPI/panels/table) rather than ahead of it. */}
          <Card title="Read this first">
            {flags.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {flags.map((f) => (
                  <div key={f.text} className="flex items-start gap-2 text-xs text-ink-secondary">
                    <span
                      aria-hidden
                      className={clsx(
                        "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                        f.serious ? "bg-[var(--text-primary)]" : "bg-[color-mix(in_srgb,var(--text-primary)_50%,transparent)]",
                      )}
                    />
                    {f.text}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-ink-secondary">
                No decline flags at this cut — pipeline, entrant economics, concentration and solo-viability all read
                normal.
              </div>
            )}
          </Card>

          {/* The chart-heavy expert cards live under the Detailed toggle; Simple keeps the
              plain-language reads (header, stat tiles, flags, opportunity) only — same split
              as GameProfile. */}
          {view === "detailed" && (
            <>
              {/* Everything in this card — the tiles, the series, the monthly history, the
                  holders list and the histogram — comes from the mart_niche_players family,
                  which is keyed by (dimension, key, date) with NO window/review-floor
                  dimension. The whole card therefore answers for one fixed panel while the
                  controls at the top of the page move; saying so once, in the subtitle, is
                  cheaper for the reader than a caveat per tile. */}
              <Card
                title="Live players — is this niche hot right now"
                subtitle="Nightly ~21–22:00 UTC point samples, not daily peaks; each game's last capture carries forward up to 7 days so the capture rotation doesn't read as audience dips. Whole measured niche: this card ignores the window and review-floor controls above."
              >
                <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile
                    help="Summed current concurrent players across every game in the niche the CCU collector has measured — NOT the cut selected above. Dominated by the niche's biggest games."
                    label="Playing now"
                    value={players?.total_players_now != null ? fmtCompact(players.total_players_now) : "—"}
                    sub={
                      players?.n_games_panel != null ? (
                        <>
                          {fmtInt(players.n_games_panel)} games measured
                          {/* On tag/Souls-like this is 798 against a header that says 223 —
                              the panel is not any of the six cuts, so the count has to be
                              readable as its own population, not as the cut's. */}
                          <span className="mt-0.5 block text-ink-muted">whole niche, not the selected cut</span>
                        </>
                      ) : undefined
                    }
                  />
                  <StatTile
                    help="Last 7 days vs the 7 before, counting only games measured in BOTH windows — growing data coverage can't fake an audience trend."
                    label="7-day trend"
                    // Trend verdict → mono steel (up = accent, down recedes to muted ink;
                    // "never red/green"), matching every other ▲/▼ verdict in the app.
                    valueClassName={
                      players?.players_trend_7d_pct == null
                        ? undefined
                        : players.players_trend_7d_pct >= 0
                          ? "text-brand"
                          : "text-ink-muted"
                    }
                    value={
                      players?.players_trend_7d_pct != null
                        ? `${players.players_trend_7d_pct >= 0 ? "+" : ""}${players.players_trend_7d_pct.toFixed(1)}%`
                        : "—"
                    }
                    sub="same-panel vs prior 7d"
                  />
                  <StatTile
                    help="Share of the playing-now total that was actually measured in the last 2 days (the rest is carried forward from recent captures). Low coverage = trust the total less."
                    label="Coverage"
                    value={players?.players_coverage != null ? fmtPct(players.players_coverage) : "—"}
                    sub="measured fresh (≤2d)"
                  />
                </div>
                <PlayersSeriesChart points={players?.series ?? []} />

                {(players?.monthly?.length ?? 0) >= 6 && (
                  <div className="mt-4">
                    <div className="mb-1 text-xs text-ink-muted">
                      Niche audience over the years — summed monthly average players
                    </div>
                    <ResponsiveContainer width="100%" height={150}>
                      <LineChart data={players!.monthly} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
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
                          tickFormatter={(v: number) => fmtAxisCompact(v)}
                          tickLine={false}
                          axisLine={false}
                          width={44}
                        />
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
                        <Line
                          type="linear"
                          dataKey="avg_players_sum"
                          stroke={CSS_VAR.demand}
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
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
                            <b className="tabular text-verdict-serious">
                              {fmtPct(players.distribution.players_top5_share)}
                            </b>
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
                              style={{
                                width: `${Math.max(1, (g.share ?? 0) * 100)}%`,
                                backgroundColor: CSS_VAR.demand,
                              }}
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
                          Concurrent players across {fmtInt(players.distribution.n_games_now)} games in the niche (log
                          scale)
                        </div>
                        <Histogram
                          buckets={players.distribution.histogram}
                          color={CSS_VAR.competition}
                          formatX={fmtCompact}
                          height={140}
                        />
                      </div>
                    )}
                  </div>
                )}

                {(activeVariant.lifetime_survival_12m != null ||
                  activeVariant.lifetime_median_dead_months != null) && (
                  <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                    <div
                      className="text-xs text-ink-muted"
                      title="Lifetime = months from a game's first month averaging 100+ concurrent players to its first full month under 10. Fixed-horizon survival counts only games whose 100+ month is at least 12 months old; steamcharts top-8k coverage."
                    >
                      How long games live here
                    </div>
                    <div className="text-xs text-ink-secondary">
                      {activeVariant.lifetime_survival_12m != null && (
                        <>
                          alive a year after reaching 100+ players:{" "}
                          <b className="tabular">{fmtPct(activeVariant.lifetime_survival_12m)}</b>
                        </>
                      )}
                      {activeVariant.lifetime_survival_12m != null &&
                        activeVariant.lifetime_median_dead_months != null &&
                        " · "}
                      {activeVariant.lifetime_median_dead_months != null && (
                        <>
                          dead ones lasted ~
                          <b className="tabular">{fmtMonths(activeVariant.lifetime_median_dead_months)}</b>
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

              <Card
                title="Revenue spread and entry economics"
                subtitle="Estimated lifetime GROSS per game (reviews × 30 owners-per-review × launch price — one flat ratio, not fitted per genre) — not net of Steam's cut, refunds or discounts."
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile
                    help="Half the niche's scored games earn less than this. What a REALISTIC entry should expect — not what the hits earn."
                    label="Median revenue"
                    value={fmtUsd(activeVariant.median_rev)}
                    sub="the typical outcome"
                  />
                  <StatTile
                    help="A quarter of the niche's games earn more than this — a good-but-not-exceptional outcome."
                    label="P75 revenue"
                    value={fmtUsd(activeVariant.p75_rev)}
                  />
                  <StatTile
                    help="Only 1 game in 10 earns more than this — what the niche's successful titles make."
                    label="P90 revenue"
                    value={activeVariant.p90_rev != null ? fmtUsd(activeVariant.p90_rev) : "—"}
                    sub="the successful tail"
                  />
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile
                    help="Estimated copies owned across all the niche's scored games — the size of the pie. Big pie + weak median = people play the hits; it doesn't hand a new entrant players."
                    label="Total owners"
                    value={fmtCompact(activeVariant.total_owners)}
                    sub={
                      activeVariant.market_size != null
                        ? `market size p${Math.round(activeVariant.market_size)}`
                        : undefined
                    }
                  />
                  <StatTile
                    help="Median revenue of games released in the last 24 months vs the niche's all-time median. The catalog-wide norm is ~1.08×, so read against that: meaningfully below 1 = recent entrants genuinely underearn the back catalog."
                    label="Newcomers earn"
                    value={activeVariant.entrant_ratio != null ? `${activeVariant.entrant_ratio.toFixed(2)}×` : "—"}
                    sub="of the back catalog's median (norm ~1.08×)"
                  />
                  <StatTile
                    help="Share of the niche's scored games that are playable single-player (catalog norm ~90%). Below ~80% the niche leans multiplayer — netcode, servers and a live player base become table stakes."
                    label="Solo viability"
                    value={fmtPct(activeVariant.solo_viability)}
                    sub="playable single-player (norm ~90%)"
                  />
                </div>
              </Card>

              <Card
                title="Hit rates vs. benchmark"
                subtitle="The odds a serious title clears each revenue bar here, against the catalog-wide reference mark."
              >
                <div className="flex flex-col gap-3">
                  <BulletMeter
                    label="Hit rate ≥ $200K"
                    value={activeVariant.hit_rate_200k}
                    benchmark={catalogHitRateBenchmark}
                    benchmarkLabel={
                      catalogHitRateBenchmark !== undefined
                        ? `Catalog-wide: ${fmtPct(catalogHitRateBenchmark)} of ALL releases clear $100K (lower bar, cited for scale)`
                        : undefined
                    }
                    color={CSS_VAR.demand}
                    valueLabel={fmtPct(activeVariant.hit_rate_200k)}
                  />
                  <BulletMeter
                    label="Hit rate ≥ $500K"
                    value={activeVariant.hit_rate_500k}
                    benchmark={catalogHitRateBenchmark}
                    benchmarkLabel={
                      catalogHitRateBenchmark !== undefined
                        ? `Catalog-wide: ${fmtPct(catalogHitRateBenchmark)} of ALL releases clear $100K (lower bar, cited for scale)`
                        : undefined
                    }
                    color={CSS_VAR.demand}
                    valueLabel={fmtPct(activeVariant.hit_rate_500k)}
                  />
                  <BulletMeter
                    label="Beatable share (thin/weak competitors)"
                    value={activeVariant.beatable_share}
                    color={CSS_VAR.qualityGap}
                    valueLabel={fmtPct(activeVariant.beatable_share)}
                  />
                  <BulletMeter
                    label="Winner concentration (top 5% revenue share)"
                    value={activeVariant.winner_concentration}
                    color={CSS_VAR.competition}
                    valueLabel={fmtPct(activeVariant.winner_concentration)}
                  />
                </div>
              </Card>

              <Card
                title="Saturation trend"
                subtitle="Releases per year against what they earned — a shrinking pipeline is decline even when competition looks invitingly low."
              >
                <SaturationTrend points={detail.saturation_trend} />
                {activeVariant.saturation_yoy != null && (
                  // Same disclosure as the KPI tile: this chart and this percentage are the
                  // whole niche at every review floor, unlike everything else on the page.
                  <p className="mt-1.5 text-[11px] text-ink-muted">
                    Releases {fmtSigned(activeVariant.saturation_yoy, 0)} year-over-year
                    {activeVariant.n_recent_year != null && activeVariant.n_prior_year != null
                      ? ` (${fmtInt(activeVariant.n_recent_year)} last full year vs ${fmtInt(activeVariant.n_prior_year)} the year before)`
                      : ""}
                    . Whole niche, every review count — not the “{variantLabel(activeVariant)}” cut selected above.
                  </p>
                )}
              </Card>

              {detail.themes.length > 0 && (
                <Card
                  title="What players praise & complain about"
                  subtitle="Review aspects pooled across the niche (vote-weighted). A complaint the whole niche shares is a quality-gap opening; a praise pillar is the bar to clear."
                >
                  <div className="overflow-x-auto rounded-card border border-chartborder">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead>
                        <tr className="border-b border-chartborder text-left text-ink-muted">
                          <th className="px-2 py-1.5 font-medium">Aspect</th>
                          <th className="px-2 py-1.5 font-medium">Praise</th>
                          <th className="px-2 py-1.5 font-medium">Complaints</th>
                          <th className="px-2 py-1.5 font-medium">vs catalog</th>
                          <th className="px-2 py-1.5 font-medium">Mentions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.themes.map((t) => (
                          <tr key={t.aspect} className="border-b border-chartborder/60 last:border-0">
                            <td className="px-2 py-1.5 font-medium text-ink-primary">{t.aspect}</td>
                            {/* Aspect sentiment is mono steel per the handoff (4c: "positive
                                accent-300, negative paper 50%") — red/green stays reserved
                                for real error/status states, not data verdicts. */}
                            <td className="tabular px-2 py-1.5 text-brand">{fmtPct(t.praise_share)}</td>
                            <td className="tabular px-2 py-1.5 text-ink-muted">{fmtPct(t.complaint_share)}</td>
                            <td
                              className={clsx(
                                "tabular px-2 py-1.5",
                                (t.praise_delta_vs_catalog ?? 0) >= 0 ? "text-brand" : "text-ink-muted",
                              )}
                              title="Praise share vs the all-catalog baseline for this aspect"
                            >
                              {t.praise_delta_vs_catalog != null
                                ? `${t.praise_delta_vs_catalog >= 0 ? "+" : ""}${(
                                    t.praise_delta_vs_catalog * 100
                                  ).toFixed(1)}pp`
                                : "—"}
                            </td>
                            <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtCompact(t.total_mentions)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              {detail.press && detail.press.timeline.length > 0 && (
                <Card
                  title="Press coverage"
                  subtitle={`${fmtInt(detail.press.total_articles)} dated press mentions of this niche's games, by month — journalist coverage only (Steam News excluded).`}
                >
                  <NichePressChart points={detail.press.timeline} />
                  {detail.press.top_outlets.length > 0 && (
                    <div className="mt-3 overflow-x-auto rounded-card border border-chartborder">
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
                    </div>
                  )}
                  <p className="mt-2 text-[11px] italic text-ink-muted">
                    Fuzzy-matched with a confidence floor; an article covering two of the niche's games counts once per
                    game. Press follows games that are already notable — read this as the niche's visibility and who to
                    pitch, not as what caused the sales.
                  </p>
                </Card>
              )}
            </>
          )}
        </>
      )}

      {tab === "games" && (
        <>
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
              subtitle="Every game in this cut, bucketed by estimated lifetime revenue (log scale). Select buckets to filter the table below."
            >
              {revenueDistDegraded ? (
                // Not a blank card: the niche detail already carries a (static, non-brushable)
                // revenue histogram, so the revenue SHAPE survives the mart rebuild window —
                // only the click-to-filter interaction is missing.
                <>
                  <Histogram buckets={detail.revenue_histogram} color={CSS_VAR.demand} formatX={fmtUsd} height={200} />
                  <DegradedNote
                    what="Bucket filtering"
                    status={revenueDistQ.error instanceof ApiError ? revenueDistQ.error.status : null}
                    extra="Showing the niche's precomputed all-time ≥50-review revenue spread meanwhile — the shape, without the click-to-filter."
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
              subtitle="Launch price across the niche's games — where the field actually prices, and where it doesn't."
            >
              {priceDistDegraded ? (
                // No static price histogram exists anywhere in the mart, so this one really
                // does have nothing to fall back to — say so plainly instead of an empty box.
                <div className="flex h-[240px] flex-col items-center justify-center gap-1 px-4 text-center">
                  <span className="text-xs text-ink-muted">No price distribution for this cut yet.</span>
                  <DegradedNote
                    what="The price histogram"
                    status={priceDistQ.error instanceof ApiError ? priceDistQ.error.status : null}
                  />
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
              gamesQ.data && !gamesUnavailable
                ? `${fmtInt(gamesQ.data.total)} game${gamesQ.data.total === 1 ? "" : "s"} in ${variantLabel(activeVariant)}${
                    hasSelection ? " matching the selected buckets" : ""
                  }`
                : undefined
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
                      ? "Showing the niche's top representative games from the existing mart meanwhile."
                      : undefined
                  }
                />
                {detail.representative_games.length > 0 && (
                  <div className="mt-3 overflow-x-auto rounded-card border border-chartborder">
                    <table className="w-full min-w-[640px] text-xs">
                      <thead>
                        <tr className="border-b border-chartborder text-left text-ink-muted">
                          <th className="px-2 py-1.5 font-medium">#</th>
                          <th className="px-2 py-1.5 font-medium">Game</th>
                          <th className="px-2 py-1.5 font-medium">Year</th>
                          <th className="px-2 py-1.5 font-medium">Price</th>
                          {/* The degraded fallback shipped the SAME mixed-estimator row as the
                              live table above — owners_mid beside est_rev_reviews — so it gets
                              the same fix. A reader who lands here during a mart rebuild has to
                              get the same arithmetic, not a second answer. */}
                          <th
                            className="px-2 py-1.5 font-medium"
                            title="Est. revenue ÷ launch price — the same reviews-based (Boxleiter) estimator as the revenue column, so the row multiplies out."
                          >
                            Est. units
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
                            <td className="tabular px-2 py-1.5">{fmtPrice(g.price_initial)}</td>
                            <td className="tabular px-2 py-1.5">
                              {fmtCompact(estimatedUnits(g.est_rev_reviews, g.price_initial, g.total_reviews))}
                            </td>
                            <td className="tabular px-2 py-1.5">{fmtInt(g.total_reviews)}</td>
                            <td className="tabular px-2 py-1.5">{fmtPct(g.positive_ratio)}</td>
                            <td className="tabular px-2 py-1.5">
                              {fmtRevenue(g.est_rev_reviews, g.price_initial === 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {!gamesUnavailable && gamesQ.data && gamesQ.data.items.length === 0 && (
              <EmptyState
                className="py-6"
                title="No games match the selected buckets"
                description="Every game in this niche falls outside the brushed revenue/price range."
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
                  ) : undefined
                }
              />
            )}

            {!gamesUnavailable && gamesQ.data && gamesQ.data.items.length > 0 && (
              <>
                <div
                  className={clsx(
                    "overflow-x-auto rounded-card border border-chartborder",
                    gamesQ.isFetching && "opacity-90 transition-opacity",
                  )}
                >
                  <table className="w-full min-w-[640px] text-xs">
                    <thead>
                      <tr className="border-b border-chartborder text-left text-ink-muted">
                        <th className="px-2 py-1.5">
                          <GameSortLabel
                            label="Game"
                            col="name"
                            active={gamesParams.sort === "name"}
                            order={gamesParams.order}
                            onSort={onGameSort}
                          />
                        </th>
                        <th className="px-2 py-1.5">
                          <GameSortLabel
                            label="Year"
                            col="release_year"
                            active={gamesParams.sort === "release_year"}
                            order={gamesParams.order}
                            onSort={onGameSort}
                          />
                        </th>
                        <th className="px-2 py-1.5">
                          <GameSortLabel
                            label="Price"
                            col="price"
                            active={gamesParams.sort === "price"}
                            order={gamesParams.order}
                            onSort={onGameSort}
                          />
                        </th>
                        <th className="px-2 py-1.5">
                          <GameSortLabel
                            label="Reviews"
                            col="reviews"
                            active={gamesParams.sort === "reviews"}
                            order={gamesParams.order}
                            onSort={onGameSort}
                          />
                        </th>
                        {/* Units, NOT SteamSpy owners. This row prints a price, a copy count and
                            a revenue side by side, so the copy count has to be the one that
                            closes the arithmetic a reader does ACROSS the row. It used to be
                            mart_game.owners_mid (owners-based) beside est_rev_reviews
                            (reviews-based) — two different estimators in one row, so revenue ÷
                            copies contradicted the price two cells to the left. Live API,
                            tag/Souls-like win=24m min_reviews=50 sorted by revenue desc
                            (2026-09-01): Path of Exile 2 read $202,068,121 over 35.0M owners =
                            $5.77 a copy against a $29.99 price; Clair Obscur $414,290,625 over
                            3.5M = $118.37 against $49.99; Silksong showed 10.9M owners here while
                            /compare printed "Est. units 12.6M" for that same game.
                            Same helper and same reasoning as /compare and the game profile's
                            Estimates panel — lib/estimates.ts explains why the reviews-based
                            estimator is the one that stays. The owners-based figure is not
                            reprinted here: the profile can afford to carry it on a sub-line
                            labelled "different method", a 25-row table has no such slot and a
                            header read once cannot un-teach a division the cells invite 25 times.
                            Still absent from the API's sort whitelist, so still an inert header
                            rather than a control that 422s — and nothing is lost by that: at a
                            fixed price units is strictly increasing in est_revenue, so the
                            "Est. revenue" control already orders this column. */}
                        <th
                          className="px-2 py-1.5 font-medium"
                          title="Estimated copies sold on the SAME reviews-based (Boxleiter) estimator as Est. revenue — est. revenue ÷ launch price, exactly. The owners-based SteamSpy estimate is a different method; it's on each game's profile, labelled as such."
                        >
                          Est. units
                        </th>
                        <th className="px-2 py-1.5">
                          <GameSortLabel
                            label="Est. revenue"
                            col="revenue"
                            active={gamesParams.sort === "revenue"}
                            order={gamesParams.order}
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
                          <td className="tabular px-2 py-1.5">{fmtPrice(g.price_initial)}</td>
                          <td className="tabular px-2 py-1.5">{fmtInt(g.total_reviews)}</td>
                          <td className="tabular px-2 py-1.5">
                            {fmtCompact(estimatedUnits(g.est_revenue, g.price_initial, g.total_reviews))}
                          </td>
                          <td className="tabular px-2 py-1.5">
                            <span
                              className="rounded px-1.5 py-0.5"
                              style={heatStyle(g.est_revenue, ...heatDomain(all, (x) => x.est_revenue))}
                            >
                              {fmtRevenue(g.est_revenue, g.price_initial === 0)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-ink-muted">
                  <span>
                    {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
                    {gamesQ.data.total.toLocaleString()}
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

/**
 * The honest degraded-state line. These two endpoints are served by a mart that only lands on
 * a REBUILD, so for a few hours after a deploy they legitimately answer 503 — saying so beats
 * an infinite spinner or a silent empty table.
 */
function DegradedNote({ what, status, extra }: { what: string; status: number | null; extra?: string }) {
  const because =
    status === 503
      ? " (the API is answering 503 until then)"
      : status === 422
        ? " (this window / review-floor cut isn't in the rebuilt mart yet — try another cut above)"
        : status === 404
          ? " (no rows for this cut yet)"
          : "";
  return (
    <p className="mt-2 text-[11px] text-ink-muted">
      {what} needs the per-niche game mart, which is rebuilt a few hours after a deploy{because}.
      {extra ? ` ${extra}` : ""} Everything else on this page is live.
    </p>
  );
}
