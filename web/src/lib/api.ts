import { useCallback, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Typed client for the Prospect FastAPI backend.
 *
 * Base defaults to the relative "/api" so requests ride the Vite dev proxy (see
 * vite.config.ts) and stay same-origin. Override with VITE_API_BASE (e.g.
 * "http://127.0.0.1:8000/api") to bypass the proxy and hit an absolute origin
 * directly — useful when running the built static bundle against a specific API.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE || "/api";

export class ApiError extends Error {
  status: number;
  /** The raw `detail` payload when the API sent a structured (non-string) one — e.g. the
   * entity-profile 404 carries `{error, suggestions}` so the UI can render did-you-mean
   * links. Undefined for plain string details (already the `message`). */
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.name = "ApiError";
    this.detail = detail;
  }
}

/**
 * The REASON inside an API error message, with the API's own "<noun> not found:" lead-in
 * removed.
 *
 * The API answers a missing game with `{"detail": "game not found: 999999999"}` and a
 * missing niche with `"niche not found: tag/Foo"` — already complete sentences. The pages
 * that render them add their own heading ("Game not found"), so pasting `error.message` in
 * raw stutters: **"Game not found: game not found: 999999999"** is what /games/999999999
 * actually showed. Only the id/key the user typed is worth appending, so strip the lead-in
 * here, once, instead of leaving each page to remember its own regex (NicheDetail carried
 * one; GameProfile did not, which is exactly how the two drifted).
 *
 * Returns "" when nothing but the lead-in was there — FastAPI's bare `"Not Found"` for an
 * unrouted path leaves no reason to show, and the caller's heading already says it. Any
 * message that is not a not-found sentence ("Internal Server Error", a network failure) is
 * passed through untouched: there the detail IS the information.
 */
export function notFoundReason(error: unknown): string {
  if (!(error instanceof Error)) return "";
  return error.message.replace(/^[a-z]*\s*not found:?\s*/i, "").trim();
}

/** One pydantic validation error out of FastAPI's 422 body. */
interface ValidationDetail {
  loc?: unknown[];
  msg?: string;
}

function isValidationDetail(v: unknown): v is ValidationDetail {
  return typeof v === "object" && v !== null && typeof (v as ValidationDetail).msg === "string";
}

/**
 * A readable sentence for a non-string API `detail`.
 *
 * FastAPI rejects an out-of-range query param with a LIST of pydantic errors, and
 * `JSON.stringify(detail)` put that list on screen verbatim. Measured on production
 * 2026-09-01, /games?offset=10025 rendered:
 *
 *   Failed to load games: [{"type":"less_than_equal","loc":["query","offset"],"msg":"Input
 *   should be less than or equal to 10000","input":"10025","ctx":{"le":10000}}]
 *
 * and /games?after=202 the same shape for released_after. The `msg` IS the explanation and
 * `loc`'s last element names the field; everything else is machine detail. `ApiError.detail`
 * still carries the raw payload, so the entity-profile 404's `{error, suggestions}` keeps
 * driving its did-you-mean links off the object rather than off this string.
 */
function detailToMessage(detail: unknown): string {
  if (Array.isArray(detail) && detail.length > 0 && detail.every(isValidationDetail)) {
    return detail
      .map((d) => {
        const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : undefined;
        return typeof field === "string" ? `${field}: ${d.msg}` : String(d.msg);
      })
      .join("; ");
  }
  if (isValidationDetail(detail)) return detail.msg as string;
  const asRecord = detail as { error?: unknown } | null;
  if (asRecord && typeof asRecord.error === "string") return asRecord.error;
  return JSON.stringify(detail);
}

/**
 * Copy for a request that never got an answer. Deliberately says nothing about the
 * resource: a transport failure is not evidence about whether the thing exists.
 */
export const TRANSPORT_FAILURE_MESSAGE = "Couldn't reach the API — check your connection, then retry.";

/**
 * True when the request never reached the API, or reached it and came back unusable.
 *
 * `fetch` rejects with a bare `TypeError: Failed to fetch` for a dropped connection, DNS
 * failure, offline client or blocked request — no status, no body. An ApiError means the
 * exact opposite: the server understood the request and answered it. Everything downstream
 * of this distinction is the difference between "we couldn't ask" and "the answer is no",
 * and the app used to collapse the two: with `**\/api\/**` aborted, /games/1962700 read
 * "Game not found: Failed to fetch" and /compare labelled live columns "Not in catalog"
 * (measured on production 2026-09-01). Both are false statements about the user's data.
 */
export function isTransportFailure(error: unknown): boolean {
  return error != null && !(error instanceof ApiError) && !isAbortError(error);
}

/**
 * True only when the API positively answered "there is no such thing".
 *
 * A 5xx, a rejected query param and a network blip are all failures to ANSWER — none of
 * them is evidence the game/niche/studio is missing, so none of them may be reported with
 * not-found copy.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * The one sentence the user sees for a failed query. Never a raw exception: `String(error)`
 * on a network failure yields "TypeError: Failed to fetch", which four cards on /timing
 * printed verbatim (measured on production 2026-09-01).
 */
export function errorMessage(error: unknown): string {
  if (error == null) return "";
  if (isTransportFailure(error)) return TRANSPORT_FAILURE_MESSAGE;
  if (error instanceof ApiError) return error.message;
  return "Something went wrong on our side.";
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // Content-Type only belongs on requests WITH a body — GETs carry no payload, and some
    // proxies/CDNs reject or misroute a bodyless request that declares one. Caller-supplied
    // headers still win, same spread order as before.
    headers: {
      ...(init?.body != null ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const body = await res.clone().json();
      detail = body?.detail ?? detail;
    } catch {
      // non-JSON error body; fall back to statusText
    }
    throw new ApiError(
      res.status,
      typeof detail === "string" ? detail : detailToMessage(detail),
      typeof detail === "string" ? undefined : detail,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

type QueryParams = Record<string, string | number | boolean | undefined | null>;

// Parameter is `object` (not `QueryParams` itself) so callers can pass a well-typed
// params interface (NicheListParams, etc.) without it needing its own index
// signature — every field on those interfaces is already a valid query-param
// value, so the single internal cast just reflects that at the boundary.
function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params as unknown as QueryParams)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---- shared ---------------------------------------------------------------------------
export type Dimension = "tag" | "genre";
export type Window = "all" | "24m";
// Mirrors the API's SORTABLE whitelist in api/app/routers/niches.py.
export type SortKey =
  | "key"
  | "opportunity"
  | "opportunity_v2"
  | "decline_gate"
  | "entrant_ratio"
  | "solo_viability"
  // opportunity_v2's sub-scores (2026-08-31 rebuild).
  | "momentum"
  | "supply_room"
  | "revenue_spread"
  | "market_pull"
  | "supply_brake"
  | "demand"
  | "competition"
  | "quality_gap"
  | "market_size"
  | "total_owners"
  | "total_rev"
  | "total_reviews"
  | "median_rev"
  | "p90_rev"
  | "median_reviews"
  | "median_price"
  | "median_owners"
  | "median_positive_ratio"
  | "recent_velocity"
  | "n_games"
  | "n_recent"
  | "hit_rate_200k"
  | "hit_rate_500k"
  | "beatable_share"
  | "saturation_yoy"
  | "self_pub_share"
  | "winner_concentration"
  | "total_players_now"
  | "players_trend_7d_pct"
  | "players_coverage"
  | "lifetime_survival_12m"
  | "lifetime_median_dead_months"
  | "reviews_24m"
  | "reviews_prev_24m"
  | "demand_trend_24m_pct";

export type NicheTier = "micro" | "theme" | "umbrella" | "meta";
export const NICHE_TIERS: NicheTier[] = ["micro", "theme", "umbrella", "meta"];

export interface HistBucket {
  bucket_index: number;
  x_min: number;
  x_max: number;
  count: number;
}

// ---- health -----------------------------------------------------------------------------
export interface Health {
  status: string;
  mart_version: string | null;
  built_at: string | null;
  source_db: string | null;
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => request<Health>("/health", { signal }),
    staleTime: 30_000,
    // Was a bare `retry: 1`, which re-issued 4xx too. Function declarations hoist, so the
    // shared predicate is usable here even though it is defined further down the file.
    retry: retryTransientOnce,
  });
}

// ---- niches (Niche Finder — resurrected 2026-08 with v2 scoring + live players) --------
export interface NicheRow {
  dimension: string;
  key: string;
  window: string;
  min_reviews: number;
  n_games: number;
  n_recent: number;
  median_rev: number | null;
  p25_rev: number | null;
  p75_rev: number | null;
  p90_rev?: number | null; // absent on marts that predate 2026-08-14
  median_reviews: number | null;
  median_price: number | null;
  median_positive_ratio: number | null;
  median_owners: number | null;
  total_owners: number | null;
  total_rev: number | null;
  total_reviews: number | null;
  market_size: number | null;
  recent_velocity: number | null;
  self_pub_share: number | null;
  winner_concentration: number | null;
  hit_rate_200k: number | null;
  hit_rate_500k: number | null;
  beatable_share: number | null;
  saturation_yoy: number | null;
  n_recent_year?: number | null;
  n_prior_year?: number | null;
  demand: number | null;
  competition: number | null;
  quality_gap: number | null;
  opportunity: number | null;
  // REBUILT 2026-08-31 (etl/marts/mart_niche.sql): a renormalised blend of momentum /
  // market_pull / revenue_spread / quality_gap, times supply_brake, read off the SAME
  // axes and bars as the Radar's ring verdicts. It used to rank the opposite way.
  opportunity_v2: number | null;
  // The sub-scores — absent (undefined) on marts that predate the rebuild, so the UI
  // omits the breakdown. null (present but empty) means "no comparable reading here",
  // which the blend honoured by renormalising rather than reading as 0.
  // THE FOUR BLENDED TERMS are momentum, market_pull, revenue_spread and quality_gap
  // (declared above). supply_room is NOT blended — it is the brake's input.
  momentum?: number | null; // weight 0.40; demand FLOW, 50 flat, 88.1 at DEMAND_ENTER_PCT
  market_pull?: number | null; // weight 0.22; 0.6*demand + 0.4*market_size
  revenue_spread?: number | null; // weight 0.20; 50 exactly at WC_WINNER_TAKE_MOST
  supply_room?: number | null; // NOT weighted — min(flood_room, entrant_room)
  supply_brake?: number | null; // the multiplier, [0.35, 1]
  // A falsification tell, not a score factor since the rebuild.
  decline_gate: number | null;
  entrant_ratio: number | null;
  solo_viability: number | null;
  // solo_viability as a FLAG: "solo" | "mixed" | "team". The raw share is compressed
  // (catalog median 0.975) so it ranks nothing — see radarVerdict.ts's module doc.
  solo_tier?: string | null;
  // Solo-evidence trio — the member profile behind solo_viability (the SINGLEPLAYER
  // SHARE, a no-netcode proxy, not a production-scope measure). Same per-cut population
  // as the share; absent (undefined) on marts that predate it — the UI then omits the
  // evidence clauses from the dossier's solo row.
  self_published_share?: number | null; // AVG(self_published) over the cut
  indie_share?: number | null; // AVG(is_indie) over the cut
  med_playtime_h?: number | null; // median member playtime_p50, hours, 1 decimal
  tier: string | null;
  // Live players — absent (undefined) on marts that predate the CCU marts.
  total_players_now?: number | null;
  players_trend_7d_pct?: number | null;
  players_coverage?: number | null;
  median_players_now?: number | null;
  players_top5_share?: number | null;
  // Lifetime (steamcharts top-8k) — absent on marts that predate the lifetime ETL.
  lifetime_n_games?: number | null;
  lifetime_survival_12m?: number | null;
  lifetime_median_dead_months?: number | null;
  // 24-month demand (review-histogram windows: last 24 complete months vs the prior 24;
  // cut-independent — one value per (dimension, key), identical on every window/floor
  // cut) — replaced the 12-month columns outright (which had replaced the 90-day ones);
  // absent on marts that predate them. On LIST rows so the Radar board rings every blip
  // on its own trend.
  reviews_24m?: number | null;
  reviews_prev_24m?: number | null;
  demand_trend_24m_pct?: number | null; // null = no prior-window baseline
  // Emerging pair (ships with the 24m columns): young tags crystallize around new games
  // only, so their prior window is near zero BY CONSTRUCTION — the raw trend % above is
  // NOT representative when demand_emerging is true (render EMERGING + absolute volume
  // instead; see lib/radarVerdict.ts). The trend itself stays served un-suppressed.
  reviews_24m_new_share?: number | null; // share of reviews_24m from games released in the last 24 months
  demand_emerging?: boolean | null;
}

export interface NicheList {
  items: NicheRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface NicheListParams {
  dimension: Dimension;
  window: Window;
  min_reviews: number;
  sort: SortKey;
  order: "asc" | "desc";
  q?: string;
  tiers?: string; // comma-joined NicheTier list (tags only)
  min_total_players?: number;
  /** The radar's population rule, OPT-IN (server default off — this list backs
   * NicheFinder too): 1 keeps only solo-friendly niches (solo_viability >= 0.8;
   * NULL = unknown = excluded). Only the Radar board passes it. */
  solo_only?: 0 | 1;
  limit: number;
  offset: number;
}

export function useNiches(params: NicheListParams) {
  return useQuery({
    queryKey: ["niches", params],
    queryFn: ({ signal }) => request<NicheList>(`/niches${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

export interface NicheGame {
  rank_in_niche: number;
  appid: number;
  name: string | null;
  release_year: number | null;
  price_initial: number | null;
  owners_mid: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  est_rev_reviews: number | null;
  self_published: number | null;
  header_image: string | null;
}

export interface TrendPoint {
  year: number;
  n_releases: number;
  n_scored: number;
  median_rev: number | null;
  p90_rev?: number | null; // absent on marts that predate 2026-08-14
}

export interface NichePlayersPoint {
  date: string;
  total_players: number;
  measured_players: number | null;
  n_games_measured: number;
}

export interface NichePlayersMonthlyPoint {
  month: string; // 'YYYY-MM-DD' (month start)
  avg_players_sum: number;
  n_games_measured: number;
}

export interface NichePlayersTopGame {
  rank: number;
  appid: number;
  name: string | null;
  players: number;
  share: number | null;
}

export interface NichePlayersDistribution {
  median_players_now: number | null;
  players_top5_share: number | null;
  n_games_now: number;
  histogram: HistBucket[];
  top_games: NichePlayersTopGame[];
}

export interface NichePlayers {
  total_players_now: number | null;
  players_trend_7d_pct: number | null;
  players_coverage: number | null;
  n_games_panel: number | null;
  series: NichePlayersPoint[];
  // Years-deep summed monthly averages (steamcharts, top-8k games only).
  monthly?: NichePlayersMonthlyPoint[];
  distribution?: NichePlayersDistribution | null;
}

export interface NicheTheme {
  aspect: string;
  n_games: number;
  total_mentions: number;
  praise_share: number | null;
  complaint_share: number | null;
  praise_delta_vs_catalog: number | null;
}

export interface NichePressPoint {
  month: string; // 'YYYY-MM'
  n_articles: number;
}

export interface NichePressOutlet {
  source: string;
  n_articles: number;
  n_games_covered: number;
}

/** The niche's press-coverage block (mart_niche_press): journalist coverage of member
 * games pooled to niche level. n_articles counts article-mentions (an article covering two
 * member games counts once per game); total_articles sums the dated timeline. */
export interface NichePress {
  total_articles: number;
  timeline: NichePressPoint[];
  top_outlets: NichePressOutlet[];
}

export interface NicheHitRates {
  hit_rate_200k: number | null;
  hit_rate_500k: number | null;
  median_rev: number | null;
  n_games: number | null;
  winner_concentration: number | null;
}

export interface NicheDetail {
  dimension: string;
  key: string;
  tier: string | null;
  variants: NicheRow[];
  saturation_trend: TrendPoint[];
  revenue_histogram: HistBucket[];
  representative_games: NicheGame[];
  players: NichePlayers | null;
  themes: NicheTheme[];
  // null = mart predates mart_niche_press, or the niche has no published press rows
  // (below the covered-games floor / genuinely uncovered).
  press: NichePress | null;
  hit_rates: NicheHitRates;
}

/**
 * Path for a niche sub-resource. Niche keys carry spaces and slashes ("Action Roguelike",
 * "Massively Multiplayer/RPG"), so the key segment is ALWAYS percent-encoded here — the API
 * matches it with a `{key:path}` converter and unquotes it back, which is exactly why the
 * encoding has to be unconditional rather than "only when it looks unsafe".
 */
export function nichePath(dimension: Dimension, key: string, suffix = ""): string {
  return `/niches/${dimension}/${encodeURIComponent(key)}${suffix}`;
}

/** Shared query options for the niche deep-dive endpoint — useNicheDetail, the Watchlist's
 * per-entry fan-out and NicheCombined's fallback sizing all read through this ONE factory,
 * so a niche already fetched anywhere hits the same cache entry everywhere instead of each
 * call site rebuilding the key/URL (and risking a drift between them). */
export function nicheDetailQueryOptions(dimension: Dimension, key: string) {
  return {
    queryKey: ["niche-detail", dimension, key] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      request<NicheDetail>(nichePath(dimension, key), { signal }),
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  };
}

export function useNicheDetail(dimension: Dimension, key: string | null) {
  return useQuery({
    ...nicheDetailQueryOptions(dimension, key ?? ""),
    enabled: key !== null,
  });
}

// ---- niche drill-down: game list + distributions (the /niches/:dimension/:key page) ------
// Both endpoints read the per-niche game mart, which only lands on a mart REBUILD — for the
// first few hours after a deploy they answer 503 (or a degraded empty payload). Neither hook
// retries a 503/404 so the page can degrade just those two sections with an honest message
// instead of spinning; everything else on the niche page comes from useNicheDetail above and
// keeps working untouched.

export interface NicheGameRow {
  appid: number;
  name: string | null;
  release_year: number | null;
  price_initial: number | null;
  est_revenue: number | null;
  total_reviews: number | null;
  owners_est: number | null;
  /** Optional because an API older than the overview-panel fix doesn't send them (the mart
   * columns always existed — see routers/niches.py `_GAME_SELECT`). They exist so the
   * overview "Top games" panel can render off this CUT-AWARE list rather than the
   * cut-independent representative_games top-8, which on tag/Souls-like at 24m/≥50 showed
   * two games (Black Myth, ELDEN RING) that are not in the 223-game cut at all. */
  positive_ratio?: number | null;
  live_players?: number | null;
  header_image?: string | null;
}

export interface NicheGamesList {
  /** Match count BEFORE limit/offset and AFTER any bucket cross-filter — page off this. */
  total: number;
  items: NicheGameRow[];
  limit: number;
  offset: number;
}

/** Mirrors the API's sortable whitelist (routers/niches.py `_GAME_SORT`). These are the
 * REQUEST-side names, deliberately not the row field names: `revenue`/`reviews` map to
 * est_rev_reviews / total_reviews server-side. Owners is not sortable. */
export type NicheGameSortKey = "revenue" | "price" | "reviews" | "release_year" | "name";

export interface NicheGamesParams {
  win: Window;
  min_reviews: number;
  sort: NicheGameSortKey;
  order: "asc" | "desc";
  limit: number;
  offset: number;
  /** Bucket cross-filter driven by the revenue/price distribution charts (USD). Undefined
   * on an axis = no filter there; both bounds always travel together. */
  rev_min?: number;
  rev_max?: number;
  price_min?: number;
  price_max?: number;
}

/** A fetch aborted by react-query's cancellation signal. It is not a failure: the query has
 * already been settled by the cancellation itself, so it must never be retried, and (see the
 * additive-overlay queryFns) never swallowed into fallback data either. The name check is on
 * Error rather than DOMException so it holds in every runtime (browsers, jsdom, Node/undici). */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * A 4xx is a FACT, not a blip: the server understood the request and answered it. Re-issuing
 * it cannot change the answer — it only multiplies failing requests and holds the page on a
 * blank loading state until every attempt has drained.
 *
 * This is not hypothetical. React Query's app-wide `retry: 1` default (main.tsx) used to
 * apply to 404s, so /games/999999999 fired five endpoints TWICE each — ten doomed requests —
 * and rendered header+footer and nothing else for 6-9 seconds before showing the "not found"
 * copy it had ready from the very first response. Same shape on /niches/tag/<bogus> and
 * /entity/<bogus>. Both retry predicates below start from this check, and `retryTransientOnce`
 * is now the app-wide default (main.tsx) so a query that declares no `retry` inherits it.
 */
function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** 503 (mart missing) is the one 5xx that is also a stable answer here — the nightly mart
 * simply has not been rebuilt yet — so it joins every 4xx (404 no such niche, 422 a
 * (win, min_reviews) cut that was never materialised, …) in being surfaced at once instead
 * of retried for seconds. Genuine blips (other 5xx, network errors) still get two attempts.
 * Cancellations never retry. */
function retryUnlessUnavailable(failureCount: number, error: unknown): boolean {
  return (
    !isAbortError(error) &&
    !isClientError(error) &&
    !(error instanceof ApiError && error.status === 503) &&
    failureCount < 2
  );
}

/** One retry for genuinely transient failures — network errors (fetch TypeError) and 5xx —
 * nothing else: 4xx are stable answers, and a cancelled fetch must never be re-issued. Used
 * by the additive-overlay queries (catalog events, marketing events, price history) whose
 * queryFns swallow only the stable misses, so a blip gets one shot before settling — and,
 * since it encodes exactly the policy every query wants by default, as the QueryClient's
 * `retry` in main.tsx. */
export function retryTransientOnce(failureCount: number, error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isClientError(error)) return false;
  return failureCount < 1;
}

/**
 * The QueryClient's `defaultOptions.queries` — the policy every hook that declares nothing
 * of its own inherits. It lives HERE rather than inline in main.tsx so it is importable by
 * tests: the retry-storm bug was a property of this object, not of any one hook, and a test
 * that builds its own client with its own retry setting cannot see it.
 */
export const DEFAULT_QUERY_OPTIONS = {
  refetchOnWindowFocus: false,
  staleTime: 30_000,
  retry: retryTransientOnce,
};

/** Stable "no data here" answers for the additive overlays: 404 = below the analysis floor,
 * 503 = the mart hasn't been (re)built yet. Both degrade to an empty list; everything else
 * is re-thrown so react-query can retry it once (retryTransientOnce) before the query
 * settles as an error — which every consumer reads as "no overlay", same as []. */
function isMissingOverlay(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 503);
}

export function useNicheGames(dimension: Dimension, key: string | null, params: NicheGamesParams) {
  return useQuery({
    queryKey: ["niche-games", dimension, key, params],
    queryFn: ({ signal }) =>
      request<NicheGamesList>(`${nichePath(dimension, key ?? "", "/games")}${qs(params)}`, { signal }),
    enabled: key !== null,
    placeholderData: keepPreviousData,
    retry: retryUnlessUnavailable,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

export type NicheDistributionMetric = "revenue" | "price";

export interface NicheDistributionResponse {
  metric: string;
  buckets: HistBucket[];
  /** Games behind the histogram (sum of bucket counts) — the chart's denominator. */
  n_games: number;
  /** "mart" = served from the precomputed mart_niche_hist (the only cut that works before a
   * rebuild), "computed" = derived from mart_niche_game. Informational. */
  source?: "mart" | "computed";
}

/** One bucketed distribution (revenue or price) over the niche's games — the source for the
 * page's brushable histograms. Deliberately NOT filtered by the bucket selection: the chart
 * has to keep showing the full shape while a sub-range is highlighted. */
export function useNicheDistribution(
  dimension: Dimension,
  key: string | null,
  metric: NicheDistributionMetric,
  params: { win: Window; min_reviews: number },
) {
  return useQuery({
    queryKey: ["niche-distribution", dimension, key, metric, params],
    queryFn: ({ signal }) =>
      request<NicheDistributionResponse>(
        `${nichePath(dimension, key ?? "", "/distribution")}${qs({ metric, ...params })}`,
        { signal },
      ),
    enabled: key !== null,
    placeholderData: keepPreviousData,
    retry: retryUnlessUnavailable,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

// NOTE: the Radar feed client (useRadarFeed + RadarFeed/RadarHero/RadarNicheCard/
// RadarSparklinePoint) was removed 2026-08-27 with the signal-feed section — the board +
// rail answer the same questions. The /api/niches/radar ENDPOINT still exists and serves
// MCP/external consumers; only this web client stopped calling it.

/** Build a download URL for the niches CSV export (GET, triggered via <a download>). */
export function nicheExportCsvUrl(params: {
  dimension: Dimension;
  window: Window;
  min_reviews?: number;
  sort?: SortKey;
  order?: "asc" | "desc";
  q?: string;
  tiers?: string;
  limit?: number;
}): string {
  return `${API_BASE}/niches/export.csv${qs(params)}`;
}

// ---- market -----------------------------------------------------------------------------
export interface PercentilePoint {
  pctile: string;
  value: number;
}

export interface BenchmarkMark {
  label: string;
  value: number;
  cite: string | null;
}

export interface MarketDistribution {
  metric: string;
  genre: string;
  window: string;
  n: number;
  buckets: HistBucket[];
  percentiles: PercentilePoint[];
  benchmark_marks: BenchmarkMark[];
}

export type DistributionMetric = "revenue" | "reviews" | "owners" | "price";

export function useMarketDistribution(metric: DistributionMetric, genre: string, window: Window) {
  return useQuery({
    queryKey: ["market-distribution", metric, genre, window],
    queryFn: ({ signal }) =>
      request<MarketDistribution>(`/market/distribution${qs({ metric, genre, window })}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

export interface DevTier {
  label: string;
  min_copies: number;
  max_copies: number | null;
  revenue_anchor_usd: number;
}

export interface BoxleiterRow {
  genre: string;
  n: number;
  owners_per_review_median: number | null;
  owners_per_review_p25: number | null;
  owners_per_review_p75: number | null;
  slope: number | null;
  intercept: number | null;
}

export interface TierRow {
  tier: string;
  tier_order: number;
  count: number;
  pct: number;
}

export interface MarketBenchmarks {
  cited: {
    median_indie_gross_usd: number;
    pct_new_releases_over_100k: number;
    bottom_30_pct_gross_usd: number;
    reviews_1000_revenue_usd: number;
    boxleiter_owners_per_review: { min: number; mid: number; max: number };
    wishlist_conversion_first_week: number;
    first_week_to_first_year_mult: number;
    steam_revenue_share_to_dev: number;
    dev_tiers: DevTier[];
    opportunity_weights: Record<string, number>;
    revenue_benchmark_marks: BenchmarkMark[];
  };
  computed: {
    median_revenue_scored: number | null;
    median_revenue_paid: number | null;
    boxleiter_owners_per_review_slope: number | null;
    pct_over_100k_scored: number | null;
    n_games_total: number | null;
    n_games_scored: number | null;
    population_note: string;
  };
  boxleiter_by_genre: BoxleiterRow[];
  tiers: TierRow[];
}

export function useMarketBenchmarks() {
  return useQuery({
    queryKey: ["market-benchmarks"],
    queryFn: ({ signal }) => request<MarketBenchmarks>("/market/benchmarks", { signal }),
    staleTime: 5 * 60_000,
  });
}

export interface GenreOption {
  value: string;
  label: string;
}

/** Genre list derived from the Boxleiter-by-genre breakdown (real catalog data, no fake
 * list). Memoized over the benchmark rows so a re-render doesn't hand callers a FRESH array
 * identity every time (which would churn useMemo/dependency chains downstream). */
export function useGenres(): GenreOption[] {
  const { data } = useMarketBenchmarks();
  const rows = data?.boxleiter_by_genre;
  return useMemo(() => {
    const genres = (rows ?? [])
      .map((b) => b.genre)
      .filter((g) => g !== "__all__")
      .sort((a, b) => a.localeCompare(b));
    return [{ value: "__all__", label: "All genres" }, ...genres.map((g) => ({ value: g, label: g }))];
  }, [rows]);
}

// ---- seasonality / launch curve ----------------------------------------------------------
export interface SeasonalityCell {
  genre: string;
  month: number | null;
  weekday: number | null;
  year: number | null;
  n_releases: number;
  n_scored: number;
  median_rev: number | null;
  median_reviews: number | null;
  median_positive_ratio: number | null;
}

export interface Seasonality {
  genre: string;
  month_weekday: SeasonalityCell[];
  month: SeasonalityCell[];
  weekday: SeasonalityCell[];
  year: SeasonalityCell[];
}

export function useSeasonality(genre: string) {
  return useQuery({
    queryKey: ["seasonality", genre],
    queryFn: ({ signal }) => request<Seasonality>(`/seasonality${qs({ genre })}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

export interface LaunchCurvePoint {
  day: number;
  mean_cum_fraction: number;
  median_cum_fraction: number;
  n_games: number;
}

export interface LaunchCurve {
  genre: string;
  points: LaunchCurvePoint[];
}

/** Shared query options so small-multiples pages can fan out via useQueries. */
export function launchCurveQueryOptions(genre: string) {
  return {
    queryKey: ["launch-curve", genre] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      request<LaunchCurve>(`/launch-curve${qs({ genre })}`, { signal }),
    staleTime: 5 * 60_000,
  };
}

/**
 * The launch curve for ONE genre.
 *
 * `genre: null` means "the genre isn't known yet" and disables the fetch — it is not the
 * same as the catalog-wide cut. GameProfile reads its genre from a profile query that
 * resolves later, and passing "__all__" as a stand-in fired a throwaway catalog-wide
 * request on every mount, immediately superseded by the real one. Callers that genuinely
 * want the catalog-wide curve (LaunchTiming's "All genres" option) pass "__all__"
 * EXPLICITLY, so that request is deliberate rather than a side effect of a pending
 * profile. Hook order is unaffected — the hook always runs, only `enabled` moves.
 */
export function useLaunchCurve(genre: string | null | undefined) {
  return useQuery({
    ...launchCurveQueryOptions(genre ?? "__all__"),
    enabled: genre != null,
  });
}

// ---- launch & timing overview (mart_timing_* — TRUE monthly review histograms) -----------
export interface TimingDemandPoint {
  month: number; // 1-12
  demand_share: number | null;
  month_reviews: number | null;
  n_games: number;
}

export interface TimingCongestionPoint {
  month: number;
  avg_releases: number;
  avg_big_releases: number;
  n_years: number;
}

export interface TimingDecayPoint {
  month_since_release: number; // 0-23
  median_share: number | null;
  mean_share: number | null;
  n_games: number;
}

export interface TimingDecaySummary {
  first_3_months_share: number | null;
  first_6_months_share: number | null;
  first_12_months_share: number | null;
  n_games: number;
}

export interface TimingWindowScore {
  month: number;
  month_name: string;
  demand_share: number | null;
  demand_index: number | null; // 1.0 = an average month
  avg_releases: number | null;
  avg_big_releases: number | null;
  congestion_index: number | null; // 1.0 = an average month
  score: number | null; // demand_index - congestion_index
}

export interface TimingWindowRecommendation {
  best_months: number[];
  best_month_names: string[];
  rationale: string;
  method: string;
  months: TimingWindowScore[];
}

export interface TimingOverview {
  genre: string;
  demand: TimingDemandPoint[];
  congestion: TimingCongestionPoint[];
  decay: TimingDecayPoint[];
  decay_summary: TimingDecaySummary | null;
  window_recommendation: TimingWindowRecommendation | null;
  notes: string[];
}

export function useTimingOverview(genre: string) {
  return useQuery({
    queryKey: ["timing-overview", genre],
    queryFn: ({ signal }) => request<TimingOverview>(`/timing/overview${qs({ genre })}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    // 503 = marts not built yet, 404 = genre below the size floors — both are stable
    // answers; surface them immediately instead of retrying for seconds.
    retry: retryUnlessUnavailable,
  });
}

// ---- games (Phase 2) --------------------------------------------------------------------
export interface GameSearchRow {
  appid: number;
  name: string | null;
  primary_genre: string | null;
  release_year: number | null;
  release_date: string | null;
  price_initial: number | null;
  is_free: number | null;
  owners_mid: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  est_rev_reviews: number | null;
  live_players: number | null;
  header_image: string | null;
  top_tags: string[];
  // Lifetime (steamcharts top-8k) — absent on marts that predate the lifetime ETL.
  lifetime_months?: number | null;
  lifetime_alive?: boolean | null;
  /** Official X handle linked from the game's own store page / dev website — may be the
   * game's, the studio's, or the dev's personal account. Absent on older marts; null =
   * none found / socials never fetched. */
  dev_x_handle?: string | null;
  /** Playable Steam demo. Absent on older marts; null = never re-checked — unknown, not "no". */
  has_demo?: boolean | null;
  /** Metacritic critic score where Steam links a page (~2.6% of games); null = no linked page. */
  metacritic_score?: number | null;
}

export interface GameSearchList {
  items: GameSearchRow[];
  total: number;
  limit: number;
  offset: number;
}

// Mirrors the API's SORTABLE whitelist in api/app/routers/games.py.
export type GameSortKey =
  | "name"
  | "release_year"
  | "release_date"
  | "price_initial"
  | "owners_mid"
  | "total_reviews"
  | "positive_ratio"
  | "est_rev_reviews"
  | "rev_pct_in_genre"
  | "reviews_pct_in_genre"
  | "owners_pct_in_genre"
  | "n_reviews_trailing_30d"
  | "live_players"
  | "lifetime_months"
  | "metacritic_score";

export interface GameSearchParams {
  q?: string;
  tag?: string;
  genre?: string;
  min_reviews?: number;
  released_within_days?: number;
  /** Price band in USD (list price). NULL-priced rows drop out of any price filter. */
  price_min?: number;
  price_max?: number;
  /** Floor on positive_ratio, 0-1 (0.8 = at least 80% positive). */
  min_positive?: number;
  /** Floor on est_rev_reviews, USD. */
  min_revenue?: number;
  /** Inclusive release_year bounds. */
  released_after?: number;
  released_before?: number;
  /** true = only, false = only-the-opposite, undefined = both (don't pass false unless meant). */
  self_published?: boolean;
  indie?: boolean;
  /** Floor on lifetime_months (steamcharts top-8k coverage; uncovered games drop out). */
  min_lifetime_months?: number;
  /** true = only still-alive audiences, false = only dead ones, undefined = both. */
  lifetime_alive?: boolean;
  /** true = only games with a playable Steam demo, false = checked-and-none, undefined = both
   * (games never re-checked for a demo drop out on either value). */
  has_demo?: boolean;
  /** Floor on the Metacritic critic score. Only ~2.6% of games have one, so this drops the rest. */
  min_metacritic?: number;
  sort: GameSortKey;
  order: "asc" | "desc";
  limit: number;
  offset: number;
}

export function useGameSearch(params: GameSearchParams) {
  return useQuery({
    queryKey: ["games-search", params],
    queryFn: ({ signal }) => request<GameSearchList>(`/games/search${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

// ---- tag autocomplete -------------------------------------------------------------------
export interface TagSuggestion {
  tag: string; // the EXACT stored tag string (case/hyphenation-sensitive)
  n_games: number;
}

export interface TagSuggestList {
  items: TagSuggestion[];
}

/** Distinct catalog tags matching `q` (case-insensitive substring), ranked by frequency.
 * Pass the DEBOUNCED input value; empty q returns the overall top tags. */
export function useTagSuggest(q: string, enabled = true) {
  return useQuery({
    queryKey: ["tag-suggest", q],
    queryFn: ({ signal }) => request<TagSuggestList>(`/games/tags/suggest${qs({ q, limit: 10 })}`, { signal }),
    enabled,
    staleTime: 5 * 60_000, // the tag universe only changes on the nightly ETL
    placeholderData: keepPreviousData,
  });
}

export interface GameProfile {
  appid: number;
  name: string | null;
  release_year: number | null;
  release_date: string | null;
  price_initial: number | null;
  is_free: number | null;
  primary_genre: string | null;
  developers: string | null;
  publishers: string | null;
  self_published: number | null;
  is_indie: number | null;
  owners_mid: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  est_rev_reviews: number | null;
  est_rev_owners: number | null;
  metacritic_score: number | null;
  achievements_count: number | null;
  avg_playtime_forever: number | null;
  header_image: string | null;
  short_description: string | null;
  rev_pct_in_genre: number | null;
  reviews_pct_in_genre: number | null;
  owners_pct_in_genre: number | null;
  top_tags: string[];
  n_reviews_sampled: number;
  n_reviews_first_30d: number;
  n_reviews_first_90d: number;
  n_reviews_first_365d: number;
  n_reviews_trailing_30d: number;
  playtime_p25: number | null;
  playtime_p50: number | null;
  playtime_p75: number | null;
  live_players: number | null;
  // Daily-CCU summaries (absent/null on marts that predate the players marts).
  players_7d_avg?: number | null;
  players_trend_7d_pct?: number | null;
  first_seen: string | null;
  // Lifetime (steamcharts top-8k) — absent on marts that predate the lifetime ETL.
  lifetime_first_100_month?: string | null;
  lifetime_died_month?: string | null;
  lifetime_months?: number | null;
  lifetime_alive?: boolean | null;
  /** Official X handle linked from the game's own store page / dev website — may be the
   * game's, the studio's, or the dev's personal account. Absent on older marts; null =
   * none found / socials never fetched. */
  dev_x_handle?: string | null;
  /** Playable Steam demo (appid links to its store page). Absent on older marts;
   * null = never re-checked — unknown, not "no". */
  demo_appid?: number | null;
  has_demo?: boolean | null;
  /** Metacritic page Steam links for this game; null = none linked (most of the catalog). */
  metacritic_url?: string | null;
  /** Official socials harvested from the developer's own pages (store page + dev website),
   * never from the platforms themselves. Absent on older marts; null = none found for that
   * platform, or socials not yet fetched for this game. */
  dev_x_url?: string | null;
  dev_discord_url?: string | null;
  dev_youtube_url?: string | null;
  dev_bluesky_handle?: string | null;
  dev_bluesky_url?: string | null;
}

/** Shared query options so the compare page can fan out over N games via useQueries while
 * hitting the same cache entries as useGameProfile. */
export function gameProfileQueryOptions(appid: number) {
  return {
    queryKey: ["game-profile", appid] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => request<GameProfile>(`/games/${appid}`, { signal }),
    staleTime: 5 * 60_000,
  };
}

export function useGameProfile(appid: number | null) {
  return useQuery({
    ...gameProfileQueryOptions(appid ?? -1),
    enabled: appid !== null,
  });
}

export interface PriceBand {
  low: number;
  high: number;
}

export interface GameComparable {
  appid: number;
  name: string | null;
  release_year: number | null;
  price_initial: number | null;
  owners_mid: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  est_rev_reviews: number | null;
  header_image: string | null;
  shared_tags: string[];
  jaccard: number;
}

export interface GameComparablesResponse {
  appid: number;
  primary_genre: string | null;
  price_band: PriceBand;
  items: GameComparable[];
}

export function useGameComparables(appid: number | null) {
  return useQuery({
    queryKey: ["game-comparables", appid],
    queryFn: ({ signal }) => request<GameComparablesResponse>(`/games/${appid}/comparables`, { signal }),
    enabled: appid !== null,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

export interface ReviewTimelinePoint {
  period: string;
  n_reviews: number;
  n_positive: number;
  cum_reviews: number;
  cum_positive: number;
  cum_positive_share: number | null;
  trailing_reviews: number | null;
  trailing_positive_share: number | null;
}

export interface LanguageShare {
  language: string;
  n: number;
  share: number;
}

export interface PlaytimePoint {
  pctile: string;
  value: number;
}

export interface GameLaunchCurvePoint {
  day: number;
  cum_fraction: number;
  sample_first_year_reviews: number;
}

export interface GameReviewsSummary {
  appid: number;
  eligible: boolean;
  timeline: ReviewTimelinePoint[];
  language_split: LanguageShare[];
  playtime_at_review: PlaytimePoint[];
  launch_curve: GameLaunchCurvePoint[];
}

export function useGameReviewsSummary(appid: number | null) {
  return useQuery({
    queryKey: ["game-reviews-summary", appid],
    queryFn: ({ signal }) => request<GameReviewsSummary>(`/games/${appid}/reviews-summary`, { signal }),
    enabled: appid !== null,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

// ---- game events (chart annotations: release / shipped updates / press) -----------------
export interface GameEvent {
  event_date: string; // 'YYYY-MM-DD'
  kind: "release" | "update" | "press";
  title: string;
  url: string | null;
}

/** Shared options for the catalog-events overlay (GET /games/{appid}/events) — useGameEvents
 * and the chart-local overlays in GameTrendsChart / ReviewsTimelineChart all read through it,
 * so however many charts on a page want the markers, react-query collapses them into one
 * network request under one queryKey. The contract is ADDITIVE: a stable miss (404/503)
 * resolves to [] so a chart without markers is complete, just less explained; transient
 * failures get one retry first, and a cancelled fetch never resolves to data. */
export function gameCatalogEventsQueryOptions(appid: number) {
  return {
    queryKey: ["game-catalog-events", appid] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      try {
        const r = await request<{ appid: number; items: GameEvent[] }>(`/games/${appid}/events`, { signal });
        return r.items;
      } catch (error) {
        if (isMissingOverlay(error)) return [] as GameEvent[];
        throw error; // transient → retryed once (retryTransientOnce); AbortError → never data
      }
    },
    staleTime: 5 * 60_000,
    retry: retryTransientOnce,
  };
}

export function useGameEvents(appid: number | null) {
  return useQuery({
    ...gameCatalogEventsQueryOptions(appid ?? -1),
    enabled: appid !== null,
  });
}

// ---- game price history (daily US snapshots via the Steam catalog diff) -----------------
export interface PricePoint {
  captured_on: string; // 'YYYY-MM-DD'
  final_cents: number | null; // null when the storefront lists no price (e.g. free)
  original_cents: number | null; // pre-discount price; null when not discounted
  discount_pct: number;
  is_free: boolean;
  country: string; // 'US' — the only market collected today
}

/** Daily price snapshots (signals.db, collection live since 2026-08-24 — a days-deep
 * series that grows by one point per day). Same ADDITIVE contract as the catalog events:
 * a stable miss (404/503) resolves to [] so the panel renders its honest "tracking just
 * started" state; transient failures get one retry first, and a cancelled fetch never
 * resolves to data. */
export function gamePriceHistoryQueryOptions(appid: number) {
  return {
    queryKey: ["game-price-history", appid] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      try {
        const r = await request<{ appid: number; items: PricePoint[] }>(`/games/${appid}/price-history`, { signal });
        return r.items;
      } catch (error) {
        if (isMissingOverlay(error)) return [] as PricePoint[];
        throw error; // transient → retryed once (retryTransientOnce); AbortError → never data
      }
    },
    staleTime: 5 * 60_000,
    retry: retryTransientOnce,
  };
}

export function useGamePriceHistory(appid: number | null) {
  return useQuery({
    ...gamePriceHistoryQueryOptions(appid ?? -1),
    enabled: appid !== null,
  });
}

// ---- game teardown (Phase 3 — "Why it works") -------------------------------------------
export interface ReviewAspect {
  aspect: string;
  n_pos_mentions: number;
  n_neg_mentions: number;
  total_mentions: number;
  // Vote-based: share of aspect-mentioning reviews that were thumbs-up OVERALL (coarse — a
  // thumbs-up review trashing this aspect still counts as praise). Shown for comparison.
  pos_share: number | null;
  n_reviews_sampled: number;
  // baseline_genre is the game's own primary_genre when it had enough qualifying
  // games, else the '__all__' catalog-wide fallback (see mart_genre_aspect_baseline).
  genre_pos_share: number | null;
  baseline_genre: string | null;
  n_games_in_baseline: number | null;
  delta_vs_genre: number | null;
  // TEXT sentiment (VADER over the review text around the aspect keyword) — what players
  // actually SAY about the aspect, the headline signal. text_pos_share = positive /
  // (positive + negative), neutrals excluded; mean_compound is the mean VADER compound
  // (-1..1). text_delta_vs_genre = text_pos_share − genre_text_pos_share. Coarse: lexicon,
  // English-only, sarcasm-/domain-blind. All null when there aren't enough opinionated mentions.
  n_text_pos: number;
  n_text_neg: number;
  n_text_neutral: number;
  text_pos_share: number | null;
  mean_compound: number | null;
  genre_text_pos_share: number | null;
  text_delta_vs_genre: number | null;
}

export interface PressBySource {
  source: string;
  n_mentions: number;
}

export interface PressTimelinePoint {
  period: string;
  n_mentions: number;
}

export interface PressNotableArticle {
  source: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
  match_confidence: number;
  is_earliest: boolean;
  // Source article URL (articles.url) — lets the client link the title out. Null on marts built
  // before this field existed, or when the scraper never captured a URL for that article.
  url: string | null;
  // Per-article coverage tone — same VADER-over-headline+summary scoring as GamePress's
  // aggregate (press_pos_share/mean_compound), unaggregated. Both null when this article wasn't
  // scored (pre-sentiment-pass mart, or no headline/summary text).
  sentiment_compound: number | null;
  sentiment: "positive" | "negative" | "neutral" | null;
}

export interface GamePress {
  total_mentions: number;
  n_sources: number;
  first_seen: string | null;
  last_seen: string | null;
  by_source: PressBySource[];
  timeline: PressTimelinePoint[];
  notable: PressNotableArticle[];
  // Coverage-tone sentiment (VADER over each matched article's headline+summary). Coarse:
  // headline/summary-level, English-only. press_pos_share = positive / (positive + negative),
  // neutrals excluded; mean_compound is the mean VADER compound (-1..1). null when nothing scored.
  n_pos_articles: number;
  n_neg_articles: number;
  n_neutral_articles: number;
  n_scored_articles: number;
  press_pos_share: number | null;
  mean_compound: number | null;
}

export interface GameTeardown {
  appid: number;
  eligible_reviews: boolean;
  n_reviews_sampled: number;
  review_aspects: ReviewAspect[];
  press: GamePress;
  caveats: string[];
}

export function useGameTeardown(appid: number | null) {
  return useQuery({
    queryKey: ["game-teardown", appid],
    queryFn: ({ signal }) => request<GameTeardown>(`/games/${appid}/teardown`, { signal }),
    enabled: appid !== null,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
  });
}

// ---- channel mix (Track M — where a genre gets marketing attention) ---------------------
export interface ChannelMixRow {
  channel: string; // 'press' (creator channels removed 2026-08-25)
  n_mentions: number;
  reach_weighted: number;
  share_mentions: number | null;
  share_reach_weighted: number | null;
}

export interface GameChannelMix {
  appid: number;
  genre: string | null;
  channels: ChannelMixRow[];
}

/** The game's GENRE-level marketing-channel mix (mart_channel_mix rows for its
 * primary_genre — the mix is a genre property, per-game channel data would be too sparse).
 * `channels` is empty when the game has no primary_genre, the genre has no rows, or the
 * mart predates the channel-mix ETL. */
export function useGameChannelMix(appid: number | null) {
  return useQuery({
    queryKey: ["game-channel-mix", appid],
    queryFn: ({ signal }) => request<GameChannelMix>(`/games/${appid}/channel-mix`, { signal }),
    enabled: appid !== null,
    staleTime: 5 * 60_000,
  });
}

// ---- game trends (+ compare overlay) ----------------------------------------------------
// Mirrors api/app/routers/trends.py. This is the CANONICAL response shape: the chart
// components (GameTrendsChart, GameMetricDrilldown) all fetch through
// gameTrendsQueryOptions below, and the /compare page uses useGameTrendsWithComps, which
// needs the `comps` block (each comp's own monthly series).
export interface GameTrendPoint {
  period: string; // 'YYYY-MM'
  n_reviews: number;
  ccu_avg: number | null;
}

export interface CompSeries {
  appid: number;
  points: GameTrendPoint[];
}

export interface GameTrendsComps {
  requested: number[];
  matched: number[];
  series: CompSeries[];
  cohort: unknown[]; // cohort median/band — unused by the compare page (it draws per-game lines)
}

export interface GameTrendsResponse {
  appid: number;
  eligible: boolean;
  points: GameTrendPoint[];
  comps: GameTrendsComps | null;
}

/** Shared query options for the base trends endpoint (no comps) — GameTrendsChart's
 * self-fetching mode and GameMetricDrilldown BOTH read through this one factory, so the
 * matching queryKeys are guaranteed by construction (they used to be rebuilt in each
 * component and match only by convention) and one cached response serves both. */
export function gameTrendsQueryOptions(appid: number) {
  return {
    queryKey: ["game-trends", appid] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      request<GameTrendsResponse>(`/games/${appid}/trends`, { signal }),
    staleTime: 5 * 60_000,
  };
}

/** Primary game's monthly trends with the rest overlaid via ?comps= (one request total). */
export function useGameTrendsWithComps(appid: number | null, comps: number[]) {
  const compsKey = comps.join(",");
  return useQuery({
    queryKey: ["game-trends-comps", appid, compsKey],
    queryFn: ({ signal }) =>
      request<GameTrendsResponse>(
        `/games/${appid}/trends${qs({ comps: compsKey || undefined })}`,
        { signal },
      ),
    enabled: appid !== null,
    staleTime: 5 * 60_000,
  });
}

// ---- game players (daily CCU point samples — the live_players drilldown) ----------------
/** GET /api/games/{appid}/players — daily CCU point samples (mart_game_players_daily). */
export interface GamePlayersPoint {
  date: string; // 'YYYY-MM-DD'
  players: number;
}

export interface GamePlayersSummary {
  live_players: number | null;
  players_7d_avg: number | null;
  players_trend_7d_pct: number | null;
  n_days_measured: number;
  first_date: string | null;
  last_date: string | null;
}

export interface GamePlayersMonthlyPoint {
  month: string; // 'YYYY-MM-DD' (month start)
  avg_players: number;
  peak_players: number | null;
}

export interface GamePlayersResponse {
  appid: number;
  days: number;
  available: boolean; // false = mart predates the daily CCU marts -> fall back to monthly
  summary: GamePlayersSummary | null;
  points: GamePlayersPoint[];
  // Deep monthly history via steamcharts (top-8k games; empty when uncovered/absent).
  monthly?: GamePlayersMonthlyPoint[];
}

/** Shared query options for the daily-CCU endpoint (GameMetricDrilldown's live_players
 * drilldown fetches through it). `days=90` is the only window asked for today. */
export function gamePlayersQueryOptions(appid: number) {
  return {
    queryKey: ["game-players", appid] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      request<GamePlayersResponse>(`/games/${appid}/players${qs({ days: 90 })}`, { signal }),
    staleTime: 5 * 60_000,
  };
}

// ---- marketing events (the org's own marketing log — GameTrendsChart annotations) -------
export interface MarketingEvent {
  id: number;
  appid: number;
  event_date: string; // 'YYYY-MM-DD'
  kind: string; // trailer | festival | press | update | other
  note: string | null;
}

/** "My marketing events" overlay (GET /api/inputs/events?appid=…) — additive on the same
 * contract as the catalog events: a stable miss resolves to [], transient failures get one
 * retry, and a cancelled fetch never resolves to data. */
export function gameMarketingEventsQueryOptions(appid: number) {
  return {
    queryKey: ["game-events", appid] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      try {
        return await request<MarketingEvent[]>(`/inputs/events${qs({ appid })}`, { signal });
      } catch (error) {
        if (isMissingOverlay(error)) return [] as MarketingEvent[];
        throw error; // transient → retryed once (retryTransientOnce); AbortError → never data
      }
    },
    staleTime: 5 * 60_000,
    retry: retryTransientOnce,
  };
}

// ---- entities (developer/publisher profiles) --------------------------------------------
export type EntityRole = "developer" | "publisher";

export interface EntitySearchRow {
  role: EntityRole;
  name: string;
  n_games: number;
  first_release_year: number | null;
  last_release_year: number | null;
  n_recent_24m: number | null;
  total_rev: number | null;
  median_rev: number | null;
  p90_rev?: number | null; // absent on marts that predate 2026-08-14
  hit_rate_200k: number | null;
  top_genres: string[];
}

export interface EntitySearchList {
  items: EntitySearchRow[];
  total: number;
  limit: number;
}

/**
 * Search OR browse entities. An empty `q` is the API's BROWSE mode (top entities by total
 * est. revenue), so the query is always enabled; `minGames` maps to the API's n_games
 * floor — browse views pass e.g. 3 so single-release credits don't drown the ranking.
 */
export function useEntitySearch(q: string, role: EntityRole | null, minGames = 1, limit = 20) {
  const query = q.trim();
  return useQuery({
    queryKey: ["entity-search", query, role, minGames, limit],
    queryFn: ({ signal }) =>
      request<EntitySearchList>(
        `/entities/search${qs({ q: query || undefined, role, min_games: minGames, limit })}`,
        { signal },
      ),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
    // 503 means "marts not built yet" — a stable answer; surface the refreshing state
    // immediately instead of retrying for seconds. So is any 4xx.
    retry: retryUnlessUnavailable,
  });
}

export interface EntitySummary {
  role: EntityRole;
  name: string;
  n_games: number;
  first_release_year: number | null;
  last_release_year: number | null;
  n_recent_24m: number | null;
  total_rev: number | null;
  median_rev: number | null;
  p90_rev?: number | null; // absent on marts that predate 2026-08-14
  hit_rate_200k: number | null;
  median_reviews: number | null;
  median_positive_ratio: number | null;
  self_published_share: number | null;
  top_genres: string[];
  // Distinct co-credited entities of the other role — null for developers by contract.
  n_partners: number | null;
}

export interface EntityGameRow {
  appid: number;
  seq: number; // 1 = the entity's earliest release
  name: string | null;
  release_year: number | null;
  release_date: string | null;
  price_initial: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  est_rev_reviews: number | null;
  primary_genre: string | null;
  header_image: string | null;
}

export interface EntityProfileResponse {
  entity: EntitySummary;
  games: EntityGameRow[]; // ordered by seq ASC
}

/** Shape of the entity-profile 404's structured detail (ApiError.detail). */
export interface EntityNotFoundDetail {
  error: string;
  suggestions: string[];
}

export function useEntityProfile(role: EntityRole | null, name: string | null) {
  return useQuery({
    queryKey: ["entity-profile", role, name],
    queryFn: ({ signal }) =>
      request<EntityProfileResponse>(`/entities/profile${qs({ role, name })}`, { signal }),
    enabled: !!role && !!name,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
    // 404 carries did-you-mean suggestions and 503 means "marts not built yet" — both are
    // stable answers, so surface them immediately instead of retrying for seconds.
    retry: retryUnlessUnavailable,
  });
}

// ---- aspect drill-down (Phase 3 — click a teardown bar to read the reviews) -------------
export type AspectSentiment = "praise" | "complaint";

export interface AspectReviewExcerpt {
  excerpt: string;
  matched_keywords: string[];
  votes_up: number | null;
  playtime_minutes: number | null;
  date: string | null;
  language: string;
  /** Full review body the excerpt was cut from — capped at 2000 chars server-side, ending in
   * "…" when it was truncated. OPTIONAL: the teardown mart is rebuilt hours after a deploy, so
   * treat "absent" as normal and degrade to the excerpt alone (see AspectReviewExamples). */
  review_text?: string | null;
  /** Permalink to this review on Steam. Optional for the same reason as `review_text`. */
  steam_url?: string | null;
}

export interface AspectReviewsResponse {
  appid: number;
  aspect: string;
  sentiment: AspectSentiment;
  items: AspectReviewExcerpt[];
}

/** Lazy: pass `enabled` (typically "is this aspect row expanded") so the request only
 * fires once a user actually opens the drill-down, per aspect, per sentiment column. */
export function useAspectReviews(
  appid: number | null,
  aspect: string | null,
  sentiment: AspectSentiment,
  enabled = true,
) {
  return useQuery({
    queryKey: ["aspect-reviews", appid, aspect, sentiment],
    queryFn: ({ signal }) =>
      request<AspectReviewsResponse>(
        `/games/${appid}/aspect-reviews${qs({ aspect: aspect ?? "", sentiment, limit: 4 })}`,
        { signal },
      ),
    enabled: enabled && appid !== null && !!aspect,
    staleTime: 5 * 60_000,
  });
}

// ---- combined niches (multi-select: a game carries many tags, so it lives in many
// niches — "Roguelike ∩ Deckbuilding" is a real, buildable segment) --------------------
export type NicheCombineMode = "intersect" | "union";

/** Per-niche input echo: the niche's OWN size in the same cut, so the UI can show the
 * drop (8,000 and 3,000 → 40) that is the whole point of combining. */
export interface NicheCombinedPerNiche {
  dimension: string;
  key: string;
  n_games: number | null;
}

/** A member game of the combination (the API's NicheGameRow). `est_revenue` and
 * `owners_est` are the web-facing names for mart_game's est_rev_reviews / owners_mid —
 * both estimates. Everything but `appid` is optional: the mart is still landing, so
 * render defensively rather than assume a column exists. */
export interface NicheCombinedGame {
  appid: number;
  name?: string | null;
  release_year?: number | null;
  price_initial?: number | null;
  est_revenue?: number | null;
  total_reviews?: number | null;
  owners_est?: number | null;
}

export interface NicheCombined {
  /** Size of the combination itself: games in ALL niches (intersect) or in ANY (union).
   * 0 is a legitimate answer — nobody has built that combination. */
  n_games: number;
  median_rev: number | null;
  p25_rev: number | null;
  p75_rev: number | null;
  p90_rev: number | null;
  median_price: number | null;
  /** Each requested niche's own size in the same cut. The API calls this `inputs`; the
   * originally-specced name was `per_niche` — both are accepted so a rename on either
   * side degrades to "sizes unknown" instead of a crash. */
  inputs?: NicheCombinedPerNiche[];
  per_niche?: NicheCombinedPerNiche[];
  items: NicheCombinedGame[];
  /** Echoed back by the API; the UI trusts its own request when absent. */
  mode?: NicheCombineMode;
  win?: string | null;
  min_reviews?: number | null;
  /** n_games == total for this surface (no cross-filter), but both are sent. */
  total?: number | null;
  limit?: number | null;
  offset?: number | null;
  /** Set by the API when it answered from an incomplete mart — the numbers above are not
   * trustworthy yet and the UI must say so instead of charting them. */
  degraded?: boolean;
  note?: string | null;
}

export interface NicheCombinedParams {
  /** Dimension-qualified refs, e.g. ["tag:Roguelike", "tag:Deckbuilding"] — repeated as
   * separate `niches=` params, not comma-joined (keys contain commas, &, apostrophes). */
  niches: string[];
  mode: NicheCombineMode;
  win?: Window;
  min_reviews?: number;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** `qs()` can't express a repeated key, so the combined query string is built here. */
function combinedQs(p: NicheCombinedParams): string {
  const sp = new URLSearchParams();
  for (const n of p.niches) sp.append("niches", n);
  sp.set("mode", p.mode);
  if (p.win) sp.set("win", p.win);
  if (p.min_reviews != null) sp.set("min_reviews", String(p.min_reviews));
  if (p.sort) sp.set("sort", p.sort);
  if (p.order) sp.set("order", p.order);
  if (p.limit != null) sp.set("limit", String(p.limit));
  if (p.offset) sp.set("offset", String(p.offset));
  return `?${sp.toString()}`;
}

/**
 * Stats for 2..N niches combined. Disabled below two niches (the API rejects it and the
 * page says so itself). 503 = the combined mart hasn't been rebuilt yet, which is the
 * expected state for hours after a deploy — surface it immediately as a degraded state
 * instead of retrying for seconds; same convention as useTimingOverview.
 */
export function useNichesCombined(params: NicheCombinedParams) {
  return useQuery({
    queryKey: ["niches-combined", params],
    queryFn: ({ signal }) => request<NicheCombined>(`/niches/combined${combinedQs(params)}`, { signal }),
    enabled: params.niches.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000, // nightly mart data — back-navigation shouldn't refetch
    // 503 (mart not rebuilt) plus every 4xx the combine endpoint can answer with — 400 for
    // a malformed combination, 404/422 for a cut that does not exist — are stable answers.
    retry: retryUnlessUnavailable,
  });
}
