-- mart_game_aspect_reviews.sql
-- Aspect drill-down: the representative review excerpts behind each Game Teardown aspect
-- bar, split by TEXT sentiment (positive vs. negative about the aspect). Powers
-- GET /api/games/{appid}/aspect-reviews — click a bar in the teardown and read the actual
-- reviews behind the percentage.
--
-- Reuses the IDENTICAL aspect lexicon (10 aspects), review floor (@TEARDOWN_MIN_REVIEWS@
-- sampled English reviews/game) and English-only filter as mart_game_teardown.sql, so a
-- drill-down excerpt always matches what the aggregate bar shows. The keyword regexes render
-- from the single source of truth ASPECT_LEXICON in build_marts.py (via @RX_*@ placeholders) —
-- the same lexicon that mines the vote flags AND the text-sentiment windows, so a keyword change
-- in one place moves everything together.
--
-- Each excerpt's praise/complaint label is the SIGN of its precomputed VADER compound
-- (stg_aspect_mention_sentiment, scored over the SAME window shown below), NOT the reviewer's
-- overall thumbs-up/down vote — so a thumbs-up review that criticizes this aspect correctly
-- lands under "complaint" here, matching the text-sentiment bar in the teardown.
--
--   mart_game_aspect_reviews  per (appid, aspect, sentiment IN ('praise','complaint')): up
--                              to @ASPECT_REVIEWS_TOP_K@ representative excerpts, ranked by
--                              votes_up DESC then recency (timestamp_created DESC). Each
--                              excerpt is a <=@ASPECT_SENTIMENT_WINDOW@-char window around the
--                              review's first matched keyword (falls back to the review start
--                              if a keyword position can't be located). Same eligible-game
--                              population as the teardown (games with >= @TEARDOWN_MIN_REVIEWS@
--                              sampled English reviews). NOT joined to mart_game, mirroring
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
SELECT r.appid, r.recommendationid, r.voted_up, r.review_text, r.votes_up,
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
-- recommendationid is carried so each mention can join to its precomputed VADER sentiment.
CREATE TEMP TABLE _aspectrev_base AS
SELECT t.appid, t.recommendationid, t.voted_up, t.review_text, t.votes_up, t.playtime_minutes,
    t.timestamp_created, t.language
FROM _aspectrev_text t
JOIN _aspectrev_elig e ON e.appid = t.appid;

-- One row per (review, matched aspect) — same lexicon as everywhere (rendered from
-- ASPECT_LEXICON via @RX_*@ placeholders), emitted as a row per match (not a boolean column)
-- and capturing every matched keyword occurrence (regexp_extract_all, group 1) so we can rank
-- candidates and later show "matched_keywords" + locate an excerpt window around the first hit.
CREATE TEMP TABLE _aspectrev_matches AS
SELECT appid, recommendationid, 'Combat & Bosses' AS aspect, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_COMBAT@', 1, 'i') AS kw_matches
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_COMBAT@', 'i')

UNION ALL
SELECT appid, recommendationid, 'World & Exploration', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_WORLD@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_WORLD@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Art & Visuals', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_ART@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_ART@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Music & Audio', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_MUSIC@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_MUSIC@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Story & Writing', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_STORY@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_STORY@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Difficulty', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_DIFFICULTY@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_DIFFICULTY@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Controls & Performance', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_CONTROLS@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_CONTROLS@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Map & Navigation / Backtracking', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_MAPNAV@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_MAPNAV@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Content & Length', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_CONTENT@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_CONTENT@', 'i')

UNION ALL
SELECT appid, recommendationid, 'Price & Value', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_PRICEVALUE@', 1, 'i')
FROM _aspectrev_base
WHERE regexp_matches(review_text, '@RX_PRICEVALUE@', 'i');

-- Classify each mention praise/complaint by the SIGN of its precomputed VADER compound
-- (stg_aspect_mention_sentiment — scored over the SAME window shown below, in build_marts.py),
-- so the columns split by what the TEXT says about the aspect, not the reviewer's overall vote.
-- LEFT JOIN + a vote-based fallback (compound=+1 for a thumbs-up, -1 for a thumbs-down) covers
-- the should-never-happen case of a mention with no sentiment row, so no excerpt is dropped.
CREATE TEMP TABLE _aspectrev_scored AS
SELECT m.*,
    CASE WHEN COALESCE(s.compound, CASE WHEN m.voted_up = 1 THEN 1.0 ELSE -1.0 END) >= 0
         THEN 'praise' ELSE 'complaint' END AS sentiment
FROM _aspectrev_matches m
LEFT JOIN stg_aspect_mention_sentiment s
    ON s.appid = m.appid AND s.recommendationid = m.recommendationid AND s.aspect = m.aspect;

-- Rank candidates within (appid, aspect, sentiment) and keep the top K (helpful, then recent).
CREATE TEMP TABLE _aspectrev_ranked AS
SELECT *,
    row_number() OVER (
        PARTITION BY appid, aspect, sentiment
        ORDER BY votes_up DESC NULLS LAST, timestamp_created DESC NULLS LAST
    ) AS rn
FROM _aspectrev_scored
QUALIFY rn <= @ASPECT_REVIEWS_TOP_K@;

-- Locate a <=@ASPECT_SENTIMENT_WINDOW@-char excerpt window around the first matched keyword
-- occurrence: find the literal position of the first regexp_extract_all hit via strpos (falls
-- back to the review start when that lookup fails, e.g. NULL kw_matches[1] shouldn't occur but
-- is guarded). Window size = the same @ASPECT_SENTIMENT_*@ constants the sentiment was scored
-- over, so an excerpt's praise/complaint label describes exactly the text displayed.
CREATE TEMP TABLE _aspectrev_windowed AS
SELECT
    appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language,
    list_distinct(list_transform(kw_matches, x -> lower(x))) AS matched_keywords,
    review_text,
    length(review_text) AS text_len,
    CASE WHEN kw_matches[1] IS NOT NULL AND strpos(review_text, kw_matches[1]) > 0
         THEN GREATEST(1, strpos(review_text, kw_matches[1]) - @ASPECT_SENTIMENT_LEAD@)
         ELSE 1 END AS win_start
FROM _aspectrev_ranked;

CREATE TABLE mart_game_aspect_reviews AS
WITH body AS (
    SELECT *, trim(substr(review_text, win_start, @ASPECT_SENTIMENT_WINDOW@)) AS excerpt_body,
        length(substr(review_text, win_start, @ASPECT_SENTIMENT_WINDOW@)) AS body_len
    FROM _aspectrev_windowed
)
SELECT
    appid,
    aspect,
    sentiment,
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
