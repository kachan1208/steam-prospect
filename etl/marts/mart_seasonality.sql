-- mart_seasonality.sql
-- Release timing outcomes. One tall table with a `grain` discriminator so the API can
-- serve the month x weekday heatmap, the monthly/weekday marginals, and the yearly trend.
--   grain in {month_weekday, month, weekday, year}
--   weekday: 0=Sunday .. 6=Saturday (DuckDB dayofweek); month: 1..12
--   genre '__all__' = whole catalog, plus per-genre for genres above the size floor.
-- n_releases counts ALL released games (supply); medians are over games with >= review floor.
-- Dates are FIRST-PUBLIC dates (stg_game.release_date — an Early Access game counts at its EA
-- launch). A first-public date known only to the MONTH (release_date_source
-- 'first_review_month', the 1st of the first review's month) has a real month and a
-- meaningless weekday, so it is kept out of the two weekday grains (weekday NULL) only.

DROP TABLE IF EXISTS mart_seasonality;

CREATE TEMP TABLE _season_base AS
WITH mkt_genres AS (
    SELECT gm.genre
    FROM stg_genre_membership gm
    JOIN stg_game g ON g.appid = gm.appid
    WHERE g.release_valid
    GROUP BY gm.genre
    HAVING COUNT(*) >= @MARKET_MIN_GENRE_GAMES@
)
SELECT '__all__' AS genre, g.release_year AS year, month(g.release_date) AS month,
       CASE WHEN g.release_date_source IS DISTINCT FROM 'first_review_month'
            THEN dayofweek(g.release_date) END AS weekday,
       g.est_rev_reviews, g.total_reviews, g.positive_ratio
FROM stg_game g WHERE g.release_valid
UNION ALL
SELECT gm.genre, s.release_year, month(s.release_date),
       CASE WHEN s.release_date_source IS DISTINCT FROM 'first_review_month'
            THEN dayofweek(s.release_date) END,
       s.est_rev_reviews, s.total_reviews, s.positive_ratio
FROM stg_genre_membership gm
JOIN stg_game s ON s.appid = gm.appid
JOIN mkt_genres mg ON mg.genre = gm.genre
WHERE s.release_valid;

CREATE TABLE mart_seasonality AS
SELECT 'month_weekday' AS grain, genre,
       CAST(NULL AS INTEGER) AS year, month, weekday,
       COUNT(*) AS n_releases,
       COUNT(*) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@) AS n_scored,
       median(est_rev_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@) AS median_rev,
       median(total_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@) AS median_reviews,
       median(positive_ratio) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@) AS median_positive_ratio
FROM _season_base
WHERE year BETWEEN @SEASON_START_YEAR@ AND @CUR_YEAR@ AND weekday IS NOT NULL
GROUP BY genre, month, weekday

UNION ALL
SELECT 'month' AS grain, genre, CAST(NULL AS INTEGER), month, CAST(NULL AS INTEGER),
       COUNT(*), COUNT(*) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(est_rev_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(total_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(positive_ratio) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@)
FROM _season_base
WHERE year BETWEEN @SEASON_START_YEAR@ AND @CUR_YEAR@
GROUP BY genre, month

UNION ALL
SELECT 'weekday' AS grain, genre, CAST(NULL AS INTEGER), CAST(NULL AS INTEGER), weekday,
       COUNT(*), COUNT(*) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(est_rev_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(total_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(positive_ratio) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@)
FROM _season_base
WHERE year BETWEEN @SEASON_START_YEAR@ AND @CUR_YEAR@ AND weekday IS NOT NULL
GROUP BY genre, weekday

UNION ALL
SELECT 'year' AS grain, genre, year, CAST(NULL AS INTEGER), CAST(NULL AS INTEGER),
       COUNT(*), COUNT(*) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(est_rev_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(total_reviews) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@),
       median(positive_ratio) FILTER (WHERE total_reviews >= @MIN_REVIEWS_DEFAULT@)
FROM _season_base
WHERE year BETWEEN @TREND_START_YEAR@ AND @CUR_YEAR@
GROUP BY genre, year;

-- Temp-table hygiene: file-local staging (nothing downstream reads it).
DROP TABLE IF EXISTS _season_base;
