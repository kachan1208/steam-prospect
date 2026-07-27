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
--                              excerpt is the sentence/clause around the review's first matched
--                              keyword -- bounded by . ! ? ; or a newline, capped at
--                              @ASPECT_SENTENCE_CHARS@ chars each side so a run-on sentence can't
--                              explode it (falls back to the review start if a keyword position
--                              can't be located). Same eligible-game population as the teardown
--                              (games with >= @TEARDOWN_MIN_REVIEWS@ sampled English reviews).
--                              NOT joined to mart_game, mirroring mart_game_teardown.sql — the
--                              API 404s upstream via mart_game before this table is ever queried
--                              for a nonexistent appid.
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
-- ASPECT_LEXICON via @RX_*@ placeholders), emitted as a row per match (not a boolean column),
-- capturing every matched keyword occurrence (regexp_extract_all, group 1) so we can rank
-- candidates and later show "matched_keywords", AND (window_text) the sentence/clause around the
-- FIRST matched keyword occurrence -- bounded by . ! ? ; or a newline, capped at
-- @ASPECT_SENTENCE_CHARS@ chars each side (RE2 [^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}). This has to
-- happen HERE, per arm, while each branch still has its own @RX_*@ text on hand — the sentiment
-- window can't be reconstructed generically after the UNION ALL below has collapsed all 10 arms
-- down to a single `aspect` label column. Same regex shape (same @ASPECT_SENTENCE_CHARS@, same
-- @RX_*@ text) as _aspect_sentence_regex()/_aspect_window_sql() in build_marts.py builds for the
-- VADER scoring pass, so this excerpt window and the text actually scored can never drift apart.
--
-- PERFORMANCE (2026-07, mirrors build_marts.py's _aspect_window_sql /
-- _aspect_keyword_position_regex -- see that comment for the full rationale): the sentence regex
-- above runs on a small substr slice around the first keyword match, not the whole review_text --
-- computing it directly against the full body, up to 10x per review, is what blew this ETL step
-- from ~85min to ~5h. Each arm below first locates the match's character position (kw_pos, via a
-- lazy `^([\s\S]*?)(?:rx)` prefix capture -- NOT strpos() on the bare matched keyword text, which
-- ignores rx's own \b word-boundary anchors and can land on an earlier false position embedded
-- inside an unrelated word, e.g. "hard" inside "hardware"; and NOT a plain `.*?` prefix, since
-- RE2's `.` doesn't cross newlines and review text routinely has them before the first match),
-- then slices @ASPECT_WINDOW_SLICE_CHARS@ characters starting @ASPECT_WINDOW_SLICE_BEFORE@ chars
-- before it -- sized to always fully contain the up-to-@ASPECT_SENTENCE_CHARS@-per-side window a
-- full-text scan would have found, so kw_matches and window_text are byte-identical to the
-- pre-optimization output. The `regexp_replace(..., '^\s+... )` -- actually `'^\S+'` -- strips a
-- possibly mid-word-truncated leading fragment from the slice (when it doesn't start at the
-- review's true position 1): a \b boundary is satisfied at the very start of ANY string, so
-- without this, a slice that happens to start inside a word (e.g. "...most p|art you're..." cut
-- at the `|`) can make the sentence regex wrongly treat that fragment ("art you're...") as a
-- standalone keyword match it would never match in the unsliced original text.
CREATE TEMP TABLE _aspectrev_matches AS
SELECT appid, recommendationid, 'Combat & Bosses' AS aspect, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_COMBAT@', 1, 'i') AS kw_matches,
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_COMBAT@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    ) AS window_text
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_COMBAT@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_COMBAT@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'World & Exploration', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_WORLD@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_WORLD@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_WORLD@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_WORLD@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Art & Visuals', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_ART@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_ART@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_ART@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_ART@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Music & Audio', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_MUSIC@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_MUSIC@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_MUSIC@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_MUSIC@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Story & Writing', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_STORY@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_STORY@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_STORY@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_STORY@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Difficulty', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_DIFFICULTY@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_DIFFICULTY@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_DIFFICULTY@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_DIFFICULTY@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Controls & Performance', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_CONTROLS@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_CONTROLS@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_CONTROLS@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_CONTROLS@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Map & Navigation / Backtracking', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_MAPNAV@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_MAPNAV@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_MAPNAV@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_MAPNAV@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Content & Length', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_CONTENT@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_CONTENT@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_CONTENT@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_CONTENT@', 'i')
)

UNION ALL
SELECT appid, recommendationid, 'Price & Value', voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
    regexp_extract_all(review_text, '@RX_PRICEVALUE@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_PRICEVALUE@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (
    SELECT appid, recommendationid, voted_up, review_text, votes_up, playtime_minutes, timestamp_created, language,
        length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_PRICEVALUE@)', 1, 'i')) + 1 AS kw_pos
    FROM _aspectrev_base
    WHERE regexp_matches(review_text, '@RX_PRICEVALUE@', 'i')
);

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

-- window_text (the sentence/clause around the first matched keyword — see the @RX_*@ branches
-- above) is already the exact excerpt body; here we just locate its offset in review_text via
-- strpos so the final SELECT knows whether to prefix/suffix an ellipsis (i.e. whether the
-- excerpt starts/ends mid-review rather than at a real sentence boundary that happens to be the
-- text's own start/end). Falls back to a plain lead substring in the should-never-happen case of
-- a NULL window_text (the WHERE filter above guarantees the wrapping regex matches wherever the
-- bare keyword regex does, so this is defensive, not expected to fire).
CREATE TEMP TABLE _aspectrev_windowed AS
SELECT
    appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language,
    list_distinct(list_transform(kw_matches, x -> lower(x))) AS matched_keywords,
    review_text,
    length(review_text) AS text_len,
    COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
    strpos(review_text, window_text) AS win_start
FROM _aspectrev_ranked;

CREATE TABLE mart_game_aspect_reviews AS
SELECT
    appid,
    aspect,
    sentiment,
    (CASE WHEN win_start > 1 THEN '…' ELSE '' END)
        || trim(excerpt_body)
        || (CASE WHEN win_start > 0 AND win_start + length(excerpt_body) - 1 < text_len THEN '…' ELSE '' END) AS excerpt,
    matched_keywords,
    votes_up,
    playtime_minutes,
    CAST(to_timestamp(timestamp_created) AS DATE)::VARCHAR AS date,
    language
FROM _aspectrev_windowed
ORDER BY appid, aspect, sentiment, votes_up DESC NULLS LAST;
