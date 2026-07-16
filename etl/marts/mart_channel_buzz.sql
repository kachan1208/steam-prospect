-- mart_channel_buzz.sql
-- Track M — reach-WEIGHTED trending game-concepts across ALL marketing channels (press +
-- creator platforms). Extends mart_press.sql's mart_buzz_trends/mart_buzz_trends_summary
-- (journalist article-title bigram mining) two ways: (1) folds in creator-mention titles
-- from every platform (YouTube video titles, Reddit post titles, Twitch stream titles, X
-- post text), tagged by `channel`; (2) weights each mention by audience size instead of
-- counting every mention equally, so a term one mega-creator is covering can outrank a term
-- with more, but smaller, mentions — see the weighting rule below.
--
--   mart_channel_buzz            per (term, channel, month): n_mentions (raw count) +
--                                 reach_weighted_score (see below). Lets the API/UI break a
--                                 term down by which channel(s) are actually carrying it.
--   mart_channel_buzz_summary    per term, ALL CHANNELS COMBINED: total_mentions,
--                                 total_weighted, recent/prior weighted averages -> slope ->
--                                 rising/cooling/flat, same windowing as mart_press's
--                                 buzz_trends_summary (last @BUZZ_RECENT_MONTHS@ complete
--                                 months vs. the @BUZZ_RECENT_MONTHS@ months before that).
--
-- Weighting: press articles contribute weight=1.0 per mention (outlets carry no audience-
-- size figure in this schema). Creator-platform mentions contribute weight = reach_at_time
-- (the creator's audience AT THE TIME of that mention — a real historical figure, not a live
-- one), falling back to the creator's most recent known reach snapshot, then to 1.0 if
-- neither exists yet. Because social-platform reach can run many orders of magnitude above a
-- "1 point per press mention" baseline, a single very-large channel can dominate
-- reach_weighted_score for a term — always show n_mentions (unweighted) and the per-channel
-- breakdown alongside it; read this as "who has the biggest megaphone on this concept," not
-- "how many people are discussing it."
--
-- Tokenization/concept-allowlist pipeline mirrors mart_press.sql's buzz mining EXACTLY (same
-- title normalization: lowercase -> strip apostrophes -> collapse non-letter/number runs to
-- one space -> adjacent-word bigrams -> stopword/denylist-filtered -> kept only if it matches
-- Steam's own tag/genre vocabulary). Re-derived here with a `_cb_`-prefixed temp-table
-- namespace — own staging, matching this repo's "each mart file owns its own staging"
-- convention (see mart_press.sql's header) — so this file has no load-order dependency on
-- mart_press.sql running first/at all. denylist_tag / denylist_genre / stopword /
-- denylist_buzz_term / denylist_buzz_word ARE shared globals (created once in
-- build_marts.py's create_staging(), same ones mart_press.sql itself reads).
--
-- Degrades gracefully: if the marketing source tables are absent/empty (see
-- create_marketing_staging() in build_marts.py), stg_game_creator_mention is empty, so this
-- mart falls back to press-only buzz (still real output, since the press corpus already
-- exists) — never a crash either way, and never empty outright unless the whole articles
-- corpus is also empty.

DROP TABLE IF EXISTS mart_channel_buzz;
DROP TABLE IF EXISTS mart_channel_buzz_summary;

-- ------------------------------------------------------------------------------------
-- Unified (title, published_at, weight, channel) rows from every source.
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _cb_press_rows AS
SELECT a.title, TRY_CAST(a.published_at AS TIMESTAMP) AS published_at, 1.0 AS weight, 'press' AS channel
FROM src.articles a
WHERE a.source != 'steam_news'
  AND a.title IS NOT NULL AND TRIM(a.title) != ''
  AND a.published_at IS NOT NULL;

CREATE TEMP TABLE _cb_creator_rows AS
SELECT cm.title, cm.published_at, COALESCE(cm.reach_at_time, rl.reach, 1)::DOUBLE AS weight, cm.platform AS channel
FROM stg_game_creator_mention cm
LEFT JOIN stg_creator_reach_latest rl ON rl.creator_id = cm.creator_id
WHERE cm.confidence >= @CREATOR_MIN_CONFIDENCE@
  AND cm.title IS NOT NULL AND TRIM(cm.title) != ''
  AND cm.published_at IS NOT NULL;

CREATE TEMP TABLE _cb_rows AS
SELECT title, published_at, weight, channel FROM _cb_press_rows
UNION ALL
SELECT title, published_at, weight, channel FROM _cb_creator_rows;

CREATE TEMP TABLE _cb_articles AS
SELECT title, weight, channel,
    datediff('month', date_trunc('month', published_at), date_trunc('month', CURRENT_DATE)) AS month_idx,
    strftime(date_trunc('month', published_at), '%Y-%m') AS period
FROM _cb_rows;

CREATE TEMP TABLE _cb_words AS
SELECT period, month_idx, weight, channel,
    str_split(trim(regexp_replace(regexp_replace(lower(title), '''', '', 'g'), '[^\p{L}\p{N}]+', ' ', 'g')), ' ') AS words
FROM _cb_articles
WHERE month_idx BETWEEN 1 AND @BUZZ_TOTAL_MONTHS@;

CREATE TEMP TABLE _cb_bigrams AS
SELECT tw.period, tw.month_idx, tw.weight, tw.channel, tw.words[s.i] AS w1, tw.words[s.i + 1] AS w2
FROM _cb_words tw, generate_series(1, greatest(len(tw.words) - 1, 0)) AS s(i)
WHERE len(tw.words) >= 2;

-- Concept allowlist, re-derived (see header) with a _cb_ prefix so it never collides with
-- mart_press.sql's own concept_unigram/concept_bigram temp tables in the same session.
CREATE TEMP TABLE _cb_concept_source AS
SELECT DISTINCT lower(trim(tag)) AS phrase
FROM src.game_tags
WHERE tag NOT IN (SELECT tag FROM denylist_tag)
UNION
SELECT DISTINCT lower(trim(genre)) AS phrase
FROM src.game_genres
WHERE genre NOT IN (SELECT genre FROM denylist_genre);

CREATE TEMP TABLE _cb_concept_words AS
SELECT phrase,
    str_split(trim(regexp_replace(regexp_replace(phrase, '''', '', 'g'), '[^\p{L}\p{N}]+', ' ', 'g')), ' ') AS words
FROM _cb_concept_source;

CREATE TEMP TABLE _cb_concept_unigram AS
SELECT DISTINCT cw.words[s.i] AS word
FROM _cb_concept_words cw, generate_series(1, len(cw.words)) AS s(i)
WHERE length(cw.words[s.i]) >= 2;

CREATE TEMP TABLE _cb_concept_bigram AS
SELECT DISTINCT cw.words[s.i] || ' ' || cw.words[s.i + 1] AS term
FROM _cb_concept_words cw, generate_series(1, greatest(len(cw.words) - 1, 0)) AS s(i)
WHERE len(cw.words) >= 2;

CREATE TEMP TABLE _cb_terms AS
SELECT period, month_idx, weight, channel, w1 || ' ' || w2 AS term
FROM _cb_bigrams
WHERE w1 NOT IN (SELECT word FROM stopword) AND w2 NOT IN (SELECT word FROM stopword)
  AND length(w1) >= 2 AND length(w2) >= 2
  AND NOT regexp_matches(w1, '^[0-9]+$') AND NOT regexp_matches(w2, '^[0-9]+$')
  AND (w1 || ' ' || w2) NOT IN (SELECT term FROM denylist_buzz_term)
  AND w1 NOT IN (SELECT word FROM denylist_buzz_word)
  AND w2 NOT IN (SELECT word FROM denylist_buzz_word)
  AND (
      (w1 || ' ' || w2) IN (SELECT term FROM _cb_concept_bigram)
      OR (w1 IN (SELECT word FROM _cb_concept_unigram) AND w2 IN (SELECT word FROM _cb_concept_unigram))
  );

CREATE TEMP TABLE _cb_term_channel_month AS
SELECT term, channel, period, month_idx, COUNT(*) AS n_mentions, SUM(weight) AS reach_weighted_score
FROM _cb_terms
GROUP BY term, channel, period, month_idx;

CREATE TEMP TABLE _cb_term_month AS
SELECT term, period, month_idx, SUM(n_mentions) AS n_mentions, SUM(reach_weighted_score) AS reach_weighted_score
FROM _cb_term_channel_month
GROUP BY term, period, month_idx;

-- Same AVG-over-matching-months semantics as mart_press's _buzz_term_stats (an average over
-- the months that had >=1 mention within the window, not a fixed-window-length average) —
-- kept identical so "rising/cooling" reads consistently across both marts.
CREATE TEMP TABLE _cb_term_stats AS
SELECT term,
    SUM(n_mentions) AS total_mentions,
    SUM(reach_weighted_score) AS total_weighted,
    COALESCE(AVG(reach_weighted_score) FILTER (WHERE month_idx BETWEEN 1 AND @BUZZ_RECENT_MONTHS@), 0) AS recent_avg_weighted,
    COALESCE(AVG(reach_weighted_score) FILTER (
        WHERE month_idx BETWEEN @BUZZ_RECENT_MONTHS@ + 1 AND @BUZZ_RECENT_MONTHS@ * 2
    ), 0) AS prior_avg_weighted
FROM _cb_term_month
GROUP BY term
HAVING SUM(n_mentions) >= @BUZZ_MIN_TOTAL_MENTIONS@;

-- NOTE: @BUZZ_SLOPE_EPSILON@ was calibrated for raw mention counts (mart_press). Reused
-- as-is here for the weighted slope too — once real (large) reach numbers flow in, this
-- floor becomes trivially easy to clear, so classification will skew toward rising/cooling
-- over flat; revisit if that turns out to be too noisy in practice.
CREATE TABLE mart_channel_buzz_summary AS
SELECT term, total_mentions, total_weighted, recent_avg_weighted, prior_avg_weighted,
    recent_avg_weighted - prior_avg_weighted AS slope_weighted,
    CASE WHEN recent_avg_weighted - prior_avg_weighted >= @BUZZ_SLOPE_EPSILON@ THEN 'rising'
         WHEN recent_avg_weighted - prior_avg_weighted <= -@BUZZ_SLOPE_EPSILON@ THEN 'cooling'
         ELSE 'flat' END AS direction
FROM _cb_term_stats
ORDER BY slope_weighted DESC;

CREATE TABLE mart_channel_buzz AS
SELECT tcm.term, tcm.channel, tcm.period, tcm.month_idx, tcm.n_mentions, tcm.reach_weighted_score
FROM _cb_term_channel_month tcm
JOIN mart_channel_buzz_summary s ON s.term = tcm.term
ORDER BY tcm.term, tcm.channel, tcm.month_idx DESC;
