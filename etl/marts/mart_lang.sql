-- mart_lang.sql
-- Per-genre review-language share (localization reference — "which languages should I
-- ship?"). Uses staging stg_review + stg_genre_membership + stg_game. genre '__all__' =
-- whole catalog, plus per-genre for genres above the market size floor (mirrors
-- mart_market.sql's genre-eligibility gate). Placeholders substituted by build_marts.py.

DROP TABLE IF EXISTS mart_lang;

CREATE TEMP TABLE _lang_elig_genres AS
SELECT gm.genre
FROM stg_genre_membership gm
JOIN stg_game g ON g.appid = gm.appid
WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@
GROUP BY gm.genre
HAVING COUNT(*) >= @MARKET_MIN_GENRE_GAMES@;

CREATE TABLE mart_lang AS
WITH base AS (
    SELECT '__all__' AS genre, r.language
    FROM stg_review r
    WHERE r.language IS NOT NULL
    UNION ALL
    SELECT gm.genre, r.language
    FROM stg_review r
    JOIN stg_genre_membership gm ON gm.appid = r.appid
    JOIN _lang_elig_genres eg ON eg.genre = gm.genre
    WHERE r.language IS NOT NULL
),
counts AS (
    SELECT genre, language, COUNT(*) AS n
    FROM base
    GROUP BY genre, language
),
totals AS ( SELECT genre, SUM(n) AS total FROM counts GROUP BY genre ),
ranked AS (
    SELECT c.genre, c.language, c.n, c.n * 1.0 / t.total AS share,
        row_number() OVER (PARTITION BY c.genre ORDER BY c.n DESC) AS rn
    FROM counts c
    JOIN totals t ON t.genre = c.genre
)
SELECT genre, language, n, share, rn AS lang_rank
FROM ranked
WHERE rn <= @LANG_TOP_N@
ORDER BY genre, rn;
