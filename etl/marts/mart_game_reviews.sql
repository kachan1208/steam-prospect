-- mart_game_reviews.sql
-- Per-appid review time-series/breakdown marts, for games with >= @GAME_DETAIL_MIN_REVIEWS@
-- SAMPLED reviews (stg_review — a per-game sample, not Steam's true review set; counts here
-- describe the sample). Powers GET /api/games/{appid}/reviews-summary.
--   mart_game_reviews_timeline  monthly review volume + a trailing 3-month positive-rating
--                                trajectory (rating-over-time AND review-velocity share one
--                                series). cum_reviews/cum_positive/cum_positive_share are
--                                also kept (all-time running total, e.g. for a future "total
--                                reviews to date" read) but cum_positive_share is NOT charted
--                                any more: an all-time-to-date ratio mathematically converges
--                                as cum_reviews grows, so it always flattens to a plateau and
--                                stops moving for any game with real history (same failure
--                                mode the launch curve had before LaunchShapeBars.tsx replaced
--                                it with a marginal/windowed view — see ReviewsTimelineChart.tsx).
--                                trailing_positive_share is the fix: a bounded trailing window
--                                that can rise AND fall.
--   mart_game_reviews_lang      per-game top languages (localization reference)
--   mart_game_reviews_playtime  playtime-at-review percentile distribution
-- Placeholder tokens are substituted by build_marts.py.

DROP TABLE IF EXISTS mart_game_reviews_timeline;
DROP TABLE IF EXISTS mart_game_reviews_lang;
DROP TABLE IF EXISTS mart_game_reviews_playtime;

CREATE TEMP TABLE _gr_elig AS
SELECT appid, COUNT(*) AS n_sampled
FROM stg_review
GROUP BY appid
HAVING COUNT(*) >= @GAME_DETAIL_MIN_REVIEWS@;

CREATE TABLE mart_game_reviews_timeline AS
WITH monthly AS (
    SELECT r.appid, date_trunc('month', r.review_date) AS period,
        COUNT(*) AS n_reviews,
        SUM(CASE WHEN r.voted_up = 1 THEN 1 ELSE 0 END) AS n_positive
    FROM stg_review r
    JOIN _gr_elig e ON e.appid = r.appid
    WHERE r.review_date IS NOT NULL
    GROUP BY r.appid, date_trunc('month', r.review_date)
),
cum AS (
    SELECT appid, period, n_reviews, n_positive,
        SUM(n_reviews) OVER (PARTITION BY appid ORDER BY period) AS cum_reviews,
        SUM(n_positive) OVER (PARTITION BY appid ORDER BY period) AS cum_positive,
        -- Trailing 3-month window (current period + the 2 before it; fewer at the start
        -- of a game's history, same convention as any trailing window). Unlike the
        -- cumulative columns above, this can go up AND down over time, so a chart of it
        -- actually shows sentiment rise/fall instead of converging to a flat plateau.
        SUM(n_reviews) OVER (PARTITION BY appid ORDER BY period ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS trailing_reviews,
        SUM(n_positive) OVER (PARTITION BY appid ORDER BY period ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS trailing_positive
    FROM monthly
)
SELECT appid, strftime(period, '%Y-%m') AS period, n_reviews, n_positive,
    cum_reviews, cum_positive,
    cum_positive * 1.0 / NULLIF(cum_reviews, 0) AS cum_positive_share,
    trailing_reviews,
    trailing_positive * 1.0 / NULLIF(trailing_reviews, 0) AS trailing_positive_share
FROM cum
ORDER BY appid, period;

CREATE TABLE mart_game_reviews_lang AS
WITH counts AS (
    SELECT r.appid, r.language, COUNT(*) AS n
    FROM stg_review r
    JOIN _gr_elig e ON e.appid = r.appid
    WHERE r.language IS NOT NULL
    GROUP BY r.appid, r.language
),
totals AS ( SELECT appid, SUM(n) AS total FROM counts GROUP BY appid ),
ranked AS (
    SELECT c.appid, c.language, c.n, c.n * 1.0 / t.total AS share,
        row_number() OVER (PARTITION BY c.appid ORDER BY c.n DESC) AS rn
    FROM counts c
    JOIN totals t ON t.appid = c.appid
)
SELECT appid, language, n, share
FROM ranked
WHERE rn <= @LANG_TOP_N@
ORDER BY appid, n DESC;

CREATE TABLE mart_game_reviews_playtime AS
WITH wide AS (
    SELECT r.appid,
        COUNT(*) AS n,
        quantile_cont(r.playtime_at_review, 0.10) AS p10,
        quantile_cont(r.playtime_at_review, 0.25) AS p25,
        quantile_cont(r.playtime_at_review, 0.50) AS p50,
        quantile_cont(r.playtime_at_review, 0.75) AS p75,
        quantile_cont(r.playtime_at_review, 0.90) AS p90
    FROM stg_review r
    JOIN _gr_elig e ON e.appid = r.appid
    WHERE r.playtime_at_review IS NOT NULL AND r.playtime_at_review >= 0
    GROUP BY r.appid
)
SELECT appid, n, pctile, value
FROM wide
UNPIVOT (value FOR pctile IN (p10, p25, p50, p75, p90));
