-- mart_press.sql
-- Phase 3 — aggregate Press / Marketing Intelligence (the "moat"): who covers a genre,
-- outlet x genre coverage, and rising/cooling buzz themes across the whole 1.12M-article
-- corpus. This is the AGGREGATE surface — distinct from the *per-game* press footprint in
-- mart_game_teardown.sql's mart_game_press_* tables, which this file does not duplicate.
--
--   mart_press_outlet_genre   per (source, genre): n_articles, n_games_covered, the
--                             median outcome (est_rev / owners / positive_ratio) of the
--                             covered games, and an example article — powers the outlet x
--                             genre heatmap, the coverage-vs-success scatter, and the
--                             outlet half of the pitch list. No row-level floor: a thin
--                             (source, genre) cell is kept and shown honestly (n_articles /
--                             n_games_covered communicate reliability; don't hide it).
--   mart_press_author         per (author, genre): n_articles, n_distinct_games, the
--                             outlets they wrote for, and an example article — the
--                             journalist pitch-list source (the headline deliverable).
--                             Generic/staff bylines (outlet mastheads, "X Staff/Team",
--                             "Press Release", ...) are filtered out; see
--                             _press_journalist.has_named_author below. Floor: >=
--                             @PRESS_AUTHOR_MIN_ARTICLES@ articles per (author, genre).
--   mart_buzz_trends          per (term, month): journalist article-title bigram
--                             frequency, last @BUZZ_TOTAL_MONTHS@ complete months. Terms
--                             are restricted to a concept allowlist (see below) so this
--                             reads as game concepts/mechanics/genres, not news noise.
--   mart_buzz_trends_summary  per term: total frequency + recent-window-vs-prior-window
--                             slope -> rising / cooling / flat classification.
--
-- Both press marts key off the SAME journalist-only, confidence-filtered article set as
-- mart_game_teardown.sql's mart_game_press_* (source != 'steam_news', match_confidence >=
-- @PRESS_MIN_CONFIDENCE@) — deliberately re-derived here rather than shared across files
-- (each mart file owns its own temp staging, matching this repo's convention), so this
-- file has no load-order dependency on mart_game_teardown.sql. Genre is the full
-- multi-label membership (stg_genre_membership), same convention as mart_market.sql /
-- mart_lang.sql — a game in two genres contributes to both.
--
-- Caveats baked into the design (surface these in the API/UI, don't just bury them here):
--   - Selection bias: covered games are already notable -> descriptive, not predictive.
--   - Fuzzy match_confidence: filtered, not proof of a correct match.
--   - Steam News excluded throughout: journalist coverage only.
--   - Buzz trends is English-tokenized (the stopword list is English); non-English titles
--     (e.g. some dou_gamedev headlines) mostly fall out on their own (no surviving word
--     pairs, or pairs below the frequency floor) rather than being explicitly source-filtered.
--   - Buzz terms are further restricted to a CONCEPT ALLOWLIST (game_tags.tag +
--     game_genres.genre, normalized) so the result reads as game concepts/mechanics/genres
--     (Roguelike, Deckbuilder, Cozy, Survival Craft, ...), not sale events, publishers, or
--     specific game titles — see the concept_unigram/concept_bigram tables below. This is a
--     coarse, word-level match (not phrase-aware NLP): an occasional edge case can still slip
--     through if two unrelated concept words happen to sit adjacent in a headline.

DROP TABLE IF EXISTS mart_press_outlet_genre;
DROP TABLE IF EXISTS mart_press_author;
DROP TABLE IF EXISTS mart_buzz_trends;
DROP TABLE IF EXISTS mart_buzz_trends_summary;

-- ------------------------------------------------------------------------------------
-- Shared base: journalist articles fuzzy-linked to a game, confidence-filtered. One row
-- per (article, mentioned appid). has_named_author flags a real byline (not an outlet
-- masthead / "Staff" / "Team" / "Press Release" credit) — computed once, reused by both
-- the author mart (filters on it) and the outlet mart (prefers it for the example article).
-- ------------------------------------------------------------------------------------
-- is_recent uses the SAME @RECENT_MONTHS@ (24) window as the rest of the app's "recent"
-- convention (stg_game.is_recent, mart_niche's 24m window) — NOT a data-availability
-- limitation: article_game_mentions is verified to span the outlets' full archives (back
-- to 1997-2005 depending on source), not just the trailing year. n_articles below is
-- therefore an ALL-TIME count (a prolific long-retired contributor can still rank #1);
-- n_articles_recent_24m is the deliberate "still active" signal alongside it.
CREATE TEMP TABLE _press_journalist AS
SELECT m.appid, a.id AS article_id, a.source, a.author, a.title, a.url,
    TRY_CAST(a.published_at AS TIMESTAMP) AS published_at,
    m.match_confidence,
    (TRY_CAST(a.published_at AS TIMESTAMP) >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH) AS is_recent,
    (a.author IS NOT NULL AND TRIM(a.author) != ''
        AND NOT regexp_matches(
            a.author,
            '(staff|\bteam\b|\beditors?\b|press release|редакція|^gamesindustry\.biz$|^ign$|^pc gamer$|^eurogamer$|^game developer$)',
            'i'
        )
    ) AS has_named_author
FROM src.article_game_mentions m
JOIN src.articles a ON a.id = m.article_id
WHERE a.source != 'steam_news'
  AND m.match_confidence >= @PRESS_MIN_CONFIDENCE@;

-- ------------------------------------------------------------------------------------
-- mart_press_outlet_genre
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _outlet_genre_articles AS
SELECT p.source, gm.genre, p.appid, p.article_id, p.author, p.title, p.url, p.published_at,
    p.has_named_author, p.is_recent
FROM _press_journalist p
JOIN stg_genre_membership gm ON gm.appid = p.appid;

-- One representative example article per (source, genre): prefer a real named byline,
-- then most recent — "who's covering this genre right now, with an example."
CREATE TEMP TABLE _outlet_genre_example AS
SELECT source, genre, author, title, url, CAST(published_at AS VARCHAR) AS published_at,
    row_number() OVER (
        PARTITION BY source, genre
        ORDER BY has_named_author DESC, published_at DESC NULLS LAST, article_id DESC
    ) AS rn
FROM _outlet_genre_articles;

CREATE TABLE mart_press_outlet_genre AS
WITH counts AS (
    SELECT source, genre, COUNT(*) AS n_articles, COUNT(DISTINCT appid) AS n_games_covered,
        COUNT(*) FILTER (WHERE is_recent) AS n_articles_recent_24m
    FROM _outlet_genre_articles
    GROUP BY source, genre
),
covered_games AS (
    SELECT DISTINCT source, genre, appid FROM _outlet_genre_articles
),
outcomes AS (
    SELECT cg.source, cg.genre,
        median(g.est_rev_reviews) AS median_est_rev,
        median(g.owners_mid) AS median_owners,
        median(g.positive_ratio) AS median_positive_ratio
    FROM covered_games cg
    JOIN stg_game g ON g.appid = cg.appid
    GROUP BY cg.source, cg.genre
)
SELECT c.source, c.genre, c.n_articles, c.n_articles_recent_24m, c.n_games_covered,
    o.median_est_rev, o.median_owners, o.median_positive_ratio,
    ex.author AS example_author, ex.title AS example_title, ex.url AS example_url,
    ex.published_at AS example_published_at
FROM counts c
JOIN outcomes o ON o.source = c.source AND o.genre = c.genre
JOIN _outlet_genre_example ex ON ex.source = c.source AND ex.genre = c.genre AND ex.rn = 1
ORDER BY c.genre, c.n_articles DESC;

-- ------------------------------------------------------------------------------------
-- mart_press_author — the journalist pitch-list source.
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _author_genre_articles AS
SELECT p.author, gm.genre, p.source, p.appid, p.article_id, p.title, p.url, p.published_at, p.is_recent
FROM _press_journalist p
JOIN stg_genre_membership gm ON gm.appid = p.appid
WHERE p.has_named_author;

CREATE TEMP TABLE _author_genre_counts AS
SELECT author, genre, COUNT(*) AS n_articles, COUNT(DISTINCT appid) AS n_distinct_games,
    COUNT(*) FILTER (WHERE is_recent) AS n_articles_recent_24m
FROM _author_genre_articles
GROUP BY author, genre
HAVING COUNT(*) >= @PRESS_AUTHOR_MIN_ARTICLES@;

-- Some journalists' bylines appear under more than one outlet source (career moves) —
-- outlets is a list so the pitch list can show all of them for this author x genre.
CREATE TEMP TABLE _author_genre_outlets AS
SELECT author, genre, list(source ORDER BY source) AS outlets
FROM (SELECT DISTINCT author, genre, source FROM _author_genre_articles)
GROUP BY author, genre;

CREATE TEMP TABLE _author_genre_example AS
SELECT author, genre, source, title, url, CAST(published_at AS VARCHAR) AS published_at,
    row_number() OVER (PARTITION BY author, genre ORDER BY published_at DESC NULLS LAST, article_id DESC) AS rn
FROM _author_genre_articles;

CREATE TABLE mart_press_author AS
SELECT c.author, c.genre, c.n_articles, c.n_articles_recent_24m, c.n_distinct_games, o.outlets,
    e.source AS example_source, e.title AS example_title, e.url AS example_url,
    e.published_at AS example_published_at
FROM _author_genre_counts c
JOIN _author_genre_outlets o ON o.author = c.author AND o.genre = c.genre
JOIN _author_genre_example e ON e.author = c.author AND e.genre = c.genre AND e.rn = 1
ORDER BY c.genre, c.n_articles DESC;

-- ------------------------------------------------------------------------------------
-- mart_buzz_trends / mart_buzz_trends_summary — bigram buzz over journalist article
-- TITLES (not full text/summary: titles are the "headline framing" signal and keep
-- tokenization cheap over the whole corpus). Scoped to the last @BUZZ_TOTAL_MONTHS@
-- COMPLETE months (excludes the current in-progress calendar month, which would
-- otherwise read as an artificial cooldown on every single rebuild). month_idx: 1 = last
-- complete month ... @BUZZ_TOTAL_MONTHS@ = oldest retained month. recent = months
-- 1..@BUZZ_RECENT_MONTHS@; prior = the equal-length window immediately before it.
-- Not scoped to article_game_mentions — this is whole-corpus press-discourse buzz, not
-- tied to a specific matched game.
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _buzz_articles AS
SELECT a.id, a.title,
    datediff('month', date_trunc('month', TRY_CAST(a.published_at AS TIMESTAMP)), date_trunc('month', CURRENT_DATE)) AS month_idx,
    strftime(date_trunc('month', TRY_CAST(a.published_at AS TIMESTAMP)), '%Y-%m') AS period
FROM src.articles a
WHERE a.source != 'steam_news'
  AND a.title IS NOT NULL AND TRIM(a.title) != ''
  AND a.published_at IS NOT NULL;

CREATE TEMP TABLE _buzz_words AS
SELECT id, period, month_idx,
    -- Strip apostrophes first (so "Baldur's" -> "baldurs", one token, not split at the
    -- word-break stage), then collapse every other non letter/number run to a single
    -- space using Unicode letter/number classes (\p{L}/\p{N}) so accented titles like
    -- "Pokémon" tokenize as one word instead of splitting on the accented character.
    str_split(trim(regexp_replace(regexp_replace(lower(title), '''', '', 'g'), '[^\p{L}\p{N}]+', ' ', 'g')), ' ') AS words
FROM _buzz_articles
WHERE month_idx BETWEEN 1 AND @BUZZ_TOTAL_MONTHS@;

-- Adjacent word pairs from the ORIGINAL title word order (not from a pre-stopword-filtered
-- sequence), so a bigram always reflects two words that actually sat next to each other in
-- the headline; the stopword/junk filter is applied per-pair, after.
CREATE TEMP TABLE _buzz_bigrams AS
SELECT tw.period, tw.month_idx, tw.words[s.i] AS w1, tw.words[s.i + 1] AS w2
FROM _buzz_words tw, generate_series(1, greatest(len(tw.words) - 1, 0)) AS s(i)
WHERE len(tw.words) >= 2;

-- ------------------------------------------------------------------------------------
-- Concept allowlist — the fix for buzz surfacing news noise (sale events, publishers,
-- specific game titles) instead of actual game concepts. Derived from the real Steam
-- descriptor space: game_tags.tag (the community-tag vocabulary — Roguelike, Deckbuilder,
-- Cozy, Metroidvania, Souls-like, ...) + game_genres.genre, denylist-filtered the SAME way
-- stg_tag_membership/stg_genre_membership are (drops application-type/franchise/hardware
-- noise like "Software", "Batman", "LEGO" — see DENYLIST_TAG/DENYLIST_GENRE), then run
-- through the IDENTICAL lower/apostrophe-strip/non-alnum-collapse pipeline as article
-- titles above so a tag phrase and a title n-gram are directly comparable.
--   concept_unigram  every individual word appearing in a tag/genre phrase, so a
--                     multi-word tag like "Time Management" also teaches "time" and
--                     "management" as concept words on their own.
--   concept_bigram    every adjacent word pair WITHIN a tag/genre phrase — covers
--                     2+-word tags directly (e.g. "open world", "pixel graphics").
-- A buzz bigram is kept (see _buzz_terms) only if it IS a known tag/genre phrase, or BOTH
-- its words are independently known concept words. The AND (not OR) is deliberate:
-- requiring only one side to match is how franchise/title debris like "duty action" (a
-- title-bigram fragment of "Call of Duty ... Action ...") would leak through on the word
-- "action" alone — exactly the kind of noise this fix removes.
CREATE TEMP TABLE _concept_source AS
SELECT DISTINCT lower(trim(tag)) AS phrase
FROM src.game_tags
WHERE tag NOT IN (SELECT tag FROM denylist_tag)
UNION
SELECT DISTINCT lower(trim(genre)) AS phrase
FROM src.game_genres
WHERE genre NOT IN (SELECT genre FROM denylist_genre);

CREATE TEMP TABLE _concept_words AS
SELECT phrase,
    str_split(trim(regexp_replace(regexp_replace(phrase, '''', '', 'g'), '[^\p{L}\p{N}]+', ' ', 'g')), ' ') AS words
FROM _concept_source;

CREATE TEMP TABLE concept_unigram AS
SELECT DISTINCT cw.words[s.i] AS word
FROM _concept_words cw, generate_series(1, len(cw.words)) AS s(i)
WHERE length(cw.words[s.i]) >= 2;

CREATE TEMP TABLE concept_bigram AS
SELECT DISTINCT cw.words[s.i] || ' ' || cw.words[s.i + 1] AS term
FROM _concept_words cw, generate_series(1, greatest(len(cw.words) - 1, 0)) AS s(i)
WHERE len(cw.words) >= 2;

CREATE TEMP TABLE _buzz_terms AS
SELECT period, month_idx, w1 || ' ' || w2 AS term
FROM _buzz_bigrams
WHERE w1 NOT IN (SELECT word FROM stopword) AND w2 NOT IN (SELECT word FROM stopword)
  AND length(w1) >= 2 AND length(w2) >= 2
  AND NOT regexp_matches(w1, '^[0-9]+$') AND NOT regexp_matches(w2, '^[0-9]+$')
  AND (w1 || ' ' || w2) NOT IN (SELECT term FROM denylist_buzz_term)
  AND w1 NOT IN (SELECT word FROM denylist_buzz_word)
  AND w2 NOT IN (SELECT word FROM denylist_buzz_word)
  AND (
      (w1 || ' ' || w2) IN (SELECT term FROM concept_bigram)
      OR (w1 IN (SELECT word FROM concept_unigram) AND w2 IN (SELECT word FROM concept_unigram))
  );

CREATE TEMP TABLE _buzz_term_month AS
SELECT term, period, month_idx, COUNT(*) AS n_mentions
FROM _buzz_terms
GROUP BY term, period, month_idx;

CREATE TEMP TABLE _buzz_term_stats AS
SELECT term,
    SUM(n_mentions) AS total_mentions,
    COALESCE(AVG(n_mentions) FILTER (WHERE month_idx BETWEEN 1 AND @BUZZ_RECENT_MONTHS@), 0) AS recent_avg,
    COALESCE(AVG(n_mentions) FILTER (
        WHERE month_idx BETWEEN @BUZZ_RECENT_MONTHS@ + 1 AND @BUZZ_RECENT_MONTHS@ * 2
    ), 0) AS prior_avg
FROM _buzz_term_month
GROUP BY term
HAVING SUM(n_mentions) >= @BUZZ_MIN_TOTAL_MENTIONS@;

CREATE TABLE mart_buzz_trends_summary AS
SELECT term, total_mentions, recent_avg, prior_avg, recent_avg - prior_avg AS slope,
    CASE WHEN recent_avg - prior_avg >= @BUZZ_SLOPE_EPSILON@ THEN 'rising'
         WHEN recent_avg - prior_avg <= -@BUZZ_SLOPE_EPSILON@ THEN 'cooling'
         ELSE 'flat' END AS direction
FROM _buzz_term_stats
ORDER BY slope DESC;

CREATE TABLE mart_buzz_trends AS
SELECT tm.term, tm.period, tm.month_idx, tm.n_mentions
FROM _buzz_term_month tm
JOIN mart_buzz_trends_summary s ON s.term = tm.term
ORDER BY tm.term, tm.month_idx DESC;
