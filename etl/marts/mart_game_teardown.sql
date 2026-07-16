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
--                                first/last seen date.
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
-- NOTE: mart_game_aspect_reviews.sql (the aspect drill-down — click a bar here to read the
-- underlying reviews) duplicates the 10 keyword regexes in _review_aspect_flags below
-- byte-for-byte, since there's no mechanism to share a regex literal across two
-- independently-rendered .sql files. If you change a keyword set here, change it there too.

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
    regexp_matches(rt.review_text,
        '\b(combat|fight|fights|fighting|boss|bosses|dodge|dodges|dodging|parry|parries|parrying|mechanic|mechanics|hitbox|hitboxes)\b', 'i') AS combat,
    regexp_matches(rt.review_text,
        '\b(world|explore|explores|exploring|exploration|area|areas|level design|open world|metroidvania)\b', 'i') AS world,
    regexp_matches(rt.review_text,
        '\b(art|visual|visuals|graphics|animation|animations|hand-drawn|hand drawn|handdrawn|aesthetic|aesthetics|gorgeous|beautiful|style|art style|artstyle)\b', 'i') AS art,
    regexp_matches(rt.review_text,
        '\b(music|soundtrack|soundtracks|sound|sounds|score|ost|audio)\b', 'i') AS music,
    regexp_matches(rt.review_text,
        '\b(story|stories|writing|lore|character|characters|narrative|dialogue|dialog|ending|endings)\b', 'i') AS story,
    regexp_matches(rt.review_text,
        '\b(difficult|difficulty|hard|hardest|challenging|challenge|challenges|punishing|brutal|easy|unfair)\b', 'i') AS difficulty,
    regexp_matches(rt.review_text,
        '\b(controls|control|responsive|tight|clunky|bug|bugs|buggy|crash|crashes|crashing|performance|fps|optimization|optimized|optimisation)\b', 'i') AS controls,
    regexp_matches(rt.review_text,
        '\b(map|maps|navigation|backtrack|backtracks|backtracking|lost|confusing|tedious|grind|grinding|grindy)\b', 'i') AS mapnav,
    regexp_matches(rt.review_text,
        '\b(content|length|hours|short|long|replay|replayability|replay value)\b', 'i') AS content,
    regexp_matches(rt.review_text,
        '\b(price|worth|value|cheap|expensive|overpriced|bargain)\b', 'i') AS pricevalue
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
    e.n_reviews_sampled
FROM long l
JOIN _teardown_elig e ON e.appid = l.appid
ORDER BY l.appid, total_mentions DESC;

-- ------------------------------------------------------------------------------------
-- Genre baseline (pooled counts, not mean-of-shares) for the differential.
-- ------------------------------------------------------------------------------------
CREATE TABLE mart_genre_aspect_baseline AS
WITH game_genre AS (
    SELECT appid, primary_genre FROM stg_primary_genre
),
base AS (
    SELECT '__all__' AS genre, appid, aspect, n_pos_mentions, n_neg_mentions
    FROM mart_game_review_aspects
    UNION ALL
    SELECT gg.primary_genre AS genre, a.appid, a.aspect, a.n_pos_mentions, a.n_neg_mentions
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
         ELSE NULL END AS pos_share
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

CREATE TABLE mart_game_press_summary AS
SELECT appid,
    COUNT(*) AS total_mentions,
    COUNT(DISTINCT source) AS n_sources,
    CAST(MIN(published_at) AS VARCHAR) AS first_seen,
    CAST(MAX(published_at) AS VARCHAR) AS last_seen
FROM _press_base
GROUP BY appid;

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
