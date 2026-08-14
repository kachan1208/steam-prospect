import { useCallback, useRef, useState } from "react";
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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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
      typeof detail === "string" ? detail : JSON.stringify(detail),
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
  | "demand"
  | "competition"
  | "quality_gap"
  | "median_rev"
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
  | "winner_concentration";

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
    queryFn: () => request<Health>("/health"),
    staleTime: 30_000,
    retry: 1,
  });
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
    queryFn: () => request<MarketDistribution>(`/market/distribution${qs({ metric, genre, window })}`),
    placeholderData: keepPreviousData,
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
    queryFn: () => request<MarketBenchmarks>("/market/benchmarks"),
    staleTime: 5 * 60_000,
  });
}

export interface GenreOption {
  value: string;
  label: string;
}

/** Genre list derived from the Boxleiter-by-genre breakdown (real catalog data, no fake list). */
export function useGenres(): GenreOption[] {
  const { data } = useMarketBenchmarks();
  const genres = (data?.boxleiter_by_genre ?? [])
    .map((b) => b.genre)
    .filter((g) => g !== "__all__")
    .sort((a, b) => a.localeCompare(b));
  return [{ value: "__all__", label: "All genres" }, ...genres.map((g) => ({ value: g, label: g }))];
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
    queryFn: () => request<Seasonality>(`/seasonality${qs({ genre })}`),
    placeholderData: keepPreviousData,
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
    queryFn: () => request<LaunchCurve>(`/launch-curve${qs({ genre })}`),
    staleTime: 5 * 60_000,
  };
}

export function useLaunchCurve(genre: string) {
  return useQuery(launchCurveQueryOptions(genre));
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
    queryFn: () => request<TimingOverview>(`/timing/overview${qs({ genre })}`),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    // 503 = marts not built yet, 404 = genre below the size floors — both are stable
    // answers; surface them immediately instead of retrying for seconds.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 503 || error.status === 404)) &&
      failureCount < 2,
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
  | "live_players";

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
  sort: GameSortKey;
  order: "asc" | "desc";
  limit: number;
  offset: number;
}

export function useGameSearch(params: GameSearchParams) {
  return useQuery({
    queryKey: ["games-search", params],
    queryFn: () => request<GameSearchList>(`/games/search${qs(params)}`),
    placeholderData: keepPreviousData,
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
    queryFn: () => request<TagSuggestList>(`/games/tags/suggest${qs({ q, limit: 10 })}`),
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
  twitch_viewers: number | null;
  twitch_streams: number | null;
  first_seen: string | null;
}

/** Shared query options so the compare page can fan out over N games via useQueries while
 * hitting the same cache entries as useGameProfile. */
export function gameProfileQueryOptions(appid: number) {
  return {
    queryKey: ["game-profile", appid] as const,
    queryFn: () => request<GameProfile>(`/games/${appid}`),
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
    queryFn: () => request<GameComparablesResponse>(`/games/${appid}/comparables`),
    enabled: appid !== null,
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
    queryFn: () => request<GameReviewsSummary>(`/games/${appid}/reviews-summary`),
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
    queryFn: () => request<GameTeardown>(`/games/${appid}/teardown`),
    enabled: appid !== null,
  });
}

// ---- game trends (+ compare overlay) ----------------------------------------------------
// Mirrors api/app/routers/trends.py. GameTrendsChart keeps its own local copy of the base
// point shape (it self-fetches without comps); these typed hooks exist for the /compare
// page, which needs the `comps` block (each comp's own monthly series).
export interface GameTrendPoint {
  period: string; // 'YYYY-MM'
  n_reviews: number;
  ccu_avg: number | null;
  twitch_viewers: number;
  n_mentions: number;
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

/** Primary game's monthly trends with the rest overlaid via ?comps= (one request total). */
export function useGameTrendsWithComps(appid: number | null, comps: number[]) {
  const compsKey = comps.join(",");
  return useQuery({
    queryKey: ["game-trends-comps", appid, compsKey],
    queryFn: () =>
      request<GameTrendsResponse>(
        `/games/${appid}/trends${qs({ comps: compsKey || undefined })}`,
      ),
    enabled: appid !== null,
    staleTime: 5 * 60_000,
  });
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
    queryFn: () =>
      request<EntitySearchList>(
        `/entities/search${qs({ q: query || undefined, role, min_games: minGames, limit })}`,
      ),
    placeholderData: keepPreviousData,
    // 503 means "marts not built yet" — a stable answer; surface the refreshing state
    // immediately instead of retrying for seconds.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 503) && failureCount < 2,
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
    queryFn: () =>
      request<EntityProfileResponse>(`/entities/profile${qs({ role, name })}`),
    enabled: !!role && !!name,
    // 404 carries did-you-mean suggestions and 503 means "marts not built yet" — both are
    // stable answers, so surface them immediately instead of retrying for seconds.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 404 || error.status === 503)) &&
      failureCount < 2,
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
    queryFn: () =>
      request<AspectReviewsResponse>(
        `/games/${appid}/aspect-reviews${qs({ aspect: aspect ?? "", sentiment, limit: 4 })}`,
      ),
    enabled: enabled && appid !== null && !!aspect,
    staleTime: 5 * 60_000,
  });
}
