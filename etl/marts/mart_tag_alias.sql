-- mart_tag_alias.sql
-- Spelling-twin resolution table: every NON-canonical spelling of a tag/genre the source
-- carries, and the canonical niche key it now resolves to. Built from build_marts.py's
-- stg_niche_alias (see NICHE_TWIN_EXCEPTIONS / TAG_RENAME_TWINS there for the rules and the
-- 2026-09-21 audit).
--
-- WHY. Steam respelled tags (Rogue-like -> Roguelike, Base-Building -> Base Building,
-- Vampire -> Vampires ...) and the catalog holds tag sets scraped before and after, so each
-- tag published as TWO niches with opposite fake trends. They are one niche now, keyed by the
-- canonical spelling — which retires the other spelling as a mart_niche / mart_niche_game /
-- mart_niche_press / mart_niche_themes key. Anything that stored one (a bookmarked
-- /niches/tag/Rogue-like URL, a saved MCP query, a key typed from memory) resolves it here:
--
--   dimension   'tag' | 'genre' — same domain as mart_niche.dimension
--   alias       the retired spelling, exactly as the source carries it (after the HTML-entity
--               unescape + trim every niche name gets)
--   canonical   the key to use instead: the spelling mart_niche.key holds
--   reason      'spelling' (case/punctuation twin: same letters and digits) | 'rename' (a
--               curated TAG_RENAME_TWINS pair, e.g. a pluralisation)
--   n_games     games whose tag set carries the ALIAS spelling (the merged niche counts both)
--
-- A key that is neither a canonical key nor an alias is not a niche. Resolution should also
-- fold case/punctuation of an unknown key (lower, drop non-alphanumerics) before giving up:
-- the table lists spellings the source HAS carried, not every spelling a person might type.

DROP TABLE IF EXISTS mart_tag_alias;

CREATE TABLE mart_tag_alias AS
SELECT
    CAST(dimension AS VARCHAR) AS dimension,
    CAST(alias AS VARCHAR)     AS alias,
    CAST(canonical AS VARCHAR) AS canonical,
    CAST(reason AS VARCHAR)    AS reason,
    CAST(n_games AS BIGINT)    AS n_games
FROM stg_niche_alias
ORDER BY dimension, canonical, alias;
