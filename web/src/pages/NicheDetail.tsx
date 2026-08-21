import { useCallback, useEffect, useMemo } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Histogram } from "../components/charts/Histogram";
import {
  NicheDistribution,
  type BucketSelection,
  type DistributionBucket,
} from "../components/charts/NicheDistribution";
import { OpportunityBars } from "../components/charts/OpportunityBars";
import { SaturationTrend } from "../components/charts/SaturationTrend";
import { TooltipPanel } from "../components/charts/TooltipPanel";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { BulletMeter } from "../components/ui/Meter";
import { StatTile } from "../components/ui/StatTile";
import { ViewToggle } from "../components/ui/ViewToggle";
import { trackEvent } from "../lib/analytics";
import {
  ApiError,
  nicheExportCsvUrl,
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
  type Window,
} from "../lib/api";
import { fmtCompact, fmtInt, fmtMonths, fmtPct, fmtPrice, fmtRevenue, fmtSigned, fmtUsd, titleCase } from "../lib/format";
import { heatDomain, heatStyle } from "../lib/heat";
import { CSS_VAR } from "../lib/palette";
import { useDetailView } from "../lib/viewMode";

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

/** The one place the route pattern is spelled; App.tsx and the round-trip test both use it. */
export const NICHE_ROUTE_PATH = "/niches/:dimension/:key";

export const GAMES_PAGE_SIZE = 25;

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

/**
 * Canonical link to a niche page. Keys carry spaces AND slashes ("Action Roguelike",
 * "Massively Multiplayer/RPG"), so the key segment is always percent-encoded — React Router
 * decodes `:key` back (it un-escapes each segment and then restores %2F to "/"), so the
 * value handed to useParams is byte-for-byte the key we linked. See NicheDetail.test.tsx.
 */
export function nicheDetailPath(
  dimension: string,
  key: string,
  search?: Record<string, string | number | undefined | null>,
): string {
  const base = `/niches/${encodeURIComponent(dimension)}/${encodeURIComponent(key)}`;
  if (!search) return base;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
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
          tickFormatter={(v: number) => fmtCompact(v)}
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
          type="monotone"
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

  const dimension = DIMENSIONS.includes(dimensionParam as Dimension) ? (dimensionParam as Dimension) : null;
  // React Router has already decoded the segment (and restored an escaped "/"), so this is
  // the niche key exactly as the finder linked it.
  const nicheKey = keyParam ?? null;

  const tab: TabKey = searchParams.get("tab") === "games" ? "games" : "overview";
  const urlWindow: Window = searchParams.get("win") === "all" ? "all" : "24m";
  const urlMinReviews = readNum(searchParams.get("min_reviews")) ?? 50;

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
    return <div className="p-6 text-sm text-ink-muted">Loading niche…</div>;
  }

  if (detailQ.isError || !detail || !activeVariant) {
    // The API's own 404 detail already reads "niche not found: tag/Foo" — don't stutter it.
    const reason =
      detailQ.error instanceof Error
        ? detailQ.error.message.replace(/^niche not found:\s*/i, "").trim()
        : "";
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
      <Link to="/niches" className="text-xs text-ink-muted hover:text-ink-primary">
        ← Back to the Niche Finder
      </Link>

      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold text-ink-primary">{nicheKey}</h1>
                <Badge color={CSS_VAR.demand}>{titleCase(dimension)}</Badge>
                {tier && (
                  <span title={TIER_HINT[tier] ?? tier}>
                    <Badge>{tier}</Badge>
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                <span>{variantLabel(activeVariant)}</span>
                <span aria-hidden="true">·</span>
                <span>{fmtInt(activeVariant.n_games)} scored games</span>
                <span aria-hidden="true">·</span>
                {/* n_recent is always the trailing-24m release count, on BOTH cuts — label it
                    as such rather than "in the window", which would be wrong on all-time. */}
                <span>{fmtInt(activeVariant.n_recent)} released in the last 24m</span>
                {tier && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{TIER_HINT[tier] ?? tier}</span>
                  </>
                )}
              </div>
            </div>
            <a
              href={csvUrl}
              onClick={() => trackEvent("niche_export_csv")}
              className="shrink-0 rounded-md border border-chartborder px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:border-brand hover:text-brand"
            >
              Export CSV
            </a>
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
                      "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                      active
                        ? "border-brand bg-page text-ink-primary"
                        : "border-chartborder text-ink-muted hover:text-ink-secondary",
                    )}
                  >
                    {variantLabel(v)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          help="The niche's overall entry score (0–100, higher = better) after the decline gate — the gate shrinks the score when the market is shrinking or newcomers underearn."
          label="Opportunity v2"
          valueClassName="text-brand"
          value={fmtCompact(activeVariant.opportunity_v2)}
          sub={
            activeVariant.decline_gate != null
              ? `after decline gate ×${activeVariant.decline_gate.toFixed(2)}`
              : undefined
          }
        />
        <StatTile
          help="Half the niche's games earn less than this (estimated lifetime gross). This is what a REALISTIC entry should expect — not what the hits earn."
          label="Typical game earns"
          value={fmtUsd(activeVariant.median_rev)}
          sub="median, lifetime gross"
        />
        <StatTile
          help="Only 1 game in 10 earns more than this — what the niche's successful titles make. Boxleiter-style estimates (reviews × owners-per-review × price), not reported sales."
          label="A hit earns"
          value={activeVariant.p90_rev != null ? fmtUsd(activeVariant.p90_rev) : "—"}
          sub="top 10% outcome"
        />
        <StatTile
          help="Summed current concurrent players across the niche's scored games — dominated by its biggest games. Nightly ~21–22:00 UTC point samples, not daily peaks."
          label="Playing right now"
          value={totalPlayersNow != null ? fmtCompact(totalPlayersNow) : "—"}
          sub={
            playersTrend != null
              ? `${playersTrend >= 0 ? "+" : ""}${playersTrend.toFixed(1)}% vs prior 7d`
              : undefined
          }
        />
        <StatTile
          help="Games released into this niche in the last 24 months (the same count on either cut). The sub-line is the release pipeline year-over-year — shrinking releases mean decline even when competition looks invitingly low."
          label="Recent releases"
          value={fmtInt(activeVariant.n_recent)}
          sub={
            activeVariant.saturation_yoy != null
              ? `${fmtSigned(activeVariant.saturation_yoy, 0)} releases vs prior year`
              : undefined
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
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                tab === t.key
                  ? "border-brand bg-page text-ink-primary"
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
          {/* Bearish read FIRST: the traps this exact cut is showing, before the scores. */}
          <Card title="Read this first">
            {flags.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {flags.map((f) => (
                  <div key={f.text} className="flex items-start gap-2 text-xs text-ink-secondary">
                    <span
                      aria-hidden
                      className={clsx(
                        "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                        f.serious ? "bg-[var(--status-critical)]" : "bg-[var(--status-warn,#d97706)]",
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

          <Card
            title="Opportunity — demand vs. competition vs. quality gap"
            subtitle="Each input is a 0–100 percentile against every other niche in this cut; the headline score weighs them and then applies the decline gate."
          >
            <div className="flex flex-wrap items-center gap-6 rounded-card border border-chartborder p-3">
              <OpportunityBars
                demand={activeVariant.demand}
                competition={activeVariant.competition}
                quality_gap={activeVariant.quality_gap}
              />
              <div className="grid flex-1 grid-cols-3 gap-2 text-center">
                <div>
                  <div
                    className="text-[10px] text-ink-muted"
                    title="0.4×pctile(median revenue) + 0.3×pctile(median owners) + 0.3×pctile(recent review velocity), ranked 0–100 vs other niches. Higher = hotter market."
                  >
                    Demand
                  </div>
                  <div className="tabular text-sm font-semibold text-ink-primary">{fmtCompact(activeVariant.demand)}</div>
                </div>
                <div>
                  <div
                    className="text-[10px] text-ink-muted"
                    title="0.6×pctile(recent releases) + 0.4×pctile(winner concentration), ranked 0–100. HIGHER IS WORSE for a new entrant."
                  >
                    Competition
                  </div>
                  <div className="tabular text-sm font-semibold text-ink-primary">
                    {fmtCompact(activeVariant.competition)}
                  </div>
                </div>
                <div>
                  <div
                    className="text-[10px] text-ink-muted"
                    title="pctile(share of incumbents that are weak — under 80% positive OR under 50 reviews), ranked 0–100. Higher = easier to out-execute."
                  >
                    Quality gap
                  </div>
                  <div className="tabular text-sm font-semibold text-ink-primary">
                    {fmtCompact(activeVariant.quality_gap)}
                  </div>
                </div>
              </div>
              <div className="shrink-0 border-l border-chartborder pl-6 text-center">
                <div className="text-[10px] text-ink-muted">Opportunity v2</div>
                <div className="tabular text-xl font-bold text-ink-primary">
                  {fmtCompact(activeVariant.opportunity_v2)}
                </div>
                <div
                  className="text-[10px] text-ink-muted"
                  title="opportunity × decline gate — the gate shrinks with pipeline decline or underearning entrants"
                >
                  raw {fmtCompact(activeVariant.opportunity)} × gate{" "}
                  {activeVariant.decline_gate != null ? activeVariant.decline_gate.toFixed(2) : "—"}
                </div>
              </div>
            </div>
            {activeVariant.demand != null && activeVariant.competition != null && activeVariant.quality_gap != null && (
              <p className="mt-1.5 tabular text-[11px] text-ink-muted">
                = 0.5×{activeVariant.demand.toFixed(1)} − 0.35×{activeVariant.competition.toFixed(1)} + 0.3×
                {activeVariant.quality_gap.toFixed(1)} ={" "}
                {(
                  0.5 * activeVariant.demand -
                  0.35 * activeVariant.competition +
                  0.3 * activeVariant.quality_gap
                ).toFixed(1)}
                {0.5 * activeVariant.demand - 0.35 * activeVariant.competition + 0.3 * activeVariant.quality_gap < 0
                  ? " → floored to 0"
                  : ""}
                {activeVariant.decline_gate != null ? ` → × gate ${activeVariant.decline_gate.toFixed(2)}` : ""}
              </p>
            )}
            {activeVariant.opportunity === 0 && (
              <p className="mt-1.5 text-[11px] text-ink-muted">
                Floored at 0: the score formula (0.5×demand − 0.35×competition + 0.3×quality gap) went negative — the
                crowding penalty outweighs what the typical game here earns. A big audience doesn't make it a good entry.
              </p>
            )}
          </Card>

          {/* The chart-heavy expert cards live under the Detailed toggle; Simple keeps the
              plain-language reads (header, stat tiles, flags, opportunity) only — same split
              as GameProfile. */}
          {view === "detailed" && (
            <>
              <Card
                title="Live players — is this niche hot right now"
                subtitle="Nightly ~21–22:00 UTC point samples, not daily peaks; each game's last capture carries forward up to 7 days so the capture rotation doesn't read as audience dips."
              >
                <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile
                    help="Summed current concurrent players across the niche's scored games. Dominated by the niche's biggest games."
                    label="Playing now"
                    value={players?.total_players_now != null ? fmtCompact(players.total_players_now) : "—"}
                    sub={players?.n_games_panel != null ? `${fmtInt(players.n_games_panel)} games measured` : undefined}
                  />
                  <StatTile
                    help="Last 7 days vs the 7 before, counting only games measured in BOTH windows — growing data coverage can't fake an audience trend."
                    label="7-day trend"
                    valueClassName={
                      players?.players_trend_7d_pct == null
                        ? undefined
                        : players.players_trend_7d_pct >= 0
                          ? "text-verdict-good"
                          : "text-verdict-serious"
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
                          tickFormatter={(v: number) => fmtCompact(v)}
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
                          type="monotone"
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
                subtitle="Estimated lifetime GROSS per game (reviews × a genre-fitted owners-per-review ratio × launch price) — not net of Steam's cut, refunds or discounts."
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
                  <p className="mt-1.5 text-[11px] text-ink-muted">
                    Releases {fmtSigned(activeVariant.saturation_yoy, 0)} year-over-year.
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
                            <td className="tabular px-2 py-1.5 text-verdict-good">{fmtPct(t.praise_share)}</td>
                            <td className="tabular px-2 py-1.5 text-verdict-serious">{fmtPct(t.complaint_share)}</td>
                            <td
                              className={clsx(
                                "tabular px-2 py-1.5",
                                (t.praise_delta_vs_catalog ?? 0) >= 0 ? "text-verdict-good" : "text-verdict-serious",
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
                          <th className="px-2 py-1.5 font-medium">Owners</th>
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
                            <td className="tabular px-2 py-1.5">{fmtCompact(g.owners_mid)}</td>
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
              <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-ink-muted">
                <span>No games in this niche match the selected buckets.</span>
                {hasSelection && (
                  <button
                    type="button"
                    onClick={() => {
                      patch(writeSelection(writeSelection(searchParams, "revenue", null), "price", null));
                      trackEvent("niche_filter_apply");
                    }}
                    className="rounded-md border border-chartborder px-2.5 py-1 font-medium text-ink-secondary transition-colors hover:border-brand hover:text-brand"
                  >
                    Clear filters
                  </button>
                )}
              </div>
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
                        {/* Owners isn't in the API's sort whitelist — an inert header rather
                            than a control that 422s. */}
                        <th className="px-2 py-1.5 font-medium" title="Estimated copies owned (SteamSpy band midpoint)">
                          Owners (est.)
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
                          <td className="tabular px-2 py-1.5">{fmtCompact(g.owners_est)}</td>
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
