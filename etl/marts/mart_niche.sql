-- mart_niche.sql
-- Builds the niche/opportunity marts from staging tables (stg_game, stg_tag_membership,
-- stg_genre_membership, stg_singleplayer_tag, tag_tier) which build_marts.py creates first.
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
    g.median_rev, g.p25_rev, g.p75_rev,
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
        * g.decline_gate, 2) AS opportunity_v2
FROM gated g
LEFT JOIN tag_tier tt ON g.dimension = 'tag' AND tt.tag = g.key;

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
