-- mart_market.sql
-- Global market-reality marts. Uses staging (stg_game, stg_genre_membership).
--   mart_market_hist       log-bucket histograms per (metric, genre, win)
--   mart_market_pct        percentile tables per (metric, genre, win)
--   mart_market_tiers      dev-tier band counts (Hobby/Small/Middle/Triple-I) on owners_mid
--   mart_market_boxleiter  per-genre owners/review coefficient (median + regression fit)
-- metric in {revenue (est_rev_reviews), reviews (total_reviews), owners (owners_mid)}
-- genre '__all__' = whole catalog. window in {all, 24m}. Placeholders substituted by build_marts.py.

DROP TABLE IF EXISTS mart_market_hist;
DROP TABLE IF EXISTS mart_market_pct;
DROP TABLE IF EXISTS mart_market_tiers;
DROP TABLE IF EXISTS mart_market_boxleiter;

-- Reusable observation set: (metric, genre, win, value), scoped to the review floor.
CREATE TEMP TABLE _mkt_obs AS
WITH mkt_genres AS (
    SELECT gm.genre
    FROM stg_genre_membership gm
    JOIN stg_game g ON g.appid = gm.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@
    GROUP BY gm.genre
    HAVING COUNT(*) >= @MARKET_MIN_GENRE_GAMES@
),
base AS (
    SELECT '__all__' AS genre, g.is_recent, g.price_initial,
           g.est_rev_reviews AS revenue, g.total_reviews AS reviews, g.owners_mid AS owners
    FROM stg_game g
    WHERE g.total_reviews >= @MARKET_MIN_REVIEWS@
    UNION ALL
    SELECT gm.genre, g.is_recent, g.price_initial,
           g.est_rev_reviews, g.total_reviews, g.owners_mid
    FROM stg_genre_membership gm
    JOIN stg_game g ON g.appid = gm.appid
    JOIN mkt_genres mg ON mg.genre = gm.genre
    WHERE g.total_reviews >= @MARKET_MIN_REVIEWS@
),
melted AS (
    -- revenue: paid games only (free games have price 0 -> $0 box revenue, not informative)
    SELECT genre, 'revenue' AS metric, revenue AS value, is_recent
    FROM base WHERE revenue IS NOT NULL AND price_initial > 0
    UNION ALL
    SELECT genre, 'reviews', reviews, is_recent FROM base WHERE reviews IS NOT NULL
    UNION ALL
    SELECT genre, 'owners', owners, is_recent FROM base WHERE owners IS NOT NULL AND owners > 0
    UNION ALL
    -- price: paid games only; bounded ($ few..$70) and clusters at price points (linear-binned below)
    SELECT genre, 'price', price_initial, is_recent FROM base WHERE price_initial IS NOT NULL AND price_initial > 0
)
SELECT genre, metric, value, 'all' AS win FROM melted
UNION ALL
SELECT genre, metric, value, '24m' AS win FROM melted WHERE is_recent;

CREATE TABLE mart_market_hist AS
WITH binned AS (
    SELECT metric, genre, win,
        -- price is bounded and clusters at price points -> linear $2.50 bins;
        -- the heavy-tailed metrics (revenue/reviews/owners) stay on half-decade log bins.
        CASE WHEN metric = 'price'
             THEN CAST(floor(value / 2.5) AS INTEGER)
             ELSE CAST(floor(log10(GREATEST(value, 1)) * 2) AS INTEGER) END AS bkt
    FROM _mkt_obs
)
SELECT metric, genre, win, bkt AS bucket_index,
    CASE WHEN metric = 'price' THEN bkt * 2.5 ELSE pow(10, bkt / 2.0) END AS x_min,
    CASE WHEN metric = 'price' THEN (bkt + 1) * 2.5 ELSE pow(10, (bkt + 1) / 2.0) END AS x_max,
    COUNT(*) AS count
FROM binned
GROUP BY metric, genre, win, bkt;

CREATE TABLE mart_market_pct AS
WITH wide AS (
    SELECT metric, genre, win,
        COUNT(*) AS n,
        quantile_cont(value, 0.10) AS p10,
        quantile_cont(value, 0.25) AS p25,
        quantile_cont(value, 0.50) AS p50,
        quantile_cont(value, 0.75) AS p75,
        quantile_cont(value, 0.90) AS p90,
        quantile_cont(value, 0.95) AS p95,
        quantile_cont(value, 0.99) AS p99
    FROM _mkt_obs
    GROUP BY metric, genre, win
)
SELECT metric, genre, win, n, pctile, value
FROM wide
UNPIVOT (value FOR pctile IN (p10, p25, p50, p75, p90, p95, p99));

CREATE TABLE mart_market_tiers AS
WITH o AS (
    SELECT owners_mid,
        CASE WHEN owners_mid < 2000 THEN 'Below Hobby'
             WHEN owners_mid < 20000 THEN 'Hobby'
             WHEN owners_mid < 200000 THEN 'Small'
             WHEN owners_mid < 1000000 THEN 'Middle'
             ELSE 'Triple-I' END AS tier
    FROM stg_game
    WHERE owners_mid IS NOT NULL AND owners_mid > 0
)
SELECT tier,
    CASE tier WHEN 'Below Hobby' THEN 0 WHEN 'Hobby' THEN 1 WHEN 'Small' THEN 2
              WHEN 'Middle' THEN 3 ELSE 4 END AS tier_order,
    COUNT(*) AS count,
    COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS pct
FROM o
GROUP BY tier;

-- Materialized straight from stg_genre_boxleiter (build_marts.py's create_staging()) --
-- NOT recomputed here. That table is deliberately built pre-owners-floor, over real
-- SteamSpy owners_mid observations only: some games now get owners_mid/est_rev_owners
-- floor-estimated from total_reviews x this very multiplier (see stg_game), and feeding
-- those manufactured rows back into this regression would partly fit it to itself. Same
-- population/formula as before this reconciliation shipped (stg_genre_membership joined
-- to games with total_reviews >= @MIN_REVIEWS_DEFAULT@ and owners_mid > 0), just with
-- total_reviews now reconciled against the actual `reviews` table -- see stg_game.
CREATE TABLE mart_market_boxleiter AS
SELECT genre, n, owners_per_review_median, owners_per_review_p25, owners_per_review_p75,
    slope, intercept
FROM stg_genre_boxleiter;
