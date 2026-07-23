"""Pydantic v2 response/request models."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# ---- health ---------------------------------------------------------------------------
class Health(BaseModel):
    status: str
    mart_version: Optional[str] = None
    built_at: Optional[str] = None
    source_db: Optional[str] = None


# ---- niches ---------------------------------------------------------------------------
class NicheRow(BaseModel):
    dimension: str
    key: str
    window: str
    min_reviews: int
    n_games: int
    n_recent: int
    median_rev: Optional[float] = None
    p25_rev: Optional[float] = None
    p75_rev: Optional[float] = None
    median_reviews: Optional[float] = None
    median_price: Optional[float] = None
    median_positive_ratio: Optional[float] = None
    median_owners: Optional[float] = None
    recent_velocity: Optional[float] = None
    self_pub_share: Optional[float] = None
    winner_concentration: Optional[float] = None
    hit_rate_200k: Optional[float] = None
    hit_rate_500k: Optional[float] = None
    beatable_share: Optional[float] = None
    saturation_yoy: Optional[float] = None
    demand: Optional[float] = None
    competition: Optional[float] = None
    quality_gap: Optional[float] = None
    opportunity: Optional[float] = None


class NicheList(BaseModel):
    items: list[NicheRow]
    total: int
    limit: int
    offset: int


class NicheGame(BaseModel):
    rank_in_niche: int
    appid: int
    name: Optional[str] = None
    release_year: Optional[int] = None
    price_initial: Optional[float] = None
    owners_mid: Optional[float] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None
    est_rev_reviews: Optional[float] = None
    self_published: Optional[int] = None
    header_image: Optional[str] = None


class HistBucket(BaseModel):
    bucket_index: int
    x_min: float
    x_max: float
    count: int


class TrendPoint(BaseModel):
    year: int
    n_releases: int
    n_scored: int
    median_rev: Optional[float] = None


class NicheDetail(BaseModel):
    dimension: str
    key: str
    variants: list[NicheRow]          # all (window, min_reviews) combinations for this key
    saturation_trend: list[TrendPoint]
    revenue_histogram: list[HistBucket]
    representative_games: list[NicheGame]
    hit_rates: dict[str, Any]


# ---- market ---------------------------------------------------------------------------
class PercentilePoint(BaseModel):
    pctile: str
    value: float


class BenchmarkMark(BaseModel):
    label: str
    value: float
    cite: Optional[str] = None


class MarketDistribution(BaseModel):
    metric: str
    genre: str
    window: str
    n: int
    buckets: list[HistBucket]
    percentiles: list[PercentilePoint]
    benchmark_marks: list[BenchmarkMark]


class BoxleiterRow(BaseModel):
    genre: str
    n: int
    owners_per_review_median: Optional[float] = None
    owners_per_review_p25: Optional[float] = None
    owners_per_review_p75: Optional[float] = None
    slope: Optional[float] = None
    intercept: Optional[float] = None


class TierRow(BaseModel):
    tier: str
    tier_order: int
    count: int
    pct: float


# ---- seasonality / launch curve -------------------------------------------------------
class SeasonalityCell(BaseModel):
    genre: str
    month: Optional[int] = None
    weekday: Optional[int] = None
    year: Optional[int] = None
    n_releases: int
    n_scored: int
    median_rev: Optional[float] = None
    median_reviews: Optional[float] = None
    median_positive_ratio: Optional[float] = None


class Seasonality(BaseModel):
    genre: str
    month_weekday: list[SeasonalityCell]
    month: list[SeasonalityCell]
    weekday: list[SeasonalityCell]
    year: list[SeasonalityCell]


class LaunchCurvePoint(BaseModel):
    day: int
    mean_cum_fraction: float
    median_cum_fraction: float
    n_games: int


class LaunchCurve(BaseModel):
    genre: str
    points: list[LaunchCurvePoint]


# ---- estimate -------------------------------------------------------------------------
class EstimateRequest(BaseModel):
    reviews: Optional[float] = Field(default=None, ge=0)
    wishlists: Optional[float] = Field(default=None, ge=0)
    price: float = Field(ge=0)
    genre: Optional[str] = None


class Range(BaseModel):
    low: float
    mid: float
    high: float


class EstimateResponse(BaseModel):
    basis: Literal["reviews", "wishlists"]
    genre: str
    owners_per_review_used: Range
    owners: Range
    revenue_gross_usd: Range
    revenue_net_usd: Range
    dev_tier: str
    notes: list[str]


# ---- saved views ----------------------------------------------------------------------
class SavedViewIn(BaseModel):
    name: str
    surface: str = "niches"
    config: dict[str, Any] = Field(default_factory=dict)


class SavedViewOut(BaseModel):
    id: int
    name: str
    surface: str
    config: dict[str, Any]
    created_at: str


# ---- games (Phase 2) -------------------------------------------------------------------
class GameSearchRow(BaseModel):
    appid: int
    name: Optional[str] = None
    primary_genre: Optional[str] = None
    release_year: Optional[int] = None
    price_initial: Optional[float] = None
    is_free: Optional[int] = None
    owners_mid: Optional[float] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None
    est_rev_reviews: Optional[float] = None
    live_players: Optional[int] = None
    header_image: Optional[str] = None
    top_tags: list[str] = Field(default_factory=list)


class GameSearchList(BaseModel):
    items: list[GameSearchRow]
    total: int
    limit: int
    offset: int


class GameProfile(BaseModel):
    appid: int
    name: Optional[str] = None
    release_year: Optional[int] = None
    release_date: Optional[str] = None
    price_initial: Optional[float] = None
    is_free: Optional[int] = None
    primary_genre: Optional[str] = None
    developers: Optional[str] = None
    publishers: Optional[str] = None
    self_published: Optional[int] = None
    is_indie: Optional[int] = None
    owners_mid: Optional[float] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None
    est_rev_reviews: Optional[float] = None
    est_rev_owners: Optional[float] = None
    metacritic_score: Optional[int] = None
    achievements_count: Optional[int] = None
    avg_playtime_forever: Optional[int] = None
    header_image: Optional[str] = None
    short_description: Optional[str] = None
    # Percentile-vs-genre (0-100), same population as niches: >=10 reviews.
    rev_pct_in_genre: Optional[float] = None
    reviews_pct_in_genre: Optional[float] = None
    owners_pct_in_genre: Optional[float] = None
    top_tags: list[str] = Field(default_factory=list)
    # Review-velocity summary — SAMPLED counts (reviews table is a per-game sample, not
    # Steam's true review set); see mart_game.sql / stg_review for the caveat.
    n_reviews_sampled: int = 0
    n_reviews_first_30d: int = 0
    n_reviews_first_90d: int = 0
    n_reviews_first_365d: int = 0
    n_reviews_trailing_30d: int = 0
    playtime_p25: Optional[float] = None
    playtime_p50: Optional[float] = None
    playtime_p75: Optional[float] = None
    # Live traction / reach — CCU snapshot (steam_players_bulk.py) + current Twitch footprint.
    live_players: Optional[int] = None
    twitch_viewers: Optional[int] = None
    twitch_streams: Optional[int] = None
    in_watchlist: bool = False


class PriceBand(BaseModel):
    low: float
    high: float


class GameComparable(BaseModel):
    appid: int
    name: Optional[str] = None
    release_year: Optional[int] = None
    price_initial: Optional[float] = None
    owners_mid: Optional[float] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None
    est_rev_reviews: Optional[float] = None
    header_image: Optional[str] = None
    shared_tags: list[str] = Field(default_factory=list)
    jaccard: float


class GameComparablesResponse(BaseModel):
    appid: int
    primary_genre: Optional[str] = None
    price_band: PriceBand
    items: list[GameComparable]


class ReviewTimelinePoint(BaseModel):
    period: str
    n_reviews: int
    n_positive: int
    cum_reviews: int
    cum_positive: int
    cum_positive_share: Optional[float] = None
    # Trailing 3-month window (this period + the 2 before it) — the moving sentiment
    # trajectory the chart actually renders; see mart_game_reviews.sql for why
    # cum_positive_share alone (all-time-to-date) isn't charted: it flattens to a plateau.
    trailing_reviews: Optional[int] = None
    trailing_positive_share: Optional[float] = None


class LanguageShare(BaseModel):
    language: str
    n: int
    share: float


class PlaytimePoint(BaseModel):
    pctile: str
    value: float


class GameLaunchCurvePoint(BaseModel):
    day: int
    cum_fraction: float
    sample_first_year_reviews: int


class GameReviewsSummary(BaseModel):
    appid: int
    eligible: bool
    timeline: list[ReviewTimelinePoint]
    language_split: list[LanguageShare]
    playtime_at_review: list[PlaytimePoint]
    launch_curve: list[GameLaunchCurvePoint]


# ---- game teardown (Phase 3 — "Why it works") -----------------------------------------
class ReviewAspect(BaseModel):
    aspect: str
    n_pos_mentions: int
    n_neg_mentions: int
    total_mentions: int
    pos_share: Optional[float] = None
    n_reviews_sampled: int
    # Genre-differential: baseline_genre is the game's own primary_genre when it has
    # enough qualifying games, else the '__all__' catalog-wide fallback (see
    # mart_genre_aspect_baseline) — always check which one you got before captioning it.
    genre_pos_share: Optional[float] = None
    baseline_genre: Optional[str] = None
    n_games_in_baseline: Optional[int] = None
    delta_vs_genre: Optional[float] = None


class PressBySource(BaseModel):
    source: str
    n_mentions: int


class PressTimelinePoint(BaseModel):
    period: str
    n_mentions: int


class PressNotableArticle(BaseModel):
    source: str
    title: Optional[str] = None
    author: Optional[str] = None
    published_at: Optional[str] = None
    match_confidence: float
    is_earliest: bool


class GamePress(BaseModel):
    total_mentions: int
    n_sources: int
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    by_source: list[PressBySource]
    timeline: list[PressTimelinePoint]
    notable: list[PressNotableArticle]


class GameTeardown(BaseModel):
    appid: int
    eligible_reviews: bool
    n_reviews_sampled: int
    review_aspects: list[ReviewAspect]
    press: GamePress
    caveats: list[str]


# ---- aspect drill-down (Phase 3 — click a teardown bar to read the reviews) -----------
class AspectReviewExcerpt(BaseModel):
    excerpt: str
    matched_keywords: list[str] = Field(default_factory=list)
    votes_up: Optional[int] = None
    playtime_minutes: Optional[int] = None
    date: Optional[str] = None
    language: str


class AspectReviewsResponse(BaseModel):
    appid: int
    aspect: str
    sentiment: Literal["praise", "complaint"]
    items: list[AspectReviewExcerpt]


# ---- press (Phase 3 — aggregate Press / Marketing Intelligence) -----------------------
class PressCoverageRow(BaseModel):
    source: str
    genre: str
    n_articles: int
    # Articles published in the last 24 months (etl RECENT_MONTHS) — n_articles itself is
    # ALL-TIME (the corpus spans back to 1997-2005 depending on outlet, verified NOT
    # recency-biased), so this is the deliberate "still active" signal alongside it.
    n_articles_recent_24m: int
    n_games_covered: int
    median_est_rev: Optional[float] = None
    median_owners: Optional[float] = None
    median_positive_ratio: Optional[float] = None
    # The field named by the request's `metric`, surfaced directly so the client doesn't
    # need to know the metric->column mapping.
    value: Optional[float] = None


class PressCoverageResponse(BaseModel):
    genre: Optional[str] = None
    metric: str
    items: list[PressCoverageRow]
    genres: list[str]   # all distinct genres present in mart_press_outlet_genre (heatmap axis)
    sources: list[str]  # all distinct outlets present (heatmap axis)


class PitchOutlet(BaseModel):
    source: str
    n_articles: int
    n_articles_recent_24m: int
    n_games_covered: int
    median_est_rev: Optional[float] = None
    median_owners: Optional[float] = None
    median_positive_ratio: Optional[float] = None
    example_author: Optional[str] = None
    example_title: Optional[str] = None
    example_url: Optional[str] = None
    example_published_at: Optional[str] = None


class PitchAuthor(BaseModel):
    author: str
    n_articles: int
    n_articles_recent_24m: int
    n_distinct_games: int
    outlets: list[str] = Field(default_factory=list)
    example_source: Optional[str] = None
    example_title: Optional[str] = None
    example_url: Optional[str] = None
    example_published_at: Optional[str] = None


class PitchListResponse(BaseModel):
    genre: str
    outlets: list[PitchOutlet]
    authors: list[PitchAuthor]
    caveats: list[str]


class BuzzTermPoint(BaseModel):
    period: str
    n_mentions: int


class BuzzTermRow(BaseModel):
    term: str
    total_mentions: int
    recent_avg: float
    prior_avg: float
    slope: float
    direction: Literal["rising", "cooling", "flat"]
    series: list[BuzzTermPoint]


class BuzzTrendsResponse(BaseModel):
    direction: Literal["rising", "cooling"]
    items: list[BuzzTermRow]
    caveats: list[str]


# ---- marketing (Track M — multi-channel: Press · YouTube · Reddit · Twitch · X) --------
# Mirrors the press schemas above but for CREATOR platforms (see etl/marts/
# mart_creator_pitch.sql / mart_channel_mix.sql / mart_channel_buzz.sql). Source data comes
# from the scraper's creator/game_creator_mention/creator_reach_snapshot tables, which may
# not have any collectors run yet — every list here can legitimately be empty; that's a
# "connect a channel" empty state, not an error.
class CreatorPitchRow(BaseModel):
    genre: str
    platform: str
    creator_id: int
    handle: Optional[str] = None
    display_name: Optional[str] = None
    creator_url: Optional[str] = None
    n_mentions: int
    n_mentions_recent: int
    n_games_covered: int
    # Latest known reach SNAPSHOT (nullable — a creator with no snapshot yet shows None,
    # which is NOT the same as zero audience; check reach_captured_at before citing it).
    reach: Optional[int] = None
    reach_captured_at: Optional[str] = None
    pitch_score: Optional[float] = None
    example_title: Optional[str] = None
    example_url: Optional[str] = None
    example_published_at: Optional[str] = None


class CreatorPitchListResponse(BaseModel):
    genre: str
    platform: str
    items: list[CreatorPitchRow]
    caveats: list[str]


class ChannelMixRow(BaseModel):
    genre: str
    channel: str
    n_mentions: int
    reach_weighted: float
    share_mentions: Optional[float] = None
    share_reach_weighted: Optional[float] = None


class ChannelMixResponse(BaseModel):
    genre: Optional[str] = None
    items: list[ChannelMixRow]
    genres: list[str]     # all distinct genres present in mart_channel_mix
    channels: list[str]   # all distinct channels present ('press' + any creator platforms)


class ChannelBuzzPoint(BaseModel):
    period: str
    n_mentions: int
    reach_weighted_score: float


class ChannelBuzzChannelBreakdown(BaseModel):
    channel: str
    n_mentions: int
    reach_weighted_score: float


class ChannelBuzzRow(BaseModel):
    term: str
    total_mentions: int
    total_weighted: float
    recent_avg_weighted: float
    prior_avg_weighted: float
    slope_weighted: float
    direction: Literal["rising", "cooling", "flat"]
    # Which channel(s) are actually driving this term, sorted by weighted contribution desc.
    by_channel: list[ChannelBuzzChannelBreakdown]
    series: list[ChannelBuzzPoint]


class ChannelBuzzResponse(BaseModel):
    direction: Literal["rising", "cooling"]
    items: list[ChannelBuzzRow]
    caveats: list[str]


# ---- watchlist (Phase 2) ----------------------------------------------------------------
class WatchlistIn(BaseModel):
    appid: int
    note: Optional[str] = None


class WatchlistOut(BaseModel):
    id: int
    appid: int
    note: Optional[str] = None
    created_at: str
    name: Optional[str] = None
    header_image: Optional[str] = None
    primary_genre: Optional[str] = None
    price_initial: Optional[float] = None
    owners_mid: Optional[float] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None
    est_rev_reviews: Optional[float] = None
    live_players: Optional[int] = None
    twitch_viewers: Optional[int] = None
    n_reviews_trailing_30d: Optional[int] = None
    velocity_sparkline: list[int] = Field(default_factory=list)


# ---- explorer (Phase 4 — safe query/filter/chart builder) -----------------------------
# The request shape here is intentionally generic (col/op/val filters, optional
# group_by, a whitelisted select list) — api/app/routers/explore.py is the ONLY place
# that turns this into SQL, and it validates every field against a server-side
# whitelist (see DIMENSIONS/METRICS there) before compiling anything. This model layer
# only bounds shape/size (list lengths, limit) — it does not and cannot validate
# column names, since the whitelist lives in the router, not here.
FilterOp = Literal["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "is_null", "not_null"]


class ExploreFilter(BaseModel):
    col: str
    op: FilterOp
    val: Any = None


class ExploreQuery(BaseModel):
    # Dimension names (row mode) or group_by-columns + metric names (grouped mode).
    select: list[str] = Field(min_length=1, max_length=8)
    filters: list[ExploreFilter] = Field(default_factory=list, max_length=8)
    group_by: list[str] = Field(default_factory=list, max_length=2)
    sort: Optional[str] = None
    order: Literal["asc", "desc"] = "desc"
    limit: int = Field(default=200, ge=1, le=1000)


class ExploreColumnMeta(BaseModel):
    name: str
    label: str
    kind: Literal["string", "number", "integer", "boolean", "list"]
    groupable: bool = False
    ops: list[str] = Field(default_factory=list)


class ExploreMetricMeta(BaseModel):
    name: str
    label: str


class ExploreSchema(BaseModel):
    dimensions: list[ExploreColumnMeta]
    metrics: list[ExploreMetricMeta]
    max_limit: int
    max_filters: int
    max_select: int
    max_group_by: int
    timeout_seconds: float


class ExploreResult(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    truncated: bool
    grouped: bool
    elapsed_ms: float
    # Compiled parameterized SQL with `?` placeholders (never literal filter values) —
    # transparency into what actually ran; safe to show since it is built entirely from
    # whitelisted identifiers, never from raw client text.
    sql_preview: str


# ---- chat (Analytics Chat — Claude tool-use assistant over the marts) -----------------
class ChatMessageIn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    # Full conversation so far, oldest first, ending with the new user turn — the API is
    # stateless, so the client resends history on every call (see web/src/lib/api.ts).
    messages: list[ChatMessageIn] = Field(default_factory=list)


class ChatStatus(BaseModel):
    ready: bool
    model: str


# ---- account / settings (Track G2 — profile, saved-view/API-key management, usage) ----
class AccountOrg(BaseModel):
    name: str
    slug: str
    plan: str


class AccountUser(BaseModel):
    email: str
    display_name: Optional[str] = None
    member_since: str


class AccountSubscription(BaseModel):
    plan: str
    status: str
    current_period_end: Optional[str] = None


class AccountEntitlements(BaseModel):
    plan: str
    can_export: bool
    api_access: bool
    max_saved_views: Optional[int] = None
    max_watchlist_items: Optional[int] = None
    max_niche_rows: Optional[int] = None


class AccountCounts(BaseModel):
    saved_views: int
    watchlist_items: int
    api_keys_active: int


class AccountOut(BaseModel):
    org: AccountOrg
    user: AccountUser
    subscription: AccountSubscription
    entitlements: AccountEntitlements
    counts: AccountCounts


class ApiKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ApiKeyOut(BaseModel):
    id: int
    name: str
    prefix: str
    active: bool
    created_at: str
    last_used_at: Optional[str] = None


class ApiKeyCreated(ApiKeyOut):
    # Only ever populated on the creation response — the plaintext secret is never stored
    # (only its hash is) and cannot be retrieved again after this response.
    secret: str


class UsageOut(BaseModel):
    # Real counts, read straight from the control-plane tables.
    saved_views: int
    watchlist_items: int
    api_keys_active: int
    # Per-query/export/chat-message activity needs a request-level usage log (Track O5,
    # not built yet) — surfaced honestly rather than faked; see `note`.
    tracking_available: bool
    note: str
