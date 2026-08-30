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
-- sentence came from. Two columns carry that:
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
--                Both columns are attached LAST, by a keyed join on (appid, recommendationid)
--                against _aspectrev_text -- see "ATTACH THE TEXT LAST" below.
--
-- PERFORMANCE (2026-07): this step used to re-run the full 10-arm keyword scan
-- (regexp_matches over ALL ~2M eligible English reviews, plus a per-match position capture and
-- window extract) to REDISCOVER which review mentions which aspect — ~70 min, and by far the
-- slowest thing in the ETL. But compute_aspect_sentiment() already did exactly that scan (its
-- _aspect_window_sql is the SAME 10-arm regexp_matches over the SAME eligible pool, one row per
-- (review, aspect) match) and cached the result in stg_aspect_mention_sentiment — INCREMENTALLY,
-- scoring only reviews new since the last run. So the mention set here is provably identical to
-- what a fresh 10-arm scan would produce; re-deriving it was pure duplicated work. We now READ
-- the mentions from that table, rank them (cheap — no text, no regex), and defer the expensive
-- excerpt regex to the <= @ASPECT_REVIEWS_TOP_K@ survivors PER (appid, aspect, sentiment) only.
--
-- PERFORMANCE (2026-08-28) — WHERE THE 4 HOURS ACTUALLY WENT. On the 2026-08-22 nightly this one
-- file cost 14,239s of an 18,276s ETL. Profiling it statement by statement against a synthetic
-- corpus of the same shape puts 99.8% of that in ONE expression: the sentence-window
-- `regexp_extract` in the ten arms below. The final `ORDER BY` — the obvious suspect, since it
-- drags 2KB/row of review_text through a sort under a 2500MB memory limit — measured 1.7s at
-- production row counts. It was never the bottleneck.
--
-- The bottleneck is RE2. The window pattern is
--     [^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}(?:<keyword alternation>)[^.!?;\n]{0,@ASPECT_SENTENCE_CHARS@}
-- and RE2 compiles a bounded repeat by UNROLLING it: 2 x @ASPECT_SENTENCE_CHARS@ copies of a
-- negated (therefore multi-range, in UTF-8 mode) character class. On a program that size the lazy
-- DFA blows its state budget and thrashes, and `regexp_extract` -- which needs match BOUNDARIES,
-- not just a yes/no -- falls back to RE2's NFA simulation. Measured on real-shaped review text,
-- identical pattern, identical input, cost per row against the bound:
--     {0,5} 0.6us   {0,20} 2.7us   {0,40} 13us   {0,80} 161us   {0,160} 767us   {0,320} 1992us
-- 767us x ~1.77M surviving rows is hours, and all of it is one regex call.
--
-- THE REWRITE (identical output; it rests on two facts):
--   1. The whole match is boundary-free. Every keyword alternative is made of word characters,
--      hyphens and spaces, and both context clauses are [^.!?;\n] — so a match can never contain
--      '.', '!', '?', ';' or a newline. It therefore lies ENTIRELY inside one maximal
--      boundary-free run of the slice: the run holding the FIRST keyword occurrence (earlier runs
--      contain no keyword, and a match cannot cross a boundary character to reach a later one).
--      Restricting the search to that run is exact. The run's edges are cut at boundary
--      characters (or at the slice's own ends), all of them NON-WORD, so the \b anchors inside the
--      keyword regex see exactly the neighbours they saw in the full slice.
--   2. INSIDE that run, [^.!?;\n] and [\s\S] are the same character class — the run contains no
--      boundary character by construction. Swapping in [\s\S] cannot change the match, and it
--      collapses the compiled program: [\s\S] is one "any rune", not a multi-range negation.
-- The run is found with two ANCHORED, alternation-free extractions (`^[^.!?;\n]*`, ~0.4us each,
-- one of them over a reversed prefix to get the left half), and the window is then cut out of it
-- by a single ANCHORED pattern — anchoring also removes RE2's start-position scan. The leading
-- `[\s\S]` in that pattern is a one-character sentinel: it carries the character that precedes the
-- leftmost legal match start, so the keyword regex's opening \b is evaluated against the SAME
-- neighbour it had in the slice. It is stripped back off with substr(..., 2). Where the match may
-- legally start at the run's first character, a space stands in for that neighbour (a space and a
-- string start are indistinguishable to \b). `[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}` is exactly
-- the original greedy left clause plus that sentinel, so the greedy choice of WHICH keyword
-- occurrence the window is cut around is preserved too.
-- Measured: 767us -> ~15us per row on this expression (44x), and a differential fuzz of 300k
-- adversarial slices x all 10 arms (keyword at the string edges, hugged by boundary characters, at
-- exactly 159/160/161 characters from one, repeated inside a clause, multi-word keywords,
-- multi-byte text, runs with no boundary at all, no keyword at all) returns ZERO differences
-- against the old expression. See etl/tests/test_mart_aspect_reviews_window_rewrite.py, which
-- re-derives the OLD expression from the same ASPECT_LEXICON and diffs it row for row.
--
-- ATTACH THE TEXT LAST (2026-08-28): the ten arms no longer carry review_text/steam_url, and the
-- windowing columns (slice / kw_off / clause_l / clause_r / window_text) are projected away at the
-- UNION ALL boundary. _aspectrev_matched is therefore a few hundred bytes/row of excerpt and
-- ranking meta instead of ~2.7KB/row — it was the multi-GB intermediate behind the 20GB scratch
-- peak, the disk filled to 91% and at least one OOM. The capped text and the permalink are built
-- ONCE into _aspectrev_text, keyed by (appid, recommendationid), and joined on at the very end.
-- NOTE the final ORDER BY stays where it is, ON THE JOINED ROW. A join does NOT preserve its probe
-- side's order in DuckDB (measured: a hash join reorders, and the optimizer is free to build on
-- either side), so sorting the lean table first and joining the text on afterwards would silently
-- change the published mart's physical row order. The sort costs ~1.7s; keep it honest.
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
-- review_text it is re-attached from _aspectrev_base below.
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
        -- recommendationid is the DETERMINISTIC TIEBREAK, and it is load-bearing (2026-08-30).
        -- votes_up + timestamp_created are not unique: plenty of groups have several reviews
        -- with the same vote count and the same second, and row_number() then picked among
        -- them arbitrarily. Measured on 120K real reviews: the SAME sql over the SAME input
        -- returned different reviews on consecutive runs, and different again at threads=1
        -- vs 4. So this mart has been CHURNING nightly — the aspect drill-down showed a
        -- different "top review" for unchanged data, which reads as fresh insight and is not.
        -- Any total order fixes it; recommendationid is unique per review and already in scope.
        ORDER BY m.votes_up DESC NULLS LAST, m.timestamp_created DESC NULLS LAST,
                 m.recommendationid
    ) AS rn
FROM stg_aspect_mention_sentiment s
JOIN _aspectrev_meta m ON m.appid = s.appid AND m.recommendationid = s.recommendationid
-- Drop neutrals BEFORE ranking, so a neutral mention can never occupy one of the
-- @ASPECT_REVIEWS_TOP_K@ slots that should hold a genuinely positive or negative excerpt.
WHERE s.text_sentiment IN ('praise', 'complaint')
QUALIFY rn <= @ASPECT_REVIEWS_TOP_K@;

DROP TABLE _aspectrev_meta;

-- The capped-text + permalink side table: ONE row per surviving (appid, recommendationid), built
-- straight off the pool while it is still in hand. Keyed by review rather than by mention because
-- a review that mentions three aspects is three rows downstream but one review here — so this is
-- strictly smaller than the excerpt table it is joined to, and it is the ONLY structure in the
-- step that holds the 2000-char text. (appid, recommendationid) is the same key
-- _aspectrev_meta / _aspectrev_base are already joined on above (a duplicate would fan the ranking
-- out too, so its uniqueness is a pre-existing assumption of this file, not a new one), and the
-- DISTINCT below is over the LEAN ranked table, so no text is aggregated to get here.
CREATE TEMP TABLE _aspectrev_text AS
SELECT b.appid, b.recommendationid,
    CASE WHEN length(b.review_text) > 2000
         THEN substr(b.review_text, 1, 1999) || '…'
         ELSE b.review_text
    END AS review_text,
    'https://steamcommunity.com/profiles/' || b.author_steamid
        || '/recommended/' || b.appid || '/' AS steam_url
FROM _aspectrev_base b
JOIN (SELECT DISTINCT appid, recommendationid FROM _aspectrev_ranked) k
  ON k.appid = b.appid AND k.recommendationid = b.recommendationid;

-- Attach review_text to the survivors ONLY (a few per group). Survivors are small, so this is a
-- hash-join with the survivors on the build side, streaming _aspectrev_base past it — no text
-- sort. Then drop the big pool so it doesn't sit in memory through the windowing below.
-- author_steamid is NOT carried here any more: the permalink is built once in _aspectrev_text
-- above, and the ten arms below never look at it.
CREATE TEMP TABLE _aspectrev_surv AS
SELECT r.appid, r.recommendationid, r.aspect, r.kw_aspect, r.sentiment,
    r.votes_up, r.playtime_minutes, r.timestamp_created, r.language,
    b.review_text
FROM _aspectrev_ranked r
JOIN _aspectrev_base b ON b.appid = r.appid AND b.recommendationid = r.recommendationid;

DROP TABLE _aspectrev_base;

-- Per-aspect excerpt window, computed on the survivors only. Each arm derives, in ONE SELECT via
-- DuckDB lateral column aliases (each evaluated once — verified, they are not re-inlined):
--
--   kw_pos      1-based character position of the FIRST keyword match in the FULL review, via the
--               lazy `^([\s\S]*?)(?:rx)` prefix capture (NOT strpos — it respects rx's \b anchors
--               and crosses newlines). The same idiom as _aspect_keyword_position_regex() in
--               build_marts.py.
--   slice       the generously-bounded window of review_text around kw_pos that the sentence
--               regex used to run over: @ASPECT_WINDOW_SLICE_BEFORE@ characters before it,
--               @ASPECT_WINDOW_SLICE_CHARS@ long, with a leading mid-word fragment stripped
--               (`^\S+`) so the slice always begins at a word boundary. Unchanged.
--   kw_off      that same first-keyword position, but WITHIN the slice.
--   clause_l    the maximal run of non-boundary characters ending just before kw_off (found on the
--               REVERSED prefix, so one anchored `^[^.!?;\n]*` does it), and
--   clause_r    the maximal run starting at kw_off. clause_l || clause_r is the boundary-free
--               clause the window must live inside — see PERFORMANCE (2026-08-28) above for why
--               that restriction is exact and why it is what makes this step affordable.
--   window_text the excerpt window: the original greedy @ASPECT_SENTENCE_CHARS@-per-side clause
--               regex, run ANCHORED on that clause behind a one-character sentinel (stripped back
--               off by substr(..., 2)). Empty string when the slice holds no keyword at all —
--               which is exactly what the un-anchored search returned in that case too.
--
-- matched_keywords is extracted from the ~300-char excerpt window, not the full review: the chips
-- it feeds exist to explain the excerpt the user is LOOKING AT, so scoping them to it is also the
-- more honest semantics (a keyword mentioned 3 paragraphs away no longer shows as a chip).
--
-- The outer projection is not cosmetic: it drops slice / kw_off / clause_l / clause_r /
-- window_text at the UNION ALL boundary, so none of them is ever materialized into
-- _aspectrev_matched. Only excerpt_body (<= 2 x @ASPECT_SENTENCE_CHARS@ chars) survives, which is
-- all the final SELECT needs.
CREATE TEMP TABLE _aspectrev_matched AS
SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
    timestamp_created, language, excerpt_body, win_start, text_len, matched_keywords
FROM (
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_COMBAT@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_COMBAT@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_COMBAT@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_COMBAT@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_COMBAT@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Combat & Bosses')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_WORLD@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_WORLD@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_WORLD@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_WORLD@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_WORLD@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'World & Exploration')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_ART@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_ART@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_ART@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_ART@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_ART@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Art & Visuals')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_MUSIC@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_MUSIC@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_MUSIC@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_MUSIC@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_MUSIC@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Music & Audio')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_STORY@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_STORY@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_STORY@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_STORY@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_STORY@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Story & Writing')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_DIFFICULTY@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_DIFFICULTY@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_DIFFICULTY@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_DIFFICULTY@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_DIFFICULTY@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Difficulty')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_CONTROLS@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_CONTROLS@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_CONTROLS@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_CONTROLS@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_CONTROLS@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Controls & Performance')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_MAPNAV@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_MAPNAV@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_MAPNAV@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_MAPNAV@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_MAPNAV@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Map & Navigation / Backtracking')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_CONTENT@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_CONTENT@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_CONTENT@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_CONTENT@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_CONTENT@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Content & Length')

    UNION ALL
    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@ > 1
             THEN regexp_replace(substr(review_text, kw_pos - @ASPECT_WINDOW_SLICE_BEFORE@, @ASPECT_WINDOW_SLICE_CHARS@), '^\S+', '')
             ELSE substr(review_text, 1, @ASPECT_WINDOW_SLICE_CHARS@)
        END AS slice,
        length(regexp_extract(slice, '^([\s\S]*?)(?:@RX_PRICEVALUE@)', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '@RX_PRICEVALUE@', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > @ASPECT_SENTENCE_CHARS@
                           THEN substr(clause_l || clause_r, length(clause_l) - @ASPECT_SENTENCE_CHARS@)
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\s\S][\s\S]{0,@ASPECT_SENTENCE_CHARS@}(?:@RX_PRICEVALUE@)[\s\S]{0,@ASPECT_SENTENCE_CHARS@}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * @ASPECT_SENTENCE_CHARS@)) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '@RX_PRICEVALUE@', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\s\S]*?)(?:@RX_PRICEVALUE@)', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = 'Price & Value')
);

DROP TABLE _aspectrev_surv;

CREATE TABLE mart_game_aspect_reviews AS
SELECT
    m.appid,
    m.aspect,
    m.sentiment,
    (CASE WHEN m.win_start > 1 THEN '…' ELSE '' END)
        || trim(m.excerpt_body)
        || (CASE WHEN m.win_start > 0 AND m.win_start + length(m.excerpt_body) - 1 < m.text_len THEN '…' ELSE '' END) AS excerpt,
    m.matched_keywords,
    m.votes_up,
    m.playtime_minutes,
    CAST(to_timestamp(m.timestamp_created) AS DATE)::VARCHAR AS date,
    m.language,
    t.review_text,
    t.steam_url
FROM _aspectrev_matched m
LEFT JOIN _aspectrev_text t
       ON t.appid = m.appid AND t.recommendationid = m.recommendationid
-- Same reasoning as the ranking window above: without a unique final key the STORED row order
-- varies run to run, which makes the mart impossible to diff against yesterday's and defeats
-- any content-level validation.
ORDER BY m.appid, m.aspect, m.sentiment, m.votes_up DESC NULLS LAST, m.recommendationid;

DROP TABLE _aspectrev_matched;
DROP TABLE _aspectrev_text;
