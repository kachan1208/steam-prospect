#!/usr/bin/env python
"""Prospect ETL — build DuckDB analytics marts from the read-only steam_games.db SQLite.

Attaches the SQLite source read-only, builds staging temp tables + the mart tables into a
versioned `data/prospect_<YYYYMMDD>.duckdb`, records build metadata, prints per-mart row
counts, then atomically repoints the `data/current.duckdb` symlink at the new file.

Why DuckDB: the marts lean on median()/quantile_cont()/percent_rank()/regr_slope() which
SQLite lacks. The SQLite source is opened READ_ONLY and never mutated.

Run:  python build_marts.py            (paths default relative to this file)
      python build_marts.py --source /path/to/steam_games.db --data-dir /path/to/data
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb

# --------------------------------------------------------------------------------------
# Tunable constants (single source of truth for the ETL). Mirrored where relevant in
# api/app/benchmarks.py — keep the two in sync if you change scoring.
# --------------------------------------------------------------------------------------
MIN_REVIEWS_DEFAULT = 10          # a game needs >= this many reviews to enter niche stats
MIN_REVIEWS_LEVELS = [10, 50]     # min_reviews floors materialised in mart_niche
MIN_NICHE_GAMES = 30              # a niche needs >= this many qualifying games to be ranked
TAG_VOTE_FLOOR = 3                # a (game,tag) association needs >= this many community votes
TAG_RANK_FLOOR = 20              # ...and be within the game's top-N tags
RECENT_MONTHS = 24               # "recent" / 24m window length
THIN_REVIEWS_BAR = 50            # below this a game counts as "thin" (beatable) for quality_gap
BEATABLE_RATIO_BAR = 0.80        # positive_ratio below this counts as beatable for quality_gap
WINNER_TOP_PCT = 0.95            # winner_concentration = revenue share of the top 5% of titles
TOP_GAMES_PER_NICHE = 12         # representative games stored per niche
MARKET_MIN_GENRE_GAMES = 150     # per-genre market breakdowns require this many games
MARKET_MIN_REVIEWS = 1           # market distribution floor: >=1 review = measurable revenue
                                 # (deliberately lower than the niche floor so the long tail
                                 #  and the cited $249 / $100K benchmark marks stay visible)

# Review-count reconciliation (SteamSpy vs. the actual scraped `reviews` table). SteamSpy
# lags badly for new releases -- it can sit at total_reviews=0 for weeks/months after
# launch while our own scraper already holds real, current review data for the same game.
# See stg_game in create_staging() below for the reconciliation itself.
BOXLEITER_OWNERS_PER_REVIEW_MIN = 20   # mirrors api/app/benchmarks.py's "New Boxleiter"
BOXLEITER_OWNERS_PER_REVIEW_MID = 30   # 20-55 owners/review band -- used here to floor
BOXLEITER_OWNERS_PER_REVIEW_MAX = 55   # owners_mid when SteamSpy reports zero. Keep in sync.

# Opportunity score weights (also documented in benchmarks.py).
W_DEMAND = 0.50
W_COMPETITION = 0.35
W_QUALITY = 0.30

# Launch-curve eligibility.
CURVE_MIN_REVIEWS = 10           # sampled first-year reviews a game needs to enter the curve
CURVE_MIN_GAMES = 30             # a genre needs this many eligible games to publish a curve

# Phase 2 — game deep-dive tunables.
TOP_TAGS_PER_GAME = 10           # tag-vector length stored per game (drives on-demand comparables)
GAME_DETAIL_MIN_REVIEWS = 10     # sampled reviews a game needs for mart_game_reviews_* facets
LANG_TOP_N = 15                  # top languages kept per genre (mart_lang) / per game (mart_game_reviews_lang)

# Phase 3 — Game Teardown tunables (review-aspect mining + press footprint).
TEARDOWN_MIN_REVIEWS = 20        # sampled English reviews (w/ text) a game needs for mart_game_review_aspects
TEARDOWN_MIN_GENRE_GAMES = 30    # qualifying games a genre needs for its own aspect baseline (else falls back to __all__)
PRESS_MIN_CONFIDENCE = 0.2       # article_game_mentions.match_confidence floor for mart_game_press_* (see mart_game_teardown.sql)
PRESS_NOTABLE_N = 10             # "notable" articles kept per game (top by match_confidence, plus the earliest)

# Phase 3 — Aspect drill-down tunable (see mart_game_aspect_reviews.sql). Reuses
# TEARDOWN_MIN_REVIEWS above as its eligibility floor so the drill-down's game population
# is identical to the teardown's, by construction.
ASPECT_REVIEWS_TOP_K = 4         # representative excerpts kept per (appid, aspect, sentiment)

# Phase 3 — Aspect-level TEXT SENTIMENT (VADER). The teardown's praise/complaint split was
# historically derived from each review's OVERALL Steam thumbs-up/down vote, so a thumbs-up
# review that trashes the combat still counted as "praise" for combat. compute_aspect_sentiment()
# below fixes that: for every (review, aspect) mention it scores the VADER compound sentiment
# of a LOCAL text window around the aspect keyword (not the whole review, not the vote), and
# precomputes per-(appid, aspect) positive/negative/neutral counts. This is classic lexicon
# sentiment — pure-Python, no network, no API/LLM (see etl/requirements.txt: vaderSentiment).
# It is COARSE and honest about it: English-only, sarcasm-blind, and domain-blind (VADER reads
# gaming terms like "hard"/"brutal"/"insane"/"sick" with their everyday valence), so e.g.
# Difficulty tends to read more negative in text than the reviewers actually mean. The UI shows
# it alongside — not silently replacing — the vote-based split, clearly labelled.
#
# The 10-aspect keyword lexicon lives HERE as the single source of truth and is rendered into
# BOTH mart_game_teardown.sql (@RX_*@ placeholders in _review_aspect_flags) and
# mart_game_aspect_reviews.sql, so the vote flags, the excerpt windows, and the sentiment
# windows can never drift apart. Each entry: (aspect label, @RX_*@ placeholder, keyword regex).
ASPECT_LEXICON = [
    ("Combat & Bosses", "RX_COMBAT",
     r"\b(combat|fight|fights|fighting|boss|bosses|dodge|dodges|dodging|parry|parries|parrying|mechanic|mechanics|hitbox|hitboxes)\b"),
    ("World & Exploration", "RX_WORLD",
     r"\b(world|explore|explores|exploring|exploration|area|areas|level design|open world|metroidvania)\b"),
    ("Art & Visuals", "RX_ART",
     r"\b(art|visual|visuals|graphics|animation|animations|hand-drawn|hand drawn|handdrawn|aesthetic|aesthetics|gorgeous|beautiful|style|art style|artstyle)\b"),
    ("Music & Audio", "RX_MUSIC",
     r"\b(music|soundtrack|soundtracks|sound|sounds|score|ost|audio)\b"),
    ("Story & Writing", "RX_STORY",
     r"\b(story|stories|writing|lore|character|characters|narrative|dialogue|dialog|ending|endings)\b"),
    ("Difficulty", "RX_DIFFICULTY",
     r"\b(difficult|difficulty|hard|hardest|challenging|challenge|challenges|punishing|brutal|easy|unfair)\b"),
    ("Controls & Performance", "RX_CONTROLS",
     r"\b(controls|control|responsive|tight|clunky|bug|bugs|buggy|crash|crashes|crashing|performance|fps|optimization|optimized|optimisation)\b"),
    ("Map & Navigation / Backtracking", "RX_MAPNAV",
     r"\b(map|maps|navigation|backtrack|backtracks|backtracking|lost|confusing|tedious|grind|grinding|grindy)\b"),
    ("Content & Length", "RX_CONTENT",
     r"\b(content|length|hours|short|long|replay|replayability|replay value)\b"),
    ("Price & Value", "RX_PRICEVALUE",
     r"\b(price|worth|value|cheap|expensive|overpriced|bargain)\b"),
]
# Local text window scored per aspect mention: substr starting LEAD chars before the first
# matched keyword, WINDOW chars long. Identical to the excerpt window in
# mart_game_aspect_reviews.sql (rendered there via the @ASPECT_SENTIMENT_*@ placeholders), so
# the sentiment class attached to a drill-down excerpt describes the exact text shown.
ASPECT_SENTIMENT_LEAD = 140
ASPECT_SENTIMENT_WINDOW = 280
# VADER compound thresholds: >= POS is positive, <= NEG is negative, strictly between is the
# neutral/unclear band (VADER's own standard cutoffs). The pos-vs-neg bar excludes neutrals.
SENTIMENT_POS_THRESHOLD = 0.05
SENTIMENT_NEG_THRESHOLD = -0.05
SENTIMENT_SCORE_BATCH = 20000    # rows pulled+scored+inserted per streamed batch (bounded memory)

# Phase 3 — aggregate Press/Marketing Intelligence tunables (see mart_press.sql). Reuses
# PRESS_MIN_CONFIDENCE above for the same journalist-only, confidence-filtered article set.
PRESS_AUTHOR_MIN_ARTICLES = 3    # a (author, genre) needs >= this many articles to be kept
                                  # ("a small floor" — mirrors TAG_VOTE_FLOOR's role)
BUZZ_TOTAL_MONTHS = 12           # months of history retained in mart_buzz_trends (a full year of
                                  # sparkline), excluding the current in-progress calendar month
BUZZ_RECENT_MONTHS = 3           # "recent" window = months 1..N back; "prior" = the equal-length
                                  # window immediately before it (months N+1..2N back)
BUZZ_MIN_TOTAL_MENTIONS = 30     # a term needs >= this many mentions over BUZZ_TOTAL_MONTHS to
                                  # be scored at all ("a meaningful minimum total frequency")
BUZZ_SLOPE_EPSILON = 1.0         # |recent_avg - prior_avg| below this -> 'flat', not rising/cooling

# Tags that are not descriptive niches (application-type leakage, hardware/store features,
# franchise/brand/meta noise). Removed from tag stats in addition to the votes/rank floor.
DENYLIST_TAG = [
    "Software", "Utilities", "Design & Illustration", "Web Publishing", "Video Production",
    "Audio Production", "Animation & Modeling", "Game Development", "Photo Editing",
    "Accounting", "Software Training",
    "Benchmark", "Hardware", "Controller", "TrackIR", "Steam Machine", "VR Only",
    "Remote Play Together", "Captions available",
    "Kickstarter", "Epic", "Games Workshop", "Warhammer 40K", "Batman", "Reboot",
    "Masterpiece", "LEGO", "Lego", "Feature Film", "Documentary",
]
# Genres in game_genres that are application-type / non-game and should be dropped.
DENYLIST_GENRE = [
    "Utilities", "Design & Illustration", "Web Publishing", "Video Production",
    "Audio Production", "Animation & Modeling", "Game Development", "Photo Editing",
    "Accounting", "Software Training", "Movie", "Short", "Documentary", "Episodic",
]

# English stopwords for mart_buzz_trends' title-bigram mining (see mart_press.sql). Grammatical
# function words only (articles/prepositions/conjunctions/pronouns/auxiliary verbs + their
# contracted forms, apostrophe already stripped upstream so "don't" -> "dont"), plus two
# corpus-specific entries: "new" (near-universal headline filler with ~no thematic content of
# its own) and "ign" (that outlet's own masthead leaking into its titles, e.g. "... Review | IGN").
STOPWORDS = [
    "a", "an", "the", "and", "or", "but", "if", "of", "at", "by", "for", "with", "about",
    "against", "between", "into", "through", "during", "before", "after", "above", "below",
    "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further",
    "then", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own",
    "same", "so", "than", "too", "very", "s", "t", "can", "will", "just", "don", "should",
    "now", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "having",
    "do", "does", "did", "doing", "would", "could", "ought", "i", "you", "he", "she", "it",
    "we", "they", "what", "which", "who", "whom", "this", "that", "these", "those", "am",
    "its", "his", "her", "their", "our", "your", "my", "me", "him", "them", "us", "as",
    "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "cant", "couldnt", "wont",
    "wouldnt", "shouldnt", "youre", "theyre", "weve", "ive", "hes", "shes", "thats", "whats",
    "heres", "theres", "new", "ign",
]
# Known masthead/branding bigram artifacts that survive the stopword filter (neither word is
# individually a stopword, e.g. "gamer"/"pc" are meaningful elsewhere) but are self-referential
# outlet noise, not buzz — identified empirically from real title data. Small and evidence-based,
# same spirit as DENYLIST_TAG. Phrase-level: matches only the exact adjacent-word pair.
DENYLIST_BUZZ_TERM = [
    "pc gamer", "pc gamers", "gamesindustry biz", "eurogamer weekly", "eurogamer fm",
    "eurogamer readers",
    # Commerce/sale-event phrases (not game concepts) that would otherwise pass the concept
    # allowlist below on a coincidental word overlap (e.g. "prime" from no tag, but caught
    # here defensively; "release date" both words are otherwise plausible-looking).
    "prime day", "amazon prime", "black friday", "steam sale", "release date",
    # Concept-allowlist false positives, identified empirically by rebuilding and reading the
    # actual output (same "small and evidence-based" spirit as the masthead artifacts above).
    # Each is TWO individually-legitimate tag-derived words (e.g. "graphics" from Pixel
    # Graphics, "card" from Card Game) that coincidentally recombine into a phrase that reads
    # as hardware, generic English, or release-status rather than a game concept/mechanic:
    #   video game    -> "video" (from the "360 Video" tag) + "game" (from Card/Board/Word
    #                    Game) is generic/tautological, not a specific concept.
    #   graphics card / gaming mouse -> PC hardware/peripherals, not game concepts.
    #   first time    -> "first" (First-Person) + "time" (Time Management/Travel) is generic
    #                    English, not a concept ("first person" itself is unaffected — it's a
    #                    direct tag match, not this word-recombination path).
    #   early access  -> a real Steam genre, but a release-status/business label, not a
    #                    mechanic/genre concept — same bucket as the "launch"/"release date"
    #                    denylist entries, not what a dev means by "buzzy concept."
    "video game", "graphics card", "gaming mouse", "first time", "early access",
]
# Word-level denylist for buzz bigrams — a generic commerce/release/PR word that taints ANY
# bigram it appears in (title-review-roundup and patch-notes debris), so it's filtered per-word
# rather than as a fixed phrase list (unlike DENYLIST_BUZZ_TERM above, which is exact-phrase).
# Same "small and evidence-based" spirit as DENYLIST_TAG/DENYLIST_BUZZ_TERM.
DENYLIST_BUZZ_WORD = [
    "sale", "deal", "deals", "discount", "review", "reviews", "trailer", "update", "patch",
    "dlc", "launch",
]

# Track M — multi-channel marketing tunables (see etl/marts/mart_creator_pitch.sql,
# mart_channel_mix.sql, mart_channel_buzz.sql). These marts read the scraper's creator /
# game_creator_mention / creator_reach_snapshot SQLite tables via create_marketing_staging()
# below, which replays the SAME fuzzy-match + genre-join pattern mart_press.sql uses for
# article_game_mentions -- hence constants that mirror PRESS_MIN_CONFIDENCE /
# PRESS_AUTHOR_MIN_ARTICLES, kept as separate names in case creator-match tuning needs to
# diverge from article-match tuning later (same starting values today).
CREATOR_MIN_CONFIDENCE = 0.2      # game_creator_mention.confidence floor (mirrors PRESS_MIN_CONFIDENCE)
CREATOR_PITCH_MIN_MENTIONS = 1    # a (creator, genre) needs >= this many mentions to be kept
                                  # (mirrors PRESS_AUTHOR_MIN_ARTICLES's role but floored at 1,
                                  # not 3 -- channel collection is new/low-volume; raise once
                                  # real volume exists).

MART_FILES = [
    "mart_game.sql",
    "mart_niche.sql",
    "mart_market.sql",
    "mart_seasonality.sql",
    "mart_launch_curve.sql",
    "mart_game_reviews.sql",
    "mart_game_trends.sql",
    "mart_lang.sql",
    "mart_game_teardown.sql",
    "mart_game_aspect_reviews.sql",
    "mart_press.sql",
    "mart_explorer.sql",
    "mart_creator_pitch.sql",
    "mart_channel_mix.sql",
    "mart_channel_buzz.sql",
]

HERE = Path(__file__).resolve().parent


def build_params() -> dict[str, str]:
    today = date.today()
    cur_year = today.year
    # Aspect keyword regexes (single source of truth) rendered into both teardown SQL files,
    # plus the shared sentiment/excerpt window size — see ASPECT_LEXICON above.
    lexicon = {placeholder: rx for (_label, placeholder, rx) in ASPECT_LEXICON}
    return {
        **lexicon,
        "ASPECT_SENTIMENT_LEAD": ASPECT_SENTIMENT_LEAD,
        "ASPECT_SENTIMENT_WINDOW": ASPECT_SENTIMENT_WINDOW,
        # VADER neutral-band cutoffs (mart_game_teardown.sql classifies press-article compounds).
        "SENTIMENT_POS_THRESHOLD": SENTIMENT_POS_THRESHOLD,
        "SENTIMENT_NEG_THRESHOLD": SENTIMENT_NEG_THRESHOLD,
        "MR_VALUES": ",".join(f"({m})" for m in MIN_REVIEWS_LEVELS),
        "MIN_REVIEWS_DEFAULT": MIN_REVIEWS_DEFAULT,
        "MIN_NICHE_GAMES": MIN_NICHE_GAMES,
        "TAG_VOTE_FLOOR": TAG_VOTE_FLOOR,
        "TAG_RANK_FLOOR": TAG_RANK_FLOOR,
        "RECENT_MONTHS": RECENT_MONTHS,
        "THIN_REVIEWS_BAR": THIN_REVIEWS_BAR,
        "BEATABLE_RATIO_BAR": BEATABLE_RATIO_BAR,
        "WINNER_TOP_PCT": WINNER_TOP_PCT,
        "TOP_GAMES_PER_NICHE": TOP_GAMES_PER_NICHE,
        "MARKET_MIN_GENRE_GAMES": MARKET_MIN_GENRE_GAMES,
        "MARKET_MIN_REVIEWS": MARKET_MIN_REVIEWS,
        "BOXLEITER_MIN": BOXLEITER_OWNERS_PER_REVIEW_MIN,
        "BOXLEITER_MID": BOXLEITER_OWNERS_PER_REVIEW_MID,
        "BOXLEITER_MAX": BOXLEITER_OWNERS_PER_REVIEW_MAX,
        "W_DEMAND": W_DEMAND,
        "W_COMPETITION": W_COMPETITION,
        "W_QUALITY": W_QUALITY,
        "CURVE_MIN_REVIEWS": CURVE_MIN_REVIEWS,
        "CURVE_MIN_GAMES": CURVE_MIN_GAMES,
        "TOP_TAGS_PER_GAME": TOP_TAGS_PER_GAME,
        "GAME_DETAIL_MIN_REVIEWS": GAME_DETAIL_MIN_REVIEWS,
        "LANG_TOP_N": LANG_TOP_N,
        "TEARDOWN_MIN_REVIEWS": TEARDOWN_MIN_REVIEWS,
        "TEARDOWN_MIN_GENRE_GAMES": TEARDOWN_MIN_GENRE_GAMES,
        "PRESS_MIN_CONFIDENCE": PRESS_MIN_CONFIDENCE,
        "PRESS_NOTABLE_N": PRESS_NOTABLE_N,
        "ASPECT_REVIEWS_TOP_K": ASPECT_REVIEWS_TOP_K,
        "PRESS_AUTHOR_MIN_ARTICLES": PRESS_AUTHOR_MIN_ARTICLES,
        "BUZZ_TOTAL_MONTHS": BUZZ_TOTAL_MONTHS,
        "BUZZ_RECENT_MONTHS": BUZZ_RECENT_MONTHS,
        "BUZZ_MIN_TOTAL_MENTIONS": BUZZ_MIN_TOTAL_MENTIONS,
        "BUZZ_SLOPE_EPSILON": BUZZ_SLOPE_EPSILON,
        "CREATOR_MIN_CONFIDENCE": CREATOR_MIN_CONFIDENCE,
        "CREATOR_PITCH_MIN_MENTIONS": CREATOR_PITCH_MIN_MENTIONS,
        "CUR_YEAR": cur_year,
        "RECENT_YEAR": cur_year - 1,
        "PRIOR_YEAR": cur_year - 2,
        "TREND_START_YEAR": cur_year - 14,
        "SEASON_START_YEAR": cur_year - 15,
    }


def render(sql: str, params: dict) -> str:
    for key, val in params.items():
        sql = sql.replace(f"@{key}@", str(val))
    if "@" in sql:
        # Surface any unresolved token instead of silently shipping bad SQL.
        import re
        leftovers = set(re.findall(r"@[A-Z_]+@", sql))
        if leftovers:
            raise ValueError(f"Unresolved SQL placeholders: {sorted(leftovers)}")
    return sql


def create_staging(con: duckdb.DuckDBPyConnection, params: dict) -> None:
    # Denylists as temp tables (avoids giant inline IN-lists in the SQL files).
    con.execute("CREATE TEMP TABLE denylist_tag(tag VARCHAR)")
    con.executemany("INSERT INTO denylist_tag VALUES (?)", [(t,) for t in DENYLIST_TAG])
    con.execute("CREATE TEMP TABLE denylist_genre(genre VARCHAR)")
    con.executemany("INSERT INTO denylist_genre VALUES (?)", [(g,) for g in DENYLIST_GENRE])
    con.execute("CREATE TEMP TABLE stopword(word VARCHAR)")
    con.executemany("INSERT INTO stopword VALUES (?)", [(w,) for w in STOPWORDS])
    con.execute("CREATE TEMP TABLE denylist_buzz_term(term VARCHAR)")
    con.executemany("INSERT INTO denylist_buzz_term VALUES (?)", [(t,) for t in DENYLIST_BUZZ_TERM])
    con.execute("CREATE TEMP TABLE denylist_buzz_word(word VARCHAR)")
    con.executemany("INSERT INTO denylist_buzz_word VALUES (?)", [(w,) for w in DENYLIST_BUZZ_WORD])

    staging_sql = render(
        """
        CREATE TEMP TABLE stg_tag_membership AS
        SELECT DISTINCT gt.appid, gt.tag
        FROM src.game_tags gt
        WHERE gt.votes >= @TAG_VOTE_FLOOR@
          AND gt.rank <= @TAG_RANK_FLOOR@
          AND gt.tag NOT IN (SELECT tag FROM denylist_tag);

        CREATE TEMP TABLE stg_genre_membership AS
        SELECT DISTINCT gg.appid, gg.genre
        FROM src.game_genres gg
        WHERE gg.genre NOT IN (SELECT genre FROM denylist_genre);

        -- Moved ahead of stg_game (below needs it for the owners-floor genre lookup).
        CREATE TEMP TABLE stg_primary_genre AS
        WITH g AS (
            SELECT gg.appid, gg.genre,
                row_number() OVER (PARTITION BY gg.appid ORDER BY
                    CASE WHEN gg.genre IN ('Indie','Casual','Early Access','Free To Play',
                                           'Massively Multiplayer') THEN 1 ELSE 0 END,
                    gg.genre) AS rn
            FROM src.game_genres gg
            WHERE gg.genre NOT IN (SELECT genre FROM denylist_genre)
        )
        SELECT appid, genre AS primary_genre FROM g WHERE rn = 1;

        -- Review-count reconciliation source: per-appid counts from the actual scraped
        -- `reviews` table (already deduped at scrape time -- recommendationid PK / unique
        -- content_hash), independent of stg_game so it can seed the reconciliation below.
        CREATE TEMP TABLE stg_reviews_agg AS
        SELECT
            r.appid,
            COUNT(*) AS reviews_table_count,
            SUM(CASE WHEN r.voted_up = 1 THEN 1 ELSE 0 END) AS reviews_table_positive,
            SUM(CASE WHEN r.voted_up = 0 THEN 1 ELSE 0 END) AS reviews_table_negative
        FROM src.reviews r
        GROUP BY r.appid;

        -- Pass 1: reconcile SteamSpy's review counts (analysis_games.total_reviews /
        -- positive_reviews / negative_reviews / positive_ratio) against stg_reviews_agg.
        -- SteamSpy is a third-party aggregator that lags badly for new releases -- it can
        -- sit at total_reviews=0 for weeks/months after launch while our own scraper
        -- (which hits Steam's review API directly) already holds hundreds of real reviews
        -- for the same game. total_reviews = GREATEST(steamspy, reviews-table) so we never
        -- regress below whichever source has seen more. Whenever the reviews-table count
        -- is the one GREATEST picked, positive/negative/positive_ratio are derived from the
        -- reviews table too (so positive+negative always sums to total_reviews instead of a
        -- stale SteamSpy split hanging off a bumped total); otherwise SteamSpy's own numbers
        -- pass through untouched. review_count_source records which happened:
        --   'steamspy'       SteamSpy's count >= the reviews-table count (the common case,
        --                     esp. older/popular titles where our scraper only holds a
        --                     bounded sample) -> nothing changed.
        --   'reviews_sample' SteamSpy reported 0/NULL but the reviews table has rows ->
        --                     total/positive/negative/ratio are entirely reviews-table-derived.
        --   'reconciled'     SteamSpy had SOME reviews but the reviews table has more (a
        --                     partial lag) -> same reviews-table derivation as above, just
        --                     starting from a nonzero SteamSpy baseline.
        -- These reviews-derived counts are an honest LOWER BOUND, same caveat as stg_review
        -- elsewhere: the reviews table is a per-game sample, not Steam's full review set.
        --
        -- est_rev_reviews (Boxleiter gross = total_reviews * 30 * price_initial) is
        -- recomputed here from the reconciled total_reviews -- leaving it at
        -- analysis_games' stale value would strand a $0 revenue estimate on every game
        -- this fixes, which is exactly the bug. est_rev_owners is untouched here; see the
        -- owners floor in stg_game below, which only overwrites the true SteamSpy zeros.
        CREATE TEMP TABLE _stg_game_reconciled AS
        WITH base AS (
            SELECT
                ag.appid, ag.name, ag.release_year,
                TRY_CAST(ag.release_date_iso AS DATE) AS release_date,
                ag.price_initial, ag.is_free, ag.developers, ag.publishers,
                ag.self_published, ag.dev_game_count, ag.is_indie,
                ag.metacritic_score, ag.achievements_count,
                ag.owners_mid AS owners_mid_steamspy,
                ag.est_rev_owners AS est_rev_owners_steamspy,
                ag.avg_playtime_forever, ag.ccu, ag.tag_count,
                COALESCE(ag.total_reviews, 0) AS ss_total_reviews,
                ag.positive_reviews AS ss_positive_reviews,
                ag.negative_reviews AS ss_negative_reviews,
                ag.positive_ratio AS ss_positive_ratio,
                COALESCE(ra.reviews_table_count, 0) AS reviews_table_count,
                COALESCE(ra.reviews_table_positive, 0) AS reviews_table_positive,
                COALESCE(ra.reviews_table_negative, 0) AS reviews_table_negative,
                -- Ground truth: Steam's own review-summary totals (backfill_review_summary.py).
                -- Present -> authoritative (exact counts, not SteamSpy and not our sample cap).
                rs.total_reviews AS api_total_reviews,
                rs.total_positive AS api_positive,
                rs.total_negative AS api_negative
            FROM src.analysis_games ag
            LEFT JOIN stg_reviews_agg ra ON ra.appid = ag.appid
            LEFT JOIN src.review_summary rs ON rs.appid = ag.appid
        )
        SELECT
            appid, name, release_year, release_date,
            price_initial, is_free, developers, publishers,
            self_published, dev_game_count, is_indie,
            metacritic_score, achievements_count,
            owners_mid_steamspy, est_rev_owners_steamspy,
            avg_playtime_forever, ccu, tag_count,
            CASE
                WHEN api_total_reviews IS NOT NULL THEN 'steam_api'
                WHEN reviews_table_count <= ss_total_reviews THEN 'steamspy'
                WHEN ss_total_reviews = 0 THEN 'reviews_sample'
                ELSE 'reconciled'
            END AS review_count_source,
            COALESCE(api_total_reviews, GREATEST(ss_total_reviews, reviews_table_count)) AS total_reviews,
            CASE WHEN api_total_reviews IS NOT NULL THEN api_positive
                 WHEN reviews_table_count > ss_total_reviews THEN reviews_table_positive
                 ELSE ss_positive_reviews END AS positive_reviews,
            CASE WHEN api_total_reviews IS NOT NULL THEN api_negative
                 WHEN reviews_table_count > ss_total_reviews THEN reviews_table_negative
                 ELSE ss_negative_reviews END AS negative_reviews,
            CASE
                WHEN api_total_reviews IS NOT NULL
                     THEN CASE WHEN api_positive + api_negative > 0
                               THEN api_positive * 1.0 / (api_positive + api_negative) ELSE NULL END
                WHEN reviews_table_count > ss_total_reviews
                     THEN CASE WHEN reviews_table_positive + reviews_table_negative > 0
                               THEN reviews_table_positive * 1.0 / (reviews_table_positive + reviews_table_negative)
                               ELSE NULL END
                ELSE ss_positive_ratio END AS positive_ratio,
            COALESCE(api_total_reviews, GREATEST(ss_total_reviews, reviews_table_count)) * 30 * price_initial AS est_rev_reviews
        FROM base;

        -- Genre Boxleiter multiplier (owners per review), computed ONCE here -- pre-floor,
        -- so every input row is a REAL SteamSpy owners_mid observation, never a value this
        -- same ETL estimated (that would self-reinforce: a floored row's owners_mid is
        -- total_reviews * this multiplier by construction, so feeding it back into the fit
        -- would just pull the "official" slope toward whatever it already was). Same
        -- population shape as the original mart_market_boxleiter query (stg_genre_membership
        -- -- a game trains every genre it belongs to -- plus an '__all__' pooled row), just
        -- using the review-count-reconciled total_reviews from _stg_game_reconciled above.
        -- mart_market.sql's mart_market_boxleiter materializes straight from this table
        -- (no recomputation), so there is exactly one definition of "the genre Boxleiter
        -- multiplier the app already computes" -- used both to floor owners below AND as
        -- the api/app/routers/estimate.py-facing mart.
        CREATE TEMP TABLE stg_genre_boxleiter AS
        WITH fit AS (
            SELECT '__all__' AS genre, g.owners_mid_steamspy AS owners_mid, g.total_reviews
            FROM _stg_game_reconciled g
            WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.owners_mid_steamspy > 0
            UNION ALL
            SELECT gm.genre, g.owners_mid_steamspy, g.total_reviews
            FROM stg_genre_membership gm
            JOIN _stg_game_reconciled g ON g.appid = gm.appid
            WHERE g.total_reviews >= @MIN_REVIEWS_DEFAULT@ AND g.owners_mid_steamspy > 0
        )
        SELECT genre,
            COUNT(*) AS n,
            median(owners_mid * 1.0 / total_reviews) AS owners_per_review_median,
            quantile_cont(owners_mid * 1.0 / total_reviews, 0.25) AS owners_per_review_p25,
            quantile_cont(owners_mid * 1.0 / total_reviews, 0.75) AS owners_per_review_p75,
            regr_slope(owners_mid, total_reviews) AS slope,
            regr_intercept(owners_mid, total_reviews) AS intercept,
            -- Clamped to the app's cited "New Boxleiter" band before use as a flooring
            -- multiplier -- guards against a noisy/degenerate per-genre fit (sparse genre,
            -- a NULL slope) producing an absurd owners estimate. Internal to the ETL only;
            -- mart_market_boxleiter below still exposes the raw unclamped slope.
            LEAST(@BOXLEITER_MAX@, GREATEST(@BOXLEITER_MIN@,
                COALESCE(regr_slope(owners_mid, total_reviews), @BOXLEITER_MID@))) AS owners_multiplier
        FROM fit
        GROUP BY genre
        HAVING COUNT(*) >= @MARKET_MIN_GENRE_GAMES@ OR genre = '__all__';

        -- Pass 2: floor owners_mid/est_rev_owners where SteamSpy reports zero owners but
        -- the reconciled review count (above) is > 0 -- i.e. a game SteamSpy hasn't
        -- surfaced owner data for at all, but that demonstrably has real players/reviews.
        -- owners_mid ~= total_reviews * (this game's genre Boxleiter multiplier, falling
        -- back to '__all__' then the literal MID constant); revenue = owners * price.
        -- Only the true zeros are touched -- any row with existing SteamSpy owners_mid
        -- passes through unchanged (owners_is_floor_estimate = FALSE), so this never
        -- overwrites good SteamSpy owner data. owners_is_floor_estimate is internal
        -- plumbing (not exposed on any mart) that keeps mart_market_boxleiter's regression
        -- fit -- see above -- from training on its own output; the appid-grain marts
        -- (mart_game, mart_niche_top) instead expose review_count_source, which -- given
        -- owners=0/NULL only ever coincides with SteamSpy also reporting 0 reviews in this
        -- catalog -- is 'reviews_sample' for every row this floor touches.
        CREATE TEMP TABLE stg_game AS
        WITH genre_pick AS (
            SELECT g.appid,
                -- SteamSpy only *resolves* owners ABOVE its 0-20k catch-all bucket (mid 10k).
                -- Inside that bucket -- or at a literal 0/NULL -- it can't tell a 300-owner game
                -- from a 19k one, and every new release sits there until SteamSpy catches up. So
                -- whenever we have reviews AND SteamSpy hasn't resolved the game above 20k,
                -- substitute the reviews-based Boxleiter estimate. Rows SteamSpy placed in a
                -- higher bucket (owners_mid > 10k) pass through untouched.
                (g.total_reviews > 0
                    AND (g.owners_mid_steamspy IS NULL OR g.owners_mid_steamspy <= 10000)) AS owners_is_floor_estimate,
                g.total_reviews * COALESCE(gb.owners_multiplier, ab.owners_multiplier, @BOXLEITER_MID@) AS reviews_owner_est
            FROM _stg_game_reconciled g
            LEFT JOIN stg_primary_genre pg ON pg.appid = g.appid
            LEFT JOIN stg_genre_boxleiter gb ON gb.genre = pg.primary_genre
            LEFT JOIN stg_genre_boxleiter ab ON ab.genre = '__all__'
        )
        SELECT
            g.appid, g.name, g.release_year, g.release_date,
            (g.release_date IS NOT NULL
                AND g.release_date <= CURRENT_DATE
                AND g.release_date >= DATE '1997-01-01') AS release_valid,
            (g.release_date IS NOT NULL
                AND g.release_date <= CURRENT_DATE
                AND g.release_date >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH) AS is_recent,
            g.price_initial, g.is_free, g.developers, g.publishers,
            g.self_published, g.dev_game_count, g.is_indie,
            g.metacritic_score, g.achievements_count,
            g.total_reviews, g.positive_reviews, g.negative_reviews, g.positive_ratio,
            g.review_count_source,
            gp.owners_is_floor_estimate,
            -- Bottom-bucket / zero / stale rows (flagged above) take the reviews-based Boxleiter
            -- estimate; SteamSpy-resolved rows (>20k) keep their measured owners. Lower bound.
            CASE WHEN gp.owners_is_floor_estimate THEN gp.reviews_owner_est
                 ELSE g.owners_mid_steamspy END AS owners_mid,
            CASE WHEN gp.owners_is_floor_estimate THEN gp.reviews_owner_est * g.price_initial
                 ELSE g.est_rev_owners_steamspy END AS est_rev_owners,
            g.est_rev_reviews,
            g.avg_playtime_forever, g.ccu, g.tag_count
        FROM _stg_game_reconciled g
        JOIN genre_pick gp ON gp.appid = g.appid;

        CREATE TEMP TABLE stg_review_dsr AS
        SELECT r.appid,
            datediff('day', g.release_date, CAST(to_timestamp(r.timestamp_created) AS DATE)) AS dsr
        FROM src.reviews r
        JOIN stg_game g ON g.appid = r.appid
        WHERE g.release_valid
          AND g.release_date <= CURRENT_DATE - INTERVAL 365 DAY
          AND r.timestamp_created IS NOT NULL
          AND datediff('day', g.release_date, CAST(to_timestamp(r.timestamp_created) AS DATE)) BETWEEN 0 AND 365;

        -- Phase 2: broad per-review staging (all games, not just >=365d old), powers the
        -- game-deep-dive marts (mart_game velocity/playtime, mart_game_reviews_*, mart_lang).
        -- NOTE: `reviews` is a per-game SAMPLE (not Steam's full review set), so counts here
        -- describe the sample, not true totals — downstream marts/API must label them as such.
        CREATE TEMP TABLE stg_review AS
        SELECT
            r.appid,
            CAST(to_timestamp(r.timestamp_created) AS DATE) AS review_date,
            CASE WHEN g.release_valid
                 THEN datediff('day', g.release_date, CAST(to_timestamp(r.timestamp_created) AS DATE))
                 ELSE NULL END AS dsr,
            r.voted_up,
            r.language,
            r.playtime_at_review,
            r.playtime_forever
        FROM src.reviews r
        JOIN stg_game g ON g.appid = r.appid
        WHERE r.timestamp_created IS NOT NULL;

        -- Phase 3 (Game Teardown): English review text for aspect-lexicon mining.
        -- Scoped to language='english' + non-empty review_text to keep the text payload
        -- bounded (~1.5M of 3.1M total reviews) — aspect mining is English-only by
        -- design (the fixed keyword lexicon is English). Not joined to stg_game /
        -- release date since aspect mining doesn't need days-since-release.
        CREATE TEMP TABLE stg_review_text AS
        SELECT r.appid, r.voted_up, r.review_text
        FROM src.reviews r
        WHERE r.language = 'english'
          AND r.review_text IS NOT NULL
          AND length(trim(r.review_text)) > 0;
        """,
        params,
    )
    con.execute(staging_sql)


# --------------------------------------------------------------------------------------
# Track M — multi-channel marketing staging. Guarded: the scraper's creator /
# game_creator_mention / creator_reach_snapshot tables are owned by a separate, concurrently
# -built collectors track and may not exist yet (schema migration hasn't landed) or may exist
# but be entirely empty (tables created, no collectors run yet). Either way this must not
# crash a normal `task etl` run -- _sqlite_table_exists() probes each table with a real
# SELECT (not information_schema, whose catalog/schema semantics for an ATTACHed sqlite db
# are an extra thing to get right) and create_marketing_staging() falls back to empty,
# correctly-typed staging tables when any are missing. Downstream mart_creator_pitch.sql /
# mart_channel_mix.sql / mart_channel_buzz.sql then query these staging tables
# UNCONDITIONALLY -- either real rows flow through, or every join resolves to zero rows (the
# app's "connect a channel" empty state) -- the .sql files never need to know which mode
# they're in.
# --------------------------------------------------------------------------------------
MARKETING_SOURCE_TABLES = ["creator", "game_creator_mention", "creator_reach_snapshot"]


def _sqlite_table_exists(con: duckdb.DuckDBPyConnection, table: str) -> bool:
    try:
        con.execute(f'SELECT 1 FROM src."{table}" LIMIT 0')
        return True
    except duckdb.Error:
        return False


def create_marketing_staging(con: duckdb.DuckDBPyConnection) -> bool:
    """Creates stg_creator / stg_game_creator_mention / stg_creator_reach_snapshot /
    stg_creator_reach_latest from the scraper's creator/game_creator_mention/
    creator_reach_snapshot SQLite tables when all three exist, or as empty typed tables
    otherwise (see MARKETING_SOURCE_TABLES / module docstring above). Returns True if real
    source tables were found (only used for the build-time log line) -- the staging tables
    themselves look identical to downstream SQL either way."""
    have_all = all(_sqlite_table_exists(con, t) for t in MARKETING_SOURCE_TABLES)

    if have_all:
        con.execute(
            """
            CREATE TEMP TABLE stg_creator AS
            SELECT creator_id, platform, handle, display_name, url, first_seen
            FROM src.creator;

            CREATE TEMP TABLE stg_game_creator_mention AS
            SELECT m.appid, m.creator_id, m.platform,
                TRY_CAST(m.published_at AS TIMESTAMP) AS published_at,
                m.url, m.title, m.reach_at_time, m.confidence
            FROM src.game_creator_mention m
            WHERE m.appid IS NOT NULL AND m.creator_id IS NOT NULL;

            CREATE TEMP TABLE stg_creator_reach_snapshot AS
            SELECT creator_id, platform, TRY_CAST(captured_at AS TIMESTAMP) AS captured_at, reach
            FROM src.creator_reach_snapshot;
            """
        )
    else:
        con.execute(
            """
            CREATE TEMP TABLE stg_creator (
                creator_id INTEGER, platform VARCHAR, handle VARCHAR, display_name VARCHAR,
                url VARCHAR, first_seen VARCHAR
            );

            CREATE TEMP TABLE stg_game_creator_mention (
                appid INTEGER, creator_id INTEGER, platform VARCHAR,
                published_at TIMESTAMP, url VARCHAR, title VARCHAR, reach_at_time INTEGER,
                confidence DOUBLE
            );

            CREATE TEMP TABLE stg_creator_reach_snapshot (
                creator_id INTEGER, platform VARCHAR, captured_at TIMESTAMP, reach INTEGER
            );
            """
        )

    # Latest reach snapshot per creator -- built either way (empty in the degraded case) so
    # downstream marts have exactly one place to look up "current known reach" regardless of
    # mode.
    con.execute(
        """
        CREATE TEMP TABLE stg_creator_reach_latest AS
        SELECT creator_id, platform, reach, captured_at
        FROM (
            SELECT creator_id, platform, reach, captured_at,
                row_number() OVER (PARTITION BY creator_id ORDER BY captured_at DESC) AS rn
            FROM stg_creator_reach_snapshot
        )
        WHERE rn = 1;
        """
    )
    return have_all


def create_ccu_staging(con: duckdb.DuckDBPyConnection) -> bool:
    """Latest live concurrent-player count per game from the scraper's `player_counts` table
    (steam_players_bulk.py — keyless GetNumberOfCurrentPlayers snapshots). Guarded exactly like
    create_marketing_staging(): builds stg_player_count_latest from the newest snapshot per game
    when the table exists, else an empty typed table so mart_game never crashes on an older source
    DB. This is REAL live traction, distinct from SteamSpy's stale daily-peak stg_game.ccu."""
    if _sqlite_table_exists(con, "player_counts"):
        con.execute(
            """
            CREATE TEMP TABLE stg_player_count_latest AS
            SELECT appid, live_players, captured_at FROM (
                SELECT appid, player_count AS live_players, captured_at,
                    row_number() OVER (PARTITION BY appid ORDER BY captured_at DESC) AS rn
                FROM src.player_counts
            ) WHERE rn = 1;
            """
        )
        return True
    con.execute("CREATE TEMP TABLE stg_player_count_latest (appid INTEGER, live_players INTEGER, captured_at TIMESTAMP)")
    return False


_ANALYZER = None


def _get_analyzer():
    """Lazily build (and cache) a single VADER analyzer — loads its bundled lexicon file once,
    no network. Raises a clear error if the (pinned) dependency is missing."""
    global _ANALYZER
    if _ANALYZER is None:
        try:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        except ImportError as e:  # pragma: no cover - surfaced only if the dep is missing
            raise RuntimeError(
                "vaderSentiment is required for text sentiment — it is pinned in "
                "etl/requirements.txt (`pip install vaderSentiment`)."
            ) from e
        _ANALYZER = SentimentIntensityAnalyzer()
    return _ANALYZER


def _stream_vader_scores(con: duckdb.DuckDBPyConnection, select_sql: str, insert_sql: str) -> int:
    """Score a text column with VADER in bounded, streamed batches — the shared engine behind
    both compute_aspect_sentiment (review text) and compute_press_sentiment (article text).
    `select_sql` returns key column(s) then the text column LAST; `insert_sql` takes those same
    key column(s) then the DOUBLE compound. Reads through an INDEPENDENT cursor so the batched
    INSERTs on `con` never invalidate the scan; peak memory is one batch, not the whole corpus
    (matters on the 2GB Droplet). DuckDB Python UDFs need numpy (absent — we stay dependency-
    light), which is why this streams in Python rather than registering a scalar UDF. Returns the
    number of rows scored."""
    analyzer = _get_analyzer()
    read = con.cursor()
    read.execute(select_sql)
    n = 0
    while True:
        batch = read.fetchmany(SENTIMENT_SCORE_BATCH)
        if not batch:
            break
        scored = [(*row[:-1], float(analyzer.polarity_scores(row[-1] or "")["compound"])) for row in batch]
        con.executemany(insert_sql, scored)
        n += len(scored)
    read.close()
    return n


def _aspect_window_sql(pool: str) -> str:
    """One row per (review, aspect) mention: the local text window scored for sentiment.
    Built entirely in DuckDB (regexp_extract first keyword + strpos/substr window) from the
    ASPECT_LEXICON single source of truth, so it can never drift from the vote flags / excerpt
    windows. Same 10-arm shape as mart_game_teardown.sql's _review_aspect_flags, but emitting
    a row per match (with recommendationid, so mart_game_aspect_reviews.sql can join each
    excerpt to its sentiment) rather than a boolean column."""
    arms = []
    for label, _placeholder, rx in ASPECT_LEXICON:
        rxe = rx.replace("'", "''")  # SQL single-quote escape (none today, but be safe)
        label_e = label.replace("'", "''")
        arms.append(
            f"""
        SELECT appid, recommendationid, '{label_e}' AS aspect,
            CASE WHEN kw <> '' AND strpos(review_text, kw) > 0
                 THEN substr(review_text, GREATEST(1, strpos(review_text, kw) - {ASPECT_SENTIMENT_LEAD}), {ASPECT_SENTIMENT_WINDOW})
                 ELSE substr(review_text, 1, {ASPECT_SENTIMENT_WINDOW}) END AS window_text
        FROM (
            SELECT appid, recommendationid, review_text,
                regexp_extract(review_text, '{rxe}', 1, 'i') AS kw
            FROM {pool}
            WHERE regexp_matches(review_text, '{rxe}', 'i')
        )"""
        )
    return "\nUNION ALL\n".join(arms)


def compute_aspect_sentiment(con: duckdb.DuckDBPyConnection) -> int:
    """Precompute per-(appid, aspect) VADER text sentiment for the Game Teardown (see the
    ASPECT_LEXICON block above for the what/why). Runs BEFORE the mart SQL loop so
    mart_game_teardown.sql / mart_game_aspect_reviews.sql can read the results:

      stg_aspect_mention_sentiment  per (appid, recommendationid, aspect): the VADER `compound`
                                     of the local text window around the aspect keyword. Feeds
                                     the drill-down (mart_game_aspect_reviews classifies each
                                     excerpt praise/complaint by the sign of this compound).
      stg_aspect_sentiment          per (appid, aspect): positive/negative/neutral mention
                                     counts (VADER ±0.05 band) + summed compound. Feeds the
                                     aggregate bars (mart_game_review_aspects / the genre
                                     baseline).

    Scoring streams through _stream_vader_scores (a per-mention window table built in SQL, read
    via an independent cursor in bounded batches) — peak memory is one batch, never the whole
    ~1.7M-row corpus (matters on the 2GB Droplet)."""
    # Eligible English-text review pool (identical population + floor to stg_review_text /
    # _teardown_elig, but carrying recommendationid). TEMP: only read on this connection.
    con.execute(
        f"""
        CREATE TEMP TABLE _sent_pool AS
        WITH elig AS (
            SELECT appid FROM src.reviews
            WHERE language='english' AND review_text IS NOT NULL AND length(trim(review_text)) > 0
            GROUP BY appid HAVING COUNT(*) >= {TEARDOWN_MIN_REVIEWS}
        )
        SELECT r.appid, r.recommendationid, r.review_text
        FROM src.reviews r
        JOIN elig e ON e.appid = r.appid
        WHERE r.language='english' AND r.review_text IS NOT NULL AND length(trim(r.review_text)) > 0
        """
    )
    # Per-mention window table. REGULAR (not TEMP) so the independent read cursor below can see
    # it; dropped after scoring so it never ships in the versioned .duckdb.
    con.execute("DROP TABLE IF EXISTS _sent_windows")
    con.execute(f"CREATE TABLE _sent_windows AS {_aspect_window_sql('_sent_pool')}")

    con.execute(
        "CREATE TEMP TABLE stg_aspect_mention_sentiment("
        "appid INTEGER, recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE)"
    )

    n_scored = _stream_vader_scores(
        con,
        "SELECT appid, recommendationid, aspect, window_text FROM _sent_windows",
        "INSERT INTO stg_aspect_mention_sentiment VALUES (?, ?, ?, ?)",
    )

    con.execute("DROP TABLE IF EXISTS _sent_windows")
    con.execute("DROP TABLE IF EXISTS _sent_pool")

    # Aggregate per (appid, aspect). pos/neg/neutral use VADER's ±0.05 band; sum_compound lets
    # the genre baseline pool a mention-weighted mean compound downstream.
    con.execute(
        f"""
        CREATE TEMP TABLE stg_aspect_sentiment AS
        SELECT appid, aspect,
            COUNT(*) AS n_text_scored,
            COALESCE(SUM(CASE WHEN compound >= {SENTIMENT_POS_THRESHOLD} THEN 1 ELSE 0 END), 0) AS n_text_pos,
            COALESCE(SUM(CASE WHEN compound <= {SENTIMENT_NEG_THRESHOLD} THEN 1 ELSE 0 END), 0) AS n_text_neg,
            COALESCE(SUM(CASE WHEN compound > {SENTIMENT_NEG_THRESHOLD} AND compound < {SENTIMENT_POS_THRESHOLD} THEN 1 ELSE 0 END), 0) AS n_text_neutral,
            SUM(compound) AS sum_compound
        FROM stg_aspect_mention_sentiment
        GROUP BY appid, aspect
        """
    )
    return n_scored


def compute_press_sentiment(con: duckdb.DuckDBPyConnection) -> int:
    """Precompute VADER sentiment of each press article's headline+summary, for the Game
    Teardown's press footprint (does a game's journalist coverage skew positive or negative?).
    Runs BEFORE the mart loop so mart_game_teardown.sql can aggregate it per game.

      stg_press_article_sentiment  per article_id: the VADER `compound` of "title. summary" for
                                    every non-Steam-News article that mentions any game.

    Same coarse-lexicon caveats as the review sentiment, plus press-specific ones: it's scored
    from the headline + short summary (not the full body), so it captures an outlet's framing,
    not a considered verdict; and an article's overall tone is only a proxy for its stance on the
    specific game it's matched to. Steam News (dev-authored posts) is excluded, matching
    _press_base in mart_game_teardown.sql. The mart applies the per-game match-confidence floor
    when it aggregates, so we score every mentioned article once here regardless of confidence."""
    # Distinct non-Steam-News articles that mention any game. REGULAR table so the streaming read
    # cursor can see it; dropped after scoring so it never ships in the versioned .duckdb.
    con.execute("DROP TABLE IF EXISTS _press_score_set")
    con.execute(
        """
        CREATE TABLE _press_score_set AS
        SELECT DISTINCT a.id AS article_id,
            trim(COALESCE(a.title, '')
                 || CASE WHEN trim(COALESCE(a.summary, '')) <> '' THEN '. ' || a.summary ELSE '' END) AS text
        FROM src.articles a
        JOIN src.article_game_mentions m ON m.article_id = a.id
        WHERE a.source <> 'steam_news'
        """
    )
    con.execute("CREATE TEMP TABLE stg_press_article_sentiment(article_id INTEGER, compound DOUBLE)")
    n = _stream_vader_scores(
        con,
        "SELECT article_id, text FROM _press_score_set",
        "INSERT INTO stg_press_article_sentiment VALUES (?, ?)",
    )
    con.execute("DROP TABLE IF EXISTS _press_score_set")
    return n


def write_meta(con: duckdb.DuckDBPyConnection, source_db: str, mart_version: str) -> None:
    med_rev = con.execute(
        "SELECT median(est_rev_reviews) FROM stg_game WHERE total_reviews >= ? AND est_rev_reviews IS NOT NULL",
        [MIN_REVIEWS_DEFAULT],
    ).fetchone()[0]
    over_100k, n_scored = con.execute(
        """
        SELECT AVG(CASE WHEN est_rev_reviews > 100000 THEN 1.0 ELSE 0.0 END), COUNT(*)
        FROM stg_game WHERE total_reviews >= ? AND est_rev_reviews IS NOT NULL
        """,
        [MIN_REVIEWS_DEFAULT],
    ).fetchone()
    n_games = con.execute("SELECT COUNT(*) FROM stg_game").fetchone()[0]
    # Population matched to the market distribution: paid games with >=1 review.
    med_rev_paid = con.execute(
        "SELECT median(est_rev_reviews) FROM stg_game "
        "WHERE total_reviews >= 1 AND price_initial > 0 AND est_rev_reviews IS NOT NULL"
    ).fetchone()[0]
    # Read straight from stg_genre_boxleiter (computed pre-owners-floor -- see
    # create_staging()) rather than recomputing regr_slope() over stg_game directly: the
    # latter would now include floor-estimated owners_mid rows, whose owners_mid/
    # total_reviews ratio is exactly the flooring multiplier by construction, quietly
    # pulling this headline slope toward whatever it already was.
    boxleiter_slope = con.execute(
        "SELECT slope FROM stg_genre_boxleiter WHERE genre = '__all__'"
    ).fetchone()[0]

    rows = {
        "mart_version": mart_version,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_db": source_db,
        "min_reviews_default": str(MIN_REVIEWS_DEFAULT),
        "n_games_total": str(n_games),
        "n_games_scored": str(n_scored),
        "global_median_revenue": f"{med_rev:.2f}" if med_rev is not None else "",
        "global_median_revenue_paid": f"{med_rev_paid:.2f}" if med_rev_paid is not None else "",
        "boxleiter_owners_per_review": f"{boxleiter_slope:.2f}" if boxleiter_slope is not None else "",
        "pct_over_100k": f"{over_100k:.4f}" if over_100k is not None else "",
        "opportunity_weights": f"demand={W_DEMAND},competition={W_COMPETITION},quality_gap={W_QUALITY}",
    }
    con.execute("DROP TABLE IF EXISTS mart_meta")
    con.execute("CREATE TABLE mart_meta(key VARCHAR, value VARCHAR)")
    con.executemany("INSERT INTO mart_meta VALUES (?, ?)", list(rows.items()))


def main() -> int:
    ap = argparse.ArgumentParser(description="Build Prospect DuckDB marts.")
    ap.add_argument("--source", default="/Users/maximbaginskiy/hobby/steam-scraper/steam_games.db",
                    help="Path to the read-only steam_games.db SQLite source.")
    ap.add_argument("--data-dir", default=str(HERE.parent / "data"),
                    help="Directory for versioned duckdb files + current.duckdb symlink.")
    ap.add_argument("--keep", type=int, default=3, help="How many versioned marts to retain.")
    args = ap.parse_args()

    source_db = str(Path(args.source).resolve())
    if not Path(source_db).exists():
        print(f"ERROR: source DB not found: {source_db}", file=sys.stderr)
        return 2

    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    mart_version = date.today().strftime("%Y%m%d")
    versioned = data_dir / f"prospect_{mart_version}.duckdb"
    current = data_dir / "current.duckdb"

    if versioned.exists():
        versioned.unlink()

    params = build_params()
    print(f"[etl] source     : {source_db}")
    print(f"[etl] output     : {versioned}")
    t0 = time.perf_counter()

    con = duckdb.connect(str(versioned))
    try:
        # On memory-constrained hosts (e.g. a small Droplet) cap DuckDB's memory so it spills
        # to its on-disk temp dir instead of being OOM-killed. Env-driven; unset = default.
        _mem = os.environ.get("PROSPECT_DUCKDB_MEMORY_LIMIT")
        if _mem:
            con.execute(f"SET memory_limit='{_mem}'")
            print(f"[etl] duckdb memory_limit={_mem}")
        con.execute("INSTALL sqlite; LOAD sqlite;")
        con.execute(f"ATTACH '{source_db}' AS src (TYPE sqlite, READ_ONLY)")

        print("[etl] building staging tables ...")
        create_staging(con, params)

        have_marketing = create_marketing_staging(con)
        print(
            "[etl] marketing source tables (creator/game_creator_mention/creator_reach_snapshot): "
            + ("found" if have_marketing else "ABSENT or not yet migrated — building empty marketing marts")
        )

        have_ccu = create_ccu_staging(con)
        print("[etl] player_counts (live CCU): "
              + ("found" if have_ccu else "ABSENT — live_players will be NULL"))

        print("[etl] scoring aspect text sentiment (VADER) ...")
        t_sent = time.perf_counter()
        n_sent = compute_aspect_sentiment(con)
        print(f"[etl] aspect sentiment: scored {n_sent:,} aspect mentions "
              f"({time.perf_counter() - t_sent:.1f}s)")

        print("[etl] scoring press-coverage sentiment (VADER) ...")
        t_press = time.perf_counter()
        n_press = compute_press_sentiment(con)
        print(f"[etl] press sentiment: scored {n_press:,} articles "
              f"({time.perf_counter() - t_press:.1f}s)")

        for fname in MART_FILES:
            sql_path = HERE / "marts" / fname
            sql = render(sql_path.read_text(), params)
            t = time.perf_counter()
            con.execute(sql)
            print(f"[etl] ran {fname:24s} ({time.perf_counter() - t:5.2f}s)")

        write_meta(con, source_db, mart_version)

        # Per-mart row counts.
        tables = [r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_name LIKE 'mart%' ORDER BY table_name"
        ).fetchall()]
        print("\n[etl] mart row counts:")
        for tbl in tables:
            n = con.execute(f'SELECT COUNT(*) FROM "{tbl}"').fetchone()[0]
            print(f"        {tbl:24s} {n:>10,}")
    finally:
        con.close()

    # Atomic symlink swap: current.duckdb -> prospect_<version>.duckdb (relative target).
    tmp_link = data_dir / ".current.tmp"
    if tmp_link.exists() or tmp_link.is_symlink():
        tmp_link.unlink()
    os.symlink(versioned.name, tmp_link)
    os.replace(tmp_link, current)
    print(f"\n[etl] swapped {current} -> {versioned.name}")

    # Retention: keep the newest N versioned files.
    versions = sorted(data_dir.glob("prospect_*.duckdb"), key=lambda p: p.name, reverse=True)
    for old in versions[args.keep:]:
        old.unlink()
        print(f"[etl] pruned old mart {old.name}")

    print(f"[etl] done in {time.perf_counter() - t0:.1f}s  (version {mart_version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
