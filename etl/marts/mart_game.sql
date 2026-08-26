-- mart_game.sql
-- Per-appid fact row: metadata + revenue/owners + positive_ratio + percentile rank of
-- est_rev_reviews within the game's primary genre. Powers lookups / "where do I land".
-- Uses staging stg_game, stg_primary_genre, stg_review + src.games (header art,
-- description) + stg_game_tags (top-tags vector, filtered same as stg_tag_membership).
--
-- Phase 2 additions: percentile-vs-genre for reviews/owners (alongside the existing
-- revenue percentile), a top-N tag vector (powers on-demand comparables + tag search —
-- see api/app/routers/games.py, never precomputed pairwise), a review-velocity summary,
-- and playtime percentiles — all from the per-review SAMPLE (stg_review), so these
-- describe the sample, not Steam's true totals.
--
-- total_reviews/positive_ratio/owners_mid/est_rev_reviews/est_rev_owners are reconciled
-- against the actual `reviews` table in stg_game (SteamSpy lags badly for new releases —
-- see build_marts.py's create_staging()). review_count_source ('steamspy'|'reviews_sample'
-- |'reconciled') records whether/how: non-'steamspy' rows are an honest lower bound, since
-- `reviews` is itself a per-game sample.

DROP TABLE IF EXISTS mart_game;

CREATE TABLE mart_game AS
WITH pct_ranks AS (
    SELECT g.appid,
        100.0 * percent_rank() OVER (PARTITION BY pg.primary_genre ORDER BY g.est_rev_reviews) AS rev_pct_in_genre,
        100.0 * percent_rank() OVER (PARTITION BY pg.primary_genre ORDER BY g.total_reviews) AS reviews_pct_in_genre,
        100.0 * percent_rank() OVER (PARTITION BY pg.primary_genre ORDER BY g.owners_mid) AS owners_pct_in_genre
    FROM stg_game g
    JOIN stg_primary_genre pg ON pg.appid = g.appid
    WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.est_rev_reviews IS NOT NULL
),
tag_ranked AS (
    -- stg_game_tags, NOT src.game_tags: HTML-entity phantom-twin tags fake niche demand
    -- trends (source fixed 2026-08-26; stale snapshots/regressions must not resurrect them).
    SELECT gt.appid, gt.tag,
        row_number() OVER (PARTITION BY gt.appid ORDER BY gt.rank) AS rn
    FROM stg_game_tags gt
    WHERE gt.votes >= @TAG_VOTE_FLOOR@
      AND gt.tag NOT IN (SELECT tag FROM denylist_tag)
),
top_tags_agg AS (
    SELECT appid, list(tag ORDER BY rn) AS top_tags
    FROM tag_ranked
    WHERE rn <= @TOP_TAGS_PER_GAME@
    GROUP BY appid
),
velocity AS (
    SELECT appid,
        COUNT(*) AS n_reviews_sampled,
        COUNT(*) FILTER (WHERE dsr BETWEEN 0 AND 30) AS n_reviews_first_30d,
        COUNT(*) FILTER (WHERE dsr BETWEEN 0 AND 90) AS n_reviews_first_90d,
        COUNT(*) FILTER (WHERE dsr BETWEEN 0 AND 365) AS n_reviews_first_365d,
        COUNT(*) FILTER (WHERE review_date >= CURRENT_DATE - INTERVAL 30 DAY) AS n_reviews_trailing_30d,
        quantile_cont(playtime_forever, 0.25) FILTER (WHERE playtime_forever IS NOT NULL AND playtime_forever > 0) AS playtime_p25,
        quantile_cont(playtime_forever, 0.50) FILTER (WHERE playtime_forever IS NOT NULL AND playtime_forever > 0) AS playtime_p50,
        quantile_cont(playtime_forever, 0.75) FILTER (WHERE playtime_forever IS NOT NULL AND playtime_forever > 0) AS playtime_p75
    FROM stg_review
    GROUP BY appid
),
ccu AS (
    -- Live concurrent players (steam_players_bulk.py -> player_counts, latest snapshot).
    SELECT appid, live_players FROM stg_player_count_latest
),
dev_x AS (
    -- The game's most PROMINENT official link PER PLATFORM, from stg_game_socials (guarded
    -- staging over the scraper's game_socials table — links harvested from the game's
    -- developer-controlled pages: store page + dev website, NOT from the platforms
    -- themselves; an account may be the game's, the studio's, or the dev's personal one).
    -- rk = source insertion order with store_page rows first, so min_by(.., rk) prefers the
    -- store page's own link when one exists.
    -- All four platforms are surfaced (not just X, as originally): the harvest already
    -- collects Discord/YouTube/Bluesky for tens of thousands of games, and they were simply
    -- being dropped at this step, leaving the API and UI with nothing but a bare handle.
    SELECT appid,
        min_by(handle, rk) FILTER (WHERE platform = 'x') AS dev_x_handle,
        min_by(url, rk)    FILTER (WHERE platform = 'x') AS dev_x_url,
        min_by(url, rk)    FILTER (WHERE platform = 'discord') AS dev_discord_url,
        min_by(url, rk)    FILTER (WHERE platform = 'youtube') AS dev_youtube_url,
        min_by(handle, rk) FILTER (WHERE platform = 'bluesky') AS dev_bluesky_handle,
        min_by(url, rk)    FILTER (WHERE platform = 'bluesky') AS dev_bluesky_url
    FROM stg_game_socials
    WHERE handle IS NOT NULL OR url IS NOT NULL
    GROUP BY appid
)
SELECT
    g.appid, g.name,
    -- Persisted lowercased name for the /api/games/search substring match: the endpoint
    -- filters on this via contains(name_lower, ?) instead of name ILIKE '%q%', which drops
    -- the per-row lower() of the ~170K-row full scan the leading-wildcard match forces on
    -- every call (~2.3x faster end-to-end — see api/app/routers/games.py). Accent-insensitive
    -- matching is NOT provided (same as the old ILIKE); only case is folded, once, at build.
    lower(g.name) AS name_lower,
    g.release_year,
    CAST(g.release_date AS VARCHAR) AS release_date,
    g.price_initial, g.is_free,
    pg.primary_genre,
    g.developers, g.publishers, g.self_published, g.is_indie,
    g.owners_mid, g.total_reviews, g.positive_ratio, g.review_count_source,
    g.est_rev_reviews, g.est_rev_owners,
    g.metacritic_score, g.achievements_count, g.avg_playtime_forever,
    gh.header_image, gh.short_description,
    CAST(gh.first_seen AS VARCHAR) AS first_seen,   -- when this game first entered OUR catalog
    pr.rev_pct_in_genre, pr.reviews_pct_in_genre, pr.owners_pct_in_genre,
    COALESCE(tt.top_tags, []::VARCHAR[]) AS top_tags,
    COALESCE(v.n_reviews_sampled, 0) AS n_reviews_sampled,
    COALESCE(v.n_reviews_first_30d, 0) AS n_reviews_first_30d,
    COALESCE(v.n_reviews_first_90d, 0) AS n_reviews_first_90d,
    COALESCE(v.n_reviews_first_365d, 0) AS n_reviews_first_365d,
    COALESCE(v.n_reviews_trailing_30d, 0) AS n_reviews_trailing_30d,
    v.playtime_p25, v.playtime_p50, v.playtime_p75,
    cc.live_players,
    -- Daily-series summaries from mart_players.sql's _game_players_summary TEMP (runs
    -- before this file): trailing-7d average of the nightly point samples + same-window
    -- trend vs the prior 7d. NULL until a game has measured days (see mart_players.sql).
    gps.players_7d_avg,
    round(gps.players_trend_7d_pct, 2) AS players_trend_7d_pct,
    -- Lifetime (steamcharts monthly, top-8k coverage; mart_players.sql _game_lifetime):
    -- months from the first 100+-avg month to the first full month under 10 avg players.
    -- NULL = never reached 100+ OR outside steamcharts coverage — "unknown", never zero.
    CAST(gl.first_100_month AS VARCHAR) AS lifetime_first_100_month,
    CAST(gl.died_month AS VARCHAR) AS lifetime_died_month,
    gl.lifetime_months,
    gl.lifetime_alive,
    -- Official social linked from the game's own pages (store page + dev website — see
    -- the dev_x CTE): may be the game's, the studio's, or the dev's personal account.
    -- NULL = no X link found OR socials never fetched for this game — "unknown",
    -- never zero.
    dx.dev_x_handle,
    dx.dev_x_url,
    dx.dev_discord_url,
    dx.dev_youtube_url,
    dx.dev_bluesky_handle,
    dx.dev_bluesky_url,
    -- Playable demo, from the game's own Steam appdetails `demos` field (SteamSpy discovery
    -- never indexes demo apps, so the parent's appdetails is the only reliable source;
    -- captured by enrichment + dev-socials + check-demos). Tri-state: TRUE/FALSE only when
    -- appdetails was seen since demo capture landed; NULL = never checked — "unknown",
    -- never "no demo".
    -- Metacritic page Steam links for this game (appdetails metacritic.url). NULL = Steam links
    -- none — which is most of the catalog (~2.6% coverage); never read it as "badly reviewed".
    gh.metacritic_url,
    gh.demo_appid,
    CASE WHEN gh.demos_checked_at IS NOT NULL THEN gh.demo_appid IS NOT NULL END AS has_demo
FROM stg_game g
LEFT JOIN stg_primary_genre pg ON pg.appid = g.appid
LEFT JOIN pct_ranks pr ON pr.appid = g.appid
LEFT JOIN top_tags_agg tt ON tt.appid = g.appid
LEFT JOIN velocity v ON v.appid = g.appid
LEFT JOIN ccu cc ON cc.appid = g.appid
LEFT JOIN _game_players_summary gps ON gps.appid = g.appid
LEFT JOIN _game_lifetime gl ON gl.appid = g.appid
LEFT JOIN dev_x dx ON dx.appid = g.appid
LEFT JOIN src.games gh ON gh.appid = g.appid;
