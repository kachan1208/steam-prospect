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
    # Lifetime (steamcharts top-8k coverage): months from the first 100+-avg-CCU month to
    # the first full month under 10. None = unknown (no coverage / never reached 100+ /
    # mart predates the lifetime ETL — see games.py::_has_lifetime_game).
    lifetime_months: Optional[int] = None
    lifetime_alive: Optional[bool] = None
    # Official X handle linked from the game's own store page / dev website (developer-
    # controlled pages, NOT X itself) — may be the game's, the studio's, or the dev's
    # personal account; we can't disambiguate without X API access. None = none found /
    # socials never fetched / mart predates the socials ETL (games.py::_has_dev_socials).
    dev_x_handle: Optional[str] = None
    # Playable Steam demo (from the game's own appdetails). Tri-state: None = appdetails
    # never re-checked for a demo yet — "unknown", not "no demo" (games.py::_has_demo_flag).
    has_demo: Optional[bool] = None
    # Metacritic critic score, where Steam links a Metacritic page (~2.6% of the catalog).
    # None = no linked page, NOT a poor score.
    metacritic_score: Optional[int] = None


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
    # Daily-CCU summaries (mart_players.sql): trailing-7d average of the nightly point
    # samples + change vs the prior 7d. Absent (None) on marts that predate the CCU marts —
    # the router omits the columns there (see games.py::_has_players_summary).
    players_7d_avg: Optional[float] = None
    players_trend_7d_pct: Optional[float] = None
    twitch_viewers: Optional[int] = None
    twitch_streams: Optional[int] = None
    first_seen: Optional[str] = None   # when this game first entered our catalog (not Steam's release date)
    # Lifetime (steamcharts monthly, top-8k coverage): t0 = first month averaging 100+
    # concurrent players, death = first full month under 10. None = unknown, never zero
    # (no steamcharts coverage / never reached 100+ / mart predates the lifetime ETL).
    lifetime_first_100_month: Optional[str] = None  # 'YYYY-MM-DD' (month start)
    lifetime_died_month: Optional[str] = None       # None while still alive
    lifetime_months: Optional[int] = None           # alive games: months so far
    lifetime_alive: Optional[bool] = None
    # Official X handle linked from the game's own store page / dev website (developer-
    # controlled pages, NOT X itself) — may be the game's, the studio's, or the dev's
    # personal account; we can't disambiguate without X API access. None = none found /
    # socials never fetched / mart predates the socials ETL (games.py::_has_dev_socials).
    dev_x_handle: Optional[str] = None
    # Playable Steam demo (from the game's own appdetails `demos` field). Tri-state:
    # None = appdetails never re-checked for a demo yet — "unknown", not "no demo".
    demo_appid: Optional[int] = None
    has_demo: Optional[bool] = None
    # Metacritic page Steam links for this game. None = Steam links none (most of the catalog)
    # or the mart predates the column (games.py::_has_metacritic_url).
    metacritic_url: Optional[str] = None
    # The rest of the official socials harvested from the same developer-controlled pages as
    # dev_x_handle. None = no link found for that platform, socials not yet fetched, or the
    # mart predates the widened columns (games.py::_has_all_socials).
    dev_x_url: Optional[str] = None
    dev_discord_url: Optional[str] = None
    dev_youtube_url: Optional[str] = None
    dev_bluesky_handle: Optional[str] = None
    dev_bluesky_url: Optional[str] = None


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


# ---- game events (chart annotations) ---------------------------------------------------
class GameEvent(BaseModel):
    """One dated, nameable thing that plausibly moved this game's curves — from
    mart_game_event: the release itself, developer updates (patch notes), and journalist
    coverage. A spike is data; a spike with "PATCH 1.4" against it is an explanation.

    kind is a closed set the mart enforces: 'release' | 'update' | 'press'. url is the
    article/patch-note permalink; NULL for the release row (there is nothing to link)."""

    event_date: str  # 'YYYY-MM-DD'
    kind: Literal["release", "update", "press"]
    title: str
    url: Optional[str] = None


class GameEventList(BaseModel):
    """Chart-annotation feed. items == [] both for a game with no recorded events AND when
    the mart predates mart_game_event — annotations are additive, so an old mart degrades
    to charts without markers, never to a 503 (same convention as the radar sparklines)."""

    appid: int
    items: list[GameEvent]


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


# ---- channel mix (Track M — where a genre gets marketing attention) --------------------
class ChannelMixRow(BaseModel):
    """One (channel) slice of a genre's marketing-attention mix (mart_channel_mix).
    share_mentions = this channel's share of raw mention volume; share_reach_weighted
    weights each mention by the creator's audience size at the time (press = 1.0/article,
    outlets carry no audience figure) — usually the more decision-relevant read, but a
    single huge channel can dominate it, so both are returned."""

    channel: str  # 'press' | 'youtube' | 'reddit' | 'twitch' | 'x'
    n_mentions: int
    reach_weighted: float
    share_mentions: Optional[float] = None
    share_reach_weighted: Optional[float] = None


class GameChannelMix(BaseModel):
    """A game's genre-level channel mix: mart_channel_mix rows for the game's own
    primary_genre (the mix is a GENRE property — per-game channel data would be too
    sparse to read). channels is empty when the genre has no rows, the game has no
    primary_genre, or the mart predates the channel-mix ETL."""

    appid: int
    genre: Optional[str] = None
    channels: list[ChannelMixRow] = Field(default_factory=list)


# ---- aspect drill-down (Phase 3 — click a teardown bar to read the reviews) -----------
class AspectReviewExcerpt(BaseModel):
    """One representative review behind an aspect bar.

    `excerpt` is the sentence around the matched keyword — what the drill-down SHOWS.
    `review_text` + `steam_url` are what let the reader open the whole thing; both are
    Optional because the mart columns behind them (mart_game_aspect_reviews.review_text /
    .steam_url) only exist after the rebuild that added them, and the API always deploys
    hours ahead of that rebuild. See games.py::_has_aspect_full_text — until the mart
    catches up, every item comes back with these two null and the rest unchanged."""

    excerpt: str
    matched_keywords: list[str] = Field(default_factory=list)
    votes_up: Optional[int] = None
    playtime_minutes: Optional[int] = None
    date: Optional[str] = None
    language: str
    # The full review, truncated by the mart to 2000 characters and ending in '…' when cut —
    # so a client can render "…" honestly rather than guessing whether it has everything.
    review_text: Optional[str] = None
    # https://steamcommunity.com/profiles/<author_steamid>/recommended/<appid>/ — null when
    # the review has no author_steamid, so a client must not assume there is a link.
    steam_url: Optional[str] = None


class AspectReviewsResponse(BaseModel):
    appid: int
    aspect: str
    sentiment: Literal["praise", "complaint"]
    items: list[AspectReviewExcerpt]


# ---- niches (Niche Finder — resurrected 2026-08 with v2 scoring + live players) --------
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
    p90_rev: Optional[float] = None  # absent on marts that predate 2026-08-14
    median_reviews: Optional[float] = None
    median_price: Optional[float] = None
    median_positive_ratio: Optional[float] = None
    median_owners: Optional[float] = None
    total_owners: Optional[float] = None
    total_rev: Optional[float] = None
    total_reviews: Optional[float] = None
    market_size: Optional[float] = None
    recent_velocity: Optional[float] = None
    self_pub_share: Optional[float] = None
    winner_concentration: Optional[float] = None
    hit_rate_200k: Optional[float] = None
    hit_rate_500k: Optional[float] = None
    beatable_share: Optional[float] = None
    saturation_yoy: Optional[float] = None
    n_recent_year: Optional[int] = None
    n_prior_year: Optional[int] = None
    demand: Optional[float] = None
    competition: Optional[float] = None
    quality_gap: Optional[float] = None
    opportunity: Optional[float] = None
    # v2 scoring (growth-gated; see etl/marts/mart_niche.sql header).
    opportunity_v2: Optional[float] = None
    decline_gate: Optional[float] = None
    entrant_ratio: Optional[float] = None
    solo_viability: Optional[float] = None
    tier: Optional[str] = None
    # Live players (one value per key, stamped on all cuts; nightly point samples).
    total_players_now: Optional[float] = None
    players_trend_7d_pct: Optional[float] = None
    players_coverage: Optional[float] = None
    median_players_now: Optional[float] = None  # the TYPICAL game's live players
    players_top5_share: Optional[float] = None  # top-5 games' share of the niche total
    # Lifetime (steamcharts top-8k; 100+-reaching games only). Absent on older marts.
    lifetime_n_games: Optional[int] = None            # covered games that ever hit 100+
    lifetime_survival_12m: Optional[float] = None     # share still >=10 a year after t0
    lifetime_median_dead_months: Optional[float] = None  # median life of the already-dead (biased LOW)


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


class TrendPoint(BaseModel):
    year: int
    n_releases: int
    n_scored: int
    median_rev: Optional[float] = None
    p90_rev: Optional[float] = None  # absent on marts that predate 2026-08-14


class NichePlayersPoint(BaseModel):
    date: str  # 'YYYY-MM-DD'
    total_players: int  # LOCF <= 7d carry so tail-rotation gaps don't read as dips
    measured_players: Optional[int] = None  # same-day captures only (the no-carry reality check)
    n_games_measured: int


class NichePlayersMonthlyPoint(BaseModel):
    """One month of the niche's summed EXTERNAL player history (steamcharts monthly
    averages, top-8k games only) — years deep, a different measure from the daily series."""

    month: str  # 'YYYY-MM-DD' (month start)
    avg_players_sum: float
    n_games_measured: int


class NichePlayersTopGame(BaseModel):
    rank: int
    appid: int
    name: Optional[str] = None
    players: int
    share: Optional[float] = None  # of the niche's current total


class NichePlayersDistribution(BaseModel):
    """Who holds the niche's players RIGHT NOW — the measurable form of "a big total
    means people play the hits": the typical game's live players, the top-5 games'
    share, a log histogram, and the named holders."""

    median_players_now: Optional[float] = None
    players_top5_share: Optional[float] = None
    n_games_now: int = 0
    histogram: list[HistBucket] = Field(default_factory=list)
    top_games: list[NichePlayersTopGame] = Field(default_factory=list)


class NichePlayers(BaseModel):
    """The niche's live-player block: mart_niche summary columns + the daily series."""

    total_players_now: Optional[float] = None
    players_trend_7d_pct: Optional[float] = None
    players_coverage: Optional[float] = None
    n_games_panel: Optional[int] = None
    series: list[NichePlayersPoint] = Field(default_factory=list)
    monthly: list[NichePlayersMonthlyPoint] = Field(default_factory=list)
    distribution: Optional[NichePlayersDistribution] = None  # None until the dist marts exist


class NicheTheme(BaseModel):
    """One review-aspect row pooled to niche level (mart_niche_themes, vote-based family)."""

    aspect: str
    n_games: int
    total_mentions: int
    praise_share: Optional[float] = None
    complaint_share: Optional[float] = None
    praise_delta_vs_catalog: Optional[float] = None


class NichePressPoint(BaseModel):
    month: str  # 'YYYY-MM'
    n_articles: int


class NichePressOutlet(BaseModel):
    source: str
    n_articles: int
    n_games_covered: int


class NichePress(BaseModel):
    """The niche's press-coverage block (mart_niche_press / mart_niche_press_outlets):
    journalist coverage of member games, pooled to niche level. n_articles counts
    article-mentions (an article covering two member games counts once per game);
    total_articles sums the dated timeline. Same caveats as every press mart: fuzzy
    match-confidence filter, selection bias (covered games are already notable), and
    Steam News excluded."""

    total_articles: int
    timeline: list[NichePressPoint] = Field(default_factory=list)
    top_outlets: list[NichePressOutlet] = Field(default_factory=list)


# ---- niche membership (the drill-down surface: which games are IN the niche) -----------
# All three models below are backed by mart_niche_game — the (dimension, key, win,
# min_reviews) -> appid membership map. It is built by the nightly mart rebuild and the API
# always ships BEFORE that rebuild lands, so every endpoint that needs it degrades to a 503
# with a rebuild hint (niches.py::_has_niche_games), never a 500.
class NicheGameRow(BaseModel):
    """One member game of a niche (or of a combined niche set). Field names are the
    web-facing contract, not the mart's: est_revenue is mart_game.est_rev_reviews (the
    review-count revenue estimate) and owners_est is mart_game.owners_mid (the midpoint of
    the SteamSpy owners band) — both estimates, neither a reported figure."""

    appid: int
    name: Optional[str] = None
    release_year: Optional[int] = None
    price_initial: Optional[float] = None   # 0.0 = free-to-play, None = price unknown
    est_revenue: Optional[float] = None
    total_reviews: Optional[int] = None
    owners_est: Optional[float] = None


class NicheGameList(BaseModel):
    """`total` is the match count BEFORE limit/offset (and AFTER any bucket cross-filter),
    so the client can paginate honestly. limit/offset echo the resolved request."""

    total: int
    items: list[NicheGameRow] = Field(default_factory=list)
    limit: int
    offset: int


class NicheDistribution(BaseModel):
    """A niche's revenue or price histogram.

    Buckets are HALF-OPEN [x_min, x_max) on both metrics, which makes them exactly
    round-trippable: handing a bucket's (x_min, x_max) back to /games as
    (rev_min, rev_max) / (price_min, price_max) returns precisely that bucket's `count`
    rows. That is the whole point of the shape — the charts cross-filter by clicking a bar.

    revenue: half-decade log10 bins, identical to mart_niche_hist's cut
      (bucket_index = floor(log10(max(v,1))*2), x_max = 10^((i+1)/2)) so the precomputed
      and the computed path are directly comparable. Bucket 0's x_min is reported as 0.0
      rather than the mart's 1.0, because the mart's GREATEST(v, 1) floor puts $0 games in
      bucket 0 and a 1.0 lower edge would make the cross-filter silently drop them.

    price: linear $2.50 bins matching mart_market_hist's price convention, EXCEPT that
      free-to-play gets its own bucket_index = -1 spanning [0.0, 0.01) instead of being
      folded into the first paid bin. F2P is a large, genuinely distinct category, and a
      "$0-$2.50" bar that silently mixes free games with $1.99 games misreads as a pricing
      floor. Paid bucket 0 therefore starts at x_min = 0.01 (the first paid cent), and
      every bucket stays exactly round-trippable.

    `source` says which path served it: 'mart' = the precomputed mart_niche_hist row set
    (only possible for revenue on its one materialised cut), 'computed' = aggregated live
    off mart_niche_game join mart_game."""

    metric: Literal["revenue", "price"]
    buckets: list[HistBucket] = Field(default_factory=list)
    n_games: int = 0  # sum of bucket counts (games with a non-null value for the metric)
    source: Literal["mart", "computed"] = "computed"


class NicheCombinedInput(BaseModel):
    """One requested niche's own membership size, so the UI can show how much each input
    contributes to the combined set. n_games is counted straight off mart_niche_game and is
    guaranteed equal to mart_niche.n_games for the same (dimension, key, win, min_reviews)."""

    dimension: str
    key: str
    n_games: int


class NicheCombined(BaseModel):
    """Headline stats over 2..N niches combined by intersect (a game must be in ALL of them
    — the read that makes "combined analysis" meaningful, since a game legitimately belongs
    to many niches) or union (in ANY of them).

    The percentiles are computed over the combined set with the same definitions
    mart_niche uses for a single niche (quantile_cont over est_rev_reviews; median over
    price_initial, free games included) — NOT averaged from the per-niche marts, which
    would be wrong for an intersection.

    n_games == total: the combined set is not bucket-filtered, so the paging total is the
    set size."""

    mode: Literal["intersect", "union"]
    win: Literal["all", "24m"]
    min_reviews: int
    inputs: list[NicheCombinedInput] = Field(default_factory=list)
    n_games: int
    median_rev: Optional[float] = None
    p25_rev: Optional[float] = None
    p75_rev: Optional[float] = None
    p90_rev: Optional[float] = None
    median_price: Optional[float] = None
    total: int
    items: list[NicheGameRow] = Field(default_factory=list)
    limit: int
    offset: int


class NicheDetail(BaseModel):
    dimension: str
    key: str
    tier: Optional[str] = None
    variants: list[NicheRow]
    saturation_trend: list[TrendPoint]
    revenue_histogram: list[HistBucket]
    representative_games: list[NicheGame]
    players: Optional[NichePlayers] = None  # None = mart predates the CCU marts
    themes: list[NicheTheme] = Field(default_factory=list)
    # None = mart predates mart_niche_press, or the niche has no published press rows
    # (below the covered-games floor / genuinely uncovered).
    press: Optional[NichePress] = None
    hit_rates: dict


# ---- Radar feed (the opportunity-feed home, mockup 3a) ---------------------------------
# Ranks on demand_trend_90d_pct (mart_niche, landed 2026-08-21 — see niches.py::_has_demand90).
# Every field below is real: no series is interpolated/invented to fill a gap the marts don't
# cover, and a niche whose demand_trend_90d_pct is NULL (no prior-90d baseline — a brand-new
# niche, not a flat one) never reaches this response; the router filters those rows out rather
# than rendering a false "unchanged".
class RadarSparklinePoint(BaseModel):
    """One month of real player history (mart_niche_players_monthly, steamcharts top-8k
    coverage) — the card sparkline's actual shape, not an invented curve. Absent (empty list
    on the card) when that mart predates the niche or the table itself doesn't exist yet."""

    month: str  # 'YYYY-MM-DD' (month start)
    players: float


class RadarNicheCard(BaseModel):
    """One niche in the feed — the hero pick and every 'Moving niches' grid card share this
    shape (the hero repeats as the grid's first card, same as mockup 3a). reviews_90d /
    reviews_prev_90d are Steam's own monthly review totals (review_histogram; 42K games
    carrying ~98% of review volume), summed over 3-calendar-month windows anchored on the
    last complete month — see mart_niche.sql's SOURCE CHANGED note. They were briefly
    counted from the sampled reviews table instead, which inflated every top trend to
    +1000%..+1500% (the keeper collects new reviews near-completely while big games' tails
    stay capped, so the ratio amplifies collector bias; measured: Rainbow Six read 16x on
    the sample and flat on the histogram). demand_trend_90d_pct is the ratio between the
    two windows, guaranteed non-null here (see module note); it lags reality by up to a
    month until histogram refresh cadence improves."""

    dimension: str
    key: str
    tier: Optional[str] = None
    n_games: int
    p90_rev: Optional[float] = None  # absent on marts that predate p90_rev (2026-08-14)
    opportunity_v2: Optional[float] = None
    saturation_yoy: Optional[float] = None
    reviews_90d: int
    reviews_prev_90d: int
    demand_trend_90d_pct: float
    # Live-player momentum (mart_niche, gated like p90_rev) — absent on older marts.
    players_trend_7d_pct: Optional[float] = None
    sparkline: list[RadarSparklinePoint] = Field(default_factory=list)


class RadarHero(RadarNicheCard):
    """The hero pick (the cut's biggest 90-day riser) plus its yearly demand-vs-pipeline
    trend for the chart column. §3a's mockup shows a smooth ~monthly two-series curve; no mart
    materialises niche review velocity or releases at monthly granularity, so — same call
    NicheDetail's §4b 'Demand vs. pipeline, by year' panel already made for the identical
    gap — this reuses that real, yearly mart_niche_trend series instead of inventing a
    monthly shape."""

    trend: list[TrendPoint] = Field(default_factory=list)


class RadarFeed(BaseModel):
    dimension: str
    window: str
    min_reviews: int
    hero: RadarHero
    # Includes the hero as movers[0] (mirrors the mockup, whose hero niche is also the grid's
    # first card) followed by the cut's other biggest 90-day movers, UP or DOWN, ranked by
    # |demand_trend_90d_pct| — "Moving niches", not "Rising niches".
    movers: list[RadarNicheCard]
