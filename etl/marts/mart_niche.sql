-- mart_niche.sql
-- Builds the niche/opportunity marts from staging tables (stg_game, stg_tag_membership,
-- stg_genre_membership) which build_marts.py creates first.
--   mart_niche       one row per (dimension, key, win, min_reviews) with opportunity score
--   mart_niche_top   top-N representative games per (dimension, key)
--   mart_niche_hist  revenue histogram per (dimension, key)   [window=all, min_reviews floor]
--   mart_niche_trend release counts per (dimension, key, year) -> saturation trend
-- Placeholder tokens are substituted by build_marts.py before execution.

DROP TABLE IF EXISTS mart_niche;
DROP TABLE IF EXISTS mart_niche_top;
DROP TABLE IF EXISTS mart_niche_hist;
DROP TABLE IF EXISTS mart_niche_trend;

CREATE TABLE mart_niche AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
mr AS ( SELECT * FROM (VALUES @MR_VALUES@) AS t(min_reviews) ),
wins AS ( SELECT * FROM (VALUES ('all'),('24m')) AS t(win) ),
pop AS (
    SELECT
        m.dimension, m.key, w.win, mr.min_reviews,
        g.appid, g.est_rev_reviews, g.total_reviews, g.price_initial,
        g.positive_ratio, g.owners_mid, g.self_published,
        (g.release_valid AND g.release_date >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH) AS is_recent
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    CROSS JOIN wins w
    CROSS JOIN mr
    WHERE g.total_reviews >= mr.min_reviews
      AND g.est_rev_reviews IS NOT NULL
      AND (
            w.win = 'all'
            OR (g.release_valid AND g.release_date >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH)
          )
),
ranked AS (
    SELECT *,
        percent_rank() OVER (PARTITION BY dimension, key, win, min_reviews
                             ORDER BY est_rev_reviews) AS rev_pr
    FROM pop
),
agg AS (
    SELECT
        dimension, key, win, min_reviews,
        COUNT(*) AS n_games,
        COUNT(*) FILTER (WHERE is_recent) AS n_recent,
        median(est_rev_reviews) AS median_rev,
        quantile_cont(est_rev_reviews, 0.25) AS p25_rev,
        quantile_cont(est_rev_reviews, 0.75) AS p75_rev,
        median(total_reviews) AS median_reviews,
        quantile_cont(total_reviews, 0.25) AS p25_reviews,
        quantile_cont(total_reviews, 0.75) AS p75_reviews,
        median(price_initial) AS median_price,
        quantile_cont(price_initial, 0.25) AS p25_price,
        quantile_cont(price_initial, 0.75) AS p75_price,
        median(positive_ratio) AS median_positive_ratio,
        median(owners_mid) AS median_owners,
        median(total_reviews) FILTER (WHERE is_recent) AS recent_velocity,
        AVG(CAST(self_published AS DOUBLE)) AS self_pub_share,
        SUM(est_rev_reviews) FILTER (WHERE rev_pr >= @WINNER_TOP_PCT@)
            / NULLIF(SUM(est_rev_reviews), 0) AS winner_concentration,
        AVG(CASE WHEN est_rev_reviews > 200000 THEN 1.0 ELSE 0.0 END) AS hit_rate_200k,
        AVG(CASE WHEN est_rev_reviews > 500000 THEN 1.0 ELSE 0.0 END) AS hit_rate_500k,
        AVG(CASE WHEN positive_ratio IS NULL OR positive_ratio < @BEATABLE_RATIO_BAR@
                      OR total_reviews < @THIN_REVIEWS_BAR@ THEN 1.0 ELSE 0.0 END) AS beatable_share
    FROM ranked
    GROUP BY dimension, key, win, min_reviews
    HAVING COUNT(*) >= @MIN_NICHE_GAMES@
),
sat AS (
    SELECT m.dimension, m.key,
        COUNT(*) FILTER (WHERE g.release_year = @RECENT_YEAR@) AS n_recent_year,
        COUNT(*) FILTER (WHERE g.release_year = @PRIOR_YEAR@) AS n_prior_year
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.release_year IS NOT NULL AND g.release_year <= @CUR_YEAR@
    GROUP BY m.dimension, m.key
),
opp AS (
    SELECT *,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY median_rev) AS pr_rev,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(median_owners,0)) AS pr_own,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(recent_velocity,0)) AS pr_vel,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY n_recent) AS pr_nrec,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(winner_concentration,0)) AS pr_wc,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY beatable_share) AS pr_beatable
    FROM agg
),
final AS (
    SELECT *,
        (0.4 * pr_rev + 0.3 * pr_own + 0.3 * pr_vel) AS demand,
        (0.6 * pr_nrec + 0.4 * pr_wc) AS competition,
        pr_beatable AS quality_gap
    FROM opp
)
SELECT
    f.dimension, f.key, f.win, f.min_reviews,
    f.n_games, f.n_recent,
    f.median_rev, f.p25_rev, f.p75_rev,
    f.median_reviews, f.p25_reviews, f.p75_reviews,
    f.median_price, f.p25_price, f.p75_price,
    f.median_positive_ratio,
    f.median_owners,
    COALESCE(f.recent_velocity, 0) AS recent_velocity,
    f.self_pub_share,
    f.winner_concentration,
    f.hit_rate_200k, f.hit_rate_500k,
    f.beatable_share,
    CASE WHEN s.n_prior_year > 0
         THEN (s.n_recent_year - s.n_prior_year) * 1.0 / s.n_prior_year
         ELSE NULL END AS saturation_yoy,
    s.n_recent_year, s.n_prior_year,
    round(f.demand, 2) AS demand,
    round(f.competition, 2) AS competition,
    round(f.quality_gap, 2) AS quality_gap,
    round(GREATEST(0, LEAST(100,
        @W_DEMAND@ * f.demand - @W_COMPETITION@ * f.competition + @W_QUALITY@ * f.quality_gap)), 2) AS opportunity
FROM final f
LEFT JOIN sat s ON s.dimension = f.dimension AND s.key = f.key;

CREATE TABLE mart_niche_top AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
scoped AS (
    SELECT m.dimension, m.key, g.appid, g.name, g.release_year,
        g.price_initial, g.owners_mid, g.total_reviews, g.positive_ratio,
        g.review_count_source,
        g.est_rev_reviews, g.self_published,
        row_number() OVER (PARTITION BY m.dimension, m.key ORDER BY g.est_rev_reviews DESC) AS rank_in_niche
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
    QUALIFY rank_in_niche <= @TOP_GAMES_PER_NICHE@
)
SELECT s.dimension, s.key, s.rank_in_niche, s.appid, s.name, s.release_year,
    s.price_initial, s.owners_mid, s.total_reviews, s.positive_ratio, s.review_count_source,
    s.est_rev_reviews, s.self_published, gh.header_image
FROM scoped s
LEFT JOIN src.games gh ON gh.appid = s.appid;

CREATE TABLE mart_niche_hist AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
scoped AS (
    SELECT m.dimension, m.key, g.est_rev_reviews AS v
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
),
counts AS ( SELECT dimension, key, COUNT(*) n FROM scoped GROUP BY 1,2 HAVING COUNT(*) >= @MIN_NICHE_GAMES@ ),
bucketed AS (
    SELECT s.dimension, s.key,
        CAST(floor(log10(GREATEST(s.v, 1)) * 2) AS INTEGER) AS bkt
    FROM scoped s
    JOIN counts c ON c.dimension = s.dimension AND c.key = s.key
)
SELECT dimension, key, bkt AS bucket_index,
    pow(10, bkt / 2.0) AS x_min,
    pow(10, (bkt + 1) / 2.0) AS x_max,
    COUNT(*) AS count
FROM bucketed
GROUP BY dimension, key, bkt;

CREATE TABLE mart_niche_trend AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
counts AS ( SELECT dimension, key, COUNT(*) n FROM membership GROUP BY 1,2 HAVING COUNT(*) >= @MIN_NICHE_GAMES@ )
SELECT m.dimension, m.key, g.release_year AS year,
    COUNT(*) AS n_releases,
    COUNT(*) FILTER (WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@) AS n_scored,
    median(g.est_rev_reviews) FILTER (WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@) AS median_rev
FROM membership m
JOIN stg_game g ON g.appid = m.appid
JOIN counts c ON c.dimension = m.dimension AND c.key = m.key
WHERE g.release_year IS NOT NULL
  AND g.release_year BETWEEN @TREND_START_YEAR@ AND @CUR_YEAR@
GROUP BY m.dimension, m.key, g.release_year;
