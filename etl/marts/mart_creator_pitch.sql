-- mart_creator_pitch.sql
-- Track M — Multi-channel marketing pitch list: the CREATOR-platform analogue of
-- mart_press.sql's mart_press_outlet_genre / mart_press_author (who to pitch, by genre),
-- for YouTube channels, Reddit communities/posters, Twitch streamers, and X accounts
-- instead of press outlets/journalists. One row per (genre, platform, creator): ranked by
-- reach x recent activity, with an example mention (title/url/date) — the "who to pitch
-- on this channel, for this genre" deliverable.
--
--   mart_creator_pitch   per (genre, platform, creator_id): n_mentions (all-time),
--                        n_mentions_recent (last @RECENT_MONTHS@ months — the "still
--                        active" signal, same convention as mart_press_outlet_genre's
--                        n_articles_recent_24m), n_games_covered, the creator's latest
--                        known reach (nullable — see caveat below), a pitch_score for
--                        ranking, and one example mention.
--
-- Source: stg_creator / stg_game_creator_mention / stg_creator_reach_latest, built in
-- build_marts.py's create_marketing_staging() from the scraper's creator /
-- game_creator_mention / creator_reach_snapshot SQLite tables — guarded there so this file
-- always sees a (possibly EMPTY, but always well-typed) staging table, never a missing one.
-- Before any collector has run, every staging table is empty -> mart_creator_pitch has zero
-- rows -> the API/UI show a "connect a channel" empty state, not an error.
--
-- Mirrors mart_press's fuzzy-match discipline: game_creator_mention.confidence is filtered
-- the same way article_game_mentions.match_confidence is, just against its own
-- @CREATOR_MIN_CONFIDENCE@ floor (kept separate from @PRESS_MIN_CONFIDENCE@ in case
-- creator-mention matching needs different tuning than article matching later — same
-- starting value today). @CREATOR_PITCH_MIN_MENTIONS@ mirrors @PRESS_AUTHOR_MIN_ARTICLES@'s
-- role (a floor before a (creator, genre) pair is surfaced) but starts at 1 (effectively no
-- floor) since channel collection is new/low-volume — raise it once real volume exists.
--
-- pitch_score = COALESCE(reach, 0) * (1 + n_mentions_recent) — reach-weighted recent
-- activity, mirroring the plan's "ranked by reach x recent-activity" spec. A creator with no
-- reach snapshot yet (reach IS NULL) scores 0 and sorts by the ORDER BY's tiebreakers
-- instead (n_mentions_recent, n_mentions) — so a real, recently-active creator without a
-- captured snapshot still surfaces, just below reach-confirmed ones, rather than vanishing.
--
-- Caveats to surface in the API/UI (same spirit as mart_press's header):
--   - Selection bias: a creator who already covered this genre, not a guarantee of future
--     coverage.
--   - reach is a SNAPSHOT (creator_reach_snapshot), not live — check reach_captured_at; a
--     creator with reach = NULL has no snapshot yet, which is NOT the same as zero audience.
--   - Fuzzy game<->mention matching, confidence-filtered but not proof of a correct match.
--   - Genre is Steam's own multi-label genre field (same convention as mart_press) — a game
--     usually carries more than one genre, so one mention can count toward several genre
--     pitch lists.

DROP TABLE IF EXISTS mart_creator_pitch;

CREATE TEMP TABLE _creator_mentions AS
SELECT m.appid, m.creator_id, m.platform, m.title, m.url, m.published_at, m.confidence,
    (m.published_at >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH) AS is_recent
FROM stg_game_creator_mention m
WHERE m.confidence >= @CREATOR_MIN_CONFIDENCE@;

CREATE TEMP TABLE _creator_genre_mentions AS
SELECT cm.appid, cm.creator_id, cm.platform, cm.title, cm.url, cm.published_at, cm.is_recent, gm.genre
FROM _creator_mentions cm
JOIN stg_genre_membership gm ON gm.appid = cm.appid;

CREATE TEMP TABLE _creator_genre_counts AS
SELECT creator_id, platform, genre,
    COUNT(*) AS n_mentions,
    COUNT(*) FILTER (WHERE is_recent) AS n_mentions_recent,
    COUNT(DISTINCT appid) AS n_games_covered
FROM _creator_genre_mentions
GROUP BY creator_id, platform, genre
HAVING COUNT(*) >= @CREATOR_PITCH_MIN_MENTIONS@;

-- One representative example mention per (creator, platform, genre): most recent first —
-- same "who's active right now, with an example" framing as mart_press's outlet example.
CREATE TEMP TABLE _creator_genre_example AS
SELECT creator_id, platform, genre, title, url, CAST(published_at AS VARCHAR) AS published_at,
    row_number() OVER (
        PARTITION BY creator_id, platform, genre
        ORDER BY published_at DESC NULLS LAST, appid DESC
    ) AS rn
FROM _creator_genre_mentions;

CREATE TABLE mart_creator_pitch AS
SELECT
    c.genre, c.platform, c.creator_id,
    cr.handle, cr.display_name, cr.url AS creator_url,
    c.n_mentions, c.n_mentions_recent, c.n_games_covered,
    rl.reach, CAST(rl.captured_at AS VARCHAR) AS reach_captured_at,
    COALESCE(rl.reach, 0) * (1 + c.n_mentions_recent) AS pitch_score,
    ex.title AS example_title, ex.url AS example_url, ex.published_at AS example_published_at
FROM _creator_genre_counts c
JOIN stg_creator cr ON cr.creator_id = c.creator_id
LEFT JOIN stg_creator_reach_latest rl ON rl.creator_id = c.creator_id
JOIN _creator_genre_example ex
    ON ex.creator_id = c.creator_id AND ex.platform = c.platform AND ex.genre = c.genre AND ex.rn = 1
ORDER BY c.genre, c.platform, pitch_score DESC, c.n_mentions DESC;
