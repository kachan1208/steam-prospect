-- mart_channel_mix.sql
-- Track M — per genre, the share of marketing "attention" held by each channel (Press vs
-- YouTube vs Reddit vs Twitch vs X) — the headline "where does this genre actually get
-- attention" chart. Two parallel measures per (genre, channel):
--
--   n_mentions       raw mention count (1 press article = 1 unit; 1 creator mention = 1
--                     unit) — "how much COVERAGE VOLUME by channel."
--   reach_weighted   mention count weighted by audience size — press contributes 1.0/mention
--                     (outlets carry no audience-size figure in this schema); a creator
--                     mention contributes reach_at_time (the creator's reach AT THE TIME of
--                     that mention), falling back to the creator's latest known reach
--                     snapshot, then to 1.0 if neither exists yet — "how many EYEBALLS by
--                     channel." This is usually the more decision-relevant read (a genre can
--                     get lots of small Reddit mentions — high n_mentions share — but almost
--                     all its real reach from one big YouTuber — high reach_weighted share)
--                     but a single very-large channel can also dominate it — show both.
--
-- share_mentions / share_reach_weighted = this channel's measure / SUM(measure) across every
-- channel for that genre (0-1, NULL if the genre's total is 0) — the pie/bar-ready share.
--
-- Same confidence floor / genre-membership join as mart_press.sql; press's steam_news
-- exclusion carried over unchanged. The creator/twitch vertical was decommissioned
-- product-wide on 2026-08-25, so press is currently the only channel with rows — every
-- genre's mix reads 100% press until another channel is (re)added as a _mix_all UNION arm.

DROP TABLE IF EXISTS mart_channel_mix;

-- Journalist mention rows come from the SHARED stg_press_base (create_staging in
-- build_marts.py) — the same base every press mart counts, so the mix can't disagree
-- with them about what a press mention is.
CREATE TEMP TABLE _mix_press AS
SELECT gm.genre, 'press' AS channel,
    COUNT(*) AS n_mentions,
    COUNT(*)::DOUBLE AS reach_weighted
FROM stg_press_base pb
JOIN stg_genre_membership gm ON gm.appid = pb.appid
GROUP BY gm.genre;

-- Creator platforms (twitch/youtube) removed 2026-08-25 — that vertical is decommissioned
-- product-wide; press is the marketing channel this mart measures now. The _mix_all shell
-- stays so re-adding a channel later is a UNION arm, not a rewrite.
CREATE TEMP TABLE _mix_all AS
SELECT * FROM _mix_press;

CREATE TEMP TABLE _mix_genre_totals AS
SELECT genre, SUM(n_mentions) AS total_mentions, SUM(reach_weighted) AS total_reach_weighted
FROM _mix_all
GROUP BY genre;

CREATE TABLE mart_channel_mix AS
SELECT mx.genre, mx.channel, mx.n_mentions, mx.reach_weighted,
    CASE WHEN t.total_mentions > 0 THEN mx.n_mentions * 1.0 / t.total_mentions ELSE NULL END AS share_mentions,
    CASE WHEN t.total_reach_weighted > 0 THEN mx.reach_weighted / t.total_reach_weighted ELSE NULL END AS share_reach_weighted
FROM _mix_all mx
JOIN _mix_genre_totals t ON t.genre = mx.genre
ORDER BY mx.genre, share_reach_weighted DESC NULLS LAST;

-- Temp-table hygiene: file-local staging (nothing downstream reads these).
DROP TABLE IF EXISTS _mix_press;
DROP TABLE IF EXISTS _mix_all;
DROP TABLE IF EXISTS _mix_genre_totals;
