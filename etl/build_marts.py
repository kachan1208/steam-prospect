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
import hashlib
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
MIN_REVIEWS_DEFAULT = 50          # a game needs >= this many reviews to enter niche/analysis STATS
                                  # (NOT the games list — that now shows the full live catalog, below)
MIN_REVIEWS_LEVELS = [50, 100]    # min_reviews floors materialised in mart_niche
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

# Live-player (CCU) daily/niche series — see mart_players.sql. The collector captures a
# fixed top-8k head nightly and rotates the tail every ~3-8 nights, so per-game daily
# coverage is intentionally sparse below the head; these knobs make that sparsity honest.
CCU_STALE_DAYS = 7               # LOCF carry-forward cap: a game's last capture counts toward
                                 # niche totals for at most this many days, then it drops out
                                 # (must comfortably cover the tail rotation cycle)
CCU_FRESH_DAYS = 2               # "fresh" for players_coverage: captured within the last
                                 # nightly cycle or two
PLAYERS_TREND_DAYS = 7           # trend windows: last 7d vs prior 7d, same-panel only
PLAYERS_HISTORY_DAYS = 365       # rolling window kept in the players marts (SQLite retains all)
NICHE_PLAYERS_MIN_MEASURED = 10  # a niche needs >= this many ever-measured games for a series;
                                 # also the same-panel floor for niche players_trend_7d_pct

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

# --------------------------------------------------------------------------------------
# Niche-score v2 (2026-08) — growth gate + tag tiers + solo viability (see mart_niche.sql).
#
# WHY: a real user rejected find_niches' top answers — sorting by raw `opportunity`
# returned Naval / Transportation / Diplomacy (new releases shrinking 15-37%/yr: the
# "low competition" the score rewarded was everyone LEAVING, not an open market) and
# 4X / Open World (genre umbrellas a solo dev can't "build", not actionable niches).
# The v2 columns fix both failure modes WITHOUT touching the original score: a decline
# gate multiplies `opportunity` into `opportunity_v2`, and a tag `tier` lets the MCP/API
# default to buildable micro-genres + themes while keeping umbrellas/meta reachable.
# --------------------------------------------------------------------------------------
# Decline gate (opportunity_v2 = opportunity * gate). Two independent decline signals:
#   sat_severity      = clamp(-saturation_yoy / GATE_SAT_FULL_DECLINE, 0, 1)
#                       (release pipeline shrinking; full severity at a
#                        GATE_SAT_FULL_DECLINE, e.g. 30%/yr, drop in new releases)
#   entrant_severity  = clamp((1 - entrant_ratio) / (1 - GATE_ENTRANT_FULL), 0, 1)
#                       (recent entrants underearn the niche's all-time median; full
#                        severity at entrant_ratio <= GATE_ENTRANT_FULL)
#   gate = 1 - (1 - GATE_FLOOR) * MAX(sat_severity, entrant_severity)   -> in [GATE_FLOOR, 1]
#
# Deliberate deviation from the obvious "AND" gate (only penalize when BOTH signals are
# bad): measured on the real catalog, the median tag's entrant_ratio is ~1.08 (24m medians
# run structurally higher than all-time medians — price inflation + the review floor
# filtering recent releases harder), so entrant_ratio >= 1 is the NORM and cannot excuse a
# collapsing release pipeline. Concretely, the user-rejected niches themselves (Naval
# er~1.5, Fighting er~3.1 — tiny 24m survivor cohorts over a huge cheap back catalog)
# would sail through an AND gate untouched. MAX (i.e. OR) semantics treat each decline
# signal as sufficient evidence on its own; a niche only keeps gate=1.0 when NEITHER
# signal is negative. NULL signals (no prior-year releases / zero or missing medians)
# count as "no evidence of decline", not as decline.
GATE_FLOOR = 0.5                 # worst-case multiplier on opportunity (never below half)
GATE_SAT_FULL_DECLINE = 0.30     # saturation_yoy <= -30%/yr -> full saturation severity
GATE_ENTRANT_FULL = 0.5          # entrant_ratio <= 0.5 -> full entrant severity
                                 # (severity ramps linearly over er in [0.5, 1.0])

# Tag tiers. Curated TAG_TIER map below classifies the big/obvious tags; any UNMAPPED tag
# falls back to a size heuristic: all-time n_games (win='all', min_reviews=
# MIN_REVIEWS_DEFAULT cut) >= UMBRELLA_N_GAMES -> 'umbrella', else 'micro'. dimension=
# 'genre' rows always get tier='genre' (Steam's fixed genre list is a different vocabulary,
# not tiered). The MCP/API default to micro+theme ONLY — see find_niches.
UMBRELLA_N_GAMES = 400

# Curated tag -> tier map ('micro' | 'umbrella' | 'theme' | 'meta'), from reading the
# actual DISTINCT keys in mart_niche (414 tags, 2026-08 build). Semantics:
#   micro     a buildable game concept — you can start THIS game tomorrow
#             (Colony Sim, Souls-like, Deckbuilding, City Builder...).
#   umbrella  a genre/mechanic/mode/perspective CONTAINER, too broad to build directly
#             (Open World, Sandbox, RPG, Turn-Based, Co-op, First-Person...). Also used
#             for feature tags (Character Customization, Multiple Endings...).
#   theme     a setting/subject/aesthetic you pick FOR a game, not a game by itself
#             (Vikings, Western, Naval, Pixel Graphics, Cozy, World War II...).
#   meta      reception/quality/store-metadata tags that describe how a game is perceived
#             or packaged, never what to build (Great Soundtrack, Nostalgia, Replay
#             Value, Early Access, RPGMaker, content-rating descriptors...).
# micro-vs-theme is informational (both included by default downstream); the boundary that
# changes behavior is (micro|theme) vs (umbrella|meta), so curation effort concentrated
# there. NOTE the vocabulary quirks preserved verbatim from real tag data: 'Dystopian '
# (trailing space) and 'Point &amp; Click' / 'Design &amp; Illustration' (HTML entities)
# are distinct keys in game_tags and must be matched exactly.
TAG_TIER: dict[str, str] = {
    # ---- umbrellas: broad genre containers ----
    "Action": "umbrella", "Adventure": "umbrella", "Action-Adventure": "umbrella",
    "Casual": "umbrella", "Simulation": "umbrella", "Strategy": "umbrella",
    "RPG": "umbrella", "Action RPG": "umbrella", "Puzzle": "umbrella",
    "Arcade": "umbrella", "Sports": "umbrella", "Racing": "umbrella",
    "Shooter": "umbrella", "FPS": "umbrella", "Third-Person Shooter": "umbrella",
    "Platformer": "umbrella", "Horror": "umbrella", "Survival": "umbrella",
    "Open World": "umbrella", "Sandbox": "umbrella", "Exploration": "umbrella",
    "Management": "umbrella", "Logic": "umbrella", "4X": "umbrella",
    "Rogue-like": "umbrella", "Rogue-lite": "umbrella", "Roguelike": "umbrella",
    "Roguelite": "umbrella", "War": "umbrella", "Combat": "umbrella",
    "Tactical": "umbrella",
    # ---- umbrellas: mechanic/feature containers ----
    "Building": "umbrella", "Crafting": "umbrella", "Base-Building": "umbrella",
    "Base Building": "umbrella", "Resource Management": "umbrella", "Economy": "umbrella",
    "Physics": "umbrella", "Procedural Generation": "umbrella", "Loot": "umbrella",
    "Turn-Based": "umbrella", "Turn-Based Combat": "umbrella", "Real-Time": "umbrella",
    "Real-Time with Pause": "umbrella", "Grid-Based Movement": "umbrella",
    "Character Customization": "umbrella", "Multiple Endings": "umbrella",
    "Choices Matter": "umbrella", "Perma Death": "umbrella", "Score Attack": "umbrella",
    "Quick-Time Events": "umbrella", "Destruction": "umbrella", "Conversation": "umbrella",
    "Bullet Time": "umbrella", "6DOF": "umbrella",
    # ---- umbrellas: mode/perspective/platform descriptors ----
    "Singleplayer": "umbrella", "Multiplayer": "umbrella",
    "Massively Multiplayer": "umbrella", "Co-op": "umbrella", "Online Co-Op": "umbrella",
    "Local Co-Op": "umbrella", "Local Multiplayer": "umbrella",
    "4 Player Local": "umbrella", "Split Screen": "umbrella", "Co-op Campaign": "umbrella",
    "Asynchronous Multiplayer": "umbrella", "Team-Based": "umbrella",
    "Competitive": "umbrella", "PvP": "umbrella", "PvE": "umbrella",
    "2D": "umbrella", "3D": "umbrella", "2.5D": "umbrella",
    "First-Person": "umbrella", "Third Person": "umbrella", "Top-Down": "umbrella",
    "Isometric": "umbrella", "Side Scroller": "umbrella", "VR": "umbrella",
    "Driving": "umbrella",
    # ---- micro: buildable genres (incl. >=UMBRELLA_N_GAMES rescues the heuristic would
    #      otherwise misfile as umbrella) ----
    "Psychological Horror": "micro", "Survival Horror": "micro", "Visual Novel": "micro",
    "Interactive Fiction": "micro", "Choose Your Own Adventure": "micro",
    "Text-Based": "micro", "JRPG": "micro", "CRPG": "micro", "Tactical RPG": "micro",
    "Strategy RPG": "micro", "Party-Based RPG": "micro", "Dungeon Crawler": "micro",
    "Immersive Sim": "micro", "Walking Simulator": "micro", "Hack and Slash": "micro",
    "Turn-Based Strategy": "micro", "Turn-Based Tactics": "micro",
    "Real Time Tactics": "micro", "RTS": "micro", "Grand Strategy": "micro",
    "Wargame": "micro", "City Builder": "micro", "Colony Sim": "micro",
    "Life Sim": "micro", "Farming Sim": "micro", "Farming": "micro",
    "Agriculture": "micro", "Automation": "micro", "Idler": "micro", "Clicker": "micro",
    "Incremental": "micro", "Time Management": "micro", "Deckbuilding": "micro",
    "Card Battler": "micro", "Auto Battler": "micro", "Roguelike Deckbuilder": "micro",
    "Action Roguelike": "micro", "Traditional Roguelike": "micro", "Roguevania": "micro",
    "Bullet Hell": "micro", "Bullet Heaven": "micro", "Shoot 'Em Up": "micro",
    "Twin Stick Shooter": "micro", "Top-Down Shooter": "micro", "Arena Shooter": "micro",
    "Boomer Shooter": "micro", "Looter Shooter": "micro", "Hero Shooter": "micro",
    "Extraction Shooter": "micro", "Battle Royale": "micro", "MOBA": "micro",
    "MMORPG": "micro", "Tower Defense": "micro", "Metroidvania": "micro",
    "2D Platformer": "micro", "3D Platformer": "micro", "Puzzle-Platformer": "micro",
    "Puzzle Platformer": "micro", "Precision Platformer": "micro", "Collectathon": "micro",
    "Souls-like": "micro", "Beat 'em up": "micro", "2D Fighter": "micro",
    "3D Fighter": "micro", "Fighting": "micro", "Spectacle fighter": "micro",
    "Character Action Game": "micro", "Musou": "micro", "Boss Rush": "micro",
    "Point & Click": "micro", "Point &amp; Click": "micro", "Hidden Object": "micro",
    "Dating Sim": "micro", "Otome": "micro", "Rhythm": "micro", "Stealth": "micro",
    "Card Game": "micro", "Board Game": "micro", "Tabletop": "micro",
    "Word Game": "micro", "Trivia": "micro", "Solitaire": "micro", "Chess": "micro",
    "Mahjong": "micro", "Pinball": "micro", "Open World Survival Craft": "micro",
    "Creature Collector": "micro", "God Game": "micro", "Political Sim": "micro",
    "Outbreak Sim": "micro", "Job Simulator": "micro", "Medical Sim": "micro",
    "Automobile Sim": "micro", "Space Sim": "micro", "Flight": "micro",
    "Combat Racing": "micro", "Vehicular Combat": "micro", "Naval Combat": "micro",
    "Trading": "micro", "Cooking": "micro", "Fishing": "micro", "Hunting": "micro",
    "Mining": "micro", "Trains": "micro", "Transportation": "micro",
    "Diplomacy": "micro", "Minigames": "micro", "Escape Room": "micro",
    "Mystery Dungeon": "micro", "Party Game": "micro", "Inventory Management": "micro",
    "Education": "micro", "FMV": "micro", "Parkour": "micro",
    "Social Deduction": "micro", "Sokoban": "micro",
    # ---- themes: setting / subject matter ----
    "Fantasy": "theme", "Dark Fantasy": "theme", "Sci-fi": "theme",
    "Cyberpunk": "theme", "Steampunk": "theme", "Space": "theme",
    "Futuristic": "theme", "Post-apocalyptic": "theme", "Zombies": "theme",
    "Medieval": "theme", "Historical": "theme", "Alternate History": "theme",
    "Rome": "theme", "Vikings": "theme", "Western": "theme", "America": "theme",
    "World War I": "theme", "World War II": "theme", "Cold War": "theme",
    "Military": "theme", "Naval": "theme", "Pirates": "theme", "Sailing": "theme",
    "Ninja": "theme", "Martial Arts": "theme", "Assassin": "theme",
    "Dwarf": "theme", "Jet": "theme", "Tanks": "theme", "Submarine": "theme",
    "Spaceships": "theme", "Mechs": "theme", "Robots": "theme", "Aliens": "theme",
    "Dragons": "theme", "Demons": "theme", "Vampire": "theme", "Werewolves": "theme",
    "Lovecraftian": "theme", "Mythology": "theme", "Gothic": "theme", "Noir": "theme",
    "Crime": "theme", "Detective": "theme", "Investigation": "theme",
    "Conspiracy": "theme", "Illuminati": "theme", "Politics": "theme",
    "Political": "theme", "Capitalism": "theme", "Dystopian": "theme",
    "Dystopian ": "theme", "Superhero": "theme", "Supernatural": "theme",
    "Magic": "theme", "Nature": "theme", "Underwater": "theme", "Underground": "theme",
    "Snow": "theme", "Cats": "theme", "Dog": "theme", "Horses": "theme",
    "Dinosaurs": "theme", "Time Travel": "theme", "Faith": "theme", "Science": "theme",
    "Artificial Intelligence": "theme", "Transhumanism": "theme", "Mars": "theme",
    "Heist": "theme", "Villain Protagonist": "theme", "Female Protagonist": "theme",
    "Based On A Novel": "theme", "Dungeons & Dragons": "theme", "Modern": "theme",
    # ---- themes: aesthetic / tone (a deliberate positioning choice, so kept in
    #      defaults, unlike reception-descriptor meta tags) ----
    "Anime": "theme", "Pixel Graphics": "theme", "Hand-drawn": "theme",
    "Voxel": "theme", "Minimalist": "theme", "Abstract": "theme",
    "Cartoony": "theme", "Cartoon": "theme", "Comic Book": "theme",
    "Stylized": "theme", "Realistic": "theme", "Retro": "theme", "Old School": "theme",
    "1980s": "theme", "1990's": "theme", "Cute": "theme", "Colorful": "theme",
    "Cozy": "theme", "Wholesome": "theme", "Family Friendly": "theme",
    "Dark": "theme", "Surreal": "theme", "Psychedelic": "theme",
    "Comedy": "theme", "Dark Humor": "theme", "Dark Comedy": "theme",
    "Satire": "theme", "Parody": "theme", "Parody ": "theme", "Memes": "theme",
    "Drama": "theme", "Romance": "theme", "Mystery": "theme", "Thriller": "theme",
    "Psychological": "theme", "Philosophical": "theme", "LGBTQ+": "theme",
    "Hentai": "theme",
    # ---- meta: reception/quality/store-metadata — never a thing to build ----
    "Great Soundtrack": "meta", "Soundtrack": "meta", "Music": "meta",
    "Nostalgia": "meta", "Replay Value": "meta", "Story Rich": "meta",
    "Atmospheric": "meta", "Emotional": "meta", "Funny": "meta", "Relaxing": "meta",
    "Addictive": "meta", "Immersive": "meta", "Beautiful": "meta", "Classic": "meta",
    "Cult Classic": "meta", "Lore-Rich": "meta", "Cinematic": "meta",
    "Experimental": "meta", "Experience": "meta", "Well-Written": "meta",
    "Narrative": "meta", "Narration": "meta", "Dynamic Narration": "meta",
    "Difficult": "meta", "Fast-Paced": "meta", "Linear": "meta", "Nonlinear": "meta",
    "Short": "meta", "Mature": "meta", "Violent": "meta", "Gore": "meta",
    "Blood": "meta", "Sexual Content": "meta", "Nudity": "meta", "NSFW": "meta",
    "Indie": "meta", "Early Access": "meta", "Free to Play": "meta",
    "e-sports": "meta", "Remake": "meta", "Sequel": "meta", "Episodic": "meta",
    "Movie": "meta", "Crowdfunded": "meta", "Tutorial": "meta", "Foreign": "meta",
    "Gaming": "meta", "Mod": "meta", "Moddable": "meta", "Level Editor": "meta",
    "RPGMaker": "meta", "GameMaker": "meta", "Mouse only": "meta",
    "Touch-Friendly": "meta", "3D Vision": "meta", "360 Video": "meta",
    "Ambient": "meta", "Silent Protagonist": "meta", "Jump Scare": "meta",
    "Unforgiving": "meta", "Intentionally Awkward Controls": "meta",
    "Design &amp; Illustration": "meta",  # HTML-entity twin of a DENYLIST_TAG entry
}

# Launch-curve eligibility.
CURVE_MIN_REVIEWS = 10           # sampled first-year reviews a game needs to enter the curve
CURVE_MIN_GAMES = 30             # a genre needs this many eligible games to publish a curve

# --------------------------------------------------------------------------------------
# Launch & Timing marts (mart_timing.sql) — built from `review_histogram`, the TRUE
# uncapped monthly review counts Steam publishes per game (scraped for every game with
# >=50 total reviews, ~40K games). Unlike the sampled `reviews` table these are exact
# per-month totals, so they support honest demand/decay reads. Guarded staging
# (create_timing_staging below): older source DBs without the table build empty marts.
# --------------------------------------------------------------------------------------
TIMING_DEMAND_YEARS = 5          # demand pools over the last N COMPLETE calendar years
                                 # (complete years only — a partial year would overweight
                                 #  the months it has already lived through)
TIMING_LAUNCH_EXCLUDE_MONTHS = 2 # demand EXCLUDES each game's first N calendar months
                                 # since release. WHY: launch spikes cluster wherever the
                                 # genre's releases cluster, so without this a popular
                                 # launch window would masquerade as "seasonal demand" by
                                 # construction. What survives is post-launch/catalog
                                 # buying — the closest thing to when players ACTUALLY buy.
TIMING_DEMAND_MIN_GAMES = 50     # a genre needs >= this many contributing games to get a
                                 # demand curve (else its shares are a few titles' noise)
TIMING_CONGESTION_YEARS = 3      # congestion averages releases over the last N complete years
TIMING_BIG_REV = 200_000         # est_rev_reviews >= this = a "big" release (mirrors the
                                 # hit_rate_200k threshold used across the niche marts)
TIMING_DECAY_MONTHS = 24         # payout-decay horizon: months 0..23 since release
TIMING_DECAY_MIN_REVIEWS = 50    # a game's first-24-months histogram total must reach this
                                 # to enter the decay stats (coverage floor: tiny games'
                                 # shares are quantized garbage — 3 reviews = 33% steps)
TIMING_DECAY_MIN_GAMES = 30      # a (genre) needs >= this many eligible games for a
                                 # decay curve (mirrors CURVE_MIN_GAMES)

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

# JTBD — niche review themes (see mart_niche_themes.sql): the per-game aspect
# praise/complaint signal rolled up to niche (tag/genre) level, with a delta vs the
# all-catalog baseline. Reuses TEARDOWN_MIN_REVIEWS implicitly (it reads
# mart_game_review_aspects, whose population that floor defines); this floor is the
# niche-level one on top of it.
NICHE_THEMES_MIN_GAMES = 10      # a (niche, aspect) needs >= this many games with >=1 review
                                  # mentioning the aspect to be published — below that, one
                                  # title's fans/haters would read as "the niche's" theme
                                  # (mirrors MIN_NICHE_GAMES's role, floored lower because the
                                  # teardown-eligible population is much smaller than mart_niche's)

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
#
# PRECISION PASS (2026-07): a real user report on Songs of Syx (appid 1162750) showed a
# negative review about Combat ("This game suffers from something frighteningly terrible:
# Combat. It was decently fun for the first few hours...") getting logged as a negative
# "Content & Length" mention, purely because bare "hours" (a playtime reference, not a
# length/content judgment) matched RX_CONTENT. That prompted a precision pass across every
# arm: dropped pure-sentiment words that aren't aspects at all (gorgeous/beautiful), dropped or
# phrase-qualified bare terms that collide with common non-aspect usage (hours, short, long,
# score, sound, style, lost, tight, area/areas), keeping the clearly-on-topic terms. Combined
# with the sentence-bounded sentiment window below (ASPECT_SENTENCE_CHARS), this fixes both the
# false attribution (wrong aspect entirely) and the sentiment bleed (right aspect, wrong
# clause's sentiment) that the loose lexicon + fixed-char window produced together. Difficulty's
# hard/easy/brutal terms are left as-is — acknowledged domain-blind (see the caveat below) but
# there's no cheap phrase-qualified fix without gutting recall on the single most common way
# reviewers describe difficulty.
ASPECT_LEXICON = [
    ("Combat & Bosses", "RX_COMBAT",
     r"\b(combat|fight|fights|fighting|boss|bosses|dodge|dodges|dodging|parry|parries|parrying|mechanic|mechanics|hitbox|hitboxes)\b"),
    ("World & Exploration", "RX_WORLD",
     r"\b(world|explore|explores|exploring|exploration|level design|open world|metroidvania)\b"),
    ("Art & Visuals", "RX_ART",
     r"\b(art|visual|visuals|graphics|animation|animations|hand-drawn|hand drawn|handdrawn|aesthetic|aesthetics|art style|artstyle)\b"),
    ("Music & Audio", "RX_MUSIC",
     r"\b(music|soundtrack|soundtracks|ost|audio|sound design)\b"),
    ("Story & Writing", "RX_STORY",
     r"\b(story|stories|writing|lore|character|characters|narrative|dialogue|dialog|ending|endings)\b"),
    ("Difficulty", "RX_DIFFICULTY",
     r"\b(difficult|difficulty|hard|hardest|challenging|challenge|challenges|punishing|brutal|easy|unfair)\b"),
    ("Controls & Performance", "RX_CONTROLS",
     r"\b(controls|control|responsive|tight controls|clunky|bug|bugs|buggy|crash|crashes|crashing|performance|fps|optimization|optimized|optimisation)\b"),
    ("Map & Navigation / Backtracking", "RX_MAPNAV",
     r"\b(map|maps|navigation|backtrack|backtracks|backtracking|confusing|tedious|grind|grinding|grindy)\b"),
    ("Content & Length", "RX_CONTENT",
     r"\b(content|length|hours of (?:content|gameplay|fun|playtime)|too short|too long|feels short|short game|long game|replay|replayability|replay value)\b"),
    ("Price & Value", "RX_PRICEVALUE",
     r"\b(price|worth|value|cheap|expensive|overpriced|bargain)\b"),
]
# Per-side cap (characters) for the sentence/clause-bounded sentiment & excerpt window: from the
# first aspect-keyword match, extend outward up to this many characters in each direction,
# stopping early at a sentence/clause boundary (. ! ? ; or newline) if one comes first. Bounding
# by clause (not a fixed char count) is what stops the scored/excerpted text from bleeding into
# an unrelated neighboring sentence -- e.g. the Songs of Syx example above, where a FIXED window
# used to pull "frighteningly terrible" (about Combat, the previous sentence) onto the unrelated
# "hours" mention, flipping a genuinely positive clause ("decently fun for the first few hours")
# negative. The cap just keeps a run-on sentence (no punctuation for a while) from exploding the
# window. Rendered into mart_game_aspect_reviews.sql's excerpt regex via the
# @ASPECT_SENTENCE_CHARS@ placeholder, string-concatenated there with the SAME @RX_*@ keyword
# regex text (see build_params() / _aspect_sentence_regex below) -- so the text actually scored
# for sentiment and the excerpt shown to users are always the identical window, by construction,
# not by keeping two numbers in sync by hand.
ASPECT_SENTENCE_CHARS = 160
# PERFORMANCE PASS (2026-07): the sentence-bounded regex above is comparatively heavy (two
# ASPECT_SENTENCE_CHARS-bounded context clauses either side of the keyword alternation), and
# running it directly against the FULL review_text -- once per aspect arm, up to 10x per review,
# across ~1.7M mentions -- is what blew the ETL from ~85min to ~5h (CPU-bound regex, not a query
# plan problem). Fix (see _aspect_keyword_position_regex / _aspect_window_sql below, and the
# identically-shaped excerpt window in mart_game_aspect_reviews.sql): locate the FIRST keyword
# match's character position, slice a small, generously-bounded substring of review_text around
# it, and run the (unchanged) sentence regex on THAT slice instead of the whole review. Output is
# byte-identical -- the slice always fully contains the up-to-ASPECT_SENTENCE_CHARS-per-side
# window a full-text scan would have found -- but the expensive pattern scans a few hundred
# characters instead of an entire (sometimes very long) review body.
#
# ASPECT_WINDOW_SLICE_BEFORE: how far (chars) before the match the slice starts -- the max
# ASPECT_SENTENCE_CHARS the left-context clause can ever consume, plus a safety margin.
# ASPECT_WINDOW_SLICE_CHARS: total slice length -- that same left margin, plus ASPECT_SENTENCE_CHARS
# of right-context, plus a generous allowance for the matched keyword phrase's own length (longest
# today is ~18 chars, "hours of playtime").
ASPECT_WINDOW_SLICE_BEFORE = ASPECT_SENTENCE_CHARS + 40                              # 200
ASPECT_WINDOW_SLICE_CHARS = ASPECT_WINDOW_SLICE_BEFORE + ASPECT_SENTENCE_CHARS + 160  # 520
# VADER compound thresholds: >= POS is positive, <= NEG is negative, strictly between is the
# neutral/unclear band (VADER's own standard cutoffs). The pos-vs-neg bar excludes neutrals.
SENTIMENT_POS_THRESHOLD = 0.05
SENTIMENT_NEG_THRESHOLD = -0.05
SENTIMENT_SCORE_BATCH = 20000    # rows pulled+scored+inserted per streamed batch (bounded memory)

# Incremental sentiment cache (2026-07): compute_aspect_sentiment/compute_press_sentiment used to
# re-run VADER over the ENTIRE ~1.7M-mention / ~204K-article corpus on EVERY ETL run, even though
# reviews/articles are immutable — a scored (recommendationid, aspect) mention or article_id's
# input text never changes once written. That's what turned an ETL that used to take ~85min into a
# ~3h run as the corpus grew: nightly, we were re-deriving the same answer for the same ~1.9M rows
# over and over. Since a score is a pure function of (text, scoring config), it only needs to be
# computed once per id and can be cached forever — see SENTIMENT_CACHE_DB_NAME and
# compute_aspect_sentiment/compute_press_sentiment below for the cache read/write flow, and
# _sentiment_config_hash for what forces a full rescore.
SENTIMENT_CACHE_DB_NAME = "sentiment_cache.duckdb"  # lives in --data-dir, deliberately NOT named
                                                     # prospect_*.duckdb — main()'s retention logic
                                                     # prunes old dated marts; this file must survive.
SENTIMENT_CACHE_VERSION = 1  # bump to force a full rescore even when none of the hashed config
                              # knobs below changed (e.g. a vaderSentiment version bump, or a fix to
                              # the scoring code itself that a config-value hash can't see).

# Domain-tuned VADER lexicon overrides (2026-07). Stock VADER is a general-English lexicon: it has
# no notion that "horror"/"brutal"/"insane"/"sick" are GENRE or INTENSITY descriptors in game
# reviews and press coverage, not the reviewer's/journalist's quality verdict -- it reads a horror
# game's own genre as negative sentiment. Real bug: The Mound: Omen of Cthulhu (appid 2569760), a
# positive IGN preview headlined "...Sets Co-op HORROR Survival for Summer 2026 With Fresh
# Gameplay Trailer", scored compound -0.34 (should read positive/neutral) purely because of
# "Horror". The identical failure mode hits Difficulty ("brutal"/"punishing"/"hard" as PRAISE for
# a well-tuned challenge reads as a complaint) and -- found by auditing ASPECT_LEXICON's own
# keyword tokens against the baseline VADER lexicon -- Combat & Bosses ("combat"/"fight(s)"/
# "fighting" are themselves baseline-negative even though they're the aspect's topic, not a
# verdict on it).
#
# Applied ONCE, in _get_analyzer() below, via analyzer.lexicon.update(...) on the single cached
# analyzer instance -- compute_aspect_sentiment (review text) and compute_press_sentiment (article
# text) both score through _stream_vader_scores -> _get_analyzer(), so this can't drift between
# the two scorers by construction (no second copy to keep in sync by hand).
#
# Values are VADER valence on its native ~-4..+4 scale. Two deliberate exceptions to a clean
# "genre word -> exactly 0.0" rule, found by testing (documented inline below):
#   "mess" -> -0.6, not 0.0. Fully zeroing it would make the sentence "buggy mess, refunded" score
#             NEUTRAL, not negative -- "buggy"/"refund(ed)" aren't in VADER at all, so "mess" is
#             the ONLY sentiment-bearing token in it. Dampened instead: still reads negative alone,
#             but drags far less on genuinely positive text (the horde/chaos-genre usage that a
#             positive real headline for this same game, "...Sanity Mechanics That Mess with Your
#             Friends", is an example of).
#   everything else that had a nonzero baseline and no such conflict -> 0.0. A sensitivity check
#             (damping Difficulty/Combat words to a small residual negative instead of 0.0, e.g.
#             -0.3..-0.8) was tried and rejected: on a real 300-review sample it roughly HALVED the
#             number of false-negative fixes (52 -> 23-25 out of 101 baseline negatives) while only
#             marginally reducing an already-tiny regression rate (1/300) -- a bad trade.
#
# HONEST LIMITATION, found the same way (real-sample testing, not guessed): VADER's own negation
# heuristic ("not so punishing" partially flips "punishing"'s valence) occasionally relied on the
# very word this dict neutralizes to correctly read a contrastive "but"-clause. E.g. "They're
# challenging enough to encourage improvement, but not so punishing that they become frustrating"
# scored +0.68 (correct) at baseline and -0.20 (wrong) tuned -- a real, small regression from a
# double-negative/contrastive-clause interaction that word-level lexicon tuning cannot reliably
# fix without undoing the fix it exists for. Rare in practice (1/300 real samples tested) and
# reported here rather than hidden; see the ETL run report for the full before/after breakdown.
#
# CRITICAL, deliberately UNCHANGED (verified by testing, not enforced by code): buggy, bug,
# broken, crash(es), boring, bored, tedious, grindy, refund, waste, disappointing, unplayable,
# garbage, trash, lag(gy), unfinished, unoptimized, terrible, awful, worst, clunky, janky,
# unresponsive, mediocre, ripoff, scam, unfair, confusing -- genuine quality complaints, including
# several (e.g. "unfair", an explicit Difficulty keyword right next to "brutal"/"hard") that sit
# immediately next to words this dict does neutralize.
GAMING_LEXICON_OVERRIDES = {
    # --- Genre / setting descriptors: neutralize (horror-genre words VADER reads as negative
    # sentiment, but which describe WHAT the game is, not whether it's good) ---
    "horror": 0.0, "terror": 0.0, "terrifying": 0.0, "scary": 0.0, "creepy": 0.0, "spooky": 0.0,
    "eerie": 0.0, "dread": 0.0, "dreadful": 0.0, "nightmare": 0.0, "nightmares": 0.0,
    "haunting": 0.0, "disturbing": 0.0, "sinister": 0.0, "ominous": 0.0, "macabre": 0.0,
    "grim": 0.0, "dark": 0.0, "darkness": 0.0, "evil": 0.0, "demon": 0.0, "demonic": 0.0,
    "demons": 0.0, "monster": 0.0, "monsters": 0.0, "creature": 0.0, "creatures": 0.0,
    "zombie": 0.0, "zombies": 0.0, "blood": 0.0, "bloody": 0.0, "gore": 0.0, "gory": 0.0,
    "death": 0.0, "dead": 0.0, "kill": 0.0, "killing": 0.0, "murder": 0.0,
    "insane": 0.0, "insanity": 0.0, "sanity": 0.0, "madness": 0.0, "mad": 0.0, "crazy": 0.0,
    "cthulhu": 0.0, "lovecraftian": 0.0, "occult": 0.0, "cursed": 0.0, "curse": 0.0,
    "omen": 0.0, "doom": 0.0, "hell": 0.0, "apocalypse": 0.0, "sacrifice": 0.0,

    # --- Difficulty descriptors: neutralize (players use these as PRAISE for a well-tuned
    # challenge; VADER reads them as complaints). NOT touched: "unfair" -- an explicit
    # ASPECT_LEXICON Difficulty keyword, but a genuine complaint (badly balanced), not a genre/
    # intensity descriptor; "challenge(s)/challenging" -- already correctly positive in VADER
    # (+0.3/+0.6) at baseline, nothing to fix. ---
    "brutal": 0.0, "brutally": 0.0, "punishing": 0.0, "unforgiving": 0.0, "relentless": 0.0,
    "merciless": 0.0, "savage": 0.0, "ruthless": 0.0, "hardcore": 0.0, "grueling": 0.0,
    "hard": 0.0, "hardest": 0.0, "difficult": 0.0, "difficulty": 0.0, "tough": 0.0,

    # --- "mess"/"chaos": see the -0.6 rationale above. "chaos"/"chaotic" have no equivalent
    # required-guard conflict, so they go to the clean 0.0 the rest of this dict uses. ---
    "mess": -0.6,
    "chaos": 0.0, "chaotic": 0.0,

    # --- Combat & Bosses aspect keywords: same bug class, found by auditing ASPECT_LEXICON's own
    # keyword tokens against the baseline lexicon -- "combat"/"fight(s)"/"fighting" are baseline-
    # negative even though they're literally the aspect's topic, not a quality judgment. Not in
    # the task's original word list but the identical failure mode. ---
    "combat": 0.0, "fight": 0.0, "fights": 0.0, "fighting": 0.0, "dodging": 0.0,

    # --- Horror-mood descriptors, found by testing: same class as dread/eerie/haunting above
    # ("nails the dread and tension" is praise for atmosphere, not a complaint). ---
    "tension": 0.0, "tense": 0.0,

    # --- Positive gaming terms VADER lacks or misreads ---
    "immersive": 1.5, "atmospheric": 1.0, "addictive": 1.0, "addicting": 1.0,
    "replayable": 1.0, "meaty": 1.0, "sick": 1.5, "epic": 1.0,
    # "killer" (slang praise, "a killer soundtrack") found by testing -- same VADER-reads-slang-
    # as-violence pattern as "sick", which was called out by name. Kept more moderate than
    # sick/immersive since "killer" more often keeps a literal negative sense in context ("a
    # killer bug", "a killer difficulty spike") than "sick" does in gaming text.
    "killer": 1.0,
}

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

# --------------------------------------------------------------------------------------
# Entity marts (mart_entity.sql) — corporate-suffix re-merge for the developers/publishers
# comma-split. mart_game.developers/publishers are comma-JOINED strings, and corporate
# names themselves contain commas: "Some Studio, Inc." naively splits into "Some Studio" +
# "Inc.", which made "Inc." the #2 publisher on Steam (916 games on the real catalog)
# before this fix. After splitting on ',', any trimmed token whose lower() matches this
# set is re-merged into the preceding token as ", <suffix>" (chains like "X, Co., Ltd."
# work — see mart_entity.sql).
#
# Tunable, EVIDENCE-BASED list — built by inspecting the real catalog's standalone
# comma-split tokens (counts below are standalone-token occurrences across both roles on
# the 2026-07-30 mart). Matching is on lower(trim(token)), which is why "INC."/"LTD."/
# "llc" variants collapse into one entry each.
ENTITY_CORP_SUFFIXES = [
    # US/UK-style incorporation suffixes — the overwhelming bulk of the bug:
    "inc.",          # 1,791 standalone tokens ("...Studio, Inc." / ", INC.")
    "inc",           #   162
    "incorporated",  #     4 ("Dream Garage, Incorporated")
    "llc",           # 1,428
    "llc.",          #    76
    "l.l.c.",        #    16
    "llp",           #     2 ("Blood Oath Games, LLP")
    "ltd.",          # 1,663
    "ltd",           #   525
    "limited",       #    35 ("Interactive Tragedy, Limited", "...CO., LIMITED")
    "pte. ltd.",     #     1 (Singapore; "Pte. Ltd." is ONE token — no inner comma)
    "co.",           #    10 (chain case: "Thirdverse, Co., Ltd.")
    "co",            #     0 today — kept as a cheap guard; bare ", Co" never occurs in
                     #       this catalog ("Yak & Co" etc. have no comma so never split)
    "co. ltd.",      #     0 today — same guard ("X Co., Ltd." splits to "X Co." + "Ltd.",
                     #       already handled; this catches a hypothetical "X, Co. Ltd.")
    "corp",          #     1
    "corp.",         #     3
    # European legal forms with real comma-suffix usage in this catalog:
    "s.r.o.",        #    19 (Czech/Slovak)
    "s.l.",          #    12 (Spanish — "Tequila Works, S.L.")
    "a.s.",          #     9 (Czech — "MADFINGER Games, a.s.")
    "s.a.",          #     3 ("Psion Tech, S.A.")
    "s.c.",          #     2 ("Vertex Games, S.C.")
    "d.o.o.",        #     2 (Balkan — "SubRealityStudio,d.o.o.")
    # DELIBERATELY EXCLUDED, from the same evidence pass:
    #   "gmbh"  — always attached without a comma ("Daedalic Entertainment GmbH"); zero
    #             standalone comma-tokens, so including it only adds false-positive risk.
    #   "s.a." IS included but "sa"/"ab"/"as"/"oy" (bare Nordic/European forms) are NOT:
    #             they appear almost exclusively as WHOLE-FIELD standalone names ("AB",
    #             "as" — 5-6 rows each), and "kk" is a real developer NAME in the list
    #             "Utayo,KK,9lock" — merging would corrupt real multi-dev lists. The one
    #             legit ", AB" row ("Underground Alien Studios, AB") is the cost.
    #             ("Gamatron AB" has no comma and is never split — unaffected.)
]
# JTBD — tag-combination lift (see mart_tag_lift.sql; runs LAST in MART_FILES so it can
# read mart_game.top_tags and mart_niche's solo-tag baselines instead of re-deriving them).
TAG_PAIR_MIN_GAMES = 15           # an unordered tag PAIR needs >= this many qualifying games
                                  # (total_reviews >= MIN_REVIEWS_DEFAULT) to be kept — a
                                  # median over fewer games is noise, not signal (mirrors
                                  # MIN_NICHE_GAMES's role at the pair grain, floored lower
                                  # because pairs slice the population much thinner).

MART_FILES = [
    "mart_players.sql",  # FIRST on purpose: reads only staging (stg_player_counts_daily,
                         # stg_player_count_latest, stg_game, stg_tag/genre_membership) and
                         # creates TEMP summary tables (_game_players_summary,
                         # _niche_players_now) that mart_game.sql and mart_niche.sql join —
                         # so it must precede both. TEMPs persist across files (one connection).
    "mart_game.sql",
    "mart_entity.sql",   # reads ONLY mart_game (+ the entity_suffix temp table) — must
                         # come anywhere after mart_game.sql; kept adjacent since it's
                         # a direct normalization of mart_game's entity strings.
    "mart_niche.sql",
    "mart_market.sql",
    "mart_seasonality.sql",
    "mart_launch_curve.sql",
    "mart_timing.sql",   # Launch & Timing rework: demand/congestion/decay over the TRUE
                         # monthly review histograms (stg_review_histogram — guarded
                         # staging, empty marts on sources without `review_histogram`).
                         # Additive: mart_seasonality/mart_launch_curve stay for their
                         # existing consumers.
    "mart_game_reviews.sql",
    "mart_game_trends.sql",
    "mart_lang.sql",
    "mart_game_teardown.sql",
    "mart_game_aspect_reviews.sql",
    "mart_press.sql",
    "mart_creator_pitch.sql",
    "mart_channel_mix.sql",
    "mart_channel_buzz.sql",
    # These two are LAST on purpose: they read marts built above (mart_game, mart_niche,
    # mart_game_review_aspects, mart_genre_aspect_baseline) rather than staging tables.
    # They are independent of each other.
    "mart_tag_lift.sql",
    "mart_niche_themes.sql",
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
        "ASPECT_SENTENCE_CHARS": ASPECT_SENTENCE_CHARS,
        "ASPECT_WINDOW_SLICE_BEFORE": ASPECT_WINDOW_SLICE_BEFORE,
        "ASPECT_WINDOW_SLICE_CHARS": ASPECT_WINDOW_SLICE_CHARS,
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
        "GATE_FLOOR": GATE_FLOOR,
        "GATE_SAT_FULL_DECLINE": GATE_SAT_FULL_DECLINE,
        "GATE_ENTRANT_FULL": GATE_ENTRANT_FULL,
        "UMBRELLA_N_GAMES": UMBRELLA_N_GAMES,
        "CURVE_MIN_REVIEWS": CURVE_MIN_REVIEWS,
        "CURVE_MIN_GAMES": CURVE_MIN_GAMES,
        "TIMING_DEMAND_YEARS": TIMING_DEMAND_YEARS,
        "TIMING_LAUNCH_EXCLUDE_MONTHS": TIMING_LAUNCH_EXCLUDE_MONTHS,
        "TIMING_DEMAND_MIN_GAMES": TIMING_DEMAND_MIN_GAMES,
        "TIMING_CONGESTION_YEARS": TIMING_CONGESTION_YEARS,
        "TIMING_BIG_REV": TIMING_BIG_REV,
        "TIMING_DECAY_MONTHS": TIMING_DECAY_MONTHS,
        "TIMING_DECAY_LAST": TIMING_DECAY_MONTHS - 1,
        "TIMING_DECAY_MIN_REVIEWS": TIMING_DECAY_MIN_REVIEWS,
        "TIMING_DECAY_MIN_GAMES": TIMING_DECAY_MIN_GAMES,
        "TOP_TAGS_PER_GAME": TOP_TAGS_PER_GAME,
        "GAME_DETAIL_MIN_REVIEWS": GAME_DETAIL_MIN_REVIEWS,
        "LANG_TOP_N": LANG_TOP_N,
        "TEARDOWN_MIN_REVIEWS": TEARDOWN_MIN_REVIEWS,
        "TEARDOWN_MIN_GENRE_GAMES": TEARDOWN_MIN_GENRE_GAMES,
        "PRESS_MIN_CONFIDENCE": PRESS_MIN_CONFIDENCE,
        "PRESS_NOTABLE_N": PRESS_NOTABLE_N,
        "ASPECT_REVIEWS_TOP_K": ASPECT_REVIEWS_TOP_K,
        "NICHE_THEMES_MIN_GAMES": NICHE_THEMES_MIN_GAMES,
        "PRESS_AUTHOR_MIN_ARTICLES": PRESS_AUTHOR_MIN_ARTICLES,
        "BUZZ_TOTAL_MONTHS": BUZZ_TOTAL_MONTHS,
        "BUZZ_RECENT_MONTHS": BUZZ_RECENT_MONTHS,
        "BUZZ_MIN_TOTAL_MENTIONS": BUZZ_MIN_TOTAL_MENTIONS,
        "BUZZ_SLOPE_EPSILON": BUZZ_SLOPE_EPSILON,
        "CREATOR_MIN_CONFIDENCE": CREATOR_MIN_CONFIDENCE,
        "CREATOR_PITCH_MIN_MENTIONS": CREATOR_PITCH_MIN_MENTIONS,
        "TAG_PAIR_MIN_GAMES": TAG_PAIR_MIN_GAMES,
        "CCU_STALE_DAYS": CCU_STALE_DAYS,
        "CCU_FRESH_DAYS": CCU_FRESH_DAYS,
        "PLAYERS_TREND_DAYS": PLAYERS_TREND_DAYS,
        "PLAYERS_TREND_DAYS_X2": PLAYERS_TREND_DAYS * 2,
        "PLAYERS_HISTORY_DAYS": PLAYERS_HISTORY_DAYS,
        "NICHE_PLAYERS_MIN_MEASURED": NICHE_PLAYERS_MIN_MEASURED,
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
    # Corporate-suffix tokens for the developers/publishers comma-split re-merge (see
    # ENTITY_CORP_SUFFIXES above; consumed by mart_entity.sql via lower(trim(token))).
    con.execute("CREATE TEMP TABLE entity_suffix(token VARCHAR)")
    con.executemany("INSERT INTO entity_suffix VALUES (?)", [(s,) for s in ENTITY_CORP_SUFFIXES])
    # Curated tag tiers (niche-score v2) — read by mart_niche.sql; unmapped tags fall back
    # to the UMBRELLA_N_GAMES size heuristic there.
    con.execute("CREATE TEMP TABLE tag_tier(tag VARCHAR, tier VARCHAR)")
    con.executemany("INSERT INTO tag_tier VALUES (?, ?)", list(TAG_TIER.items()))

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

        -- Niche-score v2 fallback for is_singleplayer (see stg_game below): games carrying
        -- the 'Singleplayer' community tag anywhere in the FULL game_tags table — no vote/
        -- rank floor, deliberately unlike stg_tag_membership, because this is a coverage
        -- signal ("is the game playable solo at all?"), not a niche-membership signal.
        -- Only consulted when the game's raw Steam `categories` field is missing/empty
        -- (~0.6 percent of the catalog); Steam's own category list wins whenever present.
        CREATE TEMP TABLE stg_singleplayer_tag AS
        SELECT DISTINCT gt.appid FROM src.game_tags gt WHERE gt.tag = 'Singleplayer';

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
            -- UNIVERSE = the LIVE `games` catalog (type='game', or an un-enriched stub with
            -- type still NULL), NOT the frozen one-off `analysis_games` table -- so every real
            -- Steam game shows in the app, even with no reviews/owners data yet. Better to show a
            -- game that's live and selling on Steam with blank stats than to hide it entirely
            -- (which is what basing the universe on the stale analysis_games did: no discovered
            -- game ever appeared). analysis_games is LEFT JOINed for its richer SteamSpy-derived
            -- aggregates where present; games without it fall back to raw appdetails columns and
            -- carry NULL/0 for the analysis-only fields (owners, playtime, self_published, ...).
            SELECT
                g.appid, COALESCE(ag.name, g.name) AS name,
                -- Release date: analysis_games' ISO date where present, else parse the raw
                -- appdetails string on the live games row ("Jul 30, 2026" / "30 Jul, 2026").
                -- analysis_games is a frozen one-off snapshot, so EVERY game released after
                -- it would otherwise carry NULL release_date/year forever (found via appid
                -- 4108000, released Jul 30 2026: reviews/price flowed through their own
                -- fallbacks below while the date stayed blank). Placeholders ("Q3 2026",
                -- "Coming soon") don't parse -> NULL, which release_valid already guards.
                COALESCE(
                    ag.release_year,
                    EXTRACT(year FROM try_strptime(g.release_date,
                        ['%b %d, %Y', '%d %b, %Y', '%B %d, %Y', '%d %B, %Y']))
                ) AS release_year,
                COALESCE(
                    TRY_CAST(ag.release_date_iso AS DATE),
                    CAST(try_strptime(g.release_date,
                        ['%b %d, %Y', '%d %b, %Y', '%B %d, %Y', '%d %B, %Y']) AS DATE)
                ) AS release_date,
                -- SteamSpy price, falling back to Steam's own appdetails price (games.price_initial,
                -- stored in cents) for brand-new games SteamSpy hasn't indexed yet -- so revenue
                -- estimates immediately instead of stranding a blank $ on every fresh release.
                COALESCE(ag.price_initial, g.price_initial / 100.0) AS price_initial,
                COALESCE(ag.is_free, g.is_free) AS is_free,
                COALESCE(ag.developers, g.developers) AS developers,
                COALESCE(ag.publishers, g.publishers) AS publishers,
                ag.self_published, ag.dev_game_count, ag.is_indie,
                COALESCE(ag.metacritic_score, g.metacritic_score) AS metacritic_score,
                COALESCE(ag.achievements_count, g.achievements_count) AS achievements_count,
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
            FROM src.games g
            LEFT JOIN src.analysis_games ag ON ag.appid = g.appid
            LEFT JOIN stg_reviews_agg ra ON ra.appid = g.appid
            LEFT JOIN src.review_summary rs ON rs.appid = g.appid
            WHERE (g.type = 'game' OR g.type IS NULL) AND g.name IS NOT NULL AND g.name <> ''
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
            g.avg_playtime_forever, g.ccu, g.tag_count,
            -- Niche-score v2: is this game playable single-player? PRIMARY source: Steam's
            -- own `categories` field (raw comma-separated appdetails list, e.g.
            -- 'Single-player,Multi-player,...'), matched as an exact trimmed token so
            -- 'Single-player' can never false-positive on another category (verified: no
            -- other category token contains the substring). FALLBACK (categories missing/
            -- empty only): the game carries the 'Singleplayer' community tag anywhere in
            -- the full game_tags table (stg_singleplayer_tag above). NOTE: Steam's checkbox
            -- means "has any solo-playable mode" — an online-only extraction shooter with a
            -- solo queue may still set it, so niche-level shares (solo_viability) are read
            -- RELATIVE to the ~0.9 catalog norm, not as an absolute guarantee.
            COALESCE(
                CASE WHEN cg.categories IS NOT NULL AND trim(cg.categories) <> ''
                     THEN list_contains(list_transform(string_split(cg.categories, ','), x -> trim(x)), 'Single-player')
                END,
                sp.appid IS NOT NULL
            ) AS is_singleplayer
        FROM _stg_game_reconciled g
        JOIN genre_pick gp ON gp.appid = g.appid
        LEFT JOIN src.games cg ON cg.appid = g.appid
        LEFT JOIN stg_singleplayer_tag sp ON sp.appid = g.appid;

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
    """Live concurrent-player staging from the scraper's `player_counts` table
    (steam_players_bulk.py — keyless GetNumberOfCurrentPlayers snapshots). Guarded exactly like
    create_marketing_staging(): builds real staging when the table exists, else empty typed
    tables so downstream marts never crash on an older source DB. Two tables:

      stg_player_count_latest — newest snapshot per game (mart_game.live_players);
      stg_player_counts_daily — one row per (appid, UTC capture date): the LAST capture of the
          day (max_by), i.e. a stable evening point sample at the nightly ~21-22:00 UTC sweep —
          deliberately NOT a daily peak. Feeds mart_players.sql (daily/niche series).

    This is REAL live traction, distinct from SteamSpy's stale daily-peak stg_game.ccu."""
    if _sqlite_table_exists(con, "player_counts"):
        con.execute(
            """
            CREATE TEMP TABLE stg_player_count_latest AS
            SELECT appid, live_players, captured_at FROM (
                SELECT appid, player_count AS live_players, captured_at,
                    row_number() OVER (PARTITION BY appid ORDER BY captured_at DESC) AS rn
                FROM src.player_counts
            ) WHERE rn = 1;

            CREATE TEMP TABLE stg_player_counts_daily AS
            SELECT appid,
                CAST(TRY_CAST(captured_at AS TIMESTAMP) AS DATE) AS cap_date,
                max_by(player_count, TRY_CAST(captured_at AS TIMESTAMP)) AS players,
                COUNT(*) AS n_captures
            FROM src.player_counts
            WHERE TRY_CAST(captured_at AS TIMESTAMP) IS NOT NULL AND player_count IS NOT NULL
            GROUP BY 1, 2;
            """
        )
        return True
    con.execute("CREATE TEMP TABLE stg_player_count_latest (appid INTEGER, live_players INTEGER, captured_at TIMESTAMP)")
    con.execute("CREATE TEMP TABLE stg_player_counts_daily (appid INTEGER, cap_date DATE, players INTEGER, n_captures INTEGER)")
    return False


def create_timing_staging(con: duckdb.DuckDBPyConnection) -> bool:
    """TRUE monthly review counts per game from the scraper's `review_histogram` table
    (Steam's own per-month review-graph totals — uncapped, unlike the sampled `reviews`
    table; covers every game with >=50 total reviews, ~40K appids). Guarded exactly like
    create_marketing_staging()/create_ccu_staging(): builds stg_review_histogram when the
    table exists, else an empty typed table so mart_timing.sql builds empty marts (never
    crashes) on an older source DB. n_reviews = up + down votes — demand is measured as
    review-WRITING velocity regardless of verdict."""
    if _sqlite_table_exists(con, "review_histogram"):
        con.execute(
            """
            CREATE TEMP TABLE stg_review_histogram AS
            SELECT rh.appid,
                CAST(rh.period || '-01' AS DATE) AS period_month,
                COALESCE(rh.recommendations_up, 0) + COALESCE(rh.recommendations_down, 0) AS n_reviews
            FROM src.review_histogram rh
            WHERE rh.period IS NOT NULL;
            """
        )
        return True
    con.execute("CREATE TEMP TABLE stg_review_histogram (appid INTEGER, period_month DATE, n_reviews BIGINT)")
    return False


_ANALYZER = None


def _get_analyzer():
    """Lazily build (and cache) a single VADER analyzer — loads its bundled lexicon file once, no
    network, then applies GAMING_LEXICON_OVERRIDES on top (see the block above) so both
    compute_aspect_sentiment (review text) and compute_press_sentiment (article text) score
    through the SAME domain-tuned lexicon, by construction (they both call this one cached
    instance) rather than by keeping two separately-patched analyzers in sync by hand. Raises a
    clear error if the (pinned) dependency is missing."""
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
        _ANALYZER.lexicon.update(GAMING_LEXICON_OVERRIDES)
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


def _aspect_sentence_regex(rx: str) -> str:
    """Wrap an aspect keyword regex so the overall match is the sentence/clause around the FIRST
    occurrence of the keyword: up to ASPECT_SENTENCE_CHARS characters on each side, stopped early
    by a sentence/clause boundary (. ! ? ; or newline -- RE2 char class [^.!?;\\n]) if one comes
    first. `rx` is wrapped in a non-capturing group so this is safe regardless of rx's own
    internal grouping/alternation shape.

    This exact shape (same ASPECT_SENTENCE_CHARS cap, same rx text) is ALSO rendered into
    mart_game_aspect_reviews.sql's excerpt regex, by string-concatenating the @ASPECT_SENTENCE_CHARS@
    and @RX_*@ placeholders directly inside a SQL string literal (see build_params()/render()) --
    so the VADER-scored window (here) and the excerpt shown to users (there) can never drift
    apart: it's the same pattern run by the same DuckDB/RE2 engine over the same review_text,
    not two numbers kept in sync by hand."""
    return rf"[^.!?;\n]{{0,{ASPECT_SENTENCE_CHARS}}}(?:{rx})[^.!?;\n]{{0,{ASPECT_SENTENCE_CHARS}}}"


def _aspect_keyword_position_regex(rx: str) -> str:
    """Wrap an aspect keyword regex to capture (group 1) everything in review_text BEFORE the
    FIRST match -- length() of that capture is the match's 1-indexed start position, used to slice
    a small window around it (see ASPECT_WINDOW_SLICE_BEFORE/CHARS and _aspect_window_sql above).

    Deliberately NOT strpos() on the bare matched keyword text: strpos is a plain substring search
    with no notion of rx's own \\b word-boundary anchors, so for a short keyword like "art" or
    "hard" it can (and on real review text, does) find an EARLIER false position embedded inside
    an unrelated word ("start", "hardware") that the \\b-anchored regex itself would never match
    there. This capture uses the exact same regex/engine/leftmost-match semantics as the real
    match, so it can't disagree with it.

    `[\\s\\S]` (matches ANY character), not `.`: RE2's `.` does not match newline by default, and
    review text routinely has embedded newlines before the first aspect keyword -- with a plain
    `.*?`, the capture would fail to cross them and silently fall back to position 1, corrupting
    the downstream slice."""
    return rf"^([\s\S]*?)(?:{rx})"


def _aspect_window_sql(pool: str) -> str:
    """One row per (review, aspect) mention: the sentence/clause-bounded text window (see
    _aspect_sentence_regex) scored for sentiment. Built entirely in DuckDB (regexp_extract of the
    whole match -- group 0) from the ASPECT_LEXICON single source of truth, so it can never drift
    from the vote flags / excerpt window. Same 10-arm shape as mart_game_teardown.sql's
    _review_aspect_flags, but emitting a row per match (with recommendationid, so
    mart_game_aspect_reviews.sql can join each excerpt to its sentiment) rather than a boolean
    column.

    PERFORMANCE (see the ASPECT_WINDOW_SLICE_BEFORE/CHARS comment above): the sentence regex runs
    on a small substr slice around the first keyword match's position (an inner subquery computes
    that position once via _aspect_keyword_position_regex), not the whole review_text -- output is
    byte-identical, but the expensive pattern scans ~ASPECT_WINDOW_SLICE_CHARS characters instead
    of the full review body. One extra wrinkle beyond a plain substr: when the slice doesn't start
    at the review's true beginning, its first few characters can be the TAIL of a word that was
    truncated mid-word by the cut (e.g. slicing into "...for the most p|art you're..." at the `|`
    leaves "art you're..." at the slice's start) -- and because a \\b boundary is satisfied at the
    very start of ANY string, the sentence regex can then wrongly treat that fragment as a
    standalone keyword match it would never have matched in the original, unsliced text. Stripped
    with a `^\\S+` regexp_replace (only when the slice doesn't start at position 1, where there's
    nothing to truncate) before the sentence regex ever sees it -- found and fixed via the
    byte-identical-output check against real review text (see the ETL run report), not by
    inspection."""
    arms = []
    for label, _placeholder, rx in ASPECT_LEXICON:
        rxe = rx.replace("'", "''")  # SQL single-quote escape (none today, but be safe)
        sent_e = _aspect_sentence_regex(rx).replace("'", "''")
        pos_e = _aspect_keyword_position_regex(rx).replace("'", "''")
        label_e = label.replace("'", "''")
        arms.append(
            f"""
        SELECT appid, recommendationid, '{label_e}' AS aspect,
            regexp_extract(
                CASE WHEN kw_pos - {ASPECT_WINDOW_SLICE_BEFORE} > 1
                     THEN regexp_replace(
                              substr(review_text, kw_pos - {ASPECT_WINDOW_SLICE_BEFORE}, {ASPECT_WINDOW_SLICE_CHARS}),
                              '^\\S+', '')
                     ELSE substr(review_text, 1, {ASPECT_WINDOW_SLICE_CHARS})
                END,
                '{sent_e}', 0, 'i'
            ) AS window_text
        FROM (
            SELECT appid, recommendationid, review_text,
                length(regexp_extract(review_text, '{pos_e}', 1, 'i')) + 1 AS kw_pos
            FROM {pool}
            WHERE regexp_matches(review_text, '{rxe}', 'i')
        )"""
        )
    return "\nUNION ALL\n".join(arms)


def _sentiment_cache_enabled() -> bool:
    """Kill-switch: PROSPECT_SENTIMENT_CACHE=off (or =0) disables the cache entirely — no ATTACH,
    no cache reads/writes, every run does a full rescore exactly as it did before this feature
    existed. Unset, or any other value, leaves the cache on (the default)."""
    return os.environ.get("PROSPECT_SENTIMENT_CACHE", "").strip().lower() not in ("off", "0")


def _sentiment_config_hash() -> str:
    """Hash of every knob that can change what a cached score's VALUE would be: the aspect keyword
    lexicon, the gaming-domain VADER overrides applied in _get_analyzer(), the sentence/window
    sizing, the pos/neg classification thresholds, plus a manually-bumpable version escape hatch.
    Any edit to any of these changes the hash — _refresh_sentiment_cache wipes the cache whenever
    the stored hash disagrees with this one, so a lexicon/window/threshold change can't silently
    keep serving scores computed under the old config.

    Deliberately NOT hashed: TEARDOWN_MIN_REVIEWS and the other eligibility floors that decide
    which reviews/articles are IN SCOPE this run — those don't change what an already-scored
    mention's compound IS, and _sent_pool/_press_score_set are recomputed fresh every run
    regardless of the cache, so a floor change is picked up automatically."""
    payload = "\n".join([
        f"version={SENTIMENT_CACHE_VERSION}",
        f"aspect_lexicon={ASPECT_LEXICON!r}",
        f"gaming_overrides={sorted(GAMING_LEXICON_OVERRIDES.items())!r}",
        f"sentence_chars={ASPECT_SENTENCE_CHARS!r}",
        f"slice_before={ASPECT_WINDOW_SLICE_BEFORE!r}",
        f"slice_chars={ASPECT_WINDOW_SLICE_CHARS!r}",
        f"pos_threshold={SENTIMENT_POS_THRESHOLD!r}",
        f"neg_threshold={SENTIMENT_NEG_THRESHOLD!r}",
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _attach_sentiment_cache(con: duckdb.DuckDBPyConnection, data_dir: Path) -> Path:
    """ATTACH the persistent, cross-run sentiment cache read-write as `cache`, creating its file
    and/or tables on first use. Caller MUST _detach_sentiment_cache() when done — both compute_*
    functions do this in a try/finally, since DuckDB holds a write lock on an attached file for as
    long as it stays attached, and a second ATTACH of the same path (e.g. the next compute_*
    call, or a re-run in the same process) would otherwise fail."""
    cache_path = Path(data_dir) / SENTIMENT_CACHE_DB_NAME
    con.execute(f"ATTACH '{cache_path}' AS cache")
    con.execute(
        "CREATE TABLE IF NOT EXISTS cache.aspect_mention("
        "recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE)"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS cache.press_article(article_id BIGINT, compound DOUBLE)"
    )
    con.execute("CREATE TABLE IF NOT EXISTS cache.meta(key VARCHAR, value VARCHAR)")
    return cache_path


def _detach_sentiment_cache(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("DETACH cache")


def _refresh_sentiment_cache(con: duckdb.DuckDBPyConnection) -> bool:
    """Wipe both cache tables when the scoring config changed since they were last populated (or
    when they're empty/newly created) — makes a lexicon/window/threshold edit, or a
    SENTIMENT_CACHE_VERSION bump, force a full rescore instead of silently serving stale scores
    computed under a different config. Returns True iff it invalidated (callers log that)."""
    current = _sentiment_config_hash()
    row = con.execute("SELECT value FROM cache.meta WHERE key = 'config_hash'").fetchone()
    if row is not None and row[0] == current:
        return False
    con.execute("DELETE FROM cache.aspect_mention")
    con.execute("DELETE FROM cache.press_article")
    con.execute("DELETE FROM cache.meta WHERE key = 'config_hash'")
    con.execute("INSERT INTO cache.meta VALUES ('config_hash', ?)", [current])
    return True


def compute_aspect_sentiment(con: duckdb.DuckDBPyConnection, data_dir: Path) -> int:
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

    INCREMENTAL (2026-07): reviews are immutable and a (recommendationid, aspect) mention's score
    never changes once computed, so this ATTACHes a persistent cross-run cache (see
    _attach_sentiment_cache) at {data_dir}/sentiment_cache.duckdb, runs the expensive
    _aspect_window_sql regex + VADER ONLY over recommendationids not already represented in
    cache.aspect_mention, and builds stg_aspect_mention_sentiment by joining the full in-scope
    pool back against the cache (old + newly-scored rows alike) — everything downstream is
    unchanged, it just reads that table exactly as before. A run with nothing new to score still
    pays for the (cheap) pool/eligibility query, but none of the regex/VADER work. Disable
    entirely with PROSPECT_SENTIMENT_CACHE=off — full rescore every run, cache file untouched (see
    _sentiment_cache_enabled).

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

    if not _sentiment_cache_enabled():
        # Original, uncached path: score the WHOLE pool every run.
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
    else:
        _attach_sentiment_cache(con, data_dir)
        try:
            if _refresh_sentiment_cache(con):
                print("[etl] sentiment cache: config/version changed -> cache cleared, full rescore")

            # _new = pool reviews not yet represented in the cache AT ALL. Invariant this relies
            # on (maintained by construction below — every recommendationid selected into _new in
            # a given run gets every aspect row it matches inserted in that same run): a cached
            # recommendationid always carries ALL of the aspect rows it ever matched, never a
            # partial subset — so "no row in cache.aspect_mention" is exactly "needs (re)scoring",
            # with no risk of mistaking a review that simply matched zero aspects for "cached"
            # (it has no cache row either, so it's correctly retried — cheap, since the vast
            # majority of reviews match at least one of the 10 broad aspect arms).
            con.execute("DROP TABLE IF EXISTS _sent_new")
            con.execute(
                """
                CREATE TEMP TABLE _sent_new AS
                SELECT p.appid, p.recommendationid, p.review_text
                FROM _sent_pool p
                WHERE p.recommendationid NOT IN (
                    SELECT recommendationid FROM cache.aspect_mention WHERE recommendationid IS NOT NULL
                )
                """
            )
            n_new_reviews = con.execute("SELECT COUNT(*) FROM _sent_new").fetchone()[0]

            # The expensive regex now runs ONLY over the delta (_sent_new), not the full pool.
            # REGULAR (not TEMP) so the independent read cursor in _stream_vader_scores can see
            # it; dropped after scoring so it never ships in the versioned .duckdb.
            con.execute("DROP TABLE IF EXISTS _sent_windows")
            con.execute(f"CREATE TABLE _sent_windows AS {_aspect_window_sql('_sent_new')}")

            n_new_mentions = _stream_vader_scores(
                con,
                "SELECT recommendationid, aspect, window_text FROM _sent_windows",
                "INSERT INTO cache.aspect_mention VALUES (?, ?, ?)",
            )
            con.execute("DROP TABLE IF EXISTS _sent_windows")
            con.execute("DROP TABLE IF EXISTS _sent_new")

            # Full in-scope set, read back from the cache (untouched old rows + just-inserted new
            # ones alike). Same shape/columns as the uncached branch above.
            con.execute(
                """
                CREATE TEMP TABLE stg_aspect_mention_sentiment AS
                SELECT p.appid, m.recommendationid, m.aspect, m.compound
                FROM cache.aspect_mention m
                JOIN _sent_pool p ON p.recommendationid = m.recommendationid
                """
            )
            n_scored = con.execute("SELECT COUNT(*) FROM stg_aspect_mention_sentiment").fetchone()[0]
            print(f"[etl] aspect sentiment cache: {n_new_reviews:,} new review(s) scored "
                  f"({n_new_mentions:,} new mention rows); {n_scored:,} mention rows in scope total")
        finally:
            _detach_sentiment_cache(con)

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


def compute_press_sentiment(con: duckdb.DuckDBPyConnection, data_dir: Path) -> int:
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
    when it aggregates, so we score every mentioned article once here regardless of confidence.

    INCREMENTAL (2026-07): same cache as compute_aspect_sentiment (see its docstring), keyed by
    article_id instead of recommendationid — articles are immutable too, so a scored article_id's
    compound never changes. PROSPECT_SENTIMENT_CACHE=off disables it (full rescore, no cache
    file touched)."""
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

    if not _sentiment_cache_enabled():
        # Original, uncached path: score every in-scope article every run.
        con.execute("CREATE TEMP TABLE stg_press_article_sentiment(article_id INTEGER, compound DOUBLE)")
        n = _stream_vader_scores(
            con,
            "SELECT article_id, text FROM _press_score_set",
            "INSERT INTO stg_press_article_sentiment VALUES (?, ?)",
        )
        con.execute("DROP TABLE IF EXISTS _press_score_set")
        return n

    _attach_sentiment_cache(con, data_dir)
    try:
        if _refresh_sentiment_cache(con):
            print("[etl] sentiment cache: config/version changed -> cache cleared, full rescore")

        # _press_new = in-scope articles not yet in the cache. REGULAR (not TEMP) so the
        # independent read cursor in _stream_vader_scores can see it.
        con.execute("DROP TABLE IF EXISTS _press_new")
        con.execute(
            """
            CREATE TABLE _press_new AS
            SELECT s.article_id, s.text
            FROM _press_score_set s
            WHERE s.article_id NOT IN (
                SELECT article_id FROM cache.press_article WHERE article_id IS NOT NULL
            )
            """
        )
        n_new_articles = con.execute("SELECT COUNT(*) FROM _press_new").fetchone()[0]

        _stream_vader_scores(
            con,
            "SELECT article_id, text FROM _press_new",
            "INSERT INTO cache.press_article VALUES (?, ?)",
        )
        con.execute("DROP TABLE IF EXISTS _press_new")

        # Full in-scope set, read back from the cache (untouched old rows + just-inserted new
        # ones alike). Same shape/columns as the uncached branch above.
        con.execute(
            """
            CREATE TEMP TABLE stg_press_article_sentiment AS
            SELECT s.article_id, c.compound
            FROM cache.press_article c
            JOIN _press_score_set s ON s.article_id = c.article_id
            """
        )
        n = con.execute("SELECT COUNT(*) FROM stg_press_article_sentiment").fetchone()[0]
        print(f"[etl] press sentiment cache: {n_new_articles:,} new article(s) scored; "
              f"{n:,} articles in scope total")
    finally:
        _detach_sentiment_cache(con)

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
    # CCU coverage at a glance (mart_players.sql runs before write_meta, so both exist —
    # zero on sources without player_counts).
    ccu_panel_games = con.execute("SELECT COUNT(*) FROM _pl_panel").fetchone()[0]
    ccu_history_days = con.execute(
        "SELECT COUNT(DISTINCT date) FROM mart_game_players_daily"
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
        "opportunity_v2_gate": (
            f"gate=1-(1-{GATE_FLOOR})*max(sat_severity,entrant_severity); "
            f"sat_full_decline={GATE_SAT_FULL_DECLINE},entrant_full={GATE_ENTRANT_FULL},"
            f"umbrella_n_games={UMBRELLA_N_GAMES}"
        ),
        "ccu_panel_games": str(ccu_panel_games),
        "ccu_history_days": str(ccu_history_days),
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

    # Build into a scratch file and only os.replace() it over the versioned name once the
    # build succeeds. A SAME-DAY rerun otherwise deletes and rebuilds the very file
    # current.duckdb points at, so the serving app and the ETL fight over a DuckDB file
    # lock — any app (re)start mid-build then crash-loops on "Conflicting lock is held"
    # (took the site down on 2026-08-04 after several manual same-day rebuilds). The
    # nightly never hits this only because each day gets a fresh filename; this makes
    # reruns safe regardless of restart timing. A failed/killed run leaves only a stale
    # .building file, which the next run removes — the served mart is never touched.
    building = data_dir / f"prospect_{mart_version}.duckdb.building"
    if building.exists():
        building.unlink()

    params = build_params()
    print(f"[etl] source     : {source_db}")
    print(f"[etl] output     : {versioned}")
    t0 = time.perf_counter()

    con = duckdb.connect(str(building))
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

        have_timing = create_timing_staging(con)
        print("[etl] review_histogram (true monthly review counts): "
              + ("found" if have_timing else "ABSENT — mart_timing_* will be empty"))

        if _sentiment_cache_enabled():
            print(f"[etl] sentiment cache  : {data_dir / SENTIMENT_CACHE_DB_NAME}")
        else:
            print("[etl] sentiment cache  : DISABLED (PROSPECT_SENTIMENT_CACHE=off) "
                  "-- full rescore every run, cache file untouched")

        print("[etl] scoring aspect text sentiment (VADER) ...")
        t_sent = time.perf_counter()
        n_sent = compute_aspect_sentiment(con, data_dir)
        print(f"[etl] aspect sentiment: scored {n_sent:,} aspect mentions "
              f"({time.perf_counter() - t_sent:.1f}s)")

        print("[etl] scoring press-coverage sentiment (VADER) ...")
        t_press = time.perf_counter()
        n_press = compute_press_sentiment(con, data_dir)
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

    # Land the finished build atomically over the versioned name (see the .building
    # comment above). os.replace is atomic on the same filesystem; if the app is serving
    # this same-day file, it keeps its open inode until the post-ETL restart.
    os.replace(building, versioned)

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
