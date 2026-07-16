-- mart_game_aspect_reviews.sql
-- Aspect drill-down: the representative review excerpts behind each Game Teardown aspect
-- bar, split praise vs. complaint. Powers GET /api/games/{appid}/aspect-reviews — click a
-- bar in "Praise vs. complaint by aspect" (AspectDivergingBars.tsx) and read the actual
-- reviews behind the percentage.
--
-- Reuses the IDENTICAL aspect lexicon (10 aspects, same keyword regexes), review floor
-- (@TEARDOWN_MIN_REVIEWS@ sampled English reviews/game) and English-only filter as
-- mart_game_teardown.sql's _teardown_elig / _review_aspect_flags, so a drill-down excerpt
-- always matches what the aggregate bar shows. The keyword regexes are intentionally
-- duplicated byte-for-byte below rather than shared across files (there's no mechanism to
-- share a SQL literal across two independently-rendered .sql files) — mart_game_teardown.sql
-- carries a pointer comment back to this file; if you change one lexicon, change both.
--
--   mart_game_aspect_reviews  per (appid, aspect, sentiment IN ('praise','complaint')): up
--                              to @ASPECT_REVIEWS_TOP_K@ representative excerpts, ranked by
--                              votes_up DESC then recency (timestamp_created DESC). Each
--                              excerpt is a <=280-char window around the review's first
--                              matched keyword (falls back to the review start if a keyword
--                              position can't be located). Same eligible-game population as
--                              the teardown (games with >= @TEARDOWN_MIN_REVIEWS@ sampled
--                              English reviews). NOT joined to mart_game, mirroring
--                              mart_game_teardown.sql — the API 404s upstream via mart_game
--                              before this table is ever queried for a nonexistent appid.
--
-- Placeholder tokens are substituted by build_marts.py.

DROP TABLE IF EXISTS mart_game_aspect_reviews;

-- Same English / non-empty-text filter as stg_review_text, but re-selected directly from
-- src.reviews (not stg_review_text) because excerpt display needs votes_up / playtime /
-- timestamp / language columns that stg_review_text intentionally omits (it's a lean,
-- text-mining-only staging table). Kept as its own filter rather than widening
-- stg_review_text, so this file can't change behavior for the already-verified
-- mart_game_teardown.sql.
CREATE TEMP TABLE _aspectrev_text AS
SELECT r.appid, r.voted_up, r.review_text, r.votes_up,
    COALESCE(r.playtime_at_review, r.playtime_forever) AS playtime_minutes,
    r.timestamp_created, r.language
FROM src.reviews r
WHERE r.language = 'english'
  AND r.review_text IS NOT NULL
  AND length(trim(r.review_text)) > 0;

CREATE TEMP TABLE _aspectrev_elig AS
SELECT appid FROM _aspectrev_text GROUP BY appid HAVING COUNT(*) >= @TEARDOWN_MIN_REVIEWS@;

-- Materialize the eligible-game review pool ONCE so the 10 aspect branches below each scan
-- it directly rather than re-joining _aspectrev_text x _aspectrev_elig ten times.
CREATE TEMP TABLE _aspectrev_base AS
SELECT t.appid, t.voted_up, t.review_text, t.votes_up, t.playtime_minutes,
    t.timestamp_created, t.language
FROM _aspectrev_text t
JOIN _aspectrev_elig e ON e.appid = t.appid;

-- One row per (review, matched aspect) — same 10 keyword regexes as
-- mart_game_teardown.sql's _review_aspect_flags, but emitted as a row per match (not a
-- boolean column) and capturing every matched keyword occurrence (regexp_extract_all,
-- group 1) so we can both rank candidates and later show "matched_keywords" + locate an
-- excerpt window around the first hit.
CREATE TEMP TABLE _aspectrev_matches AS
SELECT appid, 'Combat & Bosses' AS aspect, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(combat|fight|fights|fighting|boss|bosses|dodge|dodges|dodging|parry|parries|parrying|mechanic|mechanics|hitbox|hitboxes)\b', 1, 'i') AS kw_matches
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(combat|fight|fights|fighting|boss|bosses|dodge|dodges|dodging|parry|parries|parrying|mechanic|mechanics|hitbox|hitboxes)\b', 'i')

UNION ALL
SELECT appid, 'World & Exploration', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(world|explore|explores|exploring|exploration|area|areas|level design|open world|metroidvania)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(world|explore|explores|exploring|exploration|area|areas|level design|open world|metroidvania)\b', 'i')

UNION ALL
SELECT appid, 'Art & Visuals', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(art|visual|visuals|graphics|animation|animations|hand-drawn|hand drawn|handdrawn|aesthetic|aesthetics|gorgeous|beautiful|style|art style|artstyle)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(art|visual|visuals|graphics|animation|animations|hand-drawn|hand drawn|handdrawn|aesthetic|aesthetics|gorgeous|beautiful|style|art style|artstyle)\b', 'i')

UNION ALL
SELECT appid, 'Music & Audio', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(music|soundtrack|soundtracks|sound|sounds|score|ost|audio)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(music|soundtrack|soundtracks|sound|sounds|score|ost|audio)\b', 'i')

UNION ALL
SELECT appid, 'Story & Writing', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(story|stories|writing|lore|character|characters|narrative|dialogue|dialog|ending|endings)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(story|stories|writing|lore|character|characters|narrative|dialogue|dialog|ending|endings)\b', 'i')

UNION ALL
SELECT appid, 'Difficulty', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(difficult|difficulty|hard|hardest|challenging|challenge|challenges|punishing|brutal|easy|unfair)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(difficult|difficulty|hard|hardest|challenging|challenge|challenges|punishing|brutal|easy|unfair)\b', 'i')

UNION ALL
SELECT appid, 'Controls & Performance', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(controls|control|responsive|tight|clunky|bug|bugs|buggy|crash|crashes|crashing|performance|fps|optimization|optimized|optimisation)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(controls|control|responsive|tight|clunky|bug|bugs|buggy|crash|crashes|crashing|performance|fps|optimization|optimized|optimisation)\b', 'i')

UNION ALL
SELECT appid, 'Map & Navigation / Backtracking', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(map|maps|navigation|backtrack|backtracks|backtracking|lost|confusing|tedious|grind|grinding|grindy)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(map|maps|navigation|backtrack|backtracks|backtracking|lost|confusing|tedious|grind|grinding|grindy)\b', 'i')

UNION ALL
SELECT appid, 'Content & Length', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(content|length|hours|short|long|replay|replayability|replay value)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(content|length|hours|short|long|replay|replayability|replay value)\b', 'i')

UNION ALL
SELECT appid, 'Price & Value', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '\b(price|worth|value|cheap|expensive|overpriced|bargain)\b', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '\b(price|worth|value|cheap|expensive|overpriced|bargain)\b', 'i');

-- Rank candidates within (appid, aspect, sentiment) and keep the top K.
CREATE TEMP TABLE _aspectrev_ranked AS
SELECT *,
    row_number() OVER (
        PARTITION BY appid, aspect, voted_up
        ORDER BY votes_up DESC NULLS LAST, timestamp_created DESC NULLS LAST
    ) AS rn
FROM _aspectrev_matches
QUALIFY rn <= @ASPECT_REVIEWS_TOP_K@;

-- Locate a <=280-char excerpt window around the first matched keyword occurrence: find the
-- literal position of the first regexp_extract_all hit via strpos (falls back to the review
-- start when that lookup fails, e.g. NULL kw_matches[1] should not occur but is guarded).
CREATE TEMP TABLE _aspectrev_windowed AS
SELECT
    appid, aspect, voted_up, votes_up, playtime_minutes, timestamp_created, language,
    list_distinct(list_transform(kw_matches, x -> lower(x))) AS matched_keywords,
    review_text,
    length(review_text) AS text_len,
    CASE WHEN kw_matches[1] IS NOT NULL AND strpos(review_text, kw_matches[1]) > 0
         THEN GREATEST(1, strpos(review_text, kw_matches[1]) - 140)
         ELSE 1 END AS win_start
FROM _aspectrev_ranked;

CREATE TABLE mart_game_aspect_reviews AS
WITH body AS (
    SELECT *, trim(substr(review_text, win_start, 280)) AS excerpt_body,
        length(substr(review_text, win_start, 280)) AS body_len
    FROM _aspectrev_windowed
)
SELECT
    appid,
    aspect,
    CASE WHEN voted_up = 1 THEN 'praise' ELSE 'complaint' END AS sentiment,
    (CASE WHEN win_start > 1 THEN '…' ELSE '' END)
        || excerpt_body
        || (CASE WHEN win_start + body_len - 1 < text_len THEN '…' ELSE '' END) AS excerpt,
    matched_keywords,
    votes_up,
    playtime_minutes,
    CAST(to_timestamp(timestamp_created) AS DATE)::VARCHAR AS date,
    language
FROM body
ORDER BY appid, aspect, sentiment, votes_up DESC NULLS LAST;
