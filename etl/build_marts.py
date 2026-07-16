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

MART_FILES = [
    "mart_game.sql",
    "mart_niche.sql",
    "mart_market.sql",
    "mart_seasonality.sql",
    "mart_launch_curve.sql",
    "mart_game_reviews.sql",
    "mart_lang.sql",
    "mart_game_teardown.sql",
    "mart_game_aspect_reviews.sql",
    "mart_press.sql",
    "mart_explorer.sql",
]

HERE = Path(__file__).resolve().parent


def build_params() -> dict[str, str]:
    today = date.today()
    cur_year = today.year
    return {
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
        CREATE TEMP TABLE stg_game AS
        SELECT
            ag.appid, ag.name, ag.release_year,
            TRY_CAST(ag.release_date_iso AS DATE) AS release_date,
            (TRY_CAST(ag.release_date_iso AS DATE) IS NOT NULL
                AND TRY_CAST(ag.release_date_iso AS DATE) <= CURRENT_DATE
                AND TRY_CAST(ag.release_date_iso AS DATE) >= DATE '1997-01-01') AS release_valid,
            (TRY_CAST(ag.release_date_iso AS DATE) IS NOT NULL
                AND TRY_CAST(ag.release_date_iso AS DATE) <= CURRENT_DATE
                AND TRY_CAST(ag.release_date_iso AS DATE) >= CURRENT_DATE - INTERVAL @RECENT_MONTHS@ MONTH) AS is_recent,
            ag.price_initial, ag.is_free, ag.developers, ag.publishers,
            ag.self_published, ag.dev_game_count, ag.is_indie,
            ag.metacritic_score, ag.achievements_count,
            ag.owners_mid, ag.total_reviews, ag.positive_reviews, ag.negative_reviews,
            ag.positive_ratio, ag.est_rev_reviews, ag.est_rev_owners,
            ag.avg_playtime_forever, ag.ccu, ag.tag_count
        FROM src.analysis_games ag;

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
    boxleiter_slope = con.execute(
        "SELECT regr_slope(owners_mid, total_reviews) FROM stg_game "
        "WHERE total_reviews >= ? AND owners_mid > 0", [MIN_REVIEWS_DEFAULT]
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
        con.execute("INSTALL sqlite; LOAD sqlite;")
        con.execute(f"ATTACH '{source_db}' AS src (TYPE sqlite, READ_ONLY)")

        print("[etl] building staging tables ...")
        create_staging(con, params)

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
