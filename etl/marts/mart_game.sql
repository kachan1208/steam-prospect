-- mart_game.sql
-- Per-appid fact row: metadata + revenue/owners + positive_ratio + percentile rank of
-- est_rev_reviews within the game's primary genre. Powers lookups / "where do I land".
-- Uses staging stg_game, stg_primary_genre, stg_review + src.games (header art,
-- description) + src.game_tags (top-tags vector, filtered same as stg_tag_membership).
--
-- Phase 2 additions: percentile-vs-genre for reviews/owners (alongside the existing
-- revenue percentile), a top-N tag vector (powers on-demand comparables + tag search —
-- see api/app/routers/games.py, never precomputed pairwise), a review-velocity summary,
-- and playtime percentiles — all from the per-review SAMPLE (stg_review), so these
-- describe the sample, not Steam's true totals.

DROP TABLE IF EXISTS mart_game;

CREATE TABLE mart_game AS
WITH pct_ranks AS (
    SELECT g.appid,
        100.0 * percent_rank() OVER (PARTITION BY pg.primary_genre ORDER BY g.est_rev_reviews) AS rev_pct_in_genre,
        100.0 * percent_rank() OVER (PARTITION BY pg.primary_genre ORDER BY g.total_reviews) AS reviews_pct_in_genre,
        100.0 * percent_rank() OVER (PARTITION BY pg.primary_genre ORDER BY g.owners_mid) AS owners_pct_in_genre
    FROM stg_game g
    JOIN stg_primary_genre pg ON pg.appid = g.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
),
tag_ranked AS (
    SELECT gt.appid, gt.tag,
        row_number() OVER (PARTITION BY gt.appid ORDER BY gt.rank) AS rn
    FROM src.game_tags gt
    WHERE gt.votes >= @TAG_VOTE_FLOOR@
      AND gt.tag NOT IN (SELECT tag FROM denylist_tag)
),
top_tags_agg AS (
    SELECT appid, list(tag ORDER BY rn) AS top_tags
    FROM tag_ranked
    WHERE rn <= @TOP_TAGS_PER_GAME@
    GROUP BY appid
),
velocity AS (
    SELECT appid,
        COUNT(*) AS n_reviews_sampled,
        COUNT(*) FILTER (WHERE dsr BETWEEN 0 AND 30) AS n_reviews_first_30d,
        COUNT(*) FILTER (WHERE dsr BETWEEN 0 AND 90) AS n_reviews_first_90d,
        COUNT(*) FILTER (WHERE dsr BETWEEN 0 AND 365) AS n_reviews_first_365d,
        COUNT(*) FILTER (WHERE review_date >= CURRENT_DATE - INTERVAL 30 DAY) AS n_reviews_trailing_30d,
        quantile_cont(playtime_forever, 0.25) FILTER (WHERE playtime_forever IS NOT NULL AND playtime_forever > 0) AS playtime_p25,
        quantile_cont(playtime_forever, 0.50) FILTER (WHERE playtime_forever IS NOT NULL AND playtime_forever > 0) AS playtime_p50,
        quantile_cont(playtime_forever, 0.75) FILTER (WHERE playtime_forever IS NOT NULL AND playtime_forever > 0) AS playtime_p75
    FROM stg_review
    GROUP BY appid
)
SELECT
    g.appid, g.name, g.release_year,
    CAST(g.release_date AS VARCHAR) AS release_date,
    g.price_initial, g.is_free,
    pg.primary_genre,
    g.developers, g.publishers, g.self_published, g.is_indie,
    g.owners_mid, g.total_reviews, g.positive_ratio,
    g.est_rev_reviews, g.est_rev_owners,
    g.metacritic_score, g.achievements_count, g.avg_playtime_forever,
    gh.header_image, gh.short_description,
    pr.rev_pct_in_genre, pr.reviews_pct_in_genre, pr.owners_pct_in_genre,
    COALESCE(tt.top_tags, []::VARCHAR[]) AS top_tags,
    COALESCE(v.n_reviews_sampled, 0) AS n_reviews_sampled,
    COALESCE(v.n_reviews_first_30d, 0) AS n_reviews_first_30d,
    COALESCE(v.n_reviews_first_90d, 0) AS n_reviews_first_90d,
    COALESCE(v.n_reviews_first_365d, 0) AS n_reviews_first_365d,
    COALESCE(v.n_reviews_trailing_30d, 0) AS n_reviews_trailing_30d,
    v.playtime_p25, v.playtime_p50, v.playtime_p75
FROM stg_game g
LEFT JOIN stg_primary_genre pg ON pg.appid = g.appid
LEFT JOIN pct_ranks pr ON pr.appid = g.appid
LEFT JOIN top_tags_agg tt ON tt.appid = g.appid
LEFT JOIN velocity v ON v.appid = g.appid
LEFT JOIN src.games gh ON gh.appid = g.appid;
