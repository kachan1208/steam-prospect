-- mart_game_teardown.sql
-- "Why it works" Game Teardown: review-text aspect mining (praise vs. complaint per
-- aspect, with a genre baseline for the differential) + press/PR footprint. Powers
-- GET /api/games/{appid}/teardown.
--
--   mart_game_review_aspects    per (appid, aspect): praise/complaint mention counts +
--                                pos_share, for games with >= @TEARDOWN_MIN_REVIEWS@
--                                sampled English reviews (stg_review_text — itself a
--                                per-game SAMPLE of the `reviews` table, recency-biased
--                                for older/popular titles; see stg_review's caveat).
--                                pos_share is VOTE-based: the share of reviews mentioning the
--                                aspect that were thumbs-up OVERALL (so a thumbs-up review
--                                trashing the combat still counts as praise for combat). The
--                                n_text_*/text_pos_share/mean_compound columns are the honest
--                                fix — VADER sentiment of the review TEXT around the aspect
--                                keyword (LEFT JOINed from stg_aspect_sentiment, precomputed in
--                                etl/build_marts.py compute_aspect_sentiment). Both ship, so the
--                                UI can show text sentiment ALONGSIDE the vote split.
--   mart_genre_aspect_baseline  per (genre, aspect): the SAME praise/complaint counts
--                                POOLED across all qualifying games in the genre (+ an
--                                '__all__' catalog-wide row), so the API can compute
--                                "does this game over/under-index vs its genre peers on
--                                this aspect" (delta_vs_genre). Pooled (mention-
--                                weighted) average, not a mean of per-game shares, so
--                                heavily-reviewed games appropriately dominate the
--                                baseline instead of a single thin-sample game swinging
--                                it as much as a 500-review one.
--   mart_game_press_summary     per appid: total press mentions, distinct sources,
--                                first/last seen date, and coverage-tone sentiment (VADER over
--                                each matched article's headline+summary — press_pos_share /
--                                mean_compound / pos·neg·neutral counts).
--   mart_game_press_by_source   per (appid, source): mention count.
--   mart_game_press_timeline    per (appid, month): mention count.
--   mart_game_press_notable     per appid: up to @PRESS_NOTABLE_N@ (+1) "notable"
--                                articles — top by match_confidence, always including
--                                the earliest even if it didn't make the confidence cut
--                                — the PR "angle".
--
-- Press excludes source='steam_news' (dev-authored patch notes/announcements — a
-- separate cadence lane from journalist coverage, not press) and filters
-- article_game_mentions.match_confidence < @PRESS_MIN_CONFIDENCE@. That matcher's
-- confidence = normalized-game-name-length / normalized-title-length (see
-- steam_scraper/game_matcher.py) — a proxy for "how much of this title is about this
-- game," not a correctness score; long, busy titles about a real match still score low.
-- The floor trims the noisiest, most-diluted matches; it does not guarantee precision.
-- Placeholder tokens are substituted by build_marts.py.
--
-- NOTE: the 10 keyword regexes below (_review_aspect_flags) are NO LONGER hand-duplicated —
-- they render from the single source of truth ASPECT_LEXICON in etl/build_marts.py via the
-- @RX_*@ placeholders, which is ALSO where the text-sentiment windows are matched and where
-- mart_game_aspect_reviews.sql gets its copy. Change a keyword set in ONE place (build_marts.py)
-- and the vote flags, the sentiment windows, and the drill-down excerpts all move together.

DROP TABLE IF EXISTS mart_game_review_aspects;
DROP TABLE IF EXISTS mart_genre_aspect_baseline;
DROP TABLE IF EXISTS mart_game_press_summary;
DROP TABLE IF EXISTS mart_game_press_by_source;
DROP TABLE IF EXISTS mart_game_press_timeline;
DROP TABLE IF EXISTS mart_game_press_notable;

-- ------------------------------------------------------------------------------------
-- Review-aspect mining — fixed keyword lexicon, 10 aspects, scanned once per review.
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _teardown_elig AS
SELECT appid, COUNT(*) AS n_reviews_sampled
FROM stg_review_text
GROUP BY appid
HAVING COUNT(*) >= @TEARDOWN_MIN_REVIEWS@;

-- One boolean column per aspect (computed once per review) rather than a cross join
-- against an aspects table — 10 regex evaluations per row either way, but this avoids
-- a 10x row-count blowup before the aggregate.
CREATE TEMP TABLE _review_aspect_flags AS
SELECT
    rt.appid,
    rt.voted_up,
    regexp_matches(rt.review_text, '@RX_COMBAT@', 'i') AS combat,
    regexp_matches(rt.review_text, '@RX_WORLD@', 'i') AS world,
    regexp_matches(rt.review_text, '@RX_ART@', 'i') AS art,
    regexp_matches(rt.review_text, '@RX_MUSIC@', 'i') AS music,
    regexp_matches(rt.review_text, '@RX_STORY@', 'i') AS story,
    regexp_matches(rt.review_text, '@RX_DIFFICULTY@', 'i') AS difficulty,
    regexp_matches(rt.review_text, '@RX_CONTROLS@', 'i') AS controls,
    regexp_matches(rt.review_text, '@RX_MAPNAV@', 'i') AS mapnav,
    regexp_matches(rt.review_text, '@RX_CONTENT@', 'i') AS content,
    regexp_matches(rt.review_text, '@RX_PRICEVALUE@', 'i') AS pricevalue
FROM stg_review_text rt
JOIN _teardown_elig e ON e.appid = rt.appid;

-- COALESCE every arm to 0: SUM(...) FILTER(...) returns NULL (not 0) when a game has
-- zero reviews on that side of voted_up for the aspect (e.g. an aspect never mentioned
-- in any negative review) — without the COALESCE, total_mentions/pos_share downstream
-- would go NULL for a real, present aspect instead of reading as "0 on that side."
CREATE TEMP TABLE _aspect_agg AS
SELECT appid,
    COALESCE(SUM(combat::INT) FILTER (WHERE voted_up = 1), 0) AS combat_pos, COALESCE(SUM(combat::INT) FILTER (WHERE voted_up = 0), 0) AS combat_neg,
    COALESCE(SUM(world::INT) FILTER (WHERE voted_up = 1), 0) AS world_pos, COALESCE(SUM(world::INT) FILTER (WHERE voted_up = 0), 0) AS world_neg,
    COALESCE(SUM(art::INT) FILTER (WHERE voted_up = 1), 0) AS art_pos, COALESCE(SUM(art::INT) FILTER (WHERE voted_up = 0), 0) AS art_neg,
    COALESCE(SUM(music::INT) FILTER (WHERE voted_up = 1), 0) AS music_pos, COALESCE(SUM(music::INT) FILTER (WHERE voted_up = 0), 0) AS music_neg,
    COALESCE(SUM(story::INT) FILTER (WHERE voted_up = 1), 0) AS story_pos, COALESCE(SUM(story::INT) FILTER (WHERE voted_up = 0), 0) AS story_neg,
    COALESCE(SUM(difficulty::INT) FILTER (WHERE voted_up = 1), 0) AS difficulty_pos, COALESCE(SUM(difficulty::INT) FILTER (WHERE voted_up = 0), 0) AS difficulty_neg,
    COALESCE(SUM(controls::INT) FILTER (WHERE voted_up = 1), 0) AS controls_pos, COALESCE(SUM(controls::INT) FILTER (WHERE voted_up = 0), 0) AS controls_neg,
    COALESCE(SUM(mapnav::INT) FILTER (WHERE voted_up = 1), 0) AS mapnav_pos, COALESCE(SUM(mapnav::INT) FILTER (WHERE voted_up = 0), 0) AS mapnav_neg,
    COALESCE(SUM(content::INT) FILTER (WHERE voted_up = 1), 0) AS content_pos, COALESCE(SUM(content::INT) FILTER (WHERE voted_up = 0), 0) AS content_neg,
    COALESCE(SUM(pricevalue::INT) FILTER (WHERE voted_up = 1), 0) AS pricevalue_pos, COALESCE(SUM(pricevalue::INT) FILTER (WHERE voted_up = 0), 0) AS pricevalue_neg
FROM _review_aspect_flags
GROUP BY appid;

CREATE TABLE mart_game_review_aspects AS
WITH long AS (
    SELECT appid, 'Combat & Bosses' AS aspect, combat_pos AS n_pos_mentions, combat_neg AS n_neg_mentions FROM _aspect_agg
    UNION ALL SELECT appid, 'World & Exploration', world_pos, world_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Art & Visuals', art_pos, art_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Music & Audio', music_pos, music_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Story & Writing', story_pos, story_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Difficulty', difficulty_pos, difficulty_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Controls & Performance', controls_pos, controls_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Map & Navigation / Backtracking', mapnav_pos, mapnav_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Content & Length', content_pos, content_neg FROM _aspect_agg
    UNION ALL SELECT appid, 'Price & Value', pricevalue_pos, pricevalue_neg FROM _aspect_agg
)
SELECT l.appid, l.aspect,
    l.n_pos_mentions, l.n_neg_mentions,
    l.n_pos_mentions + l.n_neg_mentions AS total_mentions,
    CASE WHEN l.n_pos_mentions + l.n_neg_mentions > 0
         THEN l.n_pos_mentions * 1.0 / (l.n_pos_mentions + l.n_neg_mentions)
         ELSE NULL END AS pos_share,
    e.n_reviews_sampled,
    -- Aspect TEXT sentiment (VADER over the local window around the keyword — see
    -- etl/build_marts.py compute_aspect_sentiment / stg_aspect_sentiment). This is the honest
    -- "what the review TEXT says about this aspect" signal, vs pos_share above which is really
    -- "what share of reviews mentioning it were thumbs-up OVERALL." COALESCE counts to 0 for an
    -- aspect a game never mentions (no stg_aspect_sentiment row); shares/mean stay NULL there.
    COALESCE(s.n_text_pos, 0) AS n_text_pos,
    COALESCE(s.n_text_neg, 0) AS n_text_neg,
    COALESCE(s.n_text_neutral, 0) AS n_text_neutral,
    s.n_text_scored,
    s.sum_compound,
    CASE WHEN COALESCE(s.n_text_pos, 0) + COALESCE(s.n_text_neg, 0) > 0
         THEN s.n_text_pos * 1.0 / (s.n_text_pos + s.n_text_neg)
         ELSE NULL END AS text_pos_share,
    CASE WHEN s.n_text_scored > 0 THEN s.sum_compound / s.n_text_scored ELSE NULL END AS mean_compound
FROM long l
JOIN _teardown_elig e ON e.appid = l.appid
LEFT JOIN stg_aspect_sentiment s ON s.appid = l.appid AND s.aspect = l.aspect
ORDER BY l.appid, total_mentions DESC;

-- ------------------------------------------------------------------------------------
-- Genre baseline (pooled counts, not mean-of-shares) for the differential.
-- ------------------------------------------------------------------------------------
CREATE TABLE mart_genre_aspect_baseline AS
WITH game_genre AS (
    SELECT appid, primary_genre FROM stg_primary_genre
),
base AS (
    SELECT '__all__' AS genre, appid, aspect, n_pos_mentions, n_neg_mentions,
        n_text_pos, n_text_neg, n_text_neutral, n_text_scored, sum_compound
    FROM mart_game_review_aspects
    UNION ALL
    SELECT gg.primary_genre AS genre, a.appid, a.aspect, a.n_pos_mentions, a.n_neg_mentions,
        a.n_text_pos, a.n_text_neg, a.n_text_neutral, a.n_text_scored, a.sum_compound
    FROM mart_game_review_aspects a
    JOIN game_genre gg ON gg.appid = a.appid
    WHERE gg.primary_genre IS NOT NULL
)
SELECT genre, aspect,
    COUNT(DISTINCT appid) AS n_games,
    SUM(n_pos_mentions) AS n_pos_mentions,
    SUM(n_neg_mentions) AS n_neg_mentions,
    SUM(n_pos_mentions) + SUM(n_neg_mentions) AS total_mentions,
    CASE WHEN SUM(n_pos_mentions) + SUM(n_neg_mentions) > 0
         THEN SUM(n_pos_mentions) * 1.0 / (SUM(n_pos_mentions) + SUM(n_neg_mentions))
         ELSE NULL END AS pos_share,
    -- Pooled TEXT-sentiment baseline (mention-weighted, same rationale as the vote pool above):
    -- lets the API say whether THIS game's text sentiment on an aspect over/under-indexes vs
    -- its genre peers (text_delta_vs_genre), the text analogue of the vote-based differential.
    SUM(n_text_pos) AS n_text_pos,
    SUM(n_text_neg) AS n_text_neg,
    SUM(n_text_neutral) AS n_text_neutral,
    CASE WHEN SUM(n_text_pos) + SUM(n_text_neg) > 0
         THEN SUM(n_text_pos) * 1.0 / (SUM(n_text_pos) + SUM(n_text_neg))
         ELSE NULL END AS text_pos_share,
    CASE WHEN SUM(n_text_scored) > 0 THEN SUM(sum_compound) / SUM(n_text_scored) ELSE NULL END AS mean_compound
FROM base
GROUP BY genre, aspect
HAVING COUNT(DISTINCT appid) >= @TEARDOWN_MIN_GENRE_GAMES@ OR genre = '__all__';

-- ------------------------------------------------------------------------------------
-- Press footprint (journalist coverage only — steam_news excluded, see file header).
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _press_base AS
SELECT m.appid, a.id AS article_id, a.source, a.title, a.author,
    TRY_CAST(a.published_at AS TIMESTAMP) AS published_at,
    m.match_confidence
FROM src.article_game_mentions m
JOIN src.articles a ON a.id = m.article_id
WHERE a.source != 'steam_news'
  AND m.match_confidence >= @PRESS_MIN_CONFIDENCE@;

-- Press-coverage sentiment: VADER over each article's headline+summary (stg_press_article_sentiment,
-- precomputed in etl/build_marts.py compute_press_sentiment), aggregated over this game's matched
-- articles. press_pos_share = positive / (positive + negative) with VADER's ±0.05 neutral band
-- excluded; mean_compound is the mean over all scored articles. Coarse: headline/summary-level,
-- English-only, and an article's overall tone only proxies its stance on the matched game.
CREATE TABLE mart_game_press_summary AS
WITH agg AS (
    SELECT pb.appid,
        COUNT(*) AS total_mentions,
        COUNT(DISTINCT pb.source) AS n_sources,
        CAST(MIN(pb.published_at) AS VARCHAR) AS first_seen,
        CAST(MAX(pb.published_at) AS VARCHAR) AS last_seen,
        COUNT(ps.compound) AS n_scored_articles,
        COALESCE(SUM(CASE WHEN ps.compound >= @SENTIMENT_POS_THRESHOLD@ THEN 1 ELSE 0 END), 0) AS n_pos_articles,
        COALESCE(SUM(CASE WHEN ps.compound <= @SENTIMENT_NEG_THRESHOLD@ THEN 1 ELSE 0 END), 0) AS n_neg_articles,
        COALESCE(SUM(CASE WHEN ps.compound > @SENTIMENT_NEG_THRESHOLD@ AND ps.compound < @SENTIMENT_POS_THRESHOLD@ THEN 1 ELSE 0 END), 0) AS n_neutral_articles,
        AVG(ps.compound) AS mean_compound
    FROM _press_base pb
    LEFT JOIN stg_press_article_sentiment ps ON ps.article_id = pb.article_id
    GROUP BY pb.appid
)
SELECT *,
    CASE WHEN n_pos_articles + n_neg_articles > 0
         THEN n_pos_articles * 1.0 / (n_pos_articles + n_neg_articles)
         ELSE NULL END AS press_pos_share
FROM agg;

CREATE TABLE mart_game_press_by_source AS
SELECT appid, source, COUNT(*) AS n_mentions
FROM _press_base
GROUP BY appid, source
ORDER BY appid, n_mentions DESC;

CREATE TABLE mart_game_press_timeline AS
SELECT appid, strftime(date_trunc('month', published_at), '%Y-%m') AS period, COUNT(*) AS n_mentions
FROM _press_base
WHERE published_at IS NOT NULL
GROUP BY appid, date_trunc('month', published_at)
ORDER BY appid, period;

CREATE TABLE mart_game_press_notable AS
WITH ranked AS (
    SELECT appid, source, title, author, published_at, match_confidence,
        row_number() OVER (PARTITION BY appid ORDER BY match_confidence DESC, published_at ASC) AS conf_rank,
        row_number() OVER (PARTITION BY appid ORDER BY published_at ASC NULLS LAST) AS date_rank
    FROM _press_base
)
SELECT appid, source, title, author, CAST(published_at AS VARCHAR) AS published_at, match_confidence,
    (date_rank = 1) AS is_earliest
FROM ranked
WHERE conf_rank <= @PRESS_NOTABLE_N@ OR date_rank = 1
ORDER BY appid, published_at ASC NULLS LAST;
