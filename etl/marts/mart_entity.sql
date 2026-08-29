-- mart_entity.sql
-- Developer / publisher ENTITY marts: normalize mart_game's comma-joined developers/
-- publishers strings into one row per (role, entity name), plus a thin entity->game map.
-- Powers entity lookups ("who is Gamatron AB?"), publisher scouting ("which publishers
-- are active in my genre?"), and release-trajectory reads (debut -> latest arc).
--
--   mart_entity        per (role, name): game counts, first/last release year, a
--                      24m-recency activity signal, revenue/review medians, hit rate,
--                      self-published share, top genres, and (publishers only) the
--                      number of distinct developer names they've published.
--   mart_entity_games  per (role, name, appid): thin map with seq (1 = that entity's
--                      earliest release by release_date, then release_year). Consumers
--                      JOIN mart_game for the game fields — deliberately NOT duplicated
--                      here (mart_game is the single source of game facts).
--
-- THE core problem this mart exists to solve: mart_game.developers/publishers are
-- comma-joined strings, and corporate names themselves contain commas — "Some Studio,
-- Inc." naively splits into "Some Studio" + "Inc.", which made "Inc." the #2 publisher
-- on Steam (916 games) before this fix. So after splitting on ',', any trimmed token
-- that case-insensitively matches the ENTITY_CORP_SUFFIXES set (see build_marts.py —
-- evidence-tuned against this real catalog) is re-merged into the preceding token as
-- ", <suffix>". Chains work too: "Thirdverse, Co., Ltd." -> ["Thirdverse","Co.","Ltd."]
-- -> "Thirdverse, Co., Ltd." (a running count of non-suffix tokens groups each base
-- name with every suffix token that follows it). A LEADING suffix token (the whole
-- field is just "Ltd." / "LLC" — real rows in this catalog) has no base name to attach
-- to and is dropped: the name is unrecoverable, and keeping it is exactly the
-- "Inc. is a publisher" bug.
--
-- Floors / population: population = ALL of mart_game (the full live catalog, including
-- 0-review games — entity medians/hit rates handle NULL estimates honestly, see below).
-- Every entity is kept, even n_games = 1. Names are trimmed; empty names dropped. NO
-- other normalization: "Ubisoft" vs "UBISOFT", or "FromSoftware, Inc." vs
-- "FromSoftware", are SEPARATE entities by design — names are self-reported strings,
-- and guessing at fuzzy identity here would silently merge distinct studios. Surface
-- that caveat downstream instead (the MCP tools / API do).
--
-- Reads ONLY mart_game (+ the entity_suffix temp table from build_marts.py's
-- create_staging), so it can run anywhere after mart_game.sql in MART_FILES.

DROP TABLE IF EXISTS mart_entity;
DROP TABLE IF EXISTS mart_entity_games;

-- ------------------------------------------------------------------------------------
-- Split + corporate-suffix re-merge. grp = running count of NON-suffix tokens in
-- original order, so every base name pulls the run of suffix tokens immediately after
-- it into one group; string_agg(tok, ', ' ORDER BY ord) reassembles the full name.
-- grp = 0 is the leading-suffix case (no base name yet) — dropped, per the header.
-- Empty tokens (",," / trailing commas) are dropped BEFORE grouping, so a stray empty
-- token between a name and its suffix doesn't break the merge.
-- DISTINCT: a game occasionally lists the same entity twice in one field — one map row.
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _entity_map AS
WITH _raw AS (
    SELECT appid, 'developer' AS role, developers AS entity_list
    FROM mart_game WHERE developers IS NOT NULL
    UNION ALL
    SELECT appid, 'publisher' AS role, publishers AS entity_list
    FROM mart_game WHERE publishers IS NOT NULL
),
_tok AS (
    SELECT appid, role, trim(u.t) AS tok, u.ord
    FROM _raw, unnest(str_split(entity_list, ',')) WITH ORDINALITY AS u(t, ord)
),
_flag AS (
    SELECT appid, role, tok, ord,
        (lower(tok) IN (SELECT token FROM entity_suffix)) AS is_suffix
    FROM _tok
    WHERE tok <> ''
),
_grp AS (
    SELECT appid, role, tok, ord, is_suffix,
        SUM(CASE WHEN is_suffix THEN 0 ELSE 1 END)
            OVER (PARTITION BY appid, role ORDER BY ord ROWS UNBOUNDED PRECEDING) AS grp
    FROM _flag
)
SELECT DISTINCT appid, role, string_agg(tok, ', ' ORDER BY ord) AS name
FROM _grp
WHERE grp >= 1
GROUP BY appid, role, grp;

-- ------------------------------------------------------------------------------------
-- mart_entity_games — the thin map. seq 1 = the entity's earliest release, ordered by
-- release_date (NULLs last), then release_year (NULLs last), then appid (deterministic
-- tiebreak). mart_game.release_date is stored VARCHAR — TRY_CAST back for ordering.
-- ------------------------------------------------------------------------------------
CREATE TABLE mart_entity_games AS
SELECT
    m.role,
    m.name,
    CAST(m.appid AS INTEGER) AS appid,
    CAST(row_number() OVER (
        PARTITION BY m.role, m.name
        ORDER BY TRY_CAST(g.release_date AS DATE) ASC NULLS LAST,
                 g.release_year ASC NULLS LAST,
                 m.appid
    ) AS INTEGER) AS seq
FROM _entity_map m
JOIN mart_game g ON g.appid = m.appid;

-- ------------------------------------------------------------------------------------
-- mart_entity — one row per (role, name).
--   n_recent_24m         releases in the last @RECENT_MONTHS@ months (release_date-based,
--                        future-dated rows excluded) — the active/dormant signal.
--   total_rev/median_rev SUM/median of est_rev_reviews over games that HAVE an estimate
--                        (SUM/median ignore NULLs; total_rev is NULL when no game has one).
--   hit_rate_200k        share of the entity's ESTIMATED games clearing $200K (same
--                        `> 200000` bar as mart_niche's hit_rate_200k) — NULL-estimate
--                        games are excluded from the denominator rather than silently
--                        counted as misses (the full catalog population has many
--                        unpriced/unenriched rows).
--   self_published_share share of the entity's games where the SAME name (case-folded)
--                        appears in the OTHER role on the same game — derived from this
--                        mart's own normalized split, not analysis_games.self_published
--                        (which compares the raw, pre-normalization strings and is NULL
--                        for un-enriched games). For a publisher, ~1.0 means "really a
--                        self-publishing dev".
--   top_genres           up to 5 PRIMARY genres by game count (ties broken
--                        alphabetically); [] when no game has a genre.
--   n_partners           publishers: COUNT(DISTINCT developer name) across their games
--                        (includes themselves when they self-publish — read alongside
--                        self_published_share); developers: NULL.
--   x_handle             majority-vote X handle over the entity's games' dev_x_handle
--                        (see _entity_x_handle below); NULL = unknown, never zero.
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _entity_game_facts AS
SELECT
    m.role, m.name, m.appid,
    g.release_year,
    (TRY_CAST(g.release_date AS DATE)
        BETWEEN CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH AND CURRENT_DATE) AS is_recent,
    g.est_rev_reviews, g.total_reviews, g.positive_ratio, g.primary_genre,
    EXISTS (
        SELECT 1 FROM _entity_map o
        WHERE o.appid = m.appid AND o.role <> m.role AND lower(o.name) = lower(m.name)
    ) AS is_self_published
FROM _entity_map m
JOIN mart_game g ON g.appid = m.appid;

CREATE TEMP TABLE _entity_top_genres AS
WITH counts AS (
    SELECT role, name, primary_genre, COUNT(*) AS n,
        row_number() OVER (
            PARTITION BY role, name ORDER BY COUNT(*) DESC, primary_genre
        ) AS rn
    FROM _entity_game_facts
    WHERE primary_genre IS NOT NULL
    GROUP BY role, name, primary_genre
)
SELECT role, name, list(primary_genre ORDER BY rn) AS top_genres
FROM counts
WHERE rn <= 5
GROUP BY role, name;

CREATE TEMP TABLE _publisher_partners AS
SELECT p.name,
    COUNT(DISTINCT d.name) AS n_partners
FROM _entity_map p
LEFT JOIN _entity_map d ON d.appid = p.appid AND d.role = 'developer'
WHERE p.role = 'publisher'
GROUP BY p.name;

-- ------------------------------------------------------------------------------------
-- _entity_x_handle — the entity's X handle by MAJORITY VOTE over its games'
-- mart_game.dev_x_handle: the most frequent non-NULL handle among the entity's games,
-- ties broken by the handle held by the game with the most reviews (then alphabetically
-- for determinism). Majority vote rather than "any game's handle" because a studio's
-- games usually all link the STUDIO account, while a one-off collab/port can link
-- someone else's — the mode is the entity's own account far more often than any single
-- game's row is. Same attribution caveat as mart_game.dev_x_handle: an official link
-- harvested from the games' developer-controlled pages (store page + website), which
-- may be a game's, the studio's, or the dev's personal account. NULL = no game has a
-- handle (none found or socials never fetched) — "unknown", never zero.
-- ------------------------------------------------------------------------------------
CREATE TEMP TABLE _entity_x_handle AS
WITH votes AS (
    SELECT m.role, m.name, g.dev_x_handle,
        COUNT(*) AS n_games_with_handle,
        MAX(g.total_reviews) AS max_reviews
    FROM _entity_map m
    JOIN mart_game g ON g.appid = m.appid
    WHERE g.dev_x_handle IS NOT NULL
    GROUP BY m.role, m.name, g.dev_x_handle
)
SELECT role, name, dev_x_handle AS x_handle
FROM (
    SELECT role, name, dev_x_handle,
        row_number() OVER (
            PARTITION BY role, name
            ORDER BY n_games_with_handle DESC, max_reviews DESC NULLS LAST, dev_x_handle
        ) AS rn
    FROM votes
)
WHERE rn = 1;

CREATE TABLE mart_entity AS
SELECT
    f.role,
    f.name,
    CAST(COUNT(*) AS INTEGER) AS n_games,
    CAST(MIN(f.release_year) AS INTEGER) AS first_release_year,
    CAST(MAX(f.release_year) AS INTEGER) AS last_release_year,
    CAST(COUNT(*) FILTER (WHERE f.is_recent) AS INTEGER) AS n_recent_24m,
    CAST(SUM(f.est_rev_reviews) AS DOUBLE) AS total_rev,
    CAST(median(f.est_rev_reviews) AS DOUBLE) AS median_rev,
    CAST(quantile_cont(f.est_rev_reviews, 0.90) AS DOUBLE) AS p90_rev,
    CAST(AVG(CASE WHEN f.est_rev_reviews > @TIMING_BIG_REV@ THEN 1.0 ELSE 0.0 END)
            FILTER (WHERE f.est_rev_reviews IS NOT NULL) AS DOUBLE) AS hit_rate_200k,
    CAST(median(f.total_reviews) AS DOUBLE) AS median_reviews,
    CAST(median(f.positive_ratio) AS DOUBLE) AS median_positive_ratio,
    CAST(AVG(CASE WHEN f.is_self_published THEN 1.0 ELSE 0.0 END) AS DOUBLE) AS self_published_share,
    COALESCE(ANY_VALUE(tg.top_genres), []::VARCHAR[]) AS top_genres,
    CASE WHEN f.role = 'publisher'
         THEN CAST(ANY_VALUE(pp.n_partners) AS INTEGER)
         ELSE NULL END AS n_partners,
    -- Majority-vote X handle over the entity's games (see _entity_x_handle above).
    -- NULL = unknown, never zero.
    ANY_VALUE(xh.x_handle) AS x_handle
FROM _entity_game_facts f
LEFT JOIN _entity_top_genres tg ON tg.role = f.role AND tg.name = f.name
LEFT JOIN _publisher_partners pp ON f.role = 'publisher' AND pp.name = f.name
LEFT JOIN _entity_x_handle xh ON xh.role = f.role AND xh.name = f.name
GROUP BY f.role, f.name;

-- Temp-table hygiene: file-local staging (nothing downstream reads these).
DROP TABLE IF EXISTS _entity_map;
DROP TABLE IF EXISTS _entity_game_facts;
DROP TABLE IF EXISTS _entity_top_genres;
DROP TABLE IF EXISTS _publisher_partners;
DROP TABLE IF EXISTS _entity_x_handle;
