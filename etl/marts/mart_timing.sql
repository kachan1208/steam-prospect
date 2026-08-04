-- mart_timing.sql
-- Launch & Timing rework: three marts over the TRUE uncapped monthly review counts in
-- stg_review_histogram (Steam's own per-month review-graph totals, ~40K games — see
-- create_timing_staging in build_marts.py; empty staging on older sources builds empty
-- marts). These replace the old "median revenue by launch month" read, which was
-- composition-confounded (a high-median month reflects WHAT KIND of game launches then,
-- not the calendar). Additive: mart_seasonality / mart_launch_curve stay for their
-- existing consumers.
--
--   mart_timing_demand      (genre incl '__all__', calendar month 1-12): share of the
--                           genre's pooled monthly review velocity landing in that
--                           calendar month — WHEN PLAYERS ACTUALLY BUY. Each game's first
--                           @TIMING_LAUNCH_EXCLUDE_MONTHS@ calendar months since release
--                           are EXCLUDED (documented choice: launch spikes cluster
--                           wherever the genre's releases cluster, so without the
--                           exclusion a popular launch window would masquerade as
--                           seasonal demand by construction — what survives is
--                           post-launch/catalog buying). Pooled across games and years
--                           over the last @TIMING_DEMAND_YEARS@ COMPLETE calendar years
--                           (a partial year would overweight the months it has already
--                           lived through). Pooled = review-volume-weighted: big games
--                           count more, deliberately — this is genre demand, not the
--                           median game's seasonality.
--   mart_timing_congestion  (genre, calendar month): average number of releases (and of
--                           BIG releases, est_rev_reviews >= @TIMING_BIG_REV@) landing in
--                           that month over the last @TIMING_CONGESTION_YEARS@ complete
--                           years — HOW CROWDED each launch window is. Demand high +
--                           congestion low = good window.
--   mart_timing_decay       (genre, month_since_release 0-@TIMING_DECAY_LAST@): median
--                           share of a game's first-24-months review total landing in
--                           that month — HOW LONG A LAUNCH PAYS OUT. Per-game normalize
--                           FIRST, then median across games, so big games don't dominate
--                           the curve. Only games whose full 24-month window is complete
--                           in the data and whose 24-month total clears
--                           @TIMING_DECAY_MIN_REVIEWS@ reviews enter; a game's missing
--                           histogram months count as 0-share months (the honest read).
--
-- Caveats baked into every consumer: reviews proxy sales (Boxleiter); all of this is
-- correlational; congestion is genre-wide, not niche-level.

DROP TABLE IF EXISTS mart_timing_demand;
DROP TABLE IF EXISTS mart_timing_congestion;
DROP TABLE IF EXISTS mart_timing_decay;

-- Histogram rows joined to release dates once; month_since_release in whole calendar
-- months (both sides truncated to month start, so datediff counts exact months).
-- Negative rows (histogram months before the recorded release month — EA date fixups,
-- playtest reviews) exist and are excluded by every consumer below.
CREATE TEMP TABLE _timing_hist AS
SELECT h.appid, h.period_month, h.n_reviews,
    datediff('month', date_trunc('month', g.release_date), h.period_month) AS month_since_release
FROM stg_review_histogram h
JOIN stg_game g ON g.appid = h.appid
WHERE g.release_valid;

-- ---------------------------------------------------------------------------------------
-- Demand: when players in a genre actually buy.
-- ---------------------------------------------------------------------------------------
CREATE TEMP TABLE _timing_demand_base AS
SELECT genre, month(period_month) AS month, appid, n_reviews
FROM (
    SELECT '__all__' AS genre, t.* FROM _timing_hist t
    UNION ALL
    SELECT gm.genre, t.*
    FROM _timing_hist t
    JOIN stg_genre_membership gm ON gm.appid = t.appid
)
WHERE month_since_release >= @TIMING_LAUNCH_EXCLUDE_MONTHS@   -- also drops pre-release rows
  AND year(period_month) BETWEEN @CUR_YEAR@ - @TIMING_DEMAND_YEARS@ AND @CUR_YEAR@ - 1;

CREATE TABLE mart_timing_demand AS
WITH cell AS (
    SELECT genre, month,
        SUM(n_reviews) AS month_reviews,
        COUNT(DISTINCT appid) AS n_games
    FROM _timing_demand_base
    GROUP BY genre, month
),
tot AS (
    SELECT genre, SUM(month_reviews) AS genre_reviews
    FROM cell GROUP BY genre
),
pop AS (
    SELECT genre, COUNT(DISTINCT appid) AS n_games_genre
    FROM _timing_demand_base GROUP BY genre
)
SELECT c.genre, c.month,
    CASE WHEN t.genre_reviews > 0
         THEN c.month_reviews * 1.0 / t.genre_reviews END AS demand_share,
    c.month_reviews,
    c.n_games,
    p.n_games_genre
FROM cell c
JOIN tot t ON t.genre = c.genre
JOIN pop p ON p.genre = c.genre
WHERE p.n_games_genre >= @TIMING_DEMAND_MIN_GAMES@ OR c.genre = '__all__';

-- ---------------------------------------------------------------------------------------
-- Congestion: how crowded each launch window is. Fixed-denominator average (SUM / N
-- years) so a (genre, month, year) with zero releases counts as zero, not a missing row.
-- ---------------------------------------------------------------------------------------
CREATE TABLE mart_timing_congestion AS
WITH mkt_genres AS (
    -- same per-genre size floor as mart_seasonality: congestion is a supply read, so the
    -- floor is on released games, not histogram coverage
    SELECT gm.genre
    FROM stg_genre_membership gm
    JOIN stg_game g ON g.appid = gm.appid
    WHERE g.release_valid
    GROUP BY gm.genre
    HAVING COUNT(*) >= @MARKET_MIN_GENRE_GAMES@
),
rel AS (
    SELECT '__all__' AS genre, g.release_date, g.release_year, g.est_rev_reviews
    FROM stg_game g WHERE g.release_valid
    UNION ALL
    SELECT gm.genre, g.release_date, g.release_year, g.est_rev_reviews
    FROM stg_genre_membership gm
    JOIN stg_game g ON g.appid = gm.appid
    JOIN mkt_genres mg ON mg.genre = gm.genre
    WHERE g.release_valid
)
SELECT genre, month(release_date) AS month,
    COUNT(*) * 1.0 / @TIMING_CONGESTION_YEARS@ AS avg_releases,
    COUNT(*) FILTER (WHERE est_rev_reviews >= @TIMING_BIG_REV@) * 1.0
        / @TIMING_CONGESTION_YEARS@ AS avg_big_releases,
    @TIMING_CONGESTION_YEARS@ AS n_years
FROM rel
WHERE release_year BETWEEN @CUR_YEAR@ - @TIMING_CONGESTION_YEARS@ AND @CUR_YEAR@ - 1
GROUP BY genre, month(release_date);

-- ---------------------------------------------------------------------------------------
-- Payout decay: median share of a game's first-24-months reviews landing in each month
-- since release. Eligibility: full 24-month window complete in the data (the histogram's
-- max month is treated as partial and excluded from "complete") + the coverage floor.
-- ---------------------------------------------------------------------------------------
CREATE TEMP TABLE _timing_decay_pergame AS
WITH last_complete AS (
    SELECT date_trunc('month', MAX(period_month)) - INTERVAL 1 MONTH AS m
    FROM stg_review_histogram
),
totals AS (
    SELECT h.appid, SUM(h.n_reviews) AS total_24m
    FROM _timing_hist h
    JOIN stg_game g ON g.appid = h.appid
    CROSS JOIN last_complete lc
    WHERE h.month_since_release BETWEEN 0 AND @TIMING_DECAY_LAST@
      AND date_trunc('month', g.release_date) + INTERVAL @TIMING_DECAY_LAST@ MONTH <= lc.m
    GROUP BY h.appid
    HAVING SUM(h.n_reviews) >= @TIMING_DECAY_MIN_REVIEWS@
),
months AS (SELECT * FROM range(0, @TIMING_DECAY_MONTHS@) r(month_since_release))
SELECT t.appid, m.month_since_release,
    COALESCE(h.n_reviews, 0) * 1.0 / t.total_24m AS share
FROM totals t
CROSS JOIN months m
LEFT JOIN _timing_hist h
    ON h.appid = t.appid AND h.month_since_release = m.month_since_release;

CREATE TABLE mart_timing_decay AS
WITH gg AS (
    SELECT '__all__' AS genre, p.* FROM _timing_decay_pergame p
    UNION ALL
    SELECT gm.genre, p.*
    FROM _timing_decay_pergame p
    JOIN stg_genre_membership gm ON gm.appid = p.appid
)
SELECT genre, month_since_release,
    median(share) AS median_share,
    AVG(share) AS mean_share,
    COUNT(DISTINCT appid) AS n_games
FROM gg
GROUP BY genre, month_since_release
HAVING COUNT(DISTINCT appid) >= @TIMING_DECAY_MIN_GAMES@ OR genre = '__all__';
