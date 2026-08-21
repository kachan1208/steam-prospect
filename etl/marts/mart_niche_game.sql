-- mart_niche_game.sql
-- Niche -> game MEMBERSHIP keys: one row per (dimension, key, win, min_reviews, appid),
-- i.e. the exact scored population that mart_niche aggregated into a single row.
--
-- WHY THIS MART EXISTS. Until now nothing in the marts could answer "which games are IN
-- this niche?" for a given cut:
--   * mart_niche      has the headline numbers (n_games, median_rev, ...) but no appids.
--   * mart_niche_top  keeps only @TOP_GAMES_PER_NICHE@ representatives per (dimension,
--                     key) — ~5.6K rows total, one fixed cut, deliberately a teaser list.
--   * mart_game.top_tags is capped at @TOP_TAGS_PER_GAME@ tags per game, so filtering
--                     games by "has this tag in top_tags" does NOT reproduce niche
--                     membership: measured against mart_niche.n_games it lands anywhere
--                     from ~60% (Singleplayer — its games carry >10 more-specific tags,
--                     so the tag falls off the cap) to ~120% (Action — no min_reviews /
--                     est_rev_reviews eligibility filtering at all). Either way a niche
--                     page built on top_tags would show game lists and charts that
--                     contradict the niche's own headline numbers on the same screen.
--
-- So the niches UI (game list + per-niche charts) needs the real membership, and it must
-- be the SAME population mart_niche scored, not a lookalike.
--
-- PARITY WITH mart_niche IS THE WHOLE POINT — hard invariant:
--     for every (dimension, key, win, min_reviews) row in mart_niche,
--     COUNT(*) here for that group == mart_niche.n_games
-- Two mechanisms enforce it:
--   1. The `pop` CTE below is mart_niche's `pop` CTE with the unused stat columns removed:
--      same membership union, same CROSS JOIN over the wins x @MR_VALUES@ grid, same
--      eligibility filters (total_reviews >= min_reviews, est_rev_reviews IS NOT NULL,
--      and for win='24m' the release_valid + @RECENT_MONTHS@-month recency test).
--      stg_tag_membership / stg_genre_membership are DISTINCT (appid, key) and stg_game is
--      one row per appid, so a game can appear at most once per group -> COUNT(*) here is
--      exactly the COUNT(*) mart_niche's `agg` computed as n_games.
--   2. The INNER JOIN to mart_niche at the bottom applies mart_niche's own
--      HAVING COUNT(*) >= @MIN_NICHE_GAMES@ publication gate by READING THE PUBLISHED
--      TABLE rather than re-deriving the threshold — a cut mart_niche didn't publish can
--      never appear here, and the two group sets are identical by construction.
-- Runs immediately after mart_niche.sql in MART_FILES: it needs mart_niche to exist (2),
-- and adjacency keeps the CURRENT_DATE both files evaluate for the 24m window within
-- seconds of each other (the ETL as a whole runs for hours, so a distant placement could
-- straddle midnight and shift the 24m cut-off between the two).
--
-- KEYS ONLY, deliberately. No name/price/revenue/tags here: the API joins appid ->
-- mart_game for game attributes, so the niche pages show exactly the same numbers as the
-- games pages, and this table stays narrow (~4M rows across all cuts on the real catalog —
-- (all,0) alone is ~1.9M, since min_reviews=0 means "the whole tag membership"). Widening
-- it would multiply that row count by the width of whatever gets added; don't.
--
-- Consumers should treat (dimension, key, win, min_reviews) as the lookup key — the same
-- four columns, with the same value domains, as mart_niche.

DROP TABLE IF EXISTS mart_niche_game;

-- Reads _niche_pop, the population table mart_niche.sql materialises and aggregates into
-- n_games. Earlier this file restated that CTE's joins and predicates, which left exactly one
-- way for the two marts to disagree — and a disagreement here is the failure this mart exists to
-- prevent, since the drill-down charts are read against mart_niche's own n_games. Reading the
-- same table removes the possibility instead of relying on the two copies being kept in step.
CREATE TABLE mart_niche_game AS
SELECT
    CAST(p.dimension AS VARCHAR)   AS dimension,
    CAST(p.key AS VARCHAR)         AS key,
    CAST(p.win AS VARCHAR)         AS win,
    CAST(p.min_reviews AS INTEGER) AS min_reviews,
    CAST(p.appid AS INTEGER)       AS appid
FROM _niche_pop p
-- Publication gate, borrowed from mart_niche rather than re-derived: a cut mart_niche chose not
-- to publish (under MIN_NICHE_GAMES) cannot appear here, and the threshold is never restated.
JOIN mart_niche n
      ON n.dimension   = p.dimension
     AND n.key         = p.key
     AND n.win         = p.win
     AND n.min_reviews = p.min_reviews;

-- Last consumer of the shared population table; mart_niche.sql deliberately left it alive.
DROP TABLE IF EXISTS _niche_pop;
