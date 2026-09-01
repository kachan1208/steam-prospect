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


# ---- /api/market/benchmarks (previously a bare dict, invisible to OpenAPI) --------------
class CitedBenchmarks(BaseModel):
    """benchmarks.as_dict() — researched constants (VG Insights / GameDiscoverCo / Boxleiter
    work), not values derived from our catalog. Shapes mirror that module's literals."""

    median_indie_gross_usd: float
    pct_new_releases_over_100k: float
    bottom_30_pct_gross_usd: float
    reviews_1000_revenue_usd: float
    boxleiter_owners_per_review: dict[str, float]  # {min, mid, max}
    wishlist_conversion_first_week: float
    first_week_to_first_year_mult: float
    steam_revenue_share_to_dev: float
    dev_tiers: list[dict]  # {label, min_copies, max_copies|None, revenue_anchor_usd}
    opportunity_weights: dict[str, float]
    revenue_benchmark_marks: list[BenchmarkMark]


class ComputedBenchmarks(BaseModel):
    """Our catalog's own figures (mart_meta), with the population made explicit in
    population_note. All floats nullable: a mart built before a metric landed simply
    doesn't carry the key."""

    median_revenue_scored: Optional[float] = None
    median_revenue_paid: Optional[float] = None
    boxleiter_owners_per_review_slope: Optional[float] = None
    pct_over_100k_scored: Optional[float] = None
    n_games_total: Optional[float] = None
    n_games_scored: Optional[float] = None
    population_note: str


class MarketBenchmarks(BaseModel):
    cited: CitedBenchmarks
    computed: ComputedBenchmarks
    boxleiter_by_genre: list[BoxleiterRow]
    tiers: list[TierRow]


# ---- /api/refresh/history (previously a bare dict, invisible to OpenAPI) ---------------
class RefreshHistory(BaseModel):
    """The Droplet refresh cron's run log. Each run record is free-form by design — the
    cron grows new delta keys without an API deploy — so `runs` stays a list of dicts
    rather than a frozen row model; the ENVELOPE is what's contractual."""

    runs: list[dict]  # newest first (by finished_at)
    total: int  # runs on disk before `limit` was applied
    limit: int


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


class PricePoint(BaseModel):
    captured_on: str  # 'YYYY-MM-DD'
    final_cents: Optional[int] = None  # NULL = unpriced/delisted that day
    original_cents: Optional[int] = None
    discount_pct: int
    is_free: bool
    country: str


class GamePriceHistory(BaseModel):
    """Daily price snapshots from signals.db (catalog price_change_number diff -> batched
    GetItems) — LIVE collector data, not the mart: a snapshot captured this morning is
    served this morning, skipping the nightly mart cycle entirely. Depth grows one day at a
    time from 2026-08-24 — the raw material for '-20% SALE' chart markers once discount
    deltas exist."""

    appid: int
    items: list[PricePoint]


class GameEventList(BaseModel):
    """Chart-annotation feed. items == [] both for a game with no recorded events AND when
    the mart predates mart_game_event — annotations are additive, so an old mart degrades
    to charts without markers, never to a 503 (same convention as NicheDetail's monthly
    player series)."""

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

    channel: str  # 'press' (creator channels removed 2026-08-25)
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
    # v2 scoring — REBUILT 2026-08-31 (see etl/marts/mart_niche.sql's "opportunity_v2
    # REBUILT" header). A renormalised blend of momentum / market_pull / revenue_spread /
    # quality_gap, multiplied by supply_brake. It reads the same axes, against the same
    # bars, as the Radar board's ring verdicts, so a high score now means "the radar would
    # tell you to enter".
    opportunity_v2: Optional[float] = None
    # The sub-scores, 0..100 each, absent (None) on marts that predate the rebuild. NULL is
    # meaningful: "no comparable reading here" (e.g. an emerging niche has no honest demand
    # trend), and the blend renormalises rather than reading it as 0.
    # THE FOUR BLENDED TERMS are momentum, market_pull, revenue_spread and quality_gap
    # (the long-standing column above). supply_room is NOT one of them — it is the brake's
    # input, and the brake multiplies the blend rather than joining it.
    momentum: Optional[float] = None        # weight 0.40; demand FLOW, 50 flat, 88.1 at the enter bar
    market_pull: Optional[float] = None     # weight 0.22; the money/size percentiles, blended
    revenue_spread: Optional[float] = None  # weight 0.20; 50 exactly at the winner-take-most bar
    supply_room: Optional[float] = None     # NOT weighted — LEAST(flood_room, entrant_room)
    supply_brake: Optional[float] = None    # the multiplier itself, in [0.35, 1]
    # A FALSIFICATION TELL, no longer a score factor (it multiplied opportunity_v2 until
    # 2026-08-31): "did everyone STOP entering this niche?"
    decline_gate: Optional[float] = None
    entrant_ratio: Optional[float] = None
    solo_viability: Optional[float] = None
    # solo_viability as a FLAG rather than a scale: 'solo' | 'mixed' | 'team'. The raw
    # share is compressed (catalog median 0.975, p10 0.913) so it ranks nothing; it only
    # separates the ~3% of niches that are inherently multiplayer. Absent on older marts.
    solo_tier: Optional[str] = None
    # Solo-evidence trio (2026-08-27): the member profile behind solo_viability (which is
    # the SINGLEPLAYER SHARE — a no-netcode proxy, not a production-scope measure). Same
    # per-cut population as solo_viability; absent (None) on marts that predate it.
    self_published_share: Optional[float] = None  # AVG(self_published) over the cut
    indie_share: Optional[float] = None           # AVG(is_indie) over the cut
    med_playtime_h: Optional[float] = None        # median member playtime_p50, hours, 1dp
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
    # 24-month demand (review-histogram windows: last 24 complete months vs the prior 24;
    # cut-independent — ONE value per (dimension, key), identical on every window/floor
    # cut). Replaced the 12-month columns outright (which had replaced the 90-day ones);
    # absent on marts that predate them.
    reviews_24m: Optional[float] = None
    reviews_prev_24m: Optional[float] = None
    demand_trend_24m_pct: Optional[float] = None      # NULL = no prior-window baseline
    # Emerging-niche honesty pair (ships with the 24m columns, same probe): young tags
    # crystallize around new games only, so their prior window is near zero BY
    # CONSTRUCTION and the raw trend % is not representative. The trend stays computed
    # and served either way — suppression is a presentation/verdict concern.
    reviews_24m_new_share: Optional[float] = None  # share of reviews_24m from games released in the last 24 months
    demand_emerging: Optional[bool] = None         # prev base < threshold OR new-game mass >= threshold


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
    # Carried so the niche page's overview "Top games" panel can render its own columns off
    # THIS cut-aware list instead of the cut-independent mart_niche_top top-8 it used to
    # show (see niches.py::_GAME_SELECT for the measurement). live_players is
    # mart_game.live_players — the same per-appid latest CCU snapshot /api/games/{appid}
    # serves, so the two surfaces can no longer disagree (DARK SOULS III read "—" in the
    # niche panel and 3,849 on its own page).
    positive_ratio: Optional[float] = None
    live_players: Optional[int] = None
    header_image: Optional[str] = None


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
