-- mart_niche_themes.sql
-- Niche review themes: the per-game review-aspect signal (mart_game_review_aspects)
-- rolled up to NICHE level — "what does the whole Colony Sim niche praise/complain
-- about?" — so find_niches' abstract quality_gap score can be turned into a concrete,
-- actionable gap statement. Powers the `niche_review_themes` MCP tool.
--
--   mart_niche_themes   one row per (dimension 'tag'|'genre', key, aspect): number of
--                        niche games with >=1 review mentioning the aspect, their summed
--                        eligible-review pool, pooled praise/complaint shares (BOTH the
--                        vote-based and the text-sentiment signal families, mirroring
--                        mart_game_review_aspects' dual columns), and each share's delta
--                        vs the all-catalog pooled baseline for that aspect (so "this
--                        niche complains about Difficulty MORE than games in general").
--
-- Niche membership (deliberately reuses already-built marts, no re-mining of review text):
--   tag   : the tag appears in mart_game.top_tags — the game's top-@TOP_TAGS_PER_GAME@
--           community tags (vote/rank-floored + denylisted upstream). NARROWER than
--           mart_niche's stg_tag_membership (top-@TAG_RANK_FLOOR@), so a niche's n_games
--           here can be smaller than the same key's n_games in mart_niche; the KEY
--           vocabulary is the same, membership is just more focused (a game only counts
--           toward niches that actually define it).
--   genre : mart_game.primary_genre (exact match, one genre per game).
-- Either way the population is further limited to teardown-eligible games — the ones in
-- mart_game_review_aspects, i.e. >= @TEARDOWN_MIN_REVIEWS@ sampled English text reviews.
--
-- Weighting: POOLED mention counts (sum then divide), not a mean of per-game shares —
-- the same choice, for the same reason, as mart_genre_aspect_baseline: a 5-review game
-- contributes 5 reviews' worth of signal, not a full vote equal to a 500-review game's,
-- so thin-sample games can't swamp the niche read. The flip side (documented in the tool
-- caveats): one heavily-reviewed hit can dominate its niche's shares — n_games and
-- n_reviews_sampled are carried so consumers can judge how broad the base really is.
--
-- Baseline: the '__all__' row of mart_genre_aspect_baseline (the identical pooled
-- aggregate over ALL teardown-eligible games), read rather than recomputed so the two
-- can never drift. The text rates are re-derived from its count columns because this
-- mart's rate denominators INCLUDE the VADER neutral band (see below), while the
-- baseline's stored text_pos_share excludes it.
--
-- Two signal families per row (mirrors mart_game_review_aspects — see its header):
--   praise_share / complaint_share       VOTE-based: of reviews mentioning the aspect,
--                                         the share that were thumbs-up / thumbs-down
--                                         OVERALL (sums to 1; a thumbs-up review trashing
--                                         the combat still counts as combat "praise").
--   text_praise_rate / text_complaint_rate  TEXT-based: of VADER-scored local text
--                                         windows around the aspect keyword, the share
--                                         reading positive / negative. Denominator is ALL
--                                         scored windows (neutral band included), so the
--                                         two rates DON'T sum to 1 and praise/complaint
--                                         rankings are genuinely independent — this is
--                                         what lets a niche's top praise themes differ
--                                         from the mirror image of its top complaints.
-- Each family carries its delta vs the '__all__' baseline; the vote family's complaint
-- delta is just -praise_delta_vs_catalog (shares sum to 1), so only the praise delta is
-- stored for it.
--
-- Reliability floor: a (niche, aspect) row needs >= @NICHE_THEMES_MIN_GAMES@ games with
-- at least one mention of the aspect (tunable NICHE_THEMES_MIN_GAMES in build_marts.py)
-- — below that, one title's fans/haters would read as "the niche".
--
-- MUST run AFTER mart_game.sql and mart_game_teardown.sql (reads mart_game,
-- mart_game_review_aspects, mart_genre_aspect_baseline) — registered LAST in MART_FILES.
-- Placeholder tokens are substituted by build_marts.py.

DROP TABLE IF EXISTS mart_niche_themes;

-- (appid, dimension, key) niche membership, limited to teardown-eligible games so the
-- join below fans out over ~16K games x ~10 tags, not the whole 170K-game catalog.
CREATE TEMP TABLE _theme_member AS
SELECT m.appid, m.dimension, m.key
FROM (
    SELECT g.appid, 'tag' AS dimension, t.tag AS key
    FROM mart_game g, UNNEST(g.top_tags) AS t(tag)
    UNION ALL
    SELECT g.appid, 'genre' AS dimension, g.primary_genre AS key
    FROM mart_game g
    WHERE g.primary_genre IS NOT NULL
) m
WHERE m.appid IN (SELECT DISTINCT appid FROM mart_game_review_aspects);

CREATE TABLE mart_niche_themes AS
WITH agg AS (
    -- Pooled (mention-weighted) sums per (niche, aspect). total_mentions > 0 keeps the
    -- zero-mention aspect rows mart_game_review_aspects carries for every eligible game
    -- from inflating n_games (they contribute nothing to any sum).
    SELECT
        m.dimension, m.key, a.aspect,
        COUNT(DISTINCT a.appid) AS n_games,
        SUM(a.n_reviews_sampled) AS n_reviews_sampled,
        SUM(a.n_pos_mentions) AS n_pos_mentions,
        SUM(a.n_neg_mentions) AS n_neg_mentions,
        SUM(a.total_mentions) AS total_mentions,
        -- COALESCE mirrors mart_game_review_aspects' own text-column handling: a game
        -- whose aspect got vote mentions but no scored text windows contributes 0, not
        -- NULL-poisoning the niche sum.
        SUM(COALESCE(a.n_text_pos, 0)) AS n_text_pos,
        SUM(COALESCE(a.n_text_neg, 0)) AS n_text_neg,
        SUM(COALESCE(a.n_text_neutral, 0)) AS n_text_neutral,
        SUM(COALESCE(a.n_text_scored, 0)) AS n_text_scored,
        SUM(COALESCE(a.sum_compound, 0)) AS sum_compound
    FROM _theme_member m
    JOIN mart_game_review_aspects a ON a.appid = m.appid
    WHERE a.total_mentions > 0
    GROUP BY m.dimension, m.key, a.aspect
    HAVING COUNT(DISTINCT a.appid) >= @NICHE_THEMES_MIN_GAMES@
),
baseline AS (
    -- All-catalog pooled baseline per aspect (see header re: re-deriving the
    -- neutral-inclusive text rates from the stored counts).
    SELECT
        aspect,
        pos_share AS base_praise_share,
        n_text_pos * 1.0 / NULLIF(n_text_pos + n_text_neg + n_text_neutral, 0) AS base_text_praise_rate,
        n_text_neg * 1.0 / NULLIF(n_text_pos + n_text_neg + n_text_neutral, 0) AS base_text_complaint_rate
    FROM mart_genre_aspect_baseline
    WHERE genre = '__all__'
)
SELECT
    ag.dimension, ag.key, ag.aspect,
    ag.n_games, ag.n_reviews_sampled,
    ag.n_pos_mentions, ag.n_neg_mentions, ag.total_mentions,
    -- Vote family (shares sum to 1; complaint delta = -praise delta, not stored).
    ag.n_pos_mentions * 1.0 / NULLIF(ag.total_mentions, 0) AS praise_share,
    ag.n_neg_mentions * 1.0 / NULLIF(ag.total_mentions, 0) AS complaint_share,
    ag.n_pos_mentions * 1.0 / NULLIF(ag.total_mentions, 0) - b.base_praise_share AS praise_delta_vs_catalog,
    -- Text family (neutral-inclusive denominators; rates independent, don't sum to 1).
    ag.n_text_scored,
    ag.n_text_pos * 1.0 / NULLIF(ag.n_text_scored, 0) AS text_praise_rate,
    ag.n_text_neg * 1.0 / NULLIF(ag.n_text_scored, 0) AS text_complaint_rate,
    ag.n_text_pos * 1.0 / NULLIF(ag.n_text_scored, 0) - b.base_text_praise_rate AS text_praise_delta_vs_catalog,
    ag.n_text_neg * 1.0 / NULLIF(ag.n_text_scored, 0) - b.base_text_complaint_rate AS text_complaint_delta_vs_catalog,
    CASE WHEN ag.n_text_scored > 0 THEN ag.sum_compound / ag.n_text_scored ELSE NULL END AS mean_compound
FROM agg ag
JOIN baseline b USING (aspect)
ORDER BY ag.dimension, ag.key, ag.aspect;

-- Temp-table hygiene: file-local staging (nothing downstream reads it).
DROP TABLE IF EXISTS _theme_member;
