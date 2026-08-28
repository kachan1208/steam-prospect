-- mart_game_trends.sql
-- Per-(appid, month) momentum time series: the signals Prospect collects, bucketed into a
-- single monthly grain so a game's trajectory (review velocity, live players reach,
-- ) can be charted over time. Powers GET /api/games/{appid}/trends.
--
-- Columns (grain = one row per appid per 'YYYY-MM' that has ANY signal):
--   n_reviews       reviews created that month. Sourced from stg_review_histogram (Steam's
--                    store review-graph: full-history monthly up+down counts, uncapped) when
--                    the game has been backfilled — the TRUE review velocity over the game's
--                    whole life. Falls back per-appid to bucketing src.reviews.timestamp_created
--                    (the recency-biased ~2k-per-side SAMPLE — see build_marts.py's stg_review
--                    note) only for appids not yet in review_histogram.
--   ccu_avg         average live concurrent players that month from stg_player_counts_daily
--                    (GetNumberOfCurrentPlayers snapshots). Left NULL when no snapshot landed
--                    that month — a gauge we did not measure, NOT zero players (0 would draw a
--                    false floor on the line).
--
-- GUARDED SOURCES (fixed 2026-08): this file used to read src.review_histogram and
-- src.player_counts DIRECTLY, which defeated the whole point of create_timing_staging() /
-- create_ccu_staging() — on a source DB without those (optional, independently rolled-out)
-- tables the build CRASHED with a Catalog Error instead of degrading. It now reads the
-- guarded staging tables, which are empty-but-correctly-typed when the source table is
-- absent: n_reviews then falls back to the reviews sample for every game (exactly the
-- documented fallback above) and ccu_avg is uniformly NULL.
--
-- Population: appids that are BOTH in mart_game AND have >= 1 review (the review requirement
-- bounds table size — most of the ~142K catalog has no reviews). mart_game.sql runs first in
-- build_marts.py's MART_FILES, so mart_game exists when this file runs.
--
-- Robust to thin data: the period spine is the UNION of month-keys from all four sources, so a
-- month that has (say) only a CCU snapshot but no reviews still yields a row; every metric is
-- LEFT-JOINed onto that spine, COALESCE 0 for the count/sum metrics (a real "none observed"),
-- NULL preserved for ccu_avg (see above).
--
-- Creator/twitch columns removed 2026-08-25 with the creator vertical.

DROP TABLE IF EXISTS mart_game_trends;

CREATE TABLE mart_game_trends AS
WITH hist AS (
    -- Full-history monthly review counts from Steam's store review graph
    -- (stg_review_histogram, guarded staging over src.review_histogram — filled by the
    -- scraper's `review-histogram` command). n_reviews there is already up+down =
    -- reviews created that month across the game's whole life — the true review
    -- velocity, uncapped, no recency bias. period_month is a DATE; formatted back to
    -- the 'YYYY-MM' period key this mart is grained on.
    SELECT rh.appid,
        strftime(rh.period_month, '%Y-%m') AS period,
        SUM(rh.n_reviews) AS n_reviews
    FROM stg_review_histogram rh
    WHERE rh.period_month IS NOT NULL
    GROUP BY 1, 2
),
sample_rev AS (
    -- Per-appid fallback for games NOT yet backfilled into review_histogram:
    -- bucket the recency-biased ~2k-per-side `reviews` sample by timestamp. Kept
    -- so nothing regresses before the histogram backfill reaches the long tail.
    -- (When review_histogram is absent entirely, staging is empty and this covers
    -- every game — the documented degraded mode.)
    SELECT r.appid,
        strftime(date_trunc('month', make_timestamp(r.timestamp_created * 1000000)), '%Y-%m') AS period,
        COUNT(*) AS n_reviews
    FROM src.reviews r
    WHERE r.timestamp_created IS NOT NULL
      AND r.appid NOT IN (SELECT DISTINCT appid FROM stg_review_histogram)
    GROUP BY 1, 2
),
rev AS (
    SELECT appid, period, n_reviews FROM hist
    UNION ALL
    SELECT appid, period, n_reviews FROM sample_rev
),
elig AS (
    -- Appids in mart_game that have at least some reviews (bounds table size).
    SELECT DISTINCT rev.appid
    FROM rev
    JOIN mart_game mg ON mg.appid = rev.appid
),
ccu AS (
    -- Monthly mean of the DAILY point samples (stg_player_counts_daily = the last capture
    -- of each UTC day, the same panel mart_players.sql charts) rather than a mean over
    -- every raw snapshot. Identical for the ~1-capture-per-night norm, and on the rare
    -- multi-capture day it now agrees with the players marts instead of weighting that
    -- day extra.
    SELECT pc.appid,
        strftime(date_trunc('month', pc.cap_date), '%Y-%m') AS period,
        AVG(pc.players) AS ccu_avg
    FROM stg_player_counts_daily pc
    WHERE pc.cap_date IS NOT NULL
    GROUP BY 1, 2
),
spine AS (
    SELECT appid, period FROM rev
    UNION
    SELECT appid, period FROM ccu

)
SELECT
    s.appid,
    s.period,
    COALESCE(rev.n_reviews, 0)                 AS n_reviews,
    ccu.ccu_avg                                AS ccu_avg    -- NULL when unmeasured (not 0)
FROM spine s
JOIN elig e            ON e.appid = s.appid
LEFT JOIN rev          ON rev.appid = s.appid      AND rev.period = s.period
LEFT JOIN ccu          ON ccu.appid = s.appid      AND ccu.period = s.period
WHERE s.period IS NOT NULL
ORDER BY s.appid, s.period;
