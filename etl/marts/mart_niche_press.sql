-- mart_niche_press.sql
-- Niche press coverage: the per-game press footprint (mart_game_teardown.sql's
-- mart_game_press_* tables) rolled up to NICHE level — "how much journalist coverage does
-- the whole Roguelike niche get, and who writes about it?" — so the Niche Finder drawer
-- can put a niche's press visibility next to its market stats.
--
--   mart_niche_press          per (dimension 'tag'|'genre', key, month 'YYYY-MM'):
--                             n_articles + n_games_covered — the niche's press-coverage
--                             timeline, aggregated across member games. n_articles counts
--                             ARTICLE-MENTIONS (an article covering two member games
--                             counts once per game — same convention as
--                             mart_press_outlet_genre's n_articles); months with no dated
--                             coverage simply have no row.
--   mart_niche_press_outlets  per (dimension, key, source): n_articles, n_games_covered,
--                             last_article_at — "who covers this niche", capped at the top
--                             @NICHE_PRESS_TOP_OUTLETS@ outlets per niche by n_articles.
--
-- Niche membership (same pattern as mart_niche_themes.sql — reuses already-built marts):
--   tag   : the tag appears in mart_game.top_tags — the game's top-@TOP_TAGS_PER_GAME@
--           community tags. NARROWER than mart_niche's stg_tag_membership
--           (top-@TAG_RANK_FLOOR@), so a game only counts toward niches that actually
--           define it; the KEY vocabulary is the same, so the drawer can query by the
--           same (dimension, key) it already holds.
--   genre : mart_game.primary_genre (exact match, one genre per game).
-- Either way the population is further limited to press-covered games (appid appears in
-- mart_game_press_by_source), which keeps the membership join small (~press-covered games
-- x ~@TOP_TAGS_PER_GAME@ tags, not the whole catalog).
--
-- Counts are AGGREGATED FROM THE PER-GAME PRESS MARTS (mart_game_press_timeline /
-- mart_game_press_by_source), not re-derived from src.articles — so the niche numbers can
-- never disagree with the per-game press cards built from those same tables. The ONE
-- deliberate exception is _niche_press_last below: the per-game marts carry no
-- per-(appid, source) dates, so last_article_at needs a minimal date-only lookup against
-- the SHARED stg_press_base — the same journalist-only, confidence-floored base
-- mart_game_teardown.sql's press marts aggregate, so the dated set matches the counted
-- set by construction.
--
-- Reliability floor: a niche needs >= @NICHE_PRESS_MIN_GAMES@ press-covered member games
-- (tunable NICHE_PRESS_MIN_GAMES in build_marts.py) — below that, one title's press cycle
-- would read as "the niche's" coverage.
--
-- Same caveats as every press mart (surface them in the UI, don't just bury them here):
-- fuzzy match (match_confidence-floored, not proof of a correct match), selection bias
-- (covered games are already notable — descriptive, not predictive), Steam News excluded
-- (journalist coverage only), and n_articles is an ALL-TIME count.
--
-- MUST run AFTER mart_game.sql and mart_game_teardown.sql (reads mart_game +
-- mart_game_press_*) — registered at the END of MART_FILES with the other mart-reading
-- files. Placeholder tokens are substituted by build_marts.py.

DROP TABLE IF EXISTS mart_niche_press;
DROP TABLE IF EXISTS mart_niche_press_outlets;

-- (appid, dimension, key) niche membership, limited to press-covered games.
CREATE TEMP TABLE _press_niche_member AS
SELECT m.appid, m.dimension, m.key
FROM (
    SELECT g.appid, 'tag' AS dimension, t.tag AS key
    FROM mart_game g, UNNEST(g.top_tags) AS t(tag)
    UNION ALL
    SELECT g.appid, 'genre' AS dimension, g.primary_genre AS key
    FROM mart_game g
    WHERE g.primary_genre IS NOT NULL
) m
WHERE m.appid IN (SELECT DISTINCT appid FROM mart_game_press_by_source);

-- Niches clearing the coverage floor. Both output tables filter on this same set, so the
-- timeline and the outlet list can never disagree about which niches are published.
CREATE TEMP TABLE _press_niche_eligible AS
SELECT dimension, key
FROM _press_niche_member
GROUP BY dimension, key
HAVING COUNT(DISTINCT appid) >= @NICHE_PRESS_MIN_GAMES@;

CREATE TABLE mart_niche_press AS
SELECT m.dimension, m.key, t.period AS month,
    SUM(t.n_mentions) AS n_articles,
    COUNT(DISTINCT t.appid) AS n_games_covered
FROM _press_niche_member m
JOIN _press_niche_eligible e ON e.dimension = m.dimension AND e.key = m.key
JOIN mart_game_press_timeline t ON t.appid = m.appid
GROUP BY m.dimension, m.key, t.period
ORDER BY m.dimension, m.key, month;

-- Date-only lookup (see header): the latest dated article per (appid, source), read from
-- the SHARED stg_press_base (built in build_marts.py's create_staging — the same
-- journalist-only, confidence-floored base mart_game_teardown.sql's press marts use, so
-- the dated set matches the counted set by construction). Articles without a parseable
-- published_at are counted in n_articles but can't move last_article_at.
CREATE TEMP TABLE _niche_press_last AS
SELECT pb.appid, pb.source, MAX(pb.published_at) AS last_article_at
FROM stg_press_base pb
GROUP BY pb.appid, pb.source;

CREATE TABLE mart_niche_press_outlets AS
WITH agg AS (
    SELECT m.dimension, m.key, s.source,
        SUM(s.n_mentions) AS n_articles,
        COUNT(DISTINCT s.appid) AS n_games_covered,
        CAST(MAX(l.last_article_at) AS VARCHAR) AS last_article_at
    FROM _press_niche_member m
    JOIN _press_niche_eligible e ON e.dimension = m.dimension AND e.key = m.key
    JOIN mart_game_press_by_source s ON s.appid = m.appid
    LEFT JOIN _niche_press_last l ON l.appid = s.appid AND l.source = s.source
    GROUP BY m.dimension, m.key, s.source
),
ranked AS (
    SELECT *,
        row_number() OVER (
            PARTITION BY dimension, key ORDER BY n_articles DESC, source
        ) AS outlet_rank
    FROM agg
)
SELECT dimension, key, source, n_articles, n_games_covered, last_article_at
FROM ranked
WHERE outlet_rank <= @NICHE_PRESS_TOP_OUTLETS@
ORDER BY dimension, key, n_articles DESC, source;

-- Temp-table hygiene: file-local staging (nothing downstream reads these). This file is
-- also the LAST in MART_FILES and the last consumer of the shared stg_press_base — drop
-- that too (same last-consumer convention as mart_niche_game.sql's _niche_pop drop).
DROP TABLE IF EXISTS _press_niche_member;
DROP TABLE IF EXISTS _press_niche_eligible;
DROP TABLE IF EXISTS _niche_press_last;
DROP TABLE IF EXISTS stg_press_base;
