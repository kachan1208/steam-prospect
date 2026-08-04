"""Pydantic v2 response/request models."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---- health ---------------------------------------------------------------------------
class Health(BaseModel):
    status: str
    mart_version: Optional[str] = None
    built_at: Optional[str] = None
    source_db: Optional[str] = None


class HistBucket(BaseModel):
    bucket_index: int
    x_min: float
    x_max: float
    count: int


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


class Range(BaseModel):
    low: float
    mid: float
    high: float


# ---- games (Phase 2) -------------------------------------------------------------------
class GameSearchRow(BaseModel):
    appid: int
    name: Optional[str] = None
    primary_genre: Optional[str] = None
    release_year: Optional[int] = None
    release_date: Optional[str] = None
    price_initial: Optional[float] = None
    is_free: Optional[int] = None
    owners_mid: Optional[float] = None
    total_reviews: Optional[int] = None
    positive_ratio: Optional[float] = None
    est_rev_reviews: Optional[float] = None
    live_players: Optional[int] = None
    header_image: Optional[str] = None
    top_tags: list[str] = Field(default_factory=list)
    first_seen: Optional[str] = None   # when this game first entered our catalog


class GameSearchList(BaseModel):
    items: list[GameSearchRow]
    total: int
    limit: int
    offset: int


class TagSuggestion(BaseModel):
    tag: str  # the EXACT tag string as stored in mart_game.top_tags (case/hyphenation matter)
    n_games: int  # how many catalog games carry the tag (frequency = suggestion rank)


class TagSuggestList(BaseModel):
    items: list[TagSuggestion]


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
    first_seen: Optional[str] = None   # when this game first entered our catalog (not Steam's release date)


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
    # VOTE-based split: share of aspect-mentioning reviews that were thumbs-up OVERALL. Coarse
    # by construction (a thumbs-up review trashing this aspect still counts as praise here) —
    # kept for continuity/comparison; the text-sentiment fields below are the honest signal.
    pos_share: Optional[float] = None
    n_reviews_sampled: int
    # Genre-differential: baseline_genre is the game's own primary_genre when it has
    # enough qualifying games, else the '__all__' catalog-wide fallback (see
    # mart_genre_aspect_baseline) — always check which one you got before captioning it.
    genre_pos_share: Optional[float] = None
    baseline_genre: Optional[str] = None
    n_games_in_baseline: Optional[int] = None
    delta_vs_genre: Optional[float] = None
    # TEXT sentiment (VADER over the local window around the aspect keyword — see
    # mart_game_teardown.sql / etl/build_marts.py compute_aspect_sentiment). This reflects what
    # reviewers actually SAY about the aspect, not their overall thumbs-up/down. Coarse:
    # lexicon-based, English-only, sarcasm-blind, domain-blind. text_pos_share = positive /
    # (positive + negative), excluding the neutral band; mean_compound is the mean VADER
    # compound (-1..1) over all scored mentions. text_delta_vs_genre is text_pos_share minus
    # the pooled genre baseline (genre_text_pos_share).
    n_text_pos: int = 0
    n_text_neg: int = 0
    n_text_neutral: int = 0
    text_pos_share: Optional[float] = None
    mean_compound: Optional[float] = None
    genre_text_pos_share: Optional[float] = None
    text_delta_vs_genre: Optional[float] = None


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
    # Source article URL (articles.url) — lets the client link the title out to the original
    # coverage. Optional: null for marts built before this field was added, or if the scraper
    # never captured a URL for that article.
    url: Optional[str] = None
    # Per-article coverage-tone sentiment — same VADER-over-headline+summary scoring as
    # GamePress's aggregate (n_pos_articles/press_pos_share/mean_compound), just unaggregated.
    # compound is the raw VADER compound (-1..1); sentiment buckets it with the identical ±0.05
    # neutral band the aggregate counts use (see mart_game_teardown.sql). Both null when this
    # article wasn't scored (pre-sentiment-pass mart, or no headline/summary text to score).
    sentiment_compound: Optional[float] = None
    sentiment: Optional[Literal["positive", "negative", "neutral"]] = None


class GamePress(BaseModel):
    total_mentions: int
    n_sources: int
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    by_source: list[PressBySource]
    timeline: list[PressTimelinePoint]
    notable: list[PressNotableArticle]
    # Coverage-tone sentiment (VADER over each matched article's headline+summary — see
    # mart_game_teardown.sql / etl/build_marts.py compute_press_sentiment). press_pos_share =
    # positive / (positive + negative), neutrals excluded; mean_compound is the mean VADER
    # compound (-1..1) across scored articles. Coarse: headline/summary-level, English-only, and
    # an article's overall tone only proxies its stance on the matched game.
    n_pos_articles: int = 0
    n_neg_articles: int = 0
    n_neutral_articles: int = 0
    n_scored_articles: int = 0
    press_pos_share: Optional[float] = None
    mean_compound: Optional[float] = None


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
