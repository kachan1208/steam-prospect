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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
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

// ---- niches -----------------------------------------------------------------------------
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
  median_reviews: number | null;
  median_price: number | null;
  median_positive_ratio: number | null;
  median_owners: number | null;
  recent_velocity: number | null;
  self_pub_share: number | null;
  winner_concentration: number | null;
  hit_rate_200k: number | null;
  hit_rate_500k: number | null;
  beatable_share: number | null;
  saturation_yoy: number | null;
  demand: number | null;
  competition: number | null;
  quality_gap: number | null;
  opportunity: number | null;
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
  limit: number;
  offset: number;
}

export function useNiches(params: NicheListParams) {
  return useQuery({
    queryKey: ["niches", params],
    queryFn: () => request<NicheList>(`/niches${qs(params)}`),
    placeholderData: keepPreviousData,
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
  variants: NicheRow[];
  saturation_trend: TrendPoint[];
  revenue_histogram: HistBucket[];
  representative_games: NicheGame[];
  hit_rates: NicheHitRates;
}

export function useNicheDetail(dimension: Dimension, key: string | null) {
  return useQuery({
    queryKey: ["niche-detail", dimension, key],
    queryFn: () => request<NicheDetail>(`/niches/${dimension}/${encodeURIComponent(key ?? "")}`),
    enabled: key !== null,
  });
}

/** Build a download URL for the niches CSV export (GET, triggered via <a download>). */
export function nicheExportCsvUrl(params: {
  dimension: Dimension;
  window: Window;
  min_reviews?: number;
  sort?: SortKey;
  order?: "asc" | "desc";
  q?: string;
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

// ---- estimate ---------------------------------------------------------------------------
export interface EstimateRequest {
  reviews?: number;
  wishlists?: number;
  price: number;
  genre?: string;
}

export interface Range {
  low: number;
  mid: number;
  high: number;
}

export interface EstimateResponse {
  basis: "reviews" | "wishlists";
  genre: string;
  owners_per_review_used: Range;
  owners: Range;
  revenue_gross_usd: Range;
  revenue_net_usd: Range;
  dev_tier: string;
  notes: string[];
}

export function useEstimate() {
  return useMutation({
    mutationFn: (body: EstimateRequest) =>
      request<EstimateResponse>("/estimate", { method: "POST", body: JSON.stringify(body) }),
  });
}

// ---- saved views ------------------------------------------------------------------------
export interface SavedView {
  id: number;
  name: string;
  surface: string;
  config: Record<string, unknown>;
  created_at: string;
}

export function useSavedViews() {
  return useQuery({ queryKey: ["views"], queryFn: () => request<SavedView[]>("/views") });
}

export function useCreateSavedView() {
  const qc = useQueryClient();
  return useMutation({
    // config is `object` (not `Record<string, unknown>`) so callers can pass any
    // plain config interface (NicheViewConfig, etc.) without it needing its own
    // index signature — JSON.stringify accepts it as-is.
    mutationFn: (body: { name: string; surface?: string; config?: object }) =>
      request<SavedView>("/views", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
}

export function useDeleteSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<void>(`/views/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
}

// ---- games (Phase 2) --------------------------------------------------------------------
export interface GameSearchRow {
  appid: number;
  name: string | null;
  primary_genre: string | null;
  release_year: number | null;
  price_initial: number | null;
  is_free: number | null;
  owners_mid: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  est_rev_reviews: number | null;
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
  | "price_initial"
  | "owners_mid"
  | "total_reviews"
  | "positive_ratio"
  | "est_rev_reviews"
  | "rev_pct_in_genre"
  | "reviews_pct_in_genre"
  | "owners_pct_in_genre"
  | "n_reviews_trailing_30d";

export interface GameSearchParams {
  q?: string;
  tag?: string;
  genre?: string;
  min_reviews?: number;
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
  in_watchlist: boolean;
}

export function useGameProfile(appid: number | null) {
  return useQuery({
    queryKey: ["game-profile", appid],
    queryFn: () => request<GameProfile>(`/games/${appid}`),
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
  pos_share: number | null;
  n_reviews_sampled: number;
  // baseline_genre is the game's own primary_genre when it had enough qualifying
  // games, else the '__all__' catalog-wide fallback (see mart_genre_aspect_baseline).
  genre_pos_share: number | null;
  baseline_genre: string | null;
  n_games_in_baseline: number | null;
  delta_vs_genre: number | null;
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
}

export interface GamePress {
  total_mentions: number;
  n_sources: number;
  first_seen: string | null;
  last_seen: string | null;
  by_source: PressBySource[];
  timeline: PressTimelinePoint[];
  notable: PressNotableArticle[];
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

// ---- press (Phase 3 — aggregate Press / Marketing Intelligence) -------------------------
export interface PressCoverageRow {
  source: string;
  genre: string;
  n_articles: number;
  n_articles_recent_24m: number;
  n_games_covered: number;
  median_est_rev: number | null;
  median_owners: number | null;
  median_positive_ratio: number | null;
  value: number | null;
}

export interface PressCoverageResponse {
  genre: string | null;
  metric: string;
  items: PressCoverageRow[];
  genres: string[];
  sources: string[];
}

// Mirrors the API's _COVERAGE_METRICS whitelist in api/app/routers/press.py.
export type CoverageMetric = "n_articles" | "n_games_covered" | "median_est_rev" | "median_owners" | "median_positive_ratio";

export function usePressCoverage(genre?: string, metric: CoverageMetric = "n_articles") {
  return useQuery({
    queryKey: ["press-coverage", genre ?? null, metric],
    queryFn: () => request<PressCoverageResponse>(`/press/coverage${qs({ genre, metric })}`),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export interface PitchOutlet {
  source: string;
  n_articles: number;
  n_articles_recent_24m: number;
  n_games_covered: number;
  median_est_rev: number | null;
  median_owners: number | null;
  median_positive_ratio: number | null;
  example_author: string | null;
  example_title: string | null;
  example_url: string | null;
  example_published_at: string | null;
}

export interface PitchAuthor {
  author: string;
  n_articles: number;
  n_articles_recent_24m: number;
  n_distinct_games: number;
  outlets: string[];
  example_source: string | null;
  example_title: string | null;
  example_url: string | null;
  example_published_at: string | null;
}

export interface PitchListResponse {
  genre: string;
  outlets: PitchOutlet[];
  authors: PitchAuthor[];
  caveats: string[];
}

export function usePitchList(genre: string | null, limit = 25) {
  return useQuery({
    queryKey: ["press-pitch-list", genre, limit],
    queryFn: () => request<PitchListResponse>(`/press/pitch-list${qs({ genre: genre ?? "", limit })}`),
    enabled: genre !== null && genre !== "",
    placeholderData: keepPreviousData,
  });
}

export interface BuzzTermPoint {
  period: string;
  n_mentions: number;
}

export interface BuzzTermRow {
  term: string;
  total_mentions: number;
  recent_avg: number;
  prior_avg: number;
  slope: number;
  direction: "rising" | "cooling" | "flat";
  series: BuzzTermPoint[];
}

export interface BuzzTrendsResponse {
  direction: "rising" | "cooling";
  items: BuzzTermRow[];
  caveats: string[];
}

export function useBuzzTrends(direction: "rising" | "cooling", limit = 20) {
  return useQuery({
    queryKey: ["press-buzz-trends", direction, limit],
    queryFn: () => request<BuzzTrendsResponse>(`/press/buzz-trends${qs({ direction, limit })}`),
    staleTime: 5 * 60_000,
  });
}

// ---- watchlist (Phase 2) ------------------------------------------------------------------
export interface WatchlistItem {
  id: number;
  appid: number;
  note: string | null;
  created_at: string;
  name: string | null;
  header_image: string | null;
  primary_genre: string | null;
  price_initial: number | null;
  owners_mid: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  est_rev_reviews: number | null;
  velocity_sparkline: number[];
}

export function useWatchlist() {
  return useQuery({ queryKey: ["watchlist"], queryFn: () => request<WatchlistItem[]>("/watchlist") });
}

export function useAddWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { appid: number; note?: string }) =>
      request<WatchlistItem>("/watchlist", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["watchlist"] });
      qc.invalidateQueries({ queryKey: ["game-profile", vars.appid] });
    },
  });
}

export function useRemoveWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (appid: number) => request<void>(`/watchlist/${appid}`, { method: "DELETE" }),
    onSuccess: (_data, appid) => {
      qc.invalidateQueries({ queryKey: ["watchlist"] });
      qc.invalidateQueries({ queryKey: ["game-profile", appid] });
    },
  });
}

// ---- explorer (Phase 4 — safe query/filter/chart builder) -------------------------------
// Mirrors api/app/routers/explore.py's DIMENSIONS/METRICS whitelists — but the actual
// vocabulary (which names exist) is fetched at runtime via useExploreSchema(), never
// hardcoded here, so the UI never drifts from the server's whitelist.
export type ExploreColumnKind = "string" | "number" | "integer" | "boolean" | "list";

export interface ExploreColumnMeta {
  name: string;
  label: string;
  kind: ExploreColumnKind;
  groupable: boolean;
  ops: string[];
}

export interface ExploreMetricMeta {
  name: string;
  label: string;
}

export interface ExploreSchemaResponse {
  dimensions: ExploreColumnMeta[];
  metrics: ExploreMetricMeta[];
  max_limit: number;
  max_filters: number;
  max_select: number;
  max_group_by: number;
  timeout_seconds: number;
}

export function useExploreSchema() {
  return useQuery({
    queryKey: ["explore-schema"],
    queryFn: () => request<ExploreSchemaResponse>("/explore/schema"),
    staleTime: 10 * 60_000,
  });
}

export type ExploreFilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like" | "contains" | "is_null" | "not_null";

export interface ExploreFilter {
  col: string;
  op: ExploreFilterOp;
  val?: string | number | boolean | (string | number)[] | null;
}

export interface ExploreQuery {
  select: string[];
  filters: ExploreFilter[];
  group_by: string[];
  sort?: string | null;
  order: "asc" | "desc";
  limit: number;
}

export interface ExploreResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  grouped: boolean;
  elapsed_ms: number;
  sql_preview: string;
}

export function useRunExplore() {
  return useMutation({
    mutationFn: (query: ExploreQuery) =>
      request<ExploreResult>("/explore", { method: "POST", body: JSON.stringify(query) }),
  });
}

/** Build a download URL for the explorer CSV export (GET, triggered via <a download>). The
 * query travels as a single URL-encoded JSON param — the API re-validates it against the
 * same whitelist as POST /explore, so this is exactly as safe as the interactive query. */
export function exploreExportCsvUrl(query: ExploreQuery): string {
  return `${API_BASE}/explore/export.csv${qs({ query: JSON.stringify(query) })}`;
}
