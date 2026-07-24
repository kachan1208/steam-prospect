-- mart_game_trends.sql
-- Per-(appid, month) momentum time series: the signals Prospect collects, bucketed into a
-- single monthly grain so a game's trajectory (review velocity, live players, Twitch reach,
-- creator mentions) can be charted over time. Powers GET /api/games/{appid}/trends.
--
-- Columns (grain = one row per appid per 'YYYY-MM' that has ANY signal):
--   n_reviews       reviews created that month. Sourced from src.review_histogram (Steam's
--                    store review-graph: full-history monthly up+down counts, uncapped) when
--                    the game has been backfilled — the TRUE review velocity over the game's
--                    whole life. Falls back per-appid to bucketing src.reviews.timestamp_created
--                    (the recency-biased ~2k-per-side SAMPLE — see build_marts.py's stg_review
--                    note) only for appids not yet in review_histogram.
--   ccu_avg         average live concurrent players that month from src.player_counts
--                    (GetNumberOfCurrentPlayers snapshots). Left NULL when no snapshot landed
--                    that month — a gauge we did not measure, NOT zero players (0 would draw a
--                    false floor on the line).
--   twitch_viewers  SUM(reach_at_time) of that month's Twitch creator mentions — identical
--                    definition to mart_game.twitch_viewers (the viewer count when each
--                    streamer was seen on the game). See the creator_reach_snapshot note below.
--   n_mentions      count of src.game_creator_mention rows dated that month (any platform),
--                    bucketed on published_at.
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
-- WHY NOT creator_reach_snapshot for twitch_viewers: creator_reach_snapshot(creator_id,
-- platform, captured_at, reach) has NO appid, so it cannot be attributed to a game per month
-- without cross-joining a creator's ENTIRE reach history onto every game they ever mentioned
-- (which would smear one mention across unrelated months). game_creator_mention.reach_at_time
-- is the correct per-(appid, month) figure — the reach captured AT the moment of a mention
-- that is itself tied to a specific appid and published_at — and is exactly what the app's
-- canonical mart_game.twitch_viewers already uses. Standalone SQL (no template placeholders), so
-- this file runs against `src` alone for testing.

DROP TABLE IF EXISTS mart_game_trends;

CREATE TABLE mart_game_trends AS
WITH hist AS (
    -- Full-history monthly review counts from Steam's store review graph
    -- (src.review_histogram, filled by the scraper's `review-histogram` command).
    -- up+down = reviews created that month across the game's whole life — the
    -- true review velocity, uncapped, no recency bias.
    SELECT rh.appid,
        rh.period AS period,
        SUM(COALESCE(rh.recommendations_up, 0) + COALESCE(rh.recommendations_down, 0)) AS n_reviews
    FROM src.review_histogram rh
    WHERE rh.period IS NOT NULL
    GROUP BY 1, 2
),
sample_rev AS (
    -- Per-appid fallback for games NOT yet backfilled into review_histogram:
    -- bucket the recency-biased ~2k-per-side `reviews` sample by timestamp. Kept
    -- so nothing regresses before the histogram backfill reaches the long tail.
    SELECT r.appid,
        strftime(date_trunc('month', make_timestamp(r.timestamp_created * 1000000)), '%Y-%m') AS period,
        COUNT(*) AS n_reviews
    FROM src.reviews r
    WHERE r.timestamp_created IS NOT NULL
      AND r.appid NOT IN (SELECT DISTINCT appid FROM src.review_histogram)
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
    SELECT pc.appid,
        strftime(date_trunc('month', TRY_CAST(pc.captured_at AS TIMESTAMP)), '%Y-%m') AS period,
        AVG(pc.player_count) AS ccu_avg
    FROM src.player_counts pc
    WHERE TRY_CAST(pc.captured_at AS TIMESTAMP) IS NOT NULL
    GROUP BY 1, 2
),
twitch AS (
    SELECT m.appid,
        strftime(date_trunc('month', TRY_CAST(m.published_at AS TIMESTAMP)), '%Y-%m') AS period,
        SUM(COALESCE(m.reach_at_time, 0)) AS twitch_viewers
    FROM src.game_creator_mention m
    WHERE m.platform = 'twitch'
      AND TRY_CAST(m.published_at AS TIMESTAMP) IS NOT NULL
    GROUP BY 1, 2
),
mentions AS (
    SELECT m.appid,
        strftime(date_trunc('month', TRY_CAST(m.published_at AS TIMESTAMP)), '%Y-%m') AS period,
        COUNT(*) AS n_mentions
    FROM src.game_creator_mention m
    WHERE TRY_CAST(m.published_at AS TIMESTAMP) IS NOT NULL
    GROUP BY 1, 2
),
spine AS (
    SELECT appid, period FROM rev
    UNION
    SELECT appid, period FROM ccu
    UNION
    SELECT appid, period FROM twitch
    UNION
    SELECT appid, period FROM mentions
)
SELECT
    s.appid,
    s.period,
    COALESCE(rev.n_reviews, 0)                 AS n_reviews,
    ccu.ccu_avg                                AS ccu_avg,   -- NULL when unmeasured (not 0)
    CAST(COALESCE(twitch.twitch_viewers, 0) AS BIGINT) AS twitch_viewers,
    COALESCE(mentions.n_mentions, 0)           AS n_mentions
FROM spine s
JOIN elig e            ON e.appid = s.appid
LEFT JOIN rev          ON rev.appid = s.appid      AND rev.period = s.period
LEFT JOIN ccu          ON ccu.appid = s.appid      AND ccu.period = s.period
LEFT JOIN twitch       ON twitch.appid = s.appid   AND twitch.period = s.period
LEFT JOIN mentions     ON mentions.appid = s.appid AND mentions.period = s.period
WHERE s.period IS NOT NULL
ORDER BY s.appid, s.period;
