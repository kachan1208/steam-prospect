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
-- OPEN THE WHOLE REVIEW (added 2026-08-21): the excerpt above is one sentence around ONE keyword,
-- which is the right thing to SHOW but a bad place to stop — readers want the argument the
-- sentence came from. Two columns carry that, threaded down the SAME base -> surv -> matched ->
-- windowed path the excerpt already takes (no re-join to src.reviews at the end: the row's own
-- review_text is already in hand by then, and re-joining would re-scan the ~2M-row pool the
-- performance note below exists to avoid):
--
--   review_text  the review's FULL text, truncated to 2000 characters INCLUDING the ellipsis
--                -- i.e. length(review_text) <= 2000 always. When it is cut,
--                the last character is '…' so the UI can say "truncated" honestly instead of
--                trailing off mid-word with no signal. NULL only if the source text is NULL,
--                which the base pool's IS NOT NULL filter already makes impossible.
--
--                WHY A CAP, AND WHY 2000: uncapped this column is ~530MB of raw text bolted onto
--                a 557MB mart, on a 3.9GB droplet -- English reviews average ~340 chars but the
--                tail is extreme (the longest single review in the source is 9.6MB, one row that
--                alone would dwarf every excerpt in the table). 2000 chars keeps ~97% of reviews
--                whole and bounds the worst row at 2KB. The constant is INLINE rather than a
--                build_marts.py placeholder, deliberately: it is a storage-budget decision about
--                THIS table, and nothing else in the ETL reads it. Do not raise it without
--                re-measuring the mart size against the droplet's disk.
--
--   steam_url    permalink to the review on Steam:
--                https://steamcommunity.com/profiles/<author_steamid>/recommended/<appid>/
--                NULL when author_steamid is NULL (plain `||` propagates the NULL, so the column
--                is either a complete URL or nothing -- never a half-built one). No such row
--                exists in the current source (0 NULL and 0 empty of 4.37M reviews), but the
--                column is nullable in the contract and the API/web must treat it that way.
--
-- PERFORMANCE (2026-07-29): this step used to re-run the full 10-arm keyword scan
-- (regexp_matches over ALL ~2M eligible English reviews, plus a per-match position capture and
-- window extract) to REDISCOVER which review mentions which aspect — ~70 min, and by far the
-- slowest thing in the ETL. But compute_aspect_sentiment() already did exactly that scan (its
-- _aspect_window_sql is the SAME 10-arm regexp_matches over the SAME eligible pool, one row per
-- (review, aspect) match) and cached the result in stg_aspect_mention_sentiment — INCREMENTALLY,
-- scoring only reviews new since the last run. So the mention set here is provably identical to
-- what a fresh 10-arm scan would produce; re-deriving it was pure duplicated work. We now READ
-- the mentions from that table, rank them (cheap — no text, no regex), and defer the expensive
-- excerpt regex to the <= @ASPECT_REVIEWS_TOP_K@ survivors PER (appid, aspect, sentiment) only.
-- The kw_pos / window slice / sentence regex applied to those survivors is byte-for-byte the same
-- expression as before (and as _aspect_window_sql), run over the same full review_text, so the
-- excerpts are unchanged — only the ~2M-row rediscovery scan is gone.
--
-- Placeholder tokens are substituted by build_marts.py.

DROP TABLE IF EXISTS mart_game_aspect_reviews;

-- Eligible-game English review pool with the ranking meta + full text, materialized ONCE from
-- SQLite (identical population + floor to _sent_pool in compute_aspect_sentiment and to
-- stg_review_text / _teardown_elig). recommendationid joins each cached mention back to its
-- helpfulness/recency (for ranking) and its review_text (for the survivor's excerpt window).
CREATE TEMP TABLE _aspectrev_elig AS
SELECT appid FROM src.reviews
WHERE language = 'english' AND review_text IS NOT NULL AND length(trim(review_text)) > 0
GROUP BY appid HAVING COUNT(*) >= @TEARDOWN_MIN_REVIEWS@;

-- author_steamid rides along here (and only here) because it is the other half of the permalink;
-- it is a ~17-char id, so unlike review_text it costs nothing to carry through the pool.
CREATE TEMP TABLE _aspectrev_base AS
SELECT r.appid, r.recommendationid, r.review_text, r.author_steamid, r.votes_up,
    COALESCE(r.playtime_at_review, r.playtime_forever) AS playtime_minutes,
    r.timestamp_created, r.language
FROM src.reviews r
JOIN _aspectrev_elig e ON e.appid = r.appid
WHERE r.language = 'english' AND r.review_text IS NOT NULL AND length(trim(r.review_text)) > 0;

-- The ranking below must NOT touch review_text — the mentions join is ~1.5M rows and the window
-- sort orders them, so a single review_text column dragged along turns into a multi-hundred-MB
-- hash table / sort spill and blows the step's runtime right back up (learned the hard way: an
-- earlier cut of this that ranked straight off _aspectrev_base spilled ~0.8GB and ran for 20min+).
-- Relying on the optimizer to project the column out through a join + window did NOT hold, so we
-- force it with a materialized barrier: a LEAN copy of just the ranking meta (no text). The rank
-- reads only this; review_text is re-attached to the handful of survivors afterwards.
-- author_steamid is kept out of here for the same reason (it is not a ranking input); like
-- review_text it is re-attached from _aspectrev_base to the survivors below.
CREATE TEMP TABLE _aspectrev_meta AS
SELECT appid, recommendationid, votes_up, playtime_minutes, timestamp_created, language
FROM _aspectrev_base;

-- Rank the ALREADY-COMPUTED mentions (stg_aspect_mention_sentiment: one row per (review, aspect)
-- match, same lexicon/pool as a fresh 10-arm scan — see the PERFORMANCE note above) by helpfulness
-- then recency, and keep the top @ASPECT_REVIEWS_TOP_K@ per (appid, aspect, sentiment). A mention
-- splits by what the TEXT says about the aspect, not the reviewer's overall vote.
--
-- NEUTRAL BAND (fixed 2026-08-19): this used to split on the bare SIGN of the compound
-- (>= 0 -> praise), which had no neutral band at all — so every mention VADER scored at exactly
-- 0.0 was filed as PRAISE. That is not a rounding detail: 16.1% of all cached mentions (236,512
-- of 1,464,649) score exactly 0.0, because the domain lexicon deliberately neutralizes the very
-- words that carry the aspect ("combat", "fight", "brutal", "horror" -> 0), so a mention whose
-- window contains nothing else scores dead zero. Sampled output was visibly wrong: neutral
-- descriptions and outright complaints ("you can walk for under half a minute ... and hit the edge
-- of the entire game map") were being shown to users as praise.
-- Now the SAME +/-0.05 band the count columns already use (SENTIMENT_POS/NEG_THRESHOLD, VADER's
-- own standard cutoffs) applies here, and mentions inside the band are DROPPED rather than
-- relabelled: the excerpt contract is two-valued (praise|complaint) in the REST Literal, the MCP
-- tool and the web's two-column layout, and text_pos_share already excludes neutrals — so
-- excluding them is what makes the excerpts agree with the bars above them.
CREATE TEMP TABLE _aspectrev_ranked AS
-- SOURCE OF THE LABEL (changed 2026-08-21): the split is now the model's sentiment head
-- (stg_aspect_mention_sentiment.text_sentiment), not the sign of VADER's compound. The band
-- described below still exists — it is the fallback inside text_sentiment when no model verdict
-- was stored — but it no longer decides the common case. On a blind 120-window sample VADER
-- matched a human read 65.8% of the time against the head's 81.7%, winning 28 disagreements to 9:
-- VADER scores words, so "not worth full price" and "the boss and the ending are not so cool"
-- both came out as praise.
SELECT m.appid, m.recommendationid, s.aspect, s.kw_aspect,
    s.text_sentiment AS sentiment,
    m.votes_up, m.playtime_minutes, m.timestamp_created, m.language,
    row_number() OVER (
        PARTITION BY m.appid, s.aspect, s.text_sentiment
        ORDER BY m.votes_up DESC NULLS LAST, m.timestamp_created DESC NULLS LAST
    ) AS rn
FROM stg_aspect_mention_sentiment s
JOIN _aspectrev_meta m ON m.appid = s.appid AND m.recommendationid = s.recommendationid
-- Drop neutrals BEFORE ranking, so a neutral mention can never occupy one of the
-- @ASPECT_REVIEWS_TOP_K@ slots that should hold a genuinely positive or negative excerpt.
WHERE s.text_sentiment IN ('praise', 'complaint')
QUALIFY rn <= @ASPECT_REVIEWS_TOP_K@;

DROP TABLE _aspectrev_meta;

-- Attach review_text (and author_steamid, for the permalink) to the survivors ONLY (a few per
-- group). Survivors are small, so this is a hash-join with the survivors on the build side,
-- streaming _aspectrev_base past it — no text sort. Then drop the big pool so it doesn't sit in
-- memory through the windowing below.
CREATE TEMP TABLE _aspectrev_surv AS
SELECT r.appid, r.recommendationid, r.aspect, r.kw_aspect, r.sentiment,
    r.votes_up, r.playtime_minutes, r.timestamp_created, r.language,
    b.review_text, b.author_steamid
FROM _aspectrev_ranked r
JOIN _aspectrev_base b ON b.appid = r.appid AND b.recommendationid = r.recommendationid;

DROP TABLE _aspectrev_base;

-- Per-aspect excerpt window, computed on the survivors only. Each arm handles one aspect's
-- survivors (WHERE aspect = '<label>' — no regexp_matches filter needed, they already matched)
-- and applies that aspect's own @RX_*@ keyword regex. This has to stay per-arm because each
-- branch needs its own @RX_*@ text on hand for the window regex; the aspect label alone (after the
-- UNION ALL collapses all 10 arms) can't reconstruct it. The kw_matches / kw_pos / window slice /
-- sentence regex are byte-for-byte identical to the pre-optimization version AND to
-- _aspect_window_sql() / _aspect_keyword_position_regex() in build_marts.py (same
-- @ASPECT_SENTENCE_CHARS@, same @ASPECT_WINDOW_SLICE_BEFORE@/@ASPECT_WINDOW_SLICE_CHARS@, same
-- @RX_*@), run over the same full review_text — so every excerpt is unchanged. See build_marts.py
-- for the full rationale on the lazy `^([\s\S]*?)(?:rx)` position capture (NOT strpos — respects
-- rx's \b anchors and crosses newlines) and the `^\S+` mid-word-fragment strip.
CREATE TEMP TABLE _aspectrev_matched AS
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_COMBAT@', 1, 'i') AS kw_matches,
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_COMBAT@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    ) AS window_text
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_COMBAT@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Combat & Bosses')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_WORLD@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_WORLD@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_WORLD@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'World & Exploration')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_ART@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_ART@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_ART@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Art & Visuals')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_MUSIC@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_MUSIC@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_MUSIC@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Music & Audio')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_STORY@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_STORY@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_STORY@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Story & Writing')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_DIFFICULTY@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_DIFFICULTY@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_DIFFICULTY@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Difficulty')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_CONTROLS@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_CONTROLS@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_CONTROLS@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Controls & Performance')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_MAPNAV@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_MAPNAV@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_MAPNAV@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Map & Navigation / Backtracking')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_CONTENT@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_CONTENT@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_CONTENT@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Content & Length')

UNION ALL
SELECT appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language, review_text, author_steamid,
    regexp_extract_all(review_text, '@RX_PRICEVALUE@', 1, 'i'),
    regexp_extract(
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END,
        '[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_PRICEVALUE@)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
    )
FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_PRICEVALUE@)', 1, 'i')) + 1 AS kw_pos
      FROM _aspectrev_surv WHERE kw_aspect = 'Price & Value');

DROP TABLE _aspectrev_surv;

-- Locate the window's offset in review_text (strpos) so the final SELECT knows whether to
-- prefix/suffix an ellipsis (i.e. whether the excerpt starts/ends mid-review rather than at the
-- text's own start/end). Falls back to a plain lead substring in the should-never-happen case of
-- a NULL window_text. Identical to the previous version's _aspectrev_windowed step, plus the two
-- open-the-whole-review columns (see the header): this is the LAST step that still has the full
-- review_text in hand, so the 2000-char cap is applied here rather than downstream.
--
-- The cap is expressed as substr(..., 1, 1999) || '…' on purpose: the emitted value is at most
-- 2000 characters INCLUDING the ellipsis, so "capped at 2000" is a fact about the column the API
-- serves, not about some intermediate the ellipsis then overflows. length() and substr() are
-- DuckDB's CHARACTER-based (not byte-based) functions, so the cap counts what a reader counts and
-- can never split a multi-byte codepoint.
CREATE TEMP TABLE _aspectrev_windowed AS
SELECT
    appid, aspect, sentiment, votes_up, playtime_minutes, timestamp_created, language,
    list_distinct(list_transform(kw_matches, x -> lower(x))) AS matched_keywords,
    length(review_text) AS text_len,
    COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
    strpos(review_text, window_text) AS win_start,
    CASE WHEN length(review_text) > 2000
         THEN substr(review_text, 1, 1999) || '…'
         ELSE review_text
    END AS full_text,
    -- NULL-propagating concatenation: a NULL author_steamid yields a NULL steam_url, never a
    -- .../profiles//recommended/... link that 404s on Steam.
    'https://steamcommunity.com/profiles/' || author_steamid
        || '/recommended/' || appid || '/' AS steam_url
FROM _aspectrev_matched;

-- The pool is done with: _aspectrev_matched holds the UNCAPPED review_text for every survivor,
-- and _aspectrev_windowed now holds a capped copy of the same text. Dropping it here keeps only
-- one full-text-sized structure alive while the final table is written, instead of three.
DROP TABLE _aspectrev_matched;

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
    language,
    full_text AS review_text,
    steam_url
FROM _aspectrev_windowed
ORDER BY appid, aspect, sentiment, votes_up DESC NULLS LAST;

DROP TABLE _aspectrev_windowed;
