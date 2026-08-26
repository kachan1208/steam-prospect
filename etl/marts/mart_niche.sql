-- mart_niche.sql
-- Builds the niche/opportunity marts from staging tables (stg_game, stg_tag_membership,
-- stg_genre_membership, stg_singleplayer_tag, tag_tier) which build_marts.py creates first,
-- plus the TEMP _niche_players_now summary created by mart_players.sql (which runs before
-- this file — see MART_FILES ordering).
--   mart_niche       one row per (dimension, key, win, min_reviews) with opportunity score
--   mart_niche_top   top-N representative games per (dimension, key)
--   mart_niche_hist  revenue histogram per (dimension, key)   [window=all, min_reviews floor]
--   mart_niche_trend release counts per (dimension, key, year) -> saturation trend
-- Placeholder tokens are substituted by build_marts.py before execution.
--
-- Niche-score v2 columns (2026-08, additive — every v1 column is unchanged). Motivated by
-- a real user-rejected failure: sorting by raw `opportunity` surfaced Naval/Transportation/
-- Diplomacy (release pipelines shrinking 15-37%/yr — their "low competition" was everyone
-- LEAVING) and 4X/Open World (genre umbrellas, not buildable niches).
--
--   entrant_ratio   (24m median_rev) / (all-time median_rev) for the same (dimension, key,
--                   min_reviews) — the SAME value stamped on both win rows of a key. >1 =
--                   recent entrants outearn the niche's history; <1 = newcomers earn less
--                   than the back catalog did. NULL-safe: NULL when the all-time median is
--                   0/NULL or the 24m cut didn't materialise (under the MIN_NICHE_GAMES
--                   floor). CAVEAT: the catalog-median tag sits at ~1.08 (price inflation +
--                   the review floor filters recent releases harder), so read it against
--                   that norm, not against 1.0.
--   solo_viability  share of the cut's scored games that are playable single-player
--                   (stg_game.is_singleplayer: Steam's own `categories` field, community-
--                   tag fallback — see build_marts.py). Computed PER CUT from that cut's
--                   own population (not copied from the all-population), so the 24m cut
--                   reflects recent entrants. Catalog norm is ~0.9; below ~0.8 signals
--                   meaningful multiplayer dependence.
--   tier            tags only (dimension='genre' rows get 'genre'):
--                   'micro' | 'umbrella' | 'theme' | 'meta'. Curated TAG_TIER map in
--                   build_marts.py; unmapped tags: all-time n_games (win='all',
--                   min_reviews=@MIN_REVIEWS_DEFAULT@ cut) >= @UMBRELLA_N_GAMES@ ->
--                   'umbrella', else 'micro'.
--   decline_gate    the growth gate itself, exposed for inspectability, in
--                   [@GATE_FLOOR@, 1]:
--                     sat_severity     = clamp(-saturation_yoy / @GATE_SAT_FULL_DECLINE@, 0, 1)
--                     entrant_severity = clamp((1 - entrant_ratio) / (1 - @GATE_ENTRANT_FULL@), 0, 1)
--                     gate = 1 - (1 - @GATE_FLOOR@) * GREATEST(sat_severity, entrant_severity)
--                   MAX (OR) semantics on purpose — either decline signal alone cuts the
--                   score, because entrant_ratio >= 1 is the catalog NORM (see above) and
--                   must not excuse a collapsing release pipeline (Naval er~1.5, Fighting
--                   er~3.1 would sail through an AND gate). NULL signals count as "no
--                   evidence of decline" (COALESCE to the neutral value), never as decline.
--   opportunity_v2  opportunity * decline_gate — the growth-gated headline score. The
--                   original `opportunity` is kept unchanged alongside it.
--
-- Live-player columns (2026-08, additive — from mart_players.sql's _niche_players_now;
-- ONE value per (dimension, key), stamped on all 4 cut rows like entrant_ratio; population
-- = the (win='all', min_reviews=@MIN_REVIEWS_DEFAULT@) scored cut):
--   total_players_now     summed current CCU of the niche's scored games (each game's
--                         latest nightly ~21-22:00 UTC point sample, <= 7 days old — NOT
--                         a daily peak). NULL = never measured / mart predates collection.
--   players_trend_7d_pct  same-panel last-7d vs prior-7d change (%): only games measured
--                         in BOTH windows count, so coverage growth can't fake a trend.
--   players_coverage      share of total_players_now measured fresh (<= 2 days); low
--                         values mean the total leans on carried tail values.

DROP TABLE IF EXISTS mart_niche;
DROP TABLE IF EXISTS mart_niche_top;
DROP TABLE IF EXISTS mart_niche_hist;
DROP TABLE IF EXISTS mart_niche_trend;

-- THE NICHE POPULATION, materialised once and shared with mart_niche_game.sql (next in
-- MART_FILES). This used to be an inline `pop` CTE here, and mart_niche_game.sql had to restate
-- the same joins and predicates to reproduce it.
--
-- Sharing it is not tidiness. mart_niche publishes n_games, and the niche drill-down charts the
-- games behind that number: if the two populations differ by so much as one predicate, the chart
-- silently disagrees with the headline sitting above it — plausible, wrong, and invisible. As one
-- table that cannot happen, instead of being a thing a test has to keep catching.
--
-- TEMP and deliberately NOT dropped here: mart_niche_game.sql reads it and drops it as its last
-- consumer. Same cross-file TEMP pattern as _niche_players_now from mart_players.sql.
DROP TABLE IF EXISTS _niche_pop;
CREATE TEMP TABLE _niche_pop AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
mr AS ( SELECT * FROM (VALUES @MR_VALUES@) AS t(min_reviews) ),
wins AS ( SELECT * FROM (VALUES ('all'),('24m')) AS t(win) )
SELECT
    m.dimension, m.key, w.win, mr.min_reviews,
    g.appid, g.est_rev_reviews, g.total_reviews, g.price_initial,
    g.positive_ratio, g.owners_mid, g.self_published, g.is_singleplayer,
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
      );

-- DEMAND OVER 12 MONTHS — the metric the Radar surfaces ring and rank on. Nothing else in
-- the marts carries a demand trend: players_trend_7d_pct is a 7-day window, and
-- saturation_yoy counts RELEASES (pipeline), not demand.
--
-- WHY 12-MONTH WINDOWS (2026-08, replacing the original 90-day windows outright): the 90d
-- trend was quarter-over-quarter — it caught release spikes, sale weeks and seasonality,
-- which is the wrong signal for "what should I build": a game started today ships 1-3
-- years out, so the demand question is structural, not momentum. Last 12 complete months
-- vs the 12 before them — the two halves of the same 24-month span the mart's own 24m
-- population cut covers — is a year-over-year read: each window holds one full seasonal
-- cycle (seasonality cancels instead of aliasing) and a single launch spike is diluted
-- across 12 months.
--
-- SOURCE (2026-08-23, kept from the 90d version): stg_review_histogram (Steam's own
-- per-month review totals), NOT stg_review. The first 90d cut counted the sampled reviews
-- table and asserted the bias "largely cancels in a ratio". Measured, it does the
-- opposite: the keeper collects NEW reviews near-completely while a big game's historical
-- tail stays capped by deepen-reviews, so the recent window is full and the prior window
-- is a sparse sample; Radar's entire top row read +980%..+1530% until the switch (Rainbow
-- Six: 16.0x on the sample, FLAT on the histogram). The bias is asymmetric BETWEEN the
-- windows, so a ratio amplifies it.
--
-- The histogram is uncapped truth for every game with >=50 total reviews — 42,103 games
-- carrying 97.6% of all review volume. Games without one (the <50-review tail) contribute
-- nothing here, which biases niche totals toward covered games; for a per-niche demand
-- TREND that is the acceptable side of the trade, because the alternative contributes
-- fiction.
--
-- Windows are whole months anchored on the last GLOBALLY complete month (max period - 1):
-- now = (anchor-12 .. anchor], prev = (anchor-24 .. anchor-12] — 12 calendar months each.
-- A global anchor, not per-game: anchoring on each game's own last month would date a dead
-- game's "current" trend to whenever it died. Known softness: histograms are refreshed in
-- bulk (most fetched ~monthly), so the anchor month is truncated at fetch date for most
-- games — uniformly across every game and niche, which preserves ranking; the trend lags
-- reality by up to a month until histogram refresh cadence improves.
--
-- CUT-INDEPENDENT — ONE VALUE PER (dimension, key), stamped on every (win, min_reviews)
-- row like entrant_ratio and the players columns. One reason per grid axis:
--   min_reviews (kept from the 90d version, 2026-08-25): demand is the niche's overall
--     review inflow — grouping by the floor made a display toggle change a niche's trend
--     and, through the Radar board's client-side verdicts, its ring. Collapsing the
--     floors loses nothing real: the histogram only covers >=50-review games anyway.
--   win (NEW with the 12m windows; the 90d CTE joined per win): the win='24m' population
--     holds only games RELEASED in the last @RECENT_MONTHS@ months, so every member
--     released inside the last 12 months mechanically CANNOT have inflow in the
--     prior-12m window (it did not exist yet). A per-win join would structurally inflate
--     — or NULL out — every trend on that cut, and that cut is exactly the one the Radar
--     board pins. Demand is a property of the NICHE, so it is computed once over the
--     full membership (the (win='all', min_reviews=0) superset) and stamped on every cut.
DROP TABLE IF EXISTS _niche_demand12m;
CREATE TEMP TABLE _niche_demand12m AS
WITH anchor AS (
    SELECT date_trunc('month', MAX(period_month)) - INTERVAL 1 MONTH AS m
    FROM stg_review_histogram
),
v AS (
    SELECT h.appid,
        SUM(h.n_reviews) FILTER (
            WHERE h.period_month >  (SELECT m FROM anchor) - INTERVAL 12 MONTH
              AND h.period_month <= (SELECT m FROM anchor)
        ) AS r_now,
        SUM(h.n_reviews) FILTER (
            WHERE h.period_month >  (SELECT m FROM anchor) - INTERVAL 24 MONTH
              AND h.period_month <= (SELECT m FROM anchor) - INTERVAL 12 MONTH
        ) AS r_prev
    FROM stg_review_histogram h
    GROUP BY h.appid
),
-- Collapse the whole cut grid: one membership row per (dimension, key, appid). The
-- (win='all', min_reviews=0) population is the superset of every other cut, so this IS
-- the niche's full scored membership.
members AS (
    SELECT DISTINCT dimension, key, appid FROM _niche_pop
)
SELECT p.dimension, p.key,
       SUM(COALESCE(v.r_now, 0))  AS reviews_12m,
       SUM(COALESCE(v.r_prev, 0)) AS reviews_prev_12m
FROM members p
LEFT JOIN v ON v.appid = p.appid
GROUP BY 1, 2;

CREATE TABLE mart_niche AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
ranked AS (
    SELECT *,
        percent_rank() OVER (PARTITION BY dimension, key, win, min_reviews
                             ORDER BY est_rev_reviews) AS rev_pr
    FROM _niche_pop
),
agg AS (
    SELECT
        dimension, key, win, min_reviews,
        COUNT(*) AS n_games,
        COUNT(*) FILTER (WHERE is_recent) AS n_recent,
        median(est_rev_reviews) AS median_rev,
        quantile_cont(est_rev_reviews, 0.25) AS p25_rev,
        quantile_cont(est_rev_reviews, 0.75) AS p75_rev,
        quantile_cont(est_rev_reviews, 0.90) AS p90_rev,
        median(total_reviews) AS median_reviews,
        quantile_cont(total_reviews, 0.25) AS p25_reviews,
        quantile_cont(total_reviews, 0.75) AS p75_reviews,
        median(price_initial) AS median_price,
        quantile_cont(price_initial, 0.25) AS p25_price,
        quantile_cont(price_initial, 0.75) AS p75_price,
        median(positive_ratio) AS median_positive_ratio,
        median(owners_mid) AS median_owners,
        -- Absolute niche SIZE (the "pie"): totals across the scored population, NOT
        -- per-game medians. A narrow niche of strong games has high median_* but small
        -- totals; these expose that difference so a solo dev can prefer a small slice of
        -- a big pie over a big slice of a small one.
        SUM(owners_mid) AS total_owners,
        SUM(est_rev_reviews) AS total_rev,
        SUM(total_reviews) AS total_reviews,
        median(total_reviews) FILTER (WHERE is_recent) AS recent_velocity,
        AVG(CAST(self_published AS DOUBLE)) AS self_pub_share,
        -- v2: share of THIS cut's scored games playable single-player (per-cut on purpose,
        -- so the 24m cut describes recent entrants, not the whole back catalog).
        AVG(CASE WHEN is_singleplayer THEN 1.0 ELSE 0.0 END) AS solo_viability,
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
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(total_owners,0)) AS pr_size,
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
        pr_beatable AS quality_gap,
        pr_size AS market_size
    FROM opp
),
scored AS (
    SELECT f.*,
        CASE WHEN s.n_prior_year > 0
             THEN (s.n_recent_year - s.n_prior_year) * 1.0 / s.n_prior_year
             ELSE NULL END AS saturation_yoy,
        s.n_recent_year, s.n_prior_year
    FROM final f
    LEFT JOIN sat s ON s.dimension = f.dimension AND s.key = f.key
),
-- v2: cross-cut lookups via window functions over the key's own rows — entrant_ratio
-- compares the 24m and all rows of the SAME (dimension, key, min_reviews); the all-time
-- game count for the tier heuristic always comes from the (win='all',
-- min_reviews=@MIN_REVIEWS_DEFAULT@) cut, the broadest population, which exists whenever
-- ANY cut of the key exists (every other cut's population is a subset of it).
enriched AS (
    SELECT *,
        MAX(CASE WHEN win = '24m' THEN median_rev END)
            OVER (PARTITION BY dimension, key, min_reviews)
          / NULLIF(MAX(CASE WHEN win = 'all' THEN median_rev END)
            OVER (PARTITION BY dimension, key, min_reviews), 0) AS entrant_ratio,
        MAX(CASE WHEN win = 'all' AND min_reviews = @MIN_REVIEWS_DEFAULT@ THEN n_games END)
            OVER (PARTITION BY dimension, key) AS n_games_alltime
    FROM scored
),
-- v2 decline gate (full rationale in the header + build_marts.py): either decline signal
-- alone shrinks the gate linearly toward @GATE_FLOOR@; NULL signals are neutral, never
-- treated as decline.
gated AS (
    SELECT *,
        1.0 - (1.0 - @GATE_FLOOR@) * GREATEST(
            LEAST(1.0, GREATEST(0.0,
                -COALESCE(saturation_yoy, 0.0) / @GATE_SAT_FULL_DECLINE@)),
            LEAST(1.0, GREATEST(0.0,
                (1.0 - COALESCE(entrant_ratio, 1.0)) / (1.0 - @GATE_ENTRANT_FULL@)))
        ) AS decline_gate
    FROM enriched
)
SELECT
    g.dimension, g.key, g.win, g.min_reviews,
    g.n_games, g.n_recent,
    g.median_rev, g.p25_rev, g.p75_rev, g.p90_rev,
    g.median_reviews, g.p25_reviews, g.p75_reviews,
    g.median_price, g.p25_price, g.p75_price,
    g.median_positive_ratio,
    g.median_owners,
    g.total_owners, g.total_rev, g.total_reviews,
    round(g.market_size, 2) AS market_size,
    COALESCE(g.recent_velocity, 0) AS recent_velocity,
    g.self_pub_share,
    g.winner_concentration,
    g.hit_rate_200k, g.hit_rate_500k,
    g.beatable_share,
    g.saturation_yoy,
    g.n_recent_year, g.n_prior_year,
    round(g.demand, 2) AS demand,
    round(g.competition, 2) AS competition,
    round(g.quality_gap, 2) AS quality_gap,
    round(GREATEST(0, LEAST(100,
        @W_DEMAND@ * g.demand - @W_COMPETITION@ * g.competition + @W_QUALITY@ * g.quality_gap)), 2) AS opportunity,
    -- v2 columns (additive; see header).
    g.entrant_ratio,
    g.solo_viability,
    CASE WHEN g.dimension = 'genre' THEN 'genre'
         ELSE COALESCE(tt.tier,
                       CASE WHEN g.n_games_alltime >= @UMBRELLA_N_GAMES@
                            THEN 'umbrella' ELSE 'micro' END)
    END AS tier,
    round(g.decline_gate, 4) AS decline_gate,
    round(GREATEST(0, LEAST(100,
        @W_DEMAND@ * g.demand - @W_COMPETITION@ * g.competition + @W_QUALITY@ * g.quality_gap))
        * g.decline_gate, 2) AS opportunity_v2,
    -- Live-player columns (additive; see header — one value per key across all cuts).
    np.total_players_now,
    round(np.players_trend_7d_pct, 2) AS players_trend_7d_pct,
    round(np.players_coverage, 4) AS players_coverage,
    round(np.median_players_now, 1) AS median_players_now,
    round(np.players_top5_share, 4) AS players_top5_share,
    -- Lifetime columns (additive; from mart_players.sql _niche_lifetime — 100+-reaching
    -- games only, steamcharts top-8k coverage; NULL = too few covered games, "unknown").
    nl.lifetime_n_games,
    nl.lifetime_survival_12m,
    nl.lifetime_median_dead_months,
    d.reviews_12m,
    d.reviews_prev_12m,
    -- NULL, not 0, when the prior window is empty: "no baseline to compare against" and
    -- "no change" are different answers, and a niche whose first reviews all landed
    -- inside the last 12 months would otherwise read as flat instead of brand new.
    CASE WHEN COALESCE(d.reviews_prev_12m, 0) = 0 THEN NULL
         ELSE round(100.0 * (d.reviews_12m - d.reviews_prev_12m) / d.reviews_prev_12m, 1)
    END AS demand_trend_12m_pct
FROM gated g
LEFT JOIN tag_tier tt ON g.dimension = 'tag' AND tt.tag = g.key
LEFT JOIN _niche_players_now np ON np.dimension = g.dimension AND np.key = g.key
LEFT JOIN _niche_lifetime nl ON nl.dimension = g.dimension AND nl.key = g.key
-- Cut-independent on purpose (see _niche_demand12m's header): every (win, min_reviews)
-- cut of a (dimension, key) carries the SAME demand numbers.
LEFT JOIN _niche_demand12m d
       ON d.dimension = g.dimension AND d.key = g.key;

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
    median(g.est_rev_reviews) FILTER (WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@) AS median_rev,
    quantile_cont(g.est_rev_reviews, 0.90) FILTER (WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@) AS p90_rev
FROM membership m
JOIN stg_game g ON g.appid = m.appid
JOIN counts c ON c.dimension = m.dimension AND c.key = m.key
WHERE g.release_year IS NOT NULL
  AND g.release_year BETWEEN @TREND_START_YEAR@ AND @CUR_YEAR@
GROUP BY m.dimension, m.key, g.release_year;
