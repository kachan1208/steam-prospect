-- mart_niche.sql
-- Builds the niche/opportunity marts from staging tables (stg_game, stg_tag_membership,
-- stg_genre_membership, stg_singleplayer_tag, tag_tier) which build_marts.py creates first,
-- plus the TEMP _niche_players_now summary created by mart_players.sql (which runs before
-- this file — see MART_FILES ordering).
--   mart_niche       one row per (dimension, key, win, min_reviews) with opportunity score
--   mart_niche_top   top-N representative games per (dimension, key)
--   mart_niche_hist  revenue histogram per (dimension, key)   [window=all, min_reviews floor]
--   mart_niche_trend release counts per (dimension, key, year) -> saturation trend
-- Placeholder tokens are substituted by build_marts.py before execution.
--
-- Niche-score v2 columns (2026-08, additive — every v1 column is unchanged). Motivated by
-- a real user-rejected failure: sorting by raw `opportunity` surfaced Naval/Transportation/
-- Diplomacy (release pipelines shrinking 15-37%/yr — their "low competition" was everyone
-- LEAVING) and 4X/Open World (genre umbrellas, not buildable niches).
--
--   entrant_ratio   (24m median_rev) / (all-time median_rev) for the same (dimension, key,
--                   min_reviews) — the SAME value stamped on both win rows of a key. >1 =
--                   recent entrants outearn the niche's history; <1 = newcomers earn less
--                   than the back catalog did. NULL-safe: NULL when the all-time median is
--                   0/NULL or the 24m cut didn't materialise (under the MIN_NICHE_GAMES
--                   floor). CAVEAT: the catalog-median tag sits at ~1.08 (price inflation +
--                   the review floor filters recent releases harder), so read it against
--                   that norm, not against 1.0.
--   solo_viability  share of the cut's scored games that are playable single-player
--                   (stg_game.is_singleplayer: Steam's own `categories` field, community-
--                   tag fallback — see build_marts.py). Computed PER CUT from that cut's
--                   own population (not copied from the all-population), so the 24m cut
--                   reflects recent entrants. Catalog norm is ~0.9; below ~0.8 signals
--                   meaningful multiplayer dependence.
--
-- Solo-evidence trio (2026-08, additive). solo_viability is the niche's SINGLEPLAYER
-- SHARE — a no-netcode proxy, not a production-scope measure — so a bare 0.98 asserts
-- "solo-buildable" without showing who the members actually are. These three columns are
-- the member profile behind that share, computed over the SAME per-cut population as
-- solo_viability (the `agg` CTE over _niche_pop — identical scoping by construction):
--   self_published_share  AVG(self_published) over the cut's scored games. The SAME value
--                         as the long-standing self_pub_share, published under the
--                         evidence name the radar consumers probe for (aliased in the
--                         final SELECT — one computation, so the two can never drift).
--   indie_share           AVG(is_indie) over the cut's scored games.
--   med_playtime_h        median of member games' playtime_p50 (mart_game's per-game
--                         median playtime from the review sample, minutes), in HOURS,
--                         1 decimal. mart_game builds before this file (MART_FILES).
-- NULL-honest: AVG/median skip NULL inputs and return NULL when no member carries the
-- input (an older source without is_indie/playtime degrades to NULL, never to 0).
--   tier            tags only (dimension='genre' rows get 'genre'):
--                   'micro' | 'umbrella' | 'theme' | 'meta'. Curated TAG_TIER map in
--                   build_marts.py; unmapped tags: all-time n_games (win='all',
--                   min_reviews=@MIN_REVIEWS_DEFAULT@ cut) >= @UMBRELLA_N_GAMES@ ->
--                   'umbrella', else 'micro'.
--   decline_gate    A FALSIFICATION TELL, NOT A SCORE FACTOR (since 2026-08-31 — it used
--                   to multiply opportunity_v2; see the REBUILD block below). It answers
--                   one question: "did everyone STOP entering this niche?" — which is the
--                   MCP's falsification rule #1 and stays worth inspecting. In
--                   [@GATE_FLOOR@, 1]:
--                     sat_severity     = clamp(-saturation_yoy / @GATE_SAT_FULL_DECLINE@, 0, 1)
--                     entrant_severity = clamp((1 - entrant_ratio) / (1 - @GATE_ENTRANT_FULL@), 0, 1)
--                     gate = 1 - (1 - @GATE_FLOOR@) * GREATEST(sat_severity, entrant_severity)
--                   MAX (OR) semantics on purpose — either decline signal alone counts,
--                   because entrant_ratio >= 1 is the catalog NORM (see above) and must not
--                   excuse a collapsing release pipeline (Naval er~1.5, Fighting er~3.1
--                   would sail through an AND gate). NULL signals count as "no evidence of
--                   decline" (COALESCE to the neutral value), never as decline.
--   solo_tier       'solo' | 'mixed' | 'team' — the coarse read of solo_viability, NULL
--                   when the share is NULL. See the SOLO VIABILITY IS A FLAG block below.
--
-- ======================================================================================
-- opportunity_v2 REBUILT (2026-08-31) — the score and the Radar's ring are now ONE model
-- ======================================================================================
-- WHAT WAS WRONG (measured on 219 live niches, the tag / win=24m / min_reviews=50 cut
-- that the Radar board, MCP find_niches and NicheFinder all default to):
--
--   1. INVERTED. Median opportunity_v2 by the Radar's own ring:
--        enter 17.6 | hold 17.8 | crowded 20.9 | declining 23.4
--      The niches the board told you to ENTER scored LOWER than the ones it warned you
--      off. Two gradings ranking in opposite directions.
--   2. DEAD RING. The board's "watch" ring is `opportunity_v2 >= OPP_WATCH_SCORE`, then
--      60. Exactly 2 of 219 niches (0.9%) reached it; the catalog max was 63.7. That
--      constant was recalibrated 60 -> 65 with this rebuild (web/src/lib/radarVerdict.ts):
--      65 is the median score of the niches the board rings "enter", and it selects ~16%
--      of the default cut instead of ~1%.
--   3. STRUCTURAL CAUSE. corr(opportunity_v2, demand_trend_24m_pct) = -0.047 — the
--      headline score had NO relationship to the axis the Radar grades on. It blended
--      demand LEVEL percentiles (median_rev / median_owners / recent_velocity) against a
--      `competition` term that is 60% percentile(n_recent) — and on the win='24m' cut
--      n_recent IS n_games, so most of the "competition" penalty was a pure NICHE-SIZE
--      penalty. Metroidvania (177 recent games, demand +65%/24m) scored 0.0. Naval (34
--      games, demand -11.8%/24m) scored 63.7 and ranked #1.
--      NOTE the diagnosis that the numbers actually support: decline_gate was NOT the
--      culprit (its median was 1.000 — near-inert). The base `opportunity` was.
--
-- THE MODEL NOW. Four inspectable 0..100 sub-scores, blended, then braked by supply
-- pressure. The DEMAND and CONCENTRATION anchors below ARE thresholds
-- web/src/lib/radarVerdict.ts rings on, which is what makes the number and the ring agree
-- about direction. The SUPPLY brake is deliberately NOT the ring's supply read — see
-- "TWO VIEWS, BUT NOT ON SUPPLY" below before assuming they must match:
--
--   momentum        demand FLOW, the headline term. 50 + 50*tanh(g / g_enter) where
--                   g = ln(1 + demand_trend_24m_pct/100)/2 is the niche's annualised
--                   continuous demand growth and g_enter is the same for @OPP_ENTER_PCT@.
--                     flat demand (0%/24m)        -> 50.0
--                     Radar enter bar (+40%/24m)  -> 88.1   [DEMAND_ENTER_PCT]
--                     Radar hold bar  (-10%/24m)  -> 34.8   [DEMAND_HOLD_PCT]
--                     Radar decline bar (-30%/24m)-> 10.7   [DEMAND_DECLINE_PCT]
--                   tanh rather than a clamp because 61 of 219 niches clear the enter
--                   bar: a hard cap would flatten 28% of the catalog onto one value.
--   supply_room     supply FLOW + newcomer economics — the WEAKER (LEAST) of two reads,
--                   so either one alone can sink the score:
--                     flood_room   100 while demand outgrows supply; 50 when supply
--                                  outgrows demand by exactly @OPP_FLOOD_YOY@ (the Radar's
--                                  SAT_FLOOD_YOY); 0 at twice that.
--                     entrant_room 0 at entrant_ratio @OPP_ENTRANT_FULL@, 100 at the
--                                  CATALOG NORM @OPP_ENTRANT_NORM@ — read against the norm,
--                                  not against 1.0 (see entrant_ratio's caveat above), and
--                                  CAPPED there: above the norm is a survivor-cohort
--                                  artifact (Hero Shooter er 3.32), not evidence, so it
--                                  earns no bonus.
--   revenue_spread  revenue STRUCTURE from winner_concentration. 50 sits exactly on the
--                   Radar's WC_WINNER_TAKE_MOST bar (@OPP_WINNER_TAKE_MOST@); 100 at 0.70,
--                   0 at 1.00.
--   market_pull     the LEVEL terms, deliberately demoted to a supporting role:
--                   @OPP_MARKET_MEDIAN_W@*demand + (1-w)*market_size — "does a typical game
--                   here earn" blended with "how big is the pie".
--
--   opp_core       = weighted mean of the four (@W2_MOMENTUM@ / @W2_MARKET@ / @W2_SPREAD@ /
--                    @W2_QUALITY@), RENORMALISED over the sub-scores that exist.
--   supply_brake   = @SUPPLY_BRAKE_FLOOR@ + (1-floor)*supply_room/100; 1.0 when neither
--                    supply signal is available.
--   opportunity_v2 = clamp(opp_core * supply_brake, 0, 100).
--
-- WHY ADDITIVE MOMENTUM x MULTIPLICATIVE SUPPLY. Momentum had to be a first-class POSITIVE
-- term (the old decline_gate could only ever subtract, so a big stagnant niche beat a small
-- surging one by construction), while supply pressure had to be able to sink a score ON ITS
-- OWN. An additive term cannot sink — it can only remove its own weight; a multiplier
-- cannot reward. So momentum is additive and the largest weight, and supply is a multiplier
-- with a floor low enough to bite (a fully-flooded niche keeps 35% of its core).
--
-- WHY saturation_yoy IS READ AGAINST DEMAND. This column is the exact point where the two
-- old systems contradicted each other: decline_gate penalised saturation_yoy BELOW 0
-- (pipeline shrinking = decline) while the Radar penalises it ABOVE +0.15 (pipeline
-- flooding = crowding). Both readings are right; the disambiguator is demand. A pipeline
-- shrinking while demand holds is a supply GAP; a pipeline shrinking alongside demand is a
-- market dying. Differencing the two annualised growth rates resolves that structurally
-- instead of by fiat, and the death spiral earns no reward because momentum has already
-- scored the demand half. flood_room is ONE-SIDED (capped at 100 once demand outpaces
-- supply) on purpose: a collapsing pipeline is at best "calm", never a bonus — rewarding it
-- is exactly the Naval/Transportation failure mode that motivated v2 in the first place.
--
-- TWO VIEWS, BUT NOT ON SUPPLY (2026-09-01). The header above says "one model", and the
-- /docs page turned that into "the board and the score can't disagree". On supply that was
-- false, and measurably so. This mart reads supply RELATIVELY (flood_room: annualised supply
-- growth MINUS annualised demand growth, then LEAST()-ed with entrant_room). The Radar ring
-- reads it ABSOLUTELY and binary — saturation_yoy > SAT_FLOOD_YOY, full stop — because that
-- is the +15%/yr line the board literally draws across the plate as its quadrant divider.
-- MEASURED on the 222-niche default cut (tag / 24m / min50): 59 of 211 comparable niches
-- (28.0%) contradict on supply. 9 ring "supply flooding — vetoes enter" while supply_brake
-- is 1.0 (no brake at all); 43 ring "pipeline calm" while the brake sits under 0.80, and 15
-- of those are driven purely by entrant_room, which by construction never moves a ring.
-- Metroidvania is the sharpest: rings "supply not flooding", prints opportunity_v2 30.1
-- against an unbraked 56.0.
-- THE DEMAND TERM IS THE ENTIRE DIFFERENCE — not a hypothesis: among the 33 niches with
-- |demand_trend_24m_pct| < 5% the two reads agree 33/33 (100%), and among the 59 that
-- disagree the median |demand_trend_24m_pct| is 30.9%.
-- KEEP IT THAT WAY. Both alternatives were measured and rejected. Making the ring relative
-- moves 28/222 rings and promotes 7 winner-take-most niches to "Enter now". Making this
-- brake absolute changes 149/222 published scores and hands a top score back to every niche
-- everyone is LEAVING — the exact bug v2 exists to prevent. What must NOT happen is a silent
-- drift into a THIRD reading, so etl/tests/test_opportunity_ordering.py now pins the relative
-- form as an identity (flood_room < 50 <=> supply_growth - demand_growth > ln(1 +
-- OPP_FLOOD_YOY)) instead of only asserting OPP_FLOOD_YOY == SAT_FLOOD_YOY — asserting the
-- two CONSTANTS match while never asserting the two READINGS agree is precisely what let
-- this divergence sit undocumented.
--
-- NULL-HONESTY. A missing input does not vote and is never read as 0: the blend divides by
-- the weights of the sub-scores that exist. market_pull and quality_gap are percentiles and
-- always exist, so opportunity_v2 is never NULL. An unknown supply signal leaves the brake
-- at 1.0 — "no evidence of pressure", the same NULL policy decline_gate always used.
--
-- EMERGING NICHES. When demand_emerging is set, the niche's prior 24-month window is near
-- zero BY CONSTRUCTION, so its trend %, its saturation read AND its entrant_ratio are all
-- artifacts of the label's age (a young tag's 24m and all-time medians are the same games,
-- which pins entrant_ratio at ~1.00). All three flow sub-scores go NULL — the same
-- refusal-to-claim the Radar's precedence-0 emerging ring makes — and the niche is scored
-- on market_pull / revenue_spread / quality_gap alone.
--
-- MEASURED RESULT (same 219 niches, same rings), before -> after:
--     enter 17.6 -> 67.6 | hold 17.8 -> 50.2 | crowded 20.9 -> 39.1 | declining 23.4 -> 19.5
-- enter > hold > crowded > declining now holds, and holds on the min_reviews=0,
-- min_reviews=100 and win='all' cuts (pinned by etl/tests/test_opportunity_ordering.py).
-- Per-niche cross-cut rank agreement went UP: Spearman min50-vs-min0 0.553 -> 0.663,
-- 24m-vs-all 0.915 -> 0.955. That is not luck — momentum and flood_room are built from
-- demand_trend_24m_pct and saturation_yoy, which are ONE VALUE PER (dimension, key), so
-- they are identical on every cut by construction. Stronger comparability than the
-- percent_rank partitioning gives, not weaker.
--
-- ======================================================================================
-- SOLO VIABILITY IS A FLAG, NOT A SCALE (2026-08-31)
-- ======================================================================================
-- MEASURED over the same 219-niche cut:
--   min 0.353 | p05 0.853 | p10 0.913 | p25 0.953 | MEDIAN 0.975 | p75 0.990 | max 1.000
--   below 0.90: 7.8%    below 0.80: 3.2%   (stable across cuts: median 0.969-0.976)
-- Three quarters of the catalog sits inside a 0.047-wide band, so solo_viability is an
-- excellent binary multiplayer detector and a useless ranking scale. The seven niches under
-- 0.80 are the ones you would name by hand: Social Deduction 0.353, MMORPG 0.449, Party
-- Game 0.500, Party 0.636, Battle Royale 0.700, Extraction Shooter 0.705, eSports 0.788.
-- That compression is a TRUE FACT about the world — most genres really are solo-buildable —
-- not a defect to normalise away, so nothing rescales it. The raw share is published
-- unchanged and gains solo_tier beside it:
--   'team'  solo_viability <  @SOLO_TIER_TEAM_MAX@   multiplayer-dependent (~3%)
--   'mixed' in between                               passes the solo-only filter but has a
--                                                    real multiplayer minority (~5%)
--   'solo'  solo_viability >= @SOLO_TIER_SOLO_MIN@   the 10th percentile up (~92%)
-- The 0.80 pass bar is UNCHANGED (RADAR_SOLO_FRIENDLY_MIN / SOLO_FRIENDLY_MIN) — the
-- distribution says it is already the right cut. solo_viability is NOT an input to
-- opportunity_v2 and never was: solo-buildability is a property of the READER, not the
-- market (radarVerdict.ts argues this at length), and with 75% of niches inside a
-- 0.047-wide band it carries almost no ranking information anyway.
--
-- Live-player columns (2026-08, additive — from mart_players.sql's _niche_players_now;
-- ONE value per (dimension, key), stamped on all 4 cut rows like entrant_ratio; population
-- = the (win='all', min_reviews=@MIN_REVIEWS_DEFAULT@) scored cut):
--   total_players_now     summed current CCU of the niche's scored games (each game's
--                         latest nightly ~21-22:00 UTC point sample, <= 7 days old — NOT
--                         a daily peak). NULL = never measured / mart predates collection.
--   players_trend_7d_pct  same-panel last-7d vs prior-7d change (%): only games measured
--                         in BOTH windows count, so coverage growth can't fake a trend.
--   players_coverage      share of total_players_now measured fresh (<= 2 days); low
--                         values mean the total leans on carried tail values.

DROP TABLE IF EXISTS mart_niche;
DROP TABLE IF EXISTS mart_niche_top;
DROP TABLE IF EXISTS mart_niche_hist;
DROP TABLE IF EXISTS mart_niche_trend;

-- THE NICHE POPULATION, materialised once and shared with mart_niche_game.sql (next in
-- MART_FILES). This used to be an inline `pop` CTE here, and mart_niche_game.sql had to restate
-- the same joins and predicates to reproduce it.
--
-- Sharing it is not tidiness. mart_niche publishes n_games, and the niche drill-down charts the
-- games behind that number: if the two populations differ by so much as one predicate, the chart
-- silently disagrees with the headline sitting above it — plausible, wrong, and invisible. As one
-- table that cannot happen, instead of being a thing a test has to keep catching.
--
-- TEMP and deliberately NOT dropped here: mart_niche_game.sql reads it and drops it as its last
-- consumer. Same cross-file TEMP pattern as _niche_players_now from mart_players.sql.
DROP TABLE IF EXISTS _niche_pop;
CREATE TEMP TABLE _niche_pop AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
mr AS ( SELECT * FROM (VALUES @MR_VALUES@) AS t(min_reviews) ),
wins AS ( SELECT * FROM (VALUES ('all'),('24m')) AS t(win) )
SELECT
    m.dimension, m.key, w.win, mr.min_reviews,
    g.appid, g.est_rev_reviews, g.total_reviews, g.price_initial,
    g.positive_ratio, g.owners_mid, g.self_published, g.is_singleplayer,
    -- Solo-evidence inputs (see header): is_indie from staging; playtime_p50 from
    -- mart_game (built earlier in MART_FILES — same cross-mart read mart_entity.sql
    -- makes), the per-game median playtime of the review SAMPLE, in minutes.
    g.is_indie, mg.playtime_p50,
    (g.release_valid AND g.release_date >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH) AS is_recent
FROM membership m
JOIN stg_game g ON g.appid = m.appid
LEFT JOIN mart_game mg ON mg.appid = m.appid
CROSS JOIN wins w
CROSS JOIN mr
WHERE g.total_reviews >= mr.min_reviews
  AND g.est_rev_reviews IS NOT NULL
  AND (
        w.win = 'all'
        OR (g.release_valid AND g.release_date >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH)
      );

-- DEMAND OVER 24 MONTHS — the metric the Radar surfaces ring and rank on. Nothing else in
-- the marts carries a demand trend: players_trend_7d_pct is a 7-day window, and
-- saturation_yoy counts RELEASES (pipeline), not demand.
--
-- WHY 24-MONTH WINDOWS (2026-08-26, user-directed, replacing the 12-month windows — which
-- had themselves replaced the original 90-day windows): the Radar's pinned membership cut
-- is already 24m x min50 ("the market a new entrant faces"), so the demand trend now
-- speaks the same horizon — last 24 complete months vs the 24 before them. The structural
-- argument that killed the 90d windows only strengthens: a game started today ships 1-3
-- years out, each window now holds two full seasonal cycles (seasonality cancels instead
-- of aliasing), and a single launch spike is diluted across 24 months.
--
-- SOURCE (2026-08-23, kept from the 90d/12m versions): stg_review_histogram (Steam's own
-- per-month review totals), NOT stg_review. The first 90d cut counted the sampled reviews
-- table and asserted the bias "largely cancels in a ratio". Measured, it does the
-- opposite: the keeper collects NEW reviews near-completely while a big game's historical
-- tail stays capped by deepen-reviews, so the recent window is full and the prior window
-- is a sparse sample; Radar's entire top row read +980%..+1530% until the switch (Rainbow
-- Six: 16.0x on the sample, FLAT on the histogram). The bias is asymmetric BETWEEN the
-- windows, so a ratio amplifies it.
--
-- The histogram is uncapped truth for every game with >=50 total reviews — 42,103 games
-- carrying 97.6% of all review volume. Games without one (the <50-review tail) contribute
-- nothing here, which biases niche totals toward covered games; for a per-niche demand
-- TREND that is the acceptable side of the trade, because the alternative contributes
-- fiction.
--
-- Windows are whole months anchored on the last GLOBALLY complete month (max period - 1):
-- now = (anchor-24 .. anchor], prev = (anchor-48 .. anchor-24] — 24 calendar months each.
-- A global anchor, not per-game: anchoring on each game's own last month would date a dead
-- game's "current" trend to whenever it died. Known softness: histograms are refreshed in
-- bulk (most fetched ~monthly), so the anchor month is truncated at fetch date for most
-- games — uniformly across every game and niche, which preserves ranking; the trend lags
-- reality by up to a month until histogram refresh cadence improves.
--
-- CUT-INDEPENDENT — ONE VALUE PER (dimension, key), stamped on every (win, min_reviews)
-- row like entrant_ratio and the players columns. One reason per grid axis:
--   min_reviews (kept from the 90d version, 2026-08-25): demand is the niche's overall
--     review inflow — grouping by the floor made a display toggle change a niche's trend
--     and, through the Radar board's client-side verdicts, its ring. Collapsing the
--     floors loses nothing real: the histogram only covers >=50-review games anyway.
--   win (since the 12m windows; the 90d CTE joined per win — with 24m windows the case
--     is absolute): the win='24m' population holds only games RELEASED in the last
--     @RECENT_MONTHS@ months, so NO member can have inflow in the prior-24m window (it
--     did not exist yet). A per-win join would NULL out every trend on that cut, and
--     that cut is exactly the one the Radar board pins. Demand is a property of the
--     NICHE, so it is computed once over the full membership (the (win='all',
--     min_reviews=0) superset) and stamped on every cut.
--
-- EMERGING (2026-08-26, user-directed): young Steam tags crystallize around NEW games
-- only — 'Organizing' appears, its new games get the tag, but the genre's ancestors
-- (Unpacking, A Little to the Left) never get re-voted into it — so the tag's prior
-- window is near zero BY CONSTRUCTION and a raw +4,775% trend is a property of the
-- label's age, not of demand. Two tells, either one flags the niche:
--   demand_emerging = reviews_prev_24m < @DEMAND_MIN_BASE@            (no comparable base)
--                  OR reviews_24m_new_share >= @DEMAND_NEW_MASS_SHARE@ (the review mass IS
--                     the newest games, even when a stray old title lifts the prev window)
-- reviews_24m_new_share = the fraction of reviews_24m contributed by member games
-- released within the last @RECENT_MONTHS@ months (same release predicate as the
-- win='24m' population cut; NULL/invalid release dates count as NOT new; NULL share when
-- the niche had no window inflow at all). demand_trend_24m_pct stays COMPUTED AND SERVED
-- for emerging niches — the raw data stays honest; not headlining a non-representative %
-- is a presentation/verdict concern for the clients (radar feed ranking, web verdicts).
DROP TABLE IF EXISTS _niche_demand24m;
CREATE TEMP TABLE _niche_demand24m AS
WITH anchor AS (
    SELECT date_trunc('month', MAX(period_month)) - INTERVAL 1 MONTH AS m
    FROM stg_review_histogram
),
v AS (
    SELECT h.appid,
        SUM(h.n_reviews) FILTER (
            WHERE h.period_month >  (SELECT m FROM anchor) - INTERVAL 24 MONTH
              AND h.period_month <= (SELECT m FROM anchor)
        ) AS r_now,
        SUM(h.n_reviews) FILTER (
            WHERE h.period_month >  (SELECT m FROM anchor) - INTERVAL 48 MONTH
              AND h.period_month <= (SELECT m FROM anchor) - INTERVAL 24 MONTH
        ) AS r_prev
    FROM stg_review_histogram h
    GROUP BY h.appid
),
-- Collapse the whole cut grid: one membership row per (dimension, key, appid). The
-- (win='all', min_reviews=0) population is the superset of every other cut, so this IS
-- the niche's full scored membership.
members AS (
    SELECT DISTINCT dimension, key, appid FROM _niche_pop
),
agg AS (
    SELECT p.dimension, p.key,
           SUM(COALESCE(v.r_now, 0))  AS reviews_24m,
           SUM(COALESCE(v.r_prev, 0)) AS reviews_prev_24m,
           -- Share of the now-window inflow from games released in the last
           -- @RECENT_MONTHS@ months (the win='24m' cut's own release predicate, so
           -- NULL/invalid release dates count as NOT new). NULL when there is no inflow
           -- to take a share of.
           CASE WHEN SUM(COALESCE(v.r_now, 0)) = 0 THEN NULL
                ELSE COALESCE(SUM(COALESCE(v.r_now, 0)) FILTER (
                         WHERE g.release_valid
                           AND g.release_date >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH
                     ), 0) * 1.0 / SUM(COALESCE(v.r_now, 0))
           END AS new_share
    FROM members p
    LEFT JOIN v ON v.appid = p.appid
    LEFT JOIN stg_game g ON g.appid = p.appid
    GROUP BY 1, 2
)
SELECT dimension, key, reviews_24m, reviews_prev_24m,
       round(new_share, 4) AS reviews_24m_new_share,
       -- Never NULL: the NULL-share case (zero inflow) always has a sub-floor prev base
       -- too small to rank on anyway, and COALESCE keeps the boolean honest when the
       -- share is NULL with a large prev base (a dead niche is not "emerging").
       (reviews_prev_24m < @DEMAND_MIN_BASE@
        OR COALESCE(new_share >= @DEMAND_NEW_MASS_SHARE@, FALSE)) AS demand_emerging
FROM agg;

CREATE TABLE mart_niche AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
ranked AS (
    SELECT *,
        percent_rank() OVER (PARTITION BY dimension, key, win, min_reviews
                             ORDER BY est_rev_reviews) AS rev_pr
    FROM _niche_pop
),
agg AS (
    SELECT
        dimension, key, win, min_reviews,
        COUNT(*) AS n_games,
        COUNT(*) FILTER (WHERE is_recent) AS n_recent,
        median(est_rev_reviews) AS median_rev,
        quantile_cont(est_rev_reviews, 0.25) AS p25_rev,
        quantile_cont(est_rev_reviews, 0.75) AS p75_rev,
        quantile_cont(est_rev_reviews, 0.90) AS p90_rev,
        median(total_reviews) AS median_reviews,
        quantile_cont(total_reviews, 0.25) AS p25_reviews,
        quantile_cont(total_reviews, 0.75) AS p75_reviews,
        median(price_initial) AS median_price,
        quantile_cont(price_initial, 0.25) AS p25_price,
        quantile_cont(price_initial, 0.75) AS p75_price,
        median(positive_ratio) AS median_positive_ratio,
        median(owners_mid) AS median_owners,
        -- Absolute niche SIZE (the "pie"): totals across the scored population, NOT
        -- per-game medians. A narrow niche of strong games has high median_* but small
        -- totals; these expose that difference so a solo dev can prefer a small slice of
        -- a big pie over a big slice of a small one.
        SUM(owners_mid) AS total_owners,
        SUM(est_rev_reviews) AS total_rev,
        SUM(total_reviews) AS total_reviews,
        median(total_reviews) FILTER (WHERE is_recent) AS recent_velocity,
        AVG(CAST(self_published AS DOUBLE)) AS self_pub_share,
        -- v2: share of THIS cut's scored games playable single-player (per-cut on purpose,
        -- so the 24m cut describes recent entrants, not the whole back catalog).
        AVG(CASE WHEN is_singleplayer THEN 1.0 ELSE 0.0 END) AS solo_viability,
        -- Solo-evidence trio (see header): the member profile behind solo_viability, same
        -- per-cut population by construction (this very GROUP BY). NULL-honest — AVG and
        -- median skip NULLs and go NULL when no member carries the input.
        AVG(CAST(is_indie AS DOUBLE)) AS indie_share,
        median(playtime_p50) AS med_playtime_min,
        SUM(est_rev_reviews) FILTER (WHERE rev_pr >= @WINNER_TOP_PCT@)
            / NULLIF(SUM(est_rev_reviews), 0) AS winner_concentration,
        AVG(CASE WHEN est_rev_reviews > @TIMING_BIG_REV@ THEN 1.0 ELSE 0.0 END) AS hit_rate_200k,
        AVG(CASE WHEN est_rev_reviews > 500000 THEN 1.0 ELSE 0.0 END) AS hit_rate_500k,
        AVG(CASE WHEN positive_ratio IS NULL OR positive_ratio < @BEATABLE_RATIO_BAR@
                      OR total_reviews < @THIN_REVIEWS_BAR@ THEN 1.0 ELSE 0.0 END) AS beatable_share
    FROM ranked
    GROUP BY dimension, key, win, min_reviews
    HAVING COUNT(*) >= @MIN_NICHE_GAMES@
),
sat AS (
    SELECT m.dimension, m.key,
        COUNT(*) FILTER (WHERE g.release_year = @RECENT_YEAR@) AS n_recent_year,
        COUNT(*) FILTER (WHERE g.release_year = @PRIOR_YEAR@) AS n_prior_year
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.release_year IS NOT NULL AND g.release_year <= @CUR_YEAR@
    GROUP BY m.dimension, m.key
),
opp AS (
    SELECT *,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY median_rev) AS pr_rev,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(median_owners,0)) AS pr_own,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(total_owners,0)) AS pr_size,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(recent_velocity,0)) AS pr_vel,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY n_recent) AS pr_nrec,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY COALESCE(winner_concentration,0)) AS pr_wc,
        100.0 * percent_rank() OVER (PARTITION BY dimension, win, min_reviews ORDER BY beatable_share) AS pr_beatable
    FROM agg
),
final AS (
    SELECT *,
        (0.4 * pr_rev + 0.3 * pr_own + 0.3 * pr_vel) AS demand,
        (0.6 * pr_nrec + 0.4 * pr_wc) AS competition,
        pr_beatable AS quality_gap,
        pr_size AS market_size
    FROM opp
),
scored AS (
    SELECT f.*,
        CASE WHEN s.n_prior_year > 0
             THEN (s.n_recent_year - s.n_prior_year) * 1.0 / s.n_prior_year
             ELSE NULL END AS saturation_yoy,
        s.n_recent_year, s.n_prior_year
    FROM final f
    LEFT JOIN sat s ON s.dimension = f.dimension AND s.key = f.key
),
-- v2: cross-cut lookups via window functions over the key's own rows — entrant_ratio
-- compares the 24m and all rows of the SAME (dimension, key, min_reviews); the all-time
-- game count for the tier heuristic always comes from the (win='all',
-- min_reviews=@MIN_REVIEWS_DEFAULT@) cut, the broadest population, which exists whenever
-- ANY cut of the key exists (every other cut's population is a subset of it).
enriched AS (
    SELECT *,
        MAX(CASE WHEN win = '24m' THEN median_rev END)
            OVER (PARTITION BY dimension, key, min_reviews)
          / NULLIF(MAX(CASE WHEN win = 'all' THEN median_rev END)
            OVER (PARTITION BY dimension, key, min_reviews), 0) AS entrant_ratio,
        MAX(CASE WHEN win = 'all' AND min_reviews = @MIN_REVIEWS_DEFAULT@ THEN n_games END)
            OVER (PARTITION BY dimension, key) AS n_games_alltime
    FROM scored
),
-- decline gate — a FALSIFICATION TELL, no longer a score factor (full rationale in the
-- header + build_marts.py): either decline signal alone shrinks it linearly toward
-- @GATE_FLOOR@; NULL signals are neutral, never treated as decline.
gated AS (
    SELECT *,
        1.0 - (1.0 - @GATE_FLOOR@) * GREATEST(
            LEAST(1.0, GREATEST(0.0,
                -COALESCE(saturation_yoy, 0.0) / @GATE_SAT_FULL_DECLINE@)),
            LEAST(1.0, GREATEST(0.0,
                (1.0 - COALESCE(entrant_ratio, 1.0)) / (1.0 - @GATE_ENTRANT_FULL@)))
        ) AS decline_gate
    FROM enriched
),
-- ======================================================================================
-- opportunity_v2's inputs. The 24-month demand columns are joined HERE rather than in the
-- final SELECT (where they used to live) because the score is built on them: momentum and
-- flood_room ARE demand_trend_24m_pct and saturation_yoy, read on the Radar's own bars.
-- The join stays cut-independent — one row per (dimension, key) stamped on every cut.
-- ======================================================================================
flows AS (
    SELECT g.*,
        d.reviews_24m, d.reviews_prev_24m, d.reviews_24m_new_share,
        COALESCE(d.demand_emerging, FALSE) AS demand_emerging,
        -- NULL, not 0, when the prior window is empty: "no baseline to compare against"
        -- and "no change" are different answers, and a niche whose first reviews all
        -- landed inside the last 24 months would otherwise read as flat instead of new.
        CASE WHEN COALESCE(d.reviews_prev_24m, 0) = 0 THEN NULL
             ELSE round(100.0 * (d.reviews_24m - d.reviews_prev_24m) / d.reviews_prev_24m, 1)
        END AS demand_trend_24m_pct
    FROM gated g
    LEFT JOIN _niche_demand24m d
           ON d.dimension = g.dimension AND d.key = g.key
),
-- Annualised CONTINUOUS growth rates, so the demand trend (a 24-month ratio) and the
-- saturation trend (a 12-month ratio) are commensurable and can be differenced. The
-- GREATEST(..., 0.001) floors keep ln() finite at the degenerate ends (trend = -100% when
-- a niche's recent window is empty; saturation_yoy = -1 when a release year is empty) —
-- both already clamp to the worst sub-score, so the floor changes no published value.
-- Both go NULL for emerging niches: their windows are not comparable (see header).
rates AS (
    SELECT f.*,
        CASE WHEN f.demand_trend_24m_pct IS NULL OR f.demand_emerging THEN NULL
             ELSE ln(GREATEST(1.0 + f.demand_trend_24m_pct / 100.0, 0.001)) / 2.0
        END AS demand_growth,
        CASE WHEN f.saturation_yoy IS NULL OR f.demand_emerging THEN NULL
             ELSE ln(GREATEST(1.0 + f.saturation_yoy, 0.001))
        END AS supply_growth
    FROM flows f
),
-- The four sub-scores, each 0..100 and each anchored on a Radar ring threshold.
subscores AS (
    SELECT r.*,
        -- 50 at flat demand, 88.1 at the Radar's enter bar, 10.7 at its decline bar.
        CASE WHEN r.demand_growth IS NULL THEN NULL
             ELSE 50.0 + 50.0 * tanh(
                    r.demand_growth / (ln(1.0 + @OPP_ENTER_PCT@ / 100.0) / 2.0))
        END AS momentum,
        -- Supply growth measured AGAINST demand growth. One-sided: no credit for a
        -- pipeline collapsing on its own.
        -- The COALESCE(demand_growth, 0) is DEFENSIVE, not load-bearing, and the
        -- difference matters — do not read it as radarVerdict.ts's "demand unknown does
        -- not rescue a flooding niche" rule. In this mart demand_growth is NULL only when
        -- demand_emerging is set (a NULL trend means reviews_prev_24m = 0, which is under
        -- @DEMAND_MIN_BASE@, which sets the flag), and that same flag already NULLs
        -- supply_growth — so the CASE returns NULL first and the COALESCE never fires.
        -- The mart's ACTUAL behaviour for an unknown demand base is therefore
        -- supply_room NULL -> supply_brake 1.0: no penalty. That is the deliberate
        -- choice (an emerging niche's saturation read is an artifact of the label's age,
        -- so penalising on it would be inventing evidence); the board's stricter rule
        -- applies to its own ring decision, which is a different question.
        CASE WHEN r.supply_growth IS NULL THEN NULL
             ELSE 100.0 * (1.0 - LEAST(1.0, GREATEST(0.0,
                    (r.supply_growth - COALESCE(r.demand_growth, 0.0))
                    / (2.0 * ln(1.0 + @OPP_FLOOD_YOY@)))))
        END AS flood_room,
        -- Read against the CATALOG NORM and capped there (see header).
        CASE WHEN r.entrant_ratio IS NULL OR r.demand_emerging THEN NULL
             ELSE 100.0 * LEAST(1.0, GREATEST(0.0,
                    (r.entrant_ratio - @OPP_ENTRANT_FULL@)
                    / (@OPP_ENTRANT_NORM@ - @OPP_ENTRANT_FULL@)))
        END AS entrant_room,
        -- 50 sits exactly on the winner-take-most bar.
        CASE WHEN r.winner_concentration IS NULL THEN NULL
             ELSE 100.0 * LEAST(1.0, GREATEST(0.0,
                    (1.0 - r.winner_concentration)
                    / (2.0 * (1.0 - @OPP_WINNER_TAKE_MOST@))))
        END AS revenue_spread,
        -- Level terms, demoted to a supporting role. Never NULL: both are percentiles.
        @OPP_MARKET_MEDIAN_W@ * r.demand
            + (1.0 - @OPP_MARKET_MEDIAN_W@) * r.market_size AS market_pull
    FROM rates r
),
-- The weaker of the two supply reads wins (LEAST = OR-severity, the same either-signal
-- semantics decline_gate used). Written out rather than leaning on DuckDB's NULL-skipping
-- LEAST(), so the NULL policy is visible instead of implied.
supply AS (
    SELECT s.*,
        CASE WHEN s.flood_room IS NULL THEN s.entrant_room
             WHEN s.entrant_room IS NULL THEN s.flood_room
             ELSE LEAST(s.flood_room, s.entrant_room)
        END AS supply_room
    FROM subscores s
),
-- The blend. NULL-honest by renormalisation: a missing sub-score drops out of BOTH the
-- numerator and the denominator, so it neither helps nor hurts — it is never read as 0.
-- market_pull and quality_gap always exist, so the denominator is never 0.
scored_v2 AS (
    SELECT b.*,
        (   @W2_MOMENTUM@ * COALESCE(b.momentum, 0.0)
          + @W2_MARKET@   * b.market_pull
          + @W2_SPREAD@   * COALESCE(b.revenue_spread, 0.0)
          + @W2_QUALITY@  * b.quality_gap
        ) / (
            CASE WHEN b.momentum IS NULL THEN 0.0 ELSE @W2_MOMENTUM@ END
          + @W2_MARKET@
          + CASE WHEN b.revenue_spread IS NULL THEN 0.0 ELSE @W2_SPREAD@ END
          + @W2_QUALITY@
        ) AS opp_core,
        -- Unknown supply = no evidence of pressure = no brake (never a penalty).
        CASE WHEN b.supply_room IS NULL THEN 1.0
             ELSE @SUPPLY_BRAKE_FLOOR@
                  + (1.0 - @SUPPLY_BRAKE_FLOOR@) * b.supply_room / 100.0
        END AS supply_brake
    FROM supply b
)
SELECT
    g.dimension, g.key, g.win, g.min_reviews,
    g.n_games, g.n_recent,
    g.median_rev, g.p25_rev, g.p75_rev, g.p90_rev,
    g.median_reviews, g.p25_reviews, g.p75_reviews,
    g.median_price, g.p25_price, g.p75_price,
    g.median_positive_ratio,
    g.median_owners,
    g.total_owners, g.total_rev, g.total_reviews,
    round(g.market_size, 2) AS market_size,
    COALESCE(g.recent_velocity, 0) AS recent_velocity,
    g.self_pub_share,
    g.winner_concentration,
    g.hit_rate_200k, g.hit_rate_500k,
    g.beatable_share,
    g.saturation_yoy,
    g.n_recent_year, g.n_prior_year,
    round(g.demand, 2) AS demand,
    round(g.competition, 2) AS competition,
    round(g.quality_gap, 2) AS quality_gap,
    round(GREATEST(0, LEAST(100,
        @W_DEMAND@ * g.demand - @W_COMPETITION@ * g.competition + @W_QUALITY@ * g.quality_gap)), 2) AS opportunity,
    -- v2 columns (additive; see header).
    g.entrant_ratio,
    g.solo_viability,
    -- solo_tier: the coarse read of solo_viability. A FLAG, not a scale — see the
    -- SOLO VIABILITY IS A FLAG header block. NULL share stays NULL ("unknown" is its own
    -- answer and is never counted as solo-friendly).
    CASE WHEN g.solo_viability IS NULL THEN NULL
         WHEN g.solo_viability < @SOLO_TIER_TEAM_MAX@ THEN 'team'
         WHEN g.solo_viability >= @SOLO_TIER_SOLO_MIN@ THEN 'solo'
         ELSE 'mixed'
    END AS solo_tier,
    -- Solo-evidence trio (additive; see header). self_published_share IS self_pub_share
    -- under the evidence name the radar consumers probe for — one computation, aliased,
    -- so the two names can never disagree. med_playtime_h converts mart_game's minutes
    -- to hours at 1 decimal; NULL stays NULL (round(NULL) is NULL).
    g.self_pub_share AS self_published_share,
    g.indie_share,
    round(g.med_playtime_min / 60.0, 1) AS med_playtime_h,
    CASE WHEN g.dimension = 'genre' THEN 'genre'
         ELSE COALESCE(tt.tier,
                       CASE WHEN g.n_games_alltime >= @UMBRELLA_N_GAMES@
                            THEN 'umbrella' ELSE 'micro' END)
    END AS tier,
    round(g.decline_gate, 4) AS decline_gate,
    -- The v2 sub-scores, published so every score can be taken apart into the four claims
    -- it makes. NULL is preserved all the way out: a NULL sub-score means "this niche has
    -- no comparable reading here", which the blend honoured by renormalising.
    round(g.momentum, 2) AS momentum,
    round(g.supply_room, 2) AS supply_room,
    round(g.revenue_spread, 2) AS revenue_spread,
    round(g.market_pull, 2) AS market_pull,
    round(g.supply_brake, 4) AS supply_brake,
    round(GREATEST(0, LEAST(100, g.opp_core * g.supply_brake)), 2) AS opportunity_v2,
    -- Live-player columns (additive; see header — one value per key across all cuts).
    np.total_players_now,
    round(np.players_trend_7d_pct, 2) AS players_trend_7d_pct,
    round(np.players_coverage, 4) AS players_coverage,
    round(np.median_players_now, 1) AS median_players_now,
    round(np.players_top5_share, 4) AS players_top5_share,
    -- Lifetime columns (additive; from mart_players.sql _niche_lifetime — 100+-reaching
    -- games only, steamcharts top-8k coverage; NULL = too few covered games, "unknown").
    nl.lifetime_n_games,
    nl.lifetime_survival_12m,
    nl.lifetime_median_dead_months,
    -- 24-month demand. Joined upstream in the `flows` CTE (the score is built on these),
    -- so they are carried through here rather than re-joined — one computation, no way for
    -- the published trend and the trend the score used to disagree. Still cut-independent
    -- (see _niche_demand24m's header): every (win, min_reviews) cut of a (dimension, key)
    -- carries the SAME demand numbers.
    g.reviews_24m,
    g.reviews_prev_24m,
    g.demand_trend_24m_pct,
    -- Emerging pair (see _niche_demand24m's EMERGING header). The trend above stays
    -- computed for emerging niches — clients decide not to headline it, and the score
    -- declines to read it (momentum goes NULL there).
    g.reviews_24m_new_share,
    g.demand_emerging
FROM scored_v2 g
LEFT JOIN tag_tier tt ON g.dimension = 'tag' AND tt.tag = g.key
LEFT JOIN _niche_players_now np ON np.dimension = g.dimension AND np.key = g.key
LEFT JOIN _niche_lifetime nl ON nl.dimension = g.dimension AND nl.key = g.key;

CREATE TABLE mart_niche_top AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
scoped AS (
    SELECT m.dimension, m.key, g.appid, g.name, g.release_year,
        g.price_initial, g.owners_mid, g.total_reviews, g.positive_ratio,
        g.review_count_source,
        g.est_rev_reviews, g.self_published,
        row_number() OVER (PARTITION BY m.dimension, m.key ORDER BY g.est_rev_reviews DESC) AS rank_in_niche
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
    QUALIFY rank_in_niche <= @TOP_GAMES_PER_NICHE@
)
SELECT s.dimension, s.key, s.rank_in_niche, s.appid, s.name, s.release_year,
    s.price_initial, s.owners_mid, s.total_reviews, s.positive_ratio, s.review_count_source,
    s.est_rev_reviews, s.self_published, gh.header_image
FROM scoped s
LEFT JOIN src.games gh ON gh.appid = s.appid;

CREATE TABLE mart_niche_hist AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
scoped AS (
    SELECT m.dimension, m.key, g.est_rev_reviews AS v
    FROM membership m
    JOIN stg_game g ON g.appid = m.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
),
counts AS ( SELECT dimension, key, COUNT(*) n FROM scoped GROUP BY 1,2 HAVING COUNT(*) >= @MIN_NICHE_GAMES@ ),
bucketed AS (
    SELECT s.dimension, s.key,
        CAST(floor(log10(GREATEST(s.v, 1)) * 2) AS INTEGER) AS bkt
    FROM scoped s
    JOIN counts c ON c.dimension = s.dimension AND c.key = s.key
)
SELECT dimension, key, bkt AS bucket_index,
    pow(10, bkt / 2.0) AS x_min,
    pow(10, (bkt + 1) / 2.0) AS x_max,
    COUNT(*) AS count
FROM bucketed
GROUP BY dimension, key, bkt;

CREATE TABLE mart_niche_trend AS
WITH membership AS (
    SELECT 'tag' AS dimension, tag AS key, appid FROM stg_tag_membership
    UNION ALL
    SELECT 'genre' AS dimension, genre AS key, appid FROM stg_genre_membership
),
counts AS ( SELECT dimension, key, COUNT(*) n FROM membership GROUP BY 1,2 HAVING COUNT(*) >= @MIN_NICHE_GAMES@ )
SELECT m.dimension, m.key, g.release_year AS year,
    COUNT(*) AS n_releases,
    COUNT(*) FILTER (WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@) AS n_scored,
    median(g.est_rev_reviews) FILTER (WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@) AS median_rev,
    quantile_cont(g.est_rev_reviews, 0.90) FILTER (WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@) AS p90_rev
FROM membership m
JOIN stg_game g ON g.appid = m.appid
JOIN counts c ON c.dimension = m.dimension AND c.key = m.key
WHERE g.release_year IS NOT NULL
  AND g.release_year BETWEEN @TREND_START_YEAR@ AND @CUR_YEAR@
GROUP BY m.dimension, m.key, g.release_year;

-- Temp-table hygiene: _niche_demand24m is file-local; _niche_players_now /
-- _niche_lifetime are mart_players.sql handoffs whose LAST consumer is this file
-- (verified — no later mart file or build_marts.py reads them). _niche_pop is
-- deliberately left alive: mart_niche_game.sql (next in MART_FILES) reads it and
-- drops it itself.
DROP TABLE IF EXISTS _niche_demand24m;
DROP TABLE IF EXISTS _niche_players_now;
DROP TABLE IF EXISTS _niche_lifetime;
