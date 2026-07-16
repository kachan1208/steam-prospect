-- mart_launch_curve.sql
-- Average launch curve: cumulative fraction of a game's first-year reviews landed by
-- day-since-release D, aggregated per genre. Uses staging stg_review_dsr (already limited
-- to games >= 365 days old, reviews with dsr in [0,365]) + stg_genre_membership.
--   grain: (genre, day) with day in {7,14,30,60,90,180,365}
-- NOTE: the reviews table is a per-game sample, so this captures curve SHAPE (fractions),
-- not absolute review counts. Placeholders substituted by build_marts.py.
--
-- Phase 2: the per-appid fraction (`_launch_frac`, previously an inline CTE) is now
-- materialised as a temp table so it can ALSO seed mart_game_launch_curve (one game's own
-- curve, for the Game Profile "vs. genre average" chart) without recomputing it and without
-- changing a single row of mart_launch_curve's output.

DROP TABLE IF EXISTS mart_launch_curve;
DROP TABLE IF EXISTS mart_game_launch_curve;

CREATE TEMP TABLE _launch_frac AS
WITH totals AS (
    SELECT appid, COUNT(*) AS fy_total
    FROM stg_review_dsr
    GROUP BY appid
    HAVING COUNT(*) >= @CURVE_MIN_REVIEWS@
),
days AS ( SELECT * FROM (VALUES (7),(14),(30),(60),(90),(180),(365)) AS d(day) ),
cum AS (
    SELECT r.appid, d.day,
        COUNT(*) FILTER (WHERE r.dsr <= d.day) AS c
    FROM stg_review_dsr r
    JOIN totals t ON t.appid = r.appid
    CROSS JOIN days d
    GROUP BY r.appid, d.day
)
SELECT c.appid, c.day, c.c * 1.0 / t.fy_total AS f, t.fy_total
FROM cum c
JOIN totals t ON t.appid = c.appid;

CREATE TABLE mart_launch_curve AS
WITH frac_genre AS (
    SELECT '__all__' AS genre, appid, day, f FROM _launch_frac
    UNION ALL
    SELECT gm.genre, f.appid, f.day, f.f
    FROM _launch_frac f
    JOIN stg_genre_membership gm ON gm.appid = f.appid
)
SELECT genre, day,
    AVG(f) AS mean_cum_fraction,
    median(f) AS median_cum_fraction,
    COUNT(DISTINCT appid) AS n_games
FROM frac_genre
GROUP BY genre, day
HAVING COUNT(DISTINCT appid) >= @CURVE_MIN_GAMES@;

-- One game's own curve (no genre floor — a single appid is always "enough games").
-- Only present for games >=365 days old with >=@CURVE_MIN_REVIEWS@ sampled first-year
-- reviews (same eligibility as the genre curve above); recent/thin titles have no rows.
CREATE TABLE mart_game_launch_curve AS
SELECT appid, day, f AS cum_fraction, fy_total AS sample_first_year_reviews
FROM _launch_frac
ORDER BY appid, day;
