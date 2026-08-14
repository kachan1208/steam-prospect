-- mart_players.sql
-- Daily live-player (CCU) history and its niche rollup, from stg_player_counts_daily /
-- stg_player_count_latest (create_ccu_staging — guarded: empty typed staging on sources
-- without `player_counts`, so everything here degrades to empty tables, never crashes).
--
-- RUNS FIRST in MART_FILES on purpose: besides its two real tables it creates TEMP summary
-- tables (_game_players_summary, _niche_players_now) that mart_game.sql and mart_niche.sql
-- LEFT JOIN — TEMPs persist across mart files (single connection).
--
--   mart_game_players_daily  one row per (appid, date) with a capture — measured days ONLY;
--                            an absent row means "not measured that day", never zero (same
--                            NULL honesty as mart_game_trends.ccu_avg). `players` is the
--                            LAST capture of the UTC date — a stable ~21-22:00 UTC evening
--                            point sample from the nightly sweep, deliberately NOT a daily
--                            peak (SteamDB-style peaks run higher).
--   mart_niche_players       one row per (dimension, key, date): total_players carries each
--                            game's last capture forward up to @CCU_STALE_DAYS@ days (LOCF)
--                            so the collector's tail rotation (~3-8 nights/cycle) doesn't
--                            read as audience dips; games staler than the cap DROP OUT of
--                            the sum. measured_players / n_games_measured expose the raw
--                            same-day coverage so the carry is always inspectable.
--
-- Coverage model (why LOCF at all): the collector captures a fixed top-8k head nightly and
-- rotates the rest of the >=50-review universe by staleness; the head holds ~99% of all CCU,
-- so daily niche totals are dominated by real same-day measurements and the carry only
-- smooths the tail. The date spine is the set of OBSERVED capture dates — a night the
-- collector didn't run creates no fabricated carried day.
--
-- Population: niche membership = stg_tag_membership/stg_genre_membership restricted to the
-- scored population (total_reviews >= @MIN_REVIEWS_DEFAULT@), i.e. mart_niche's
-- (win='all', min_reviews=@MIN_REVIEWS_DEFAULT@) cut — NOT the narrower top-10-tags
-- membership mart_niche_themes uses. Floors: @MIN_NICHE_GAMES@ scored games (mirrors
-- mart_niche, computed inline — no ordering dependency) AND @NICHE_PLAYERS_MIN_MEASURED@
-- ever-measured games.

DROP TABLE IF EXISTS mart_game_players_daily;
DROP TABLE IF EXISTS mart_niche_players;

-- ---------------------------------------------------------------------------------------
-- Per-game daily series: measured days only, rolling @PLAYERS_HISTORY_DAYS@-day window.
-- ---------------------------------------------------------------------------------------
CREATE TABLE mart_game_players_daily AS
SELECT appid, cap_date AS date, players, n_captures
FROM stg_player_counts_daily
WHERE cap_date >= CURRENT_DATE - INTERVAL @PLAYERS_HISTORY_DAYS@ DAY;

-- Scored games with at least one capture (the niche-rollup panel), and their first
-- measured date (each game's spine starts there — no pre-history rows).
CREATE TEMP TABLE _pl_panel AS
SELECT d.appid, MIN(d.date) AS first_date
FROM mart_game_players_daily d
JOIN stg_game g ON g.appid = d.appid
WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@
GROUP BY d.appid;

-- Date spine = dates the collector actually ran (empty source -> empty spine -> empty marts).
CREATE TEMP TABLE _pl_dates AS
SELECT DISTINCT date FROM mart_game_players_daily;

-- LOCF fill per (panel game, spine date since first capture): carry the last measured value
-- forward, tracking how stale it is; rows staler than @CCU_STALE_DAYS@ are dropped BEFORE
-- the (fan-out) membership join, which bounds the niche aggregate's input.
-- DATE - DATE yields INTEGER days in DuckDB; staleness = 0 on measured days.
CREATE TEMP TABLE _pl_filled AS
SELECT appid, date, measured_players, players_filled
FROM (
    SELECT s.appid, s.date,
        d.players AS measured_players,
        last_value(d.players IGNORE NULLS) OVER w AS players_filled,
        s.date - max(CASE WHEN d.players IS NOT NULL THEN s.date END) OVER w AS staleness
    FROM (SELECT p.appid, dt.date FROM _pl_panel p JOIN _pl_dates dt ON dt.date >= p.first_date) s
    LEFT JOIN mart_game_players_daily d ON d.appid = s.appid AND d.date = s.date
    WINDOW w AS (PARTITION BY s.appid ORDER BY s.date
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
)
WHERE staleness <= @CCU_STALE_DAYS@;

-- ---------------------------------------------------------------------------------------
-- Niche daily series.
-- ---------------------------------------------------------------------------------------
CREATE TABLE mart_niche_players AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
scored_floor AS (
    SELECT m.dimension, m.key
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) >= @MIN_NICHE_GAMES@
),
panel AS (
    SELECT m.dimension, m.key, COUNT(DISTINCT m.appid) AS n_games_panel
    FROM membership m
    JOIN _pl_panel p ON p.appid = m.appid
    GROUP BY 1, 2
    HAVING COUNT(DISTINCT m.appid) >= @NICHE_PLAYERS_MIN_MEASURED@
)
SELECT m.dimension, m.key, f.date,
    CAST(SUM(f.players_filled)   AS BIGINT) AS total_players,     -- LOCF <= @CCU_STALE_DAYS@d
    CAST(SUM(f.measured_players) AS BIGINT) AS measured_players,  -- same-day captures only
    COUNT(f.measured_players) AS n_games_measured,
    COUNT(f.players_filled)   AS n_games_covered,
    MAX(p.n_games_panel)      AS n_games_panel
FROM membership m
JOIN panel p        ON p.dimension = m.dimension AND p.key = m.key
JOIN scored_floor s ON s.dimension = m.dimension AND s.key = m.key
JOIN _pl_filled f   ON f.appid = m.appid
GROUP BY 1, 2, 3;

-- ---------------------------------------------------------------------------------------
-- Per-game trend windows (measured days only — no LOCF at game level) -> TEMP summary
-- joined by mart_game.sql. Trend needs data in BOTH windows; avg_prior > 0 guards div-by-0.
-- ---------------------------------------------------------------------------------------
CREATE TEMP TABLE _pl_game_windows AS
SELECT appid,
    AVG(players) FILTER (WHERE date >  CURRENT_DATE - INTERVAL @PLAYERS_TREND_DAYS@ DAY) AS avg_recent,
    AVG(players) FILTER (WHERE date <= CURRENT_DATE - INTERVAL @PLAYERS_TREND_DAYS@ DAY
                           AND date >  CURRENT_DATE - INTERVAL @PLAYERS_TREND_DAYS_X2@ DAY) AS avg_prior
FROM mart_game_players_daily
GROUP BY appid;

CREATE TEMP TABLE _game_players_summary AS
SELECT appid,
    avg_recent AS players_7d_avg,
    CASE WHEN avg_recent IS NOT NULL AND avg_prior > 0
         THEN 100.0 * (avg_recent - avg_prior) / avg_prior END AS players_trend_7d_pct
FROM _pl_game_windows;

-- ---------------------------------------------------------------------------------------
-- All-sources player history (additive, 2026-08-14). Three measures, one table, a `source`
-- discriminator and a `grain` column — NEVER aggregated across sources:
--   steamcharts_monthly  month-start dates, avg + true monthly peak (back to 2012)
--   steamcharts_daily    daily averages for roughly the trailing 90 days
--   prospect_sample      our own nightly ~21-22:00 UTC point samples (daily grain)
-- External rows come from steamcharts_backfill.py (top-8k-by-reviews only — coverage is
-- deliberately partial; the tail has no external history).
-- ---------------------------------------------------------------------------------------
DROP TABLE IF EXISTS mart_game_players_history;
CREATE TABLE mart_game_players_history AS
SELECT appid, date, source,
    CASE WHEN source = 'steamcharts_monthly' THEN 'monthly' ELSE 'daily' END AS grain,
    avg_players, peak_players
FROM stg_player_history_external
UNION ALL
SELECT appid, cap_date AS date, 'prospect_sample' AS source, 'daily' AS grain,
    CAST(players AS DOUBLE) AS avg_players, NULL AS peak_players
FROM stg_player_counts_daily;

-- Niche audience over the YEARS: monthly summed averages of the niche's scored games,
-- steamcharts_monthly only (our own history is weeks deep; mixing measures is forbidden).
-- Same membership + floors as mart_niche_players. Coverage caveat: external history covers
-- only the top-8k games — totals describe the niche's measured HEAD, not its whole tail.
DROP TABLE IF EXISTS mart_niche_players_monthly;
CREATE TABLE mart_niche_players_monthly AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
scored_floor AS (
    SELECT m.dimension, m.key
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) >= @MIN_NICHE_GAMES@
),
ext_monthly AS (
    SELECT h.appid, h.date AS month, h.avg_players
    FROM stg_player_history_external h
    JOIN stg_game g ON g.appid = h.appid
    WHERE h.source = 'steamcharts_monthly' AND g.total_reviews >= @MIN_REVIEWS_DEFAULT@
)
SELECT m.dimension, m.key, e.month,
    CAST(SUM(e.avg_players) AS BIGINT) AS avg_players_sum,
    COUNT(DISTINCT e.appid) AS n_games_measured
FROM membership m
JOIN scored_floor s ON s.dimension = m.dimension AND s.key = m.key
JOIN ext_monthly e  ON e.appid = m.appid
GROUP BY 1, 2, 3
HAVING COUNT(DISTINCT e.appid) >= @NICHE_PLAYERS_MIN_MEASURED@;

-- ---------------------------------------------------------------------------------------
-- Niche "now" summary -> TEMP joined by mart_niche.sql (stamped on all 4 cut rows of a
-- key, same one-value-per-key convention as entrant_ratio; population = the all/50 cut).
--   total_players_now     sum of each scored member's latest capture, <= @CCU_STALE_DAYS@d old
--   players_coverage      share of total_players_now measured within @CCU_FRESH_DAYS@d
--                         (1.0 = fully fresh; low = mostly carried tail values)
--   players_trend_7d_pct  SAME-PANEL trend: only games measured in BOTH 7d windows count,
--                         so growth in *coverage* can never masquerade as audience growth
-- ---------------------------------------------------------------------------------------
CREATE TEMP TABLE _niche_players_now AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
lat AS (
    SELECT l.appid, l.live_players,
        CURRENT_DATE - CAST(TRY_CAST(l.captured_at AS TIMESTAMP) AS DATE) AS staleness
    FROM stg_player_count_latest l
    JOIN stg_game g ON g.appid = l.appid
    WHERE l.live_players IS NOT NULL AND g.total_reviews >= @MIN_REVIEWS_DEFAULT@
),
now_agg AS (
    SELECT m.dimension, m.key,
        SUM(CASE WHEN la.staleness <= @CCU_STALE_DAYS@ THEN la.live_players END) AS total_players_now,
        SUM(CASE WHEN la.staleness <= @CCU_FRESH_DAYS@ THEN la.live_players END) AS fresh_players_now
    FROM membership m
    JOIN lat la ON la.appid = m.appid
    GROUP BY 1, 2
),
tr AS (
    SELECT m.dimension, m.key,
        SUM(w.avg_recent) AS sum_recent,
        SUM(w.avg_prior)  AS sum_prior,
        COUNT(*) AS n_games_trend
    FROM membership m
    JOIN _pl_game_windows w ON w.appid = m.appid
    JOIN stg_game g ON g.appid = m.appid
    WHERE w.avg_recent IS NOT NULL AND w.avg_prior IS NOT NULL
      AND g.total_reviews >= @MIN_REVIEWS_DEFAULT@
    GROUP BY 1, 2
)
SELECT n.dimension, n.key,
    CAST(n.total_players_now AS BIGINT) AS total_players_now,
    n.fresh_players_now * 1.0 / NULLIF(n.total_players_now, 0) AS players_coverage,
    CASE WHEN t.sum_prior > 0 AND t.n_games_trend >= @NICHE_PLAYERS_MIN_MEASURED@
         THEN 100.0 * (t.sum_recent - t.sum_prior) / t.sum_prior END AS players_trend_7d_pct,
    t.n_games_trend
FROM now_agg n
LEFT JOIN tr t ON t.dimension = n.dimension AND t.key = n.key;
