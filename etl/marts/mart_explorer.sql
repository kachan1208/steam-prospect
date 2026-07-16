-- mart_explorer.sql
-- Wide, denormalized "one row per game" table tuned for the Data Explorer's ad-hoc
-- filter / group-by / chart query builder (see api/app/routers/explore.py). Phase 4.
--
-- Built from the already-materialized mart_game rather than re-derived from staging:
-- this file runs LAST in build_marts.py's MART_FILES list (appended at the end), so
-- mart_game (name/genre/top_tags/velocity/percentiles) already exists as a real table by
-- the time this runs. That keeps this file a pure reshape + bucketing pass with no
-- duplicated tag-vote-floor / velocity / percentile logic, and no new dependency on
-- staging internals (which etl/build_marts.py's staging section, Track A's territory,
-- may reshape independently of this file).
--
-- Column contract consumed by api/app/routers/explore.py's DIMENSIONS/METRICS
-- whitelists — if you rename or drop a column here, update those whitelists too.
--
-- Derived "bucket" columns exist because the query builder's group-by only makes sense
-- over low-cardinality categoricals: grouping by raw price_initial or owners_mid would
-- produce ~one group per row. Each bucket is a coarse, documented re-binning of a
-- continuous column already present here in its raw form (so both are always available
-- side by side — bucket for GROUP BY, raw for filters/metrics/sort).

DROP TABLE IF EXISTS mart_explorer;

CREATE TABLE mart_explorer AS
SELECT
    appid,
    name,
    release_year,
    release_date,
    primary_genre,
    -- "Primary tag" = the game's single highest-voted tag (top_tags is already ordered
    -- by rank in mart_game) — a tag-level counterpart to primary_genre for group-by.
    -- NULL-safe: top_tags[1] on an empty list returns NULL, not an error.
    top_tags[1] AS primary_tag,
    top_tags,
    price_initial,
    is_free,
    is_indie,
    self_published,
    developers,
    publishers,
    owners_mid,
    total_reviews,
    positive_ratio,
    est_rev_reviews,
    est_rev_owners,
    metacritic_score,
    achievements_count,
    avg_playtime_forever,
    n_reviews_trailing_30d,
    n_reviews_first_365d,
    rev_pct_in_genre,
    reviews_pct_in_genre,
    owners_pct_in_genre,
    header_image,

    -- Released in the last RECENT_MONTHS (24) months — mirrors stg_game.is_recent /
    -- the niches "24m" window elsewhere in the app. release_date here is already the
    -- VARCHAR ISO date mart_game exposes (NULL when the source release date wasn't
    -- parseable), so re-cast for the interval comparison.
    (TRY_CAST(release_date AS DATE) IS NOT NULL
        AND TRY_CAST(release_date AS DATE) >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH) AS is_recent,

    CASE
        WHEN is_free = 1 OR price_initial = 0 THEN 'Free'
        WHEN price_initial IS NULL THEN NULL
        WHEN price_initial < 5 THEN '$0.01-4.99'
        WHEN price_initial < 10 THEN '$5-9.99'
        WHEN price_initial < 20 THEN '$10-19.99'
        WHEN price_initial < 30 THEN '$20-29.99'
        ELSE '$30+'
    END AS price_bucket,

    -- Competition-size proxy: how many (sampled) reviews a game has accrued.
    CASE
        WHEN total_reviews IS NULL THEN NULL
        WHEN total_reviews < 10 THEN 'Under 10'
        WHEN total_reviews < 50 THEN '10-49'
        WHEN total_reviews < 200 THEN '50-199'
        WHEN total_reviews < 1000 THEN '200-999'
        WHEN total_reviews < 5000 THEN '1K-4.9K'
        ELSE '5K+'
    END AS review_bucket,

    -- Dev-tier band on owners_mid. Mirrors mart_market.sql's mart_market_tiers
    -- thresholds (2K/20K/200K/1M) and api/app/benchmarks.py's DEV_TIERS — keep all
    -- three in sync if you ever change the boundaries.
    CASE
        WHEN owners_mid IS NULL OR owners_mid <= 0 THEN NULL
        WHEN owners_mid < 2000 THEN 'Below Hobby'
        WHEN owners_mid < 20000 THEN 'Hobby'
        WHEN owners_mid < 200000 THEN 'Small'
        WHEN owners_mid < 1000000 THEN 'Middle'
        ELSE 'Triple-I'
    END AS dev_tier,

    -- Approximate Steam-style review descriptor band. A documented simplification of
    -- Valve's real algorithm (which also weighs review *count* into the "Overwhelmingly"
    -- bands via a Wilson-score-like confidence adjustment, not a flat ratio floor) —
    -- good enough for a group-by bucket, not a claim of matching Steam's exact label.
    CASE
        WHEN total_reviews IS NULL OR total_reviews < 10 THEN 'Insufficient reviews'
        WHEN positive_ratio >= 0.95 THEN 'Overwhelmingly Positive'
        WHEN positive_ratio >= 0.80 THEN 'Very Positive'
        WHEN positive_ratio >= 0.70 THEN 'Mostly Positive'
        WHEN positive_ratio >= 0.40 THEN 'Mixed'
        ELSE 'Mostly Negative'
    END AS rating_tier
FROM mart_game;
