-- mart_tag_lift.sql
-- Pairwise tag-combination performance ("which tags should MY game ship with?"):
-- one row per unordered pair of community tags (canonical order tag_a < tag_b), with the
-- pair's revenue outcomes and its LIFT over the better of the two tags alone.
--
-- Runs LAST in MART_FILES so it can read two earlier marts instead of re-deriving them:
--   mart_game   supplies each game's top_tags (up to TOP_TAGS_PER_GAME community tags,
--               already vote-floored + denylist-filtered exactly like stg_tag_membership —
--               see mart_game.sql's tag_ranked CTE — so synthetic/app-type tags never
--               enter a pair) plus est_rev_reviews / total_reviews.
--   mart_niche  supplies the single-tag baselines: the (dimension='tag', win='all',
--               min_reviews=@MIN_REVIEWS_DEFAULT@) cut, whose per-game population filter
--               (total_reviews >= @MIN_REVIEWS_DEFAULT@, est_rev_reviews IS NOT NULL) is
--               replicated verbatim below for the pair population, so pair and solo
--               medians describe comparable populations by construction.
--
-- LIFT = pair median est_rev_reviews / GREATEST(tag_a solo median, tag_b solo median).
-- Comparing against the BETTER solo tag means lift > 1 can't be trivially achieved by
-- pairing a strong tag with a weak one — it asks "does the combination beat the best
-- thing either tag does alone?". NULL when both solo medians are 0 (all-free-game tags).
--
-- Floors:
--   * per-game: total_reviews >= @MIN_REVIEWS_DEFAULT@ (matches the niche mart's
--     min_reviews=@MIN_REVIEWS_DEFAULT@ cut used as the baseline).
--   * per-pair: n_games >= @TAG_PAIR_MIN_GAMES@ (TAG_PAIR_MIN_GAMES in build_marts.py) —
--     a median over fewer games than that is noise, not signal.
--   * per-solo-tag: baselines come from mart_niche, which itself requires
--     MIN_NICHE_GAMES qualifying games per tag — the INNER JOINs below therefore also
--     drop the (rare) pair whose member tag is too small to have a baseline at all,
--     which is deliberate: a lift against an unmeasured baseline is meaningless.
--
-- hit_rate_200k mirrors mart_niche's convention exactly (share of the pair's games with
-- est_rev_reviews > $200K).
--
-- Caveat carried into the MCP tool (tag_combos): est_rev_reviews is a Boxleiter-style
-- ESTIMATE (reviews x owners-per-review x price — gross lifetime), tags are SteamSpy
-- community tags, and pair performance is correlational — good games choose these tag
-- combinations as much as the combinations make games good.

DROP TABLE IF EXISTS mart_tag_lift;

CREATE TABLE mart_tag_lift AS
WITH exploded AS (
    -- One row per (qualifying game, top tag). Population filter = mart_niche's
    -- min_reviews=@MIN_REVIEWS_DEFAULT@ pop CTE, so baselines stay comparable.
    SELECT g.appid, unnest(g.top_tags) AS tag, g.est_rev_reviews
    FROM mart_game g
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@
      AND g.est_rev_reviews IS NOT NULL
),
pairs AS (
    -- Unordered pairs in canonical order: tag_a < tag_b, each game contributes each of
    -- its C(k,2) top-tag pairs exactly once.
    SELECT a.tag AS tag_a, b.tag AS tag_b, a.appid, a.est_rev_reviews
    FROM exploded a
    JOIN exploded b ON b.appid = a.appid AND a.tag < b.tag
),
agg AS (
    SELECT
        tag_a, tag_b,
        COUNT(*) AS n_games,
        median(est_rev_reviews) AS median_rev,
        AVG(CASE WHEN est_rev_reviews > @TIMING_BIG_REV@ THEN 1.0 ELSE 0.0 END) AS hit_rate_200k
    FROM pairs
    GROUP BY tag_a, tag_b
    HAVING COUNT(*) >= @TAG_PAIR_MIN_GAMES@
),
solo AS (
    -- Single-tag baseline: the all-history, min_reviews=@MIN_REVIEWS_DEFAULT@ cut.
    SELECT key AS tag, n_games, median_rev, hit_rate_200k
    FROM mart_niche
    WHERE dimension = 'tag' AND win = 'all' AND min_reviews = @MIN_REVIEWS_DEFAULT@
)
SELECT
    p.tag_a, p.tag_b,
    p.n_games,
    p.median_rev,
    p.hit_rate_200k,
    sa.median_rev AS tag_a_solo_median_rev,
    sb.median_rev AS tag_b_solo_median_rev,
    sa.n_games AS tag_a_solo_n_games,
    sb.n_games AS tag_b_solo_n_games,
    GREATEST(sa.median_rev, sb.median_rev) AS best_solo_median_rev,
    p.median_rev / NULLIF(GREATEST(sa.median_rev, sb.median_rev), 0) AS lift
FROM agg p
JOIN solo sa ON sa.tag = p.tag_a
JOIN solo sb ON sb.tag = p.tag_b;
