-- SOLO/INDIE EVIDENCE on mart_niche (2026-09-24). See the INDIE_* constants block in
-- build_marts.py for the why and the calibration. Per niche cut (dimension, key, win,
-- min_reviews), over EXACTLY the population mart_niche aggregated (mart_niche_game):
--
--   n_hits_100k            paid games with est. revenue >= @INDIE_HIT_MIN_REV@ (free and
--                          unknown-price games carry NULL revenue, so they are never hits)
--   n_small_indie_hits     of those: is_indie AND the developer's catalog (max over the
--                          game's developers of mart_entity.n_games) <= @SMALL_DEV_MAX_GAMES@.
--                          A game whose developer isn't in mart_entity is a hit, not a
--                          small-indie hit (unknown is never counted in the indie's favour).
--   small_indie_hit_share  n_small_indie_hits / n_hits_100k; NULL when the cut has no hits
--   indie_friendly         share >= @INDIE_FRIENDLY_MIN_SHARE@ AND n_small_indie_hits >=
--                          @INDIE_FRIENDLY_MIN_HITS@ AND solo_viability >=
--                          @INDIE_SINGLEPLAYER_MIN@ — FALSE (never NULL) otherwise
ALTER TABLE mart_niche ADD COLUMN n_hits_100k BIGINT;
ALTER TABLE mart_niche ADD COLUMN n_small_indie_hits BIGINT;
ALTER TABLE mart_niche ADD COLUMN small_indie_hit_share DOUBLE;
ALTER TABLE mart_niche ADD COLUMN indie_friendly BOOLEAN;

CREATE OR REPLACE TEMP TABLE _dev_catalog AS
SELECT eg.appid, MAX(e.n_games) AS dev_catalog_max
FROM mart_entity_games eg
JOIN mart_entity e ON e.role = eg.role AND e.name = eg.name
WHERE eg.role = 'developer'
GROUP BY eg.appid;

CREATE OR REPLACE TEMP TABLE _niche_indie AS
SELECT ng.dimension, ng.key, ng.win, ng.min_reviews,
    COUNT(*) FILTER (WHERE g.est_rev_reviews >= @INDIE_HIT_MIN_REV@) AS n_hits,
    COUNT(*) FILTER (WHERE g.est_rev_reviews >= @INDIE_HIT_MIN_REV@
                       AND COALESCE(CAST(g.is_indie AS INTEGER), 0) = 1
                       AND d.dev_catalog_max <= @SMALL_DEV_MAX_GAMES@) AS n_small
FROM mart_niche_game ng
JOIN mart_game g ON g.appid = ng.appid
LEFT JOIN _dev_catalog d ON d.appid = ng.appid
GROUP BY ng.dimension, ng.key, ng.win, ng.min_reviews;

UPDATE mart_niche AS n SET
    n_hits_100k = s.n_hits,
    n_small_indie_hits = s.n_small,
    small_indie_hit_share = CASE WHEN s.n_hits > 0 THEN s.n_small * 1.0 / s.n_hits END,
    indie_friendly = s.n_hits > 0
        AND s.n_small >= @INDIE_FRIENDLY_MIN_HITS@
        AND s.n_small * 1.0 / s.n_hits >= @INDIE_FRIENDLY_MIN_SHARE@
        AND COALESCE(n.solo_viability, 0) >= @INDIE_SINGLEPLAYER_MIN@
FROM _niche_indie AS s
WHERE s.dimension = n.dimension AND s.key = n.key
  AND s.win = n.win AND s.min_reviews = n.min_reviews;

-- A cut with no membership rows (not expected — mart_niche_game inherits mart_niche's gate)
-- reads as "no evidence", never as NULL-means-maybe.
UPDATE mart_niche SET n_hits_100k = 0, n_small_indie_hits = 0, indie_friendly = FALSE
WHERE n_hits_100k IS NULL;
