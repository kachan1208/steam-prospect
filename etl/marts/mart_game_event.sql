-- mart_game_event.sql
-- Dated events per game, for annotating the lifetime charts: a spike is data, a spike with
-- "PATCH 1.4" or "PC GAMER REVIEW" against it is an explanation. Powers the event markers on
-- review-velocity / players / press charts.
--
-- WHY THIS IS SMALLER THAN IT SOUNDS. The obvious fear is a picket fence: annotate every patch
-- note and a popular game's chart becomes unreadable. Measured against the real catalog, that
-- fear is wrong for almost everyone — of the 31,747 games with patch notes, 21,895 have 1-5 and
-- 9,492 have 6-20. Only 351 games have 21-100, and NINE have more than 100. So 98.9% of games can
-- carry every event they have, and the cap below exists purely for those few hundred.
--
-- WHAT COUNTS AS AN EVENT. Only things that plausibly MOVED the curve and can be named in a few
-- words: the release itself, developer updates (patch_notes), and journalist coverage. Deliberately
-- excluded: dev_post (425k rows of developer marketing — high volume, low explanatory power per
-- item) and press_syndicated (the same story reprinted, so it would double-mark one event).
--
-- NOT INCLUDED, and the omission matters: price changes and sales. game_snapshots carries
-- price_final and discount_percent but holds ~1 row per game, so there is nothing to diff — see
-- IDEAS.md. "-20% SALE" is the single most explanatory marker there is and it cannot be built
-- until a scheduled price snapshot starts accruing history.
--
-- Placeholder tokens are substituted by build_marts.py.

DROP TABLE IF EXISTS mart_game_event;

CREATE TABLE mart_game_event AS
WITH ev AS (
    -- Release: one per game, the anchor every other event is read against.
    SELECT g.appid,
           g.release_date AS event_date,
           'release'      AS kind,
           'Released'     AS title,
           CAST(NULL AS VARCHAR) AS url
    FROM stg_game g
    WHERE g.release_valid AND g.release_date IS NOT NULL

    UNION ALL

    -- Developer updates and journalist coverage. articles.appid is populated directly for these
    -- (162,293 patch notes / 137,086 press rows carry it), so no join through
    -- article_game_mentions is needed — that table only covers the press channels anyway.
    SELECT a.appid,
           CAST(TRY_CAST(a.published_at AS TIMESTAMP) AS DATE) AS event_date,
           CASE WHEN a.channel = 'patch_notes' THEN 'update' ELSE 'press' END AS kind,
           a.title,
           a.url
    FROM src.articles a
    WHERE a.appid IS NOT NULL
      AND a.channel IN ('patch_notes', 'press', 'trade_press')
      AND a.title IS NOT NULL AND length(trim(a.title)) > 0
      AND TRY_CAST(a.published_at AS TIMESTAMP) IS NOT NULL
),
ranked AS (
    SELECT *,
        row_number() OVER (
            PARTITION BY appid
            -- Release first so it always survives the cap, then most recent. A game's own launch
            -- is the one event whose absence would make the rest unreadable.
            ORDER BY CASE WHEN kind = 'release' THEN 0 ELSE 1 END, event_date DESC
        ) AS rn
    FROM ev
    WHERE event_date IS NOT NULL
      AND event_date >= DATE '1997-01-01'
      AND event_date <= CURRENT_DATE
)
SELECT appid, event_date, kind, title, url
FROM ranked
WHERE rn <= @GAME_EVENT_CAP@
ORDER BY appid, event_date;
