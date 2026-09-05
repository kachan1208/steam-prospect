#!/usr/bin/env python
"""Prospect ETL — build DuckDB analytics marts from the read-only steam_games.db SQLite.

Attaches the SQLite source read-only, builds staging temp tables + the mart tables into a
versioned `data/prospect_<YYYYMMDD>.duckdb`, records build metadata, prints per-mart row
counts, then atomically repoints the `data/current.duckdb` symlink at the new file.

Why DuckDB: the marts lean on median()/quantile_cont()/percent_rank()/regr_slope() which
SQLite lacks. The SQLite source is opened READ_ONLY and never mutated.

Run:  python build_marts.py            (paths default relative to this file)
      python build_marts.py --source /path/to/steam_games.db --data-dir /path/to/data

Exit codes (deploy/prospect-refresh.sh treats any non-zero as "keep the previous mart"):
  0  built, validated and swapped
  1  the build FINISHED but the pre-swap validation gate refused the swap. current.duckdb is
     untouched and the finished artifact is KEPT at data/prospect_<version>.duckdb.building
     (its spill dir is not) — see the remedy the run prints; none of the options need a rebuild.
  2  refused before doing any work (missing source DB, missing aspect model, --light guard,
     contradictory flags such as --light with --fulltext build).

DEPLOY NOTE — the first build after the model-fingerprint change (2026-08). The sentiment
cache is keyed on a hash of the scoring config, which includes a fingerprint of
etl/aspect_model.json.gz. That fingerprint moved from size:mtime to a SHA-256 of the file's
CONTENT (see _aspect_model_fingerprint: an scp/checkout of the identical file used to wipe the
16M-row cache for nothing). Changing the fingerprint scheme changes the config hash's value
once, which would itself have forced a full ~16M-row rescore — hours — on the first build
after deploy. _refresh_sentiment_cache() therefore RE-KEYS a cache that still carries the old
size:mtime hash instead of wiping it; the run logs "sentiment cache: re-keyed ...". The re-key
only fires when the model file's size and integer mtime are still what they were at the last
build, so:
  * deploy the code with the model file untouched, or copy it with `scp -p`, and the first
    build is a normal incremental one;
  * if the model's mtime HAS moved (a plain `scp`/checkout of it), the re-key misses, the
    cache is wiped as it would be today, and the first build pays for one full rescore. That
    is a planned multi-hour run, not a surprise — schedule it, don't discover it at 03:00.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb

import aspect_classifier

# --------------------------------------------------------------------------------------
# Tunable constants (single source of truth for the ETL). Mirrored where relevant in
# api/app/benchmarks.py — keep the two in sync if you change scoring.
# --------------------------------------------------------------------------------------
MIN_REVIEWS_DEFAULT = 50          # a game needs >= this many reviews to enter niche/analysis STATS
                                  # (NOT the games list — that now shows the full live catalog, below)
MIN_REVIEWS_LEVELS = [0, 50, 100]  # min_reviews floors materialised in mart_niche. 0 = NO floor:
                                  # the whole tag membership, unreviewed releases included —
                                  # n_games there is the honest full tag size; revenue medians
                                  # still skip games with no estimable revenue (NULLs)
MIN_NICHE_GAMES = 30              # a niche needs >= this many qualifying games to be ranked
TAG_VOTE_FLOOR = 3                # a (game,tag) association needs >= this many community votes
TAG_RANK_FLOOR = 20              # ...and be within the game's top-N tags
RECENT_MONTHS = 24               # "recent" / 24m window length
DEMAND_MIN_BASE = 1000           # emerging tell 1 (mart_niche demand_emerging): a niche whose
                                 # reviews_prev_24m is below this has no comparable base — young
                                 # tags crystallize around new games only (old genre ancestors
                                 # never get re-voted into a new label), so their prior window is
                                 # near zero BY CONSTRUCTION and the raw trend % is noise
DEMAND_NEW_MASS_SHARE = 0.8      # emerging tell 2: >= this share of reviews_24m coming from games
                                 # released within the last RECENT_MONTHS means the niche's review
                                 # mass IS its newest games — same non-comparability, caught even
                                 # when a stray old title lifts the prev window past the base floor
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

# Game lifetime (steamcharts monthly, top-8k coverage) — see mart_players.sql _game_lifetime.
LIFETIME_ALIVE_CCU = 100         # a game "has an audience" from its first month AVERAGING
                                 # >= this many concurrent players
LIFETIME_DEAD_CCU = 10           # ...and is "dead" from its first FULL month averaging below
                                 # this — the "how long does a game live" 100+ -> <10 metric
LIFETIME_MIN_NICHE_GAMES = 5     # a niche needs >= this many 100+-reaching games before its
                                 # lifetime columns are stamped (tiny samples are noise)

# Review-count reconciliation (SteamSpy vs. the actual scraped `reviews` table). SteamSpy
# lags badly for new releases -- it can sit at total_reviews=0 for weeks/months after
# launch while our own scraper already holds real, current review data for the same game.
# See stg_game in create_staging() below for the reconciliation itself.
BOXLEITER_OWNERS_PER_REVIEW_MIN = 20   # mirrors api/app/benchmarks.py's "New Boxleiter"
BOXLEITER_OWNERS_PER_REVIEW_MID = 30   # 20-55 owners/review band -- used here to floor
BOXLEITER_OWNERS_PER_REVIEW_MAX = 55   # owners_mid when SteamSpy reports zero. Keep in sync.

# Opportunity score weights for the ORIGINAL v1 `opportunity` (also documented in
# benchmarks.py). v1 is frozen: opportunity_v2 no longer derives from it (see below).
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
# The v2 columns fixed both failure modes WITHOUT touching the original score: a decline
# gate multiplied `opportunity` into `opportunity_v2`, and a tag `tier` lets the MCP/API
# default to buildable micro-genres + themes while keeping umbrellas/meta reachable.
#
# SUPERSEDED 2026-08-31 for the score half of that: the decline gate below NO LONGER
# produces opportunity_v2 — see the "opportunity_v2 REBUILT" block further down for the
# model that does. `decline_gate` is still computed and published, because it is a
# genuinely useful falsification TELL ("did everyone stop entering this niche?") and the
# MCP guidance is built on it; it just stopped being the headline multiplier. GATE_* below
# therefore configure a diagnostic, not the score. The tag `tier` half is unchanged.
# --------------------------------------------------------------------------------------
# Decline gate — two independent decline signals:
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
GATE_FLOOR = 0.5                 # worst-case value of the tell (never below half). It was
                                 # the worst-case MULTIPLIER on opportunity until
                                 # 2026-08-31; it multiplies nothing now.
GATE_SAT_FULL_DECLINE = 0.30     # saturation_yoy <= -30%/yr -> full saturation severity
GATE_ENTRANT_FULL = 0.5          # entrant_ratio <= 0.5 -> full entrant severity
                                 # (severity ramps linearly over er in [0.5, 1.0])

# --------------------------------------------------------------------------------------
# opportunity_v2 REBUILT (2026-08-31) — one model behind BOTH the numeric score and the
# Radar's ring verdict. Full derivation in etl/marts/mart_niche.sql's header; the bars
# below are the SAME numbers web/src/lib/radarVerdict.ts rings on, and MUST stay in
# lockstep with it.
#
# WHY (measured on 219 live niches, tag / win=24m / min_reviews=50, the cut the Radar,
# find_niches and NicheFinder all default to):
#   - The old score ranked BACKWARDS against the Radar. Median opportunity_v2 by ring:
#     enter 17.6, watch/hold 17.8, crowded 20.9, declining 23.4 — the niches the board
#     told you to enter scored LOWER than the ones it warned you off.
#   - corr(opportunity_v2, demand_trend_24m_pct) = -0.047. The headline score had
#     literally NO relationship to the Radar's primary axis.
#   - The mechanism was not the decline gate (median 1.000 — near-inert). It was
#     `competition` = 0.6*percentile(n_recent) + 0.4*percentile(winner_concentration):
#     on the win='24m' cut n_recent IS n_games, so 60% of the competition penalty was a
#     pure NICHE-SIZE penalty. Metroidvania (177 recent games, demand +65%/24m) scored
#     0.0; Naval (34 games, demand -11.8%/24m) scored 63.7 and ranked #1.
#   - Only 2 of 219 niches (0.9%) reached the Radar's then-OPP_WATCH_SCORE=60 bar, catalog
#     max 63.7 — the "watch" ring was unreachable by score. That constant was recalibrated
#     60 -> 65 alongside this rebuild (web/src/lib/radarVerdict.ts), where 65 is the median
#     score of the niches the board rings "enter" and selects ~16% of the default cut.
#
# THE MODEL. Four inspectable 0..100 sub-scores, blended, then braked by supply pressure:
#
#   momentum        demand FLOW. 50 + 50*tanh(g / g_enter), where g is the niche's
#                   annualised continuous demand growth ln(1 + trend/100)/2 and g_enter
#                   is the same for OPP_ENTER_PCT. So: flat demand = 50, the Radar's
#                   enter bar (+40%/24m) = 88.1, the Radar's decline bar (-30%/24m) =
#                   10.7. tanh, not a clamp, so nothing piles up at the ends (61 of 219
#                   niches clear the enter bar — a hard cap would flatten 28% of the
#                   catalog onto one value).
#   supply_room     supply FLOW measured AGAINST demand flow, and newcomer economics —
#                   the weaker (MIN) of:
#                     flood_room   100 at or below zero excess supply growth, 50 when
#                                  supply outgrows demand by exactly the Radar's flooding
#                                  bar (+15%/yr), 0 at twice that.
#                     entrant_room 0 at entrant_ratio 0.5, 100 at the CATALOG NORM 1.08
#                                  (not 1.0 — see entrant_ratio's caveat). Capped there:
#                                  above the norm is a survivor-cohort artifact, not
#                                  evidence, so it earns no bonus.
#   revenue_spread  revenue STRUCTURE from winner_concentration: 50 sits exactly on the
#                   Radar's winner-take-most bar (0.85), 100 at 0.70, 0 at 1.00.
#   market_pull     the LEVEL terms, deliberately demoted to a supporting role:
#                   OPP_MARKET_MEDIAN_W * demand + (1-w) * market_size — "does a typical
#                   game here earn" blended with "how big is the pie".
#
#   opp_core     = the weighted mean of the four, RENORMALISED over the sub-scores that
#                  exist (a missing input does not vote and is never read as 0).
#   supply_brake = SUPPLY_BRAKE_FLOOR + (1-floor) * supply_room/100, or 1.0 when neither
#                  supply signal is available (unknown is not evidence of pressure).
#   opportunity_v2 = opp_core * supply_brake, clamped to [0, 100].
#
# WHY THIS SHAPE. Two constraints pulled in opposite directions: momentum had to be a
# first-class POSITIVE term (the old gate could only ever subtract, so a big stagnant
# niche beat a small surging one by construction), while supply pressure had to be able
# to sink a score ON ITS OWN. An additive term cannot sink (it can only remove its own
# weight); a multiplier cannot reward. So momentum is additive and large, supply is a
# multiplier with a floor low enough to bite: a fully-flooded niche keeps 35% of its core.
#
# WHY saturation_yoy IS READ AGAINST DEMAND, not on its own. This column is the exact
# point where the two old systems contradicted each other: decline_gate penalised
# saturation_yoy BELOW 0 (pipeline shrinking = decline) while the Radar penalises it
# ABOVE +0.15 (pipeline flooding = crowding). Both readings are right, and the
# disambiguator is demand: a pipeline shrinking while demand holds is a supply GAP; a
# pipeline shrinking alongside demand is a market dying. Differencing the two growth
# rates resolves it structurally instead of by fiat — and the death spiral gets no
# reward, because momentum has already scored the demand half.
#   flood_room is ONE-SIDED on purpose (capped at 100 once demand outpaces supply): a
# collapsing pipeline is at best "calm", never a bonus. Rewarding it is precisely the
# Naval/Transportation failure mode that motivated v2 in the first place.
#
# EMERGING NICHES. When demand_emerging is set, the niche's prior 24-month window is near
# zero BY CONSTRUCTION (young Steam tags crystallize around new games only), so its
# trend %, its saturation read AND its entrant_ratio are all artifacts of the label's
# age. All three flow sub-scores go NULL and the niche is scored on market_pull /
# revenue_spread / quality_gap alone — the same refusal-to-claim the Radar's precedence-0
# emerging ring makes. NOT zero: NULL, so the blend renormalises.
#
# MEASURED RESULT (same 219 niches, same rings):
#   median opportunity_v2 by ring, before -> after
#     enter      17.6 -> 67.6      crowded    20.9 -> 39.1
#     hold       17.8 -> 50.2      declining  23.4 -> 19.5
#   The ordering enter > hold > crowded > declining now holds, and holds on the
#   min_reviews=0, min_reviews=100 and win='all' cuts too (pinned by
#   etl/tests/test_opportunity_ordering.py). Per-niche cross-cut rank agreement went UP,
#   not down (Spearman min50-vs-min0 0.553 -> 0.663, 24m-vs-all 0.915 -> 0.955): the two
#   flow sub-scores are computed from cut-INDEPENDENT columns, so they are identical on
#   every cut by construction, which is stronger comparability than percentiles give.
# --------------------------------------------------------------------------------------
# Bars shared with web/src/lib/radarVerdict.ts — the score's sub-score anchors ARE the
# Radar's ring thresholds, which is what makes the ring and the number agree about
# DIRECTION. Not about supply: the constants match, the READINGS do not. OPP_FLOOD_YOY is
# applied to supply growth NET of demand growth here and to raw saturation_yoy in the ring,
# so the two contradict on 28.0% of the default cut on purpose (mart_niche.sql, "TWO VIEWS,
# BUT NOT ON SUPPLY"). Equal constants were the only thing ever asserted, which is how that
# went unnoticed; test_opportunity_ordering.py now pins the reading itself.
OPP_ENTER_PCT = 40.0             # == DEMAND_ENTER_PCT: +40%/24m demand growth -> momentum 88.1
OPP_FLOOD_YOY = 0.15             # == SAT_FLOOD_YOY as a NUMBER, but read differently: the ring
                                 # tests saturation_yoy against it directly; flood_room hits 50
                                 # when supply outgrows DEMAND by this much
OPP_WINNER_TAKE_MOST = 0.85      # == WC_WINNER_TAKE_MOST -> revenue_spread 50
OPP_ENTRANT_NORM = 1.08          # == ENTRANT_RATIO_CATALOG_NORM -> entrant_room 100 (capped)
OPP_ENTRANT_FULL = 0.5           # entrant_ratio <= 0.5 -> entrant_room 0 (same bar the
                                 # retired gate used, kept so the two agree on "as bad as
                                 # newcomer economics get")
# Blend weights — must sum to 1.0 (asserted below). momentum is the single largest term
# by design: the score's headline claim is about demand FLOW.
W2_MOMENTUM = 0.40
W2_MARKET = 0.22
W2_SPREAD = 0.20
W2_QUALITY = 0.18
OPP_MARKET_MEDIAN_W = 0.6        # market_pull = 0.6*demand + 0.4*market_size (per-game
                                 # money weighted over absolute pie size)
SUPPLY_BRAKE_FLOOR = 0.35        # a fully supply-pressured niche keeps 35% of its core.
                                 # Swept 0.25/0.35/0.45 on the live catalog: all three
                                 # preserve the ring ordering on all four cuts; 0.35 gave
                                 # the best margin/stability balance.
assert abs((W2_MOMENTUM + W2_MARKET + W2_SPREAD + W2_QUALITY) - 1.0) < 1e-9, (
    "opportunity_v2 blend weights must sum to 1.0"
)

# --------------------------------------------------------------------------------------
# Solo viability is a FLAG, not a scale (2026-08-31, user-reported: "solo scoring isn't
# working at all"). MEASURED over the same 219-niche production cut (tag / 24m / min50):
#   min 0.353 | p05 0.853 | p10 0.913 | p25 0.953 | MEDIAN 0.975 | p75 0.990 | max 1.000
#   below 0.90: 17 niches (7.8%)      below 0.80: 7 niches (3.2%)
# and it is stable across cuts (median 0.969-0.976; below-0.80 2.1-4.0% on 24m/min0,
# 24m/min100 and all/min50).
#
# So solo_viability is an EXCELLENT binary multiplayer detector and a USELESS ranking
# scale: three quarters of the catalog sits inside a 0.047-wide band. The seven niches
# under 0.80 are exactly the ones you would name by hand — Social Deduction 0.353,
# MMORPG 0.449, Party Game 0.500, Party 0.636, Battle Royale 0.700, Extraction Shooter
# 0.705, eSports 0.788. That is a true fact about the world (most genres really are
# solo-buildable), NOT a defect to normalise away, so nothing here rescales it: the raw
# share stays published unchanged and gains a coarse tier beside it.
#
# The 0.80 pass bar is UNCHANGED (RADAR_SOLO_FRIENDLY_MIN in api/app/routers/niches.py,
# SOLO_FRIENDLY_MIN in web/src/lib/radarVerdict.ts): the distribution says it is already
# the right cut. What was wrong was the DOCUMENTATION — the MCP instructions called ~0.9
# "the norm" when 0.9 is the 10th percentile. Fixed there, not here.
SOLO_TIER_SOLO_MIN = 0.90        # >= this -> 'solo'. The 10th percentile (p10 = 0.913):
                                 # ~92% of niches, i.e. "unremarkable, like everything else".
SOLO_TIER_TEAM_MAX = 0.80        # < this -> 'team' (multiplayer-dependent). Same bar the
                                 # API's solo_only filter and the web legend use — one
                                 # number, three places, no drift.
                                 # In between -> 'mixed': passes the solo-only filter, but
                                 # a real multiplayer minority among its members (Hero
                                 # Shooter 0.800, Minigames 0.805, Escape Room 0.836,
                                 # Class-Based 0.851, Football (Soccer) 0.853) — the band
                                 # a bare "solo-friendly" badge used to hide.

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
TIMING_BIG_REV = 200_000         # est_rev_reviews >= this = a "big" release. Single source of
                                 # truth for the $200K bar: rendered as @TIMING_BIG_REV@ into
                                 # mart_timing.sql AND the hit_rate_200k columns in
                                 # mart_niche.sql / mart_entity.sql / mart_tag_lift.sql
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
GAME_EVENT_CAP = 40           # dated events kept per game for chart annotation. 98.9% of games
                              # have <=20 events anyway; this only bounds the ~360 that do not.
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

# JTBD — niche press coverage (see mart_niche_press.sql): the per-game press footprint
# (mart_game_press_timeline / mart_game_press_by_source) rolled up to niche (tag/genre)
# level — a coverage timeline + "who covers this niche" for the Niche Finder drawer.
NICHE_PRESS_MIN_GAMES = 5        # a niche needs >= this many press-covered member games to
                                  # be published — below that, one title's press cycle would
                                  # read as "the niche's" coverage (mirrors
                                  # NICHE_THEMES_MIN_GAMES's role, floored lower because
                                  # journalist coverage is far sparser than review text)
NICHE_PRESS_TOP_OUTLETS = 15     # outlets kept per niche (top by n_articles) — the drawer
                                  # shows a short pitch-relevant list, not the full long tail

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

# THE UNIT OF WORK for compute_aspect_sentiment's scoring loop: how many REVIEWS one hash bucket
# should hold. The bucket count is derived from this and the size of the delta
# (_rescore_bucket_count), rather than being a fixed number, because the two regimes it has to
# serve differ by four orders of magnitude and want opposite things:
#
#   ordinary night   ~1.1M new reviews  ->   9 buckets   (bucketing is nearly free, and each
#                                                         bucket re-streams src.reviews, so a
#                                                         big fixed count would be pure cost)
#   config wipe      24.4M reviews      -> 196 buckets   (the delta is the whole corpus and the
#                                                         run CANNOT finish it in one night)
#
# SIZED FROM MEASURED THROUGHPUT, against the nightly's spare time budget:
#   * scoring rate on the droplet ~= 116 mention-rows/s. (Measured: this codebase's
#     _stream_vader_and_classify does 405 rows/s on 206-char aspect windows on a dev laptop;
#     the droplet runs the SAME code over press articles at 205,526/987s = 208/s where the
#     laptop does 733/s, i.e. 3.5x slower, so 405/3.5 ~= 116.)
#   * this corpus has 21,684,113 mention rows over 24,458,199 scanned reviews = 0.887
#     mentions per review, so 116 mention-rows/s ~= 131 reviews/s.
#   * 125,000 reviews therefore ~= 110,900 mention rows ~= 956s ~= 16 minutes per bucket.
#
# 16 minutes is the number that matters. The ETL runs under `timeout 21600` (6h, see
# deploy/prospect-refresh.sh) and staging + the mart loop + validation + the swap need most of
# it, so the sentiment phase's realistic slack is ~2h. A bucket must finish COMFORTABLY inside
# that: 16 min is 13% of a 2h slack, ~7 buckets complete per night, and the most a run can
# overshoot its deadline (it only stops BETWEEN buckets) is one bucket. Contrast the old fixed
# 8: on a wipe that is 6.5h PER BUCKET, larger than the entire nightly budget, so not one
# bucket would ever complete and a resumable rescore would never advance a single step.
# Bigger is not free either — every bucket re-streams the 24.8M-row sqlite reviews table
# (~50s on the droplet), so the overhead is N x 50s: 2.7h across a 196-bucket rescore (+5% on
# 52h of scoring), where N=1000 would be 13.9h (+27%).
RESCORE_BUCKET_REVIEWS = 125_000

# THE UNIT OF WORK for repair_sentiment_arms (--repair-arms), in reviews per hash bucket.
# Deliberately 8x the scoring loop's RESCORE_BUCKET_REVIEWS, because the two bound different
# things. That one bounds TIME: ~16 minutes of VADER + classifier per bucket, sized so the
# nightly can stop between buckets. A repair bucket does no such pass — it streams the
# bucket's text out of src.reviews (~50s on the droplet), runs the ten keyword regexes over
# it and scores only the ~1% of reviews found mismatched — so slicing a 24.4M-review pool
# into 196 buckets would spend 2.7h re-streaming sqlite to bound a phase that has nothing to
# bound. What a repair bucket must bound is MEMORY: its text is one TEMP table (charged to
# max_temp_directory_size, see the scoring loop's notes), and 1M reviews is ~340MB of it
# (8.45GB / 24.8M rows) — comfortably inside the nightly's 2200MB DuckDB budget with the
# ten-arm scan running over it, and ~25 buckets for the whole pool.
# PROSPECT_REPAIR_BUCKET_REVIEWS overrides it (validated in _env_config_errors).
REPAIR_BUCKET_REVIEWS = 1_000_000

# How long a process will WAIT for another one to release the sentiment cache file before giving
# up (see _attach_sentiment_cache for the measured lock semantics). 30 minutes is sized from the
# longest legitimate hold either side takes: the light build's press pass, 205,526 articles at
# 208/s = 987s, plus room for the corpus to grow. Long enough that a rescore and a light build
# always hand off cleanly; short enough that a genuinely wedged process fails a nightly loudly
# instead of hanging it until the 6h timeout.
SENTIMENT_CACHE_LOCK_WAIT_SECONDS = 1800
SENTIMENT_CACHE_LOCK_POLL_SECONDS = 2.0

# PER-GAME CAP ON THE SCORING POOL (2026-09-05). compute_aspect_sentiment's pool used to be every
# English review with text for every game over the TEARDOWN_MIN_REVIEWS floor, with no per-game
# cap. The daytime keeper deepens review text toward 20,000 per game across ~5,600 games, and every
# review it fetches is new text the nightly must score once, at ~131 reviews/s (see
# RESCORE_BUCKET_REVIEWS for the measurement). On a heavy day that is 1-4M never-scored reviews —
# the nightlies whose delta went past ~1.2M are the ones that failed. A per-aspect share computed
# from a few thousand mentions is already precise to about ±2 points, and the UI hides anything
# under 10 rated mentions, so review text beyond a few thousand per game buys nothing the teardown
# can show. Since 2026-09-05 the pool is therefore, per eligible game, at most this many reviews.
#
# WHICH reviews: the cap-many with the HIGHEST recommendationid. Steam ids are monotonic in time
# (highest = newest) and unique (no ties), so the selection is deterministic and stable night to
# night: a game whose newest cap-many are already scored contributes NOTHING to the next delta
# until a genuinely newer review arrives, and the keeper's back-catalogue deepening creates no
# scoring work at all. NOT "most helpful" — vote counts change nightly, so a helpfulness-ranked
# pool would churn at the margin every night and the cache would rescore the same games forever.
#
# The floor is still evaluated on the UNCAPPED count (a game with >= TEARDOWN_MIN_REVIEWS such
# reviews is eligible; then it is capped), and the cap only decides what is IN SCOPE: cache rows
# for reviews that fall outside it are ignored, not deleted, so it can move in either direction
# without touching the cache. Applied in exactly one place (the _sent_pool_meta CTAS in
# compute_aspect_sentiment); every consumer — the delta, the read-back, the keyword votes, the
# rescore_status pool figures and the teardown's n_reviews_sampled — derives from that table.
#
# DELIBERATELY NOT PART OF _sentiment_config_hash. That hash wipes and refills the whole ~24M-row
# cache when it moves; this knob changes which reviews are read, never what a scored mention's
# value IS, so moving it must never trigger a rescore (pinned by test_sentiment_pool_cap.py).
# 0 = uncapped, the pre-2026-09-05 behaviour. PROSPECT_SENTIMENT_POOL_CAP overrides it per run
# (validated up front by _env_config_errors; read by _sentiment_pool_cap).
SENTIMENT_POOL_CAP_PER_GAME = 5000

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
SENTIMENT_CACHE_VERSION = 2  # bump to force a full rescore even when none of the hashed config
                              # knobs below changed (e.g. a vaderSentiment version bump, or a fix
                              # to the scoring code itself that a config-value hash can't see).
                              #
                              # 1 -> 2 (2026-09-01): THE ONE-TIME REPAIR of the frozen mention
                              # hole measured on 2026-08-31 and documented in full in
                              # _build_aspect_keyword_votes' KNOWN GAP paragraph — 1,962 of
                              # 314,626 raw mentions (0.62%; 118 of 9,404 cells, touching 73 of
                              # 600 games) missing from the cache, every one of them in the last
                              # two arms of _aspect_window_sql's UNION ALL, left behind by an
                              # OOM-killed scoring stream and frozen in by the 2026-08-22
                              # scored_review seed migration. The gap is not reachable from the
                              # cache alone, so one full rescore is the only repair there is.
                              #
                              # THE HOLD IS BEING LIFTED DELIBERATELY, and this commit is the
                              # whole of it. This constant was previously set to 2 inside a
                              # 37-file commit and put back to 1 — not because the repair was
                              # wrong (the measurement above is solid) but because a 21.7M-row
                              # rescore must never fire as an invisible side effect of an
                              # unrelated change, least of all on the night after this pipeline
                              # produced its first clean nightly in three days. af1ba5b exists
                              # for exactly that reason. The condition that hold asked for is now
                              # met: this is a single-purpose change, and the rescore is
                              # SCHEDULED for the 21:00 UTC nightly_refresh of 2026-09-01 with
                              # someone watching. Note the schedule detail that decides WHICH run
                              # pays for it (deploy/crontab.txt): 21:00 nightly_refresh is the
                              # only FULL build; the 13:30 light_build runs --light, which does
                              # not score at all and will NOT perform the rescore.
                              #
                              # WHAT THAT BUILD DOES: _refresh_sentiment_cache sees a changed
                              # _sentiment_config_hash and DELETEs all three cache tables, then
                              # compute_aspect_sentiment re-scores the whole eligible pool from
                              # src.reviews. Live sizes measured on the droplet 2026-09-01, so
                              # the next reader does not have to re-derive the blast radius:
                              #     sentiment_cache.duckdb      0.46 GB on disk
                              #     cache.aspect_mention     21,684,113 rows
                              #     cache.scored_review      24,458,199 rows
                              #     cache.press_article         205,508 rows
                              # All three are discarded and rebuilt. press_article rides along
                              # because it is keyed by the same single config hash; at 205K rows
                              # it is rounding error next to the reviews.

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
# Genres in game_genres that are application-type / non-game and should be dropped, plus
# release-state/monetization labels Steam ships in the appdetails `genres` field that are
# not genres (user-reported 2026-08-28): 'Early Access', 'Free To Play'. Both 'To'/'to'
# case variants listed defensively — the genres field spells it 'Free To Play', other
# Steam fields (tags) spell it 'Free to Play' (same exact-twin precedent as LEGO/Lego
# in DENYLIST_TAG).
DENYLIST_GENRE = [
    "Utilities", "Design & Illustration", "Web Publishing", "Video Production",
    "Audio Production", "Animation & Modeling", "Game Development", "Photo Editing",
    "Accounting", "Software Training", "Movie", "Short", "Documentary", "Episodic",
    "Early Access", "Free To Play", "Free to Play",
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

# NOTE: the creator/twitch marketing vertical was decommissioned product-wide on
# 2026-08-25. mart_channel_mix.sql / mart_channel_buzz.sql remain (the MCP channel_mix /
# channel_buzz tools still read them) but are press-only now; the creator-side staging,
# mart_creator_pitch.sql and CREATOR_PITCH_MIN_MENTIONS are gone.

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
    "mart_game_event.sql",  # dated events for chart annotation; reads stg_game + src.articles
    "mart_entity.sql",   # reads ONLY mart_game (+ the entity_suffix temp table) — must
                         # come anywhere after mart_game.sql; kept adjacent since it's
                         # a direct normalization of mart_game's entity strings.
    "mart_niche.sql",
    "mart_niche_game.sql",  # niche -> game membership KEYS (the population mart_niche
                            # aggregated). Must come straight after mart_niche.sql: it
                            # INNER JOINs mart_niche to inherit that mart's
                            # MIN_NICHE_GAMES publication gate instead of re-deriving it
                            # (so the two can't disagree on which cuts exist), and it
                            # re-reads the same staging tables (stg_game,
                            # stg_tag/genre_membership — TEMPs that live for the whole
                            # run, never dropped). Adjacency also keeps the CURRENT_DATE
                            # both files evaluate for the 24m window seconds apart.
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
    "mart_channel_mix.sql",
    "mart_channel_buzz.sql",
    # These are LAST on purpose: they read marts built above (mart_game, mart_niche,
    # mart_game_review_aspects, mart_genre_aspect_baseline, mart_game_press_*) rather
    # than staging tables. They are independent of each other.
    "mart_tag_lift.sql",
    "mart_niche_themes.sql",
    "mart_niche_press.sql",
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
        # The 10 aspect LABELS as a SQL VALUES list. mart_game_teardown.sql cross-joins it
        # with the eligible games so every (game, aspect) pair gets a row even when the aspect
        # was never mentioned — the shape the hand-written 10-arm UNION ALL used to produce.
        # Rendered from ASPECT_LEXICON for the same reason the regexes are: adding an aspect
        # must not require editing a list of labels in a second file.
        "ASPECT_LABEL_VALUES": ", ".join(
            "('" + label.replace("'", "''") + "')" for (label, _p, _rx) in ASPECT_LEXICON),
        # The ten excerpt arms of mart_game_aspect_reviews.sql's _aspectrev_matched,
        # generated from ASPECT_LEXICON — see _aspect_excerpt_arms_sql().
        "ASPECT_REVIEW_ARMS": _aspect_excerpt_arms_sql(),
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
        "DEMAND_MIN_BASE": DEMAND_MIN_BASE,
        "DEMAND_NEW_MASS_SHARE": DEMAND_NEW_MASS_SHARE,
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
        # opportunity_v2 (rebuilt 2026-08-31) — the raw bars go into the SQL, which does
        # the ln()/tanh() arithmetic inline so the derivation is visible where it is used.
        "OPP_ENTER_PCT": OPP_ENTER_PCT,
        "OPP_FLOOD_YOY": OPP_FLOOD_YOY,
        "OPP_WINNER_TAKE_MOST": OPP_WINNER_TAKE_MOST,
        "OPP_ENTRANT_NORM": OPP_ENTRANT_NORM,
        "OPP_ENTRANT_FULL": OPP_ENTRANT_FULL,
        "W2_MOMENTUM": W2_MOMENTUM,
        "W2_MARKET": W2_MARKET,
        "W2_SPREAD": W2_SPREAD,
        "W2_QUALITY": W2_QUALITY,
        "OPP_MARKET_MEDIAN_W": OPP_MARKET_MEDIAN_W,
        "SUPPLY_BRAKE_FLOOR": SUPPLY_BRAKE_FLOOR,
        "SOLO_TIER_SOLO_MIN": SOLO_TIER_SOLO_MIN,
        "SOLO_TIER_TEAM_MAX": SOLO_TIER_TEAM_MAX,
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
        "GAME_EVENT_CAP": GAME_EVENT_CAP,
        "TEARDOWN_MIN_GENRE_GAMES": TEARDOWN_MIN_GENRE_GAMES,
        "PRESS_MIN_CONFIDENCE": PRESS_MIN_CONFIDENCE,
        "PRESS_NOTABLE_N": PRESS_NOTABLE_N,
        "ASPECT_REVIEWS_TOP_K": ASPECT_REVIEWS_TOP_K,
        # SENTIMENT_POS_THRESHOLD / SENTIMENT_NEG_THRESHOLD appear ONCE, above, next to the
        # other VADER cutoffs (a duplicate pair lived here until 2026-09-01 — same values,
        # silently shadowed by the dict, deleted rather than kept as a sync hazard).
        "NICHE_THEMES_MIN_GAMES": NICHE_THEMES_MIN_GAMES,
        "NICHE_PRESS_MIN_GAMES": NICHE_PRESS_MIN_GAMES,
        "NICHE_PRESS_TOP_OUTLETS": NICHE_PRESS_TOP_OUTLETS,
        "PRESS_AUTHOR_MIN_ARTICLES": PRESS_AUTHOR_MIN_ARTICLES,
        "BUZZ_TOTAL_MONTHS": BUZZ_TOTAL_MONTHS,
        "BUZZ_RECENT_MONTHS": BUZZ_RECENT_MONTHS,
        "BUZZ_MIN_TOTAL_MENTIONS": BUZZ_MIN_TOTAL_MENTIONS,
        "BUZZ_SLOPE_EPSILON": BUZZ_SLOPE_EPSILON,
        "TAG_PAIR_MIN_GAMES": TAG_PAIR_MIN_GAMES,
        "CCU_STALE_DAYS": CCU_STALE_DAYS,
        "CCU_FRESH_DAYS": CCU_FRESH_DAYS,
        "PLAYERS_TREND_DAYS": PLAYERS_TREND_DAYS,
        "PLAYERS_TREND_DAYS_X2": PLAYERS_TREND_DAYS * 2,
        "PLAYERS_HISTORY_DAYS": PLAYERS_HISTORY_DAYS,
        "NICHE_PLAYERS_MIN_MEASURED": NICHE_PLAYERS_MIN_MEASURED,
        "LIFETIME_ALIVE_CCU": LIFETIME_ALIVE_CCU,
        "LIFETIME_DEAD_CCU": LIFETIME_DEAD_CCU,
        "LIFETIME_MIN_NICHE_GAMES": LIFETIME_MIN_NICHE_GAMES,
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
        # Surface any unresolved token instead of silently shipping bad SQL. The pattern is
        # deliberately WIDER than the real placeholder alphabet (@[A-Z_]+@): a typo'd token
        # with a digit or a lowercase letter (@LANG_TOP_n@, @LANG_T0P_N@) must be caught HERE
        # as an unresolved placeholder, not shipped to DuckDB as an opaque syntax error hours
        # into a mart build. (2026-09-01 — was @[A-Z_]+@, which let typos through.)
        import re
        leftovers = set(re.findall(r"@[A-Za-z0-9_]+@", sql))
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
        -- Single normalized read of src.game_tags — every tag consumer (staging below,
        -- mart_game/mart_press/mart_channel_buzz) reads THIS, never src.game_tags directly:
        -- the scraper's store-page fallback briefly stored HTML-entity-escaped tag names
        -- ('Point &amp; Click'), and such phantom-twin tags skew toward recently-fetched
        -- games, faking explosive niche demand trends. The source was fixed 2026-08-26, but
        -- stale snapshots / future scraper regressions must not resurrect the twins.
        -- '&amp;' is unescaped FIRST; twins that merge into one (appid, tag) keep MAX(votes),
        -- and rank is recomputed by votes DESC (source rank can't be trusted across a merge).
        CREATE TEMP TABLE stg_game_tags AS
        WITH unescaped AS (
            -- trim() is the same fix as the unescape beside it, for a different character.
            -- The unescape landed because '&amp;' and '&' were publishing as two niches with
            -- one visible name; trailing SPACE does exactly that too, and was still doing it
            -- on 2026-09-01: 'Dystopian ' and 'Dystopian' rendered as an identical pair in the
            -- Niche Finder, and on the Radar as two blips with OPPOSITE verdicts (ENTER NOW vs
            -- EMERGING). Splitting one tag's games across two keys also wrecks the trend — the
            -- thinner twin showed demand_trend_24m_pct +2735%, a pure artifact of the split.
            -- Normalise BEFORE the GROUP BY below so the twins merge into one niche and their
            -- votes combine, exactly as the entity variants do.
            SELECT gt.appid,
                trim(replace(replace(replace(replace(replace(gt.tag,
                    '&amp;', '&'), '&quot;', '"'), '&#39;', ''''), '&lt;', '<'), '&gt;', '>')) AS tag,
                gt.votes
            FROM src.game_tags gt
            WHERE trim(COALESCE(gt.tag, '')) <> ''   -- a whitespace-only tag is not a niche
        ),
        merged AS (
            SELECT appid, tag, MAX(votes) AS votes
            FROM unescaped
            GROUP BY appid, tag
        )
        SELECT appid, tag, votes,
            row_number() OVER (PARTITION BY appid ORDER BY votes DESC, tag) AS rank
        FROM merged;

        CREATE TEMP TABLE stg_tag_membership AS
        SELECT DISTINCT gt.appid, gt.tag
        FROM stg_game_tags gt
        WHERE gt.votes >= @TAG_VOTE_FLOOR@
          AND gt.rank <= @TAG_RANK_FLOOR@
          AND gt.tag NOT IN (SELECT tag FROM denylist_tag);

        CREATE TEMP TABLE stg_genre_membership AS
        -- trim + case-fold BOTH sides of the denylist comparison (2026-09-01). It was an exact
        -- NOT IN, so 'Early Access ' with a trailing space, or 'early access', slipped straight
        -- past the list and republished the very niche the denylist exists to suppress — the
        -- bug this table was created to fix. The list carrying BOTH 'Free To Play' and
        -- 'Free to Play' by hand is the tell that case had already bitten once; enumerating
        -- spellings does not scale, normalising does. The whitespace half is not theoretical:
        -- the TAG side shipped 'Dystopian ' and 'Parody ' as twins of their trimmed selves.
        -- trim() on the stored value too, so twins merge instead of publishing side by side.
        SELECT DISTINCT gg.appid, trim(gg.genre) AS genre
        FROM src.game_genres gg
        WHERE trim(COALESCE(gg.genre, '')) <> ''
          AND lower(trim(gg.genre)) NOT IN (SELECT lower(trim(genre)) FROM denylist_genre);

        -- Niche-score v2 fallback for is_singleplayer (see stg_game below): games carrying
        -- the 'Singleplayer' community tag anywhere in the FULL game_tags table — no vote/
        -- rank floor, deliberately unlike stg_tag_membership, because this is a coverage
        -- signal ("is the game playable solo at all?"), not a niche-membership signal.
        -- Only consulted when the game's raw Steam `categories` field is missing/empty
        -- (~0.6 percent of the catalog); Steam's own category list wins whenever present.
        CREATE TEMP TABLE stg_singleplayer_tag AS
        SELECT DISTINCT gt.appid FROM stg_game_tags gt WHERE gt.tag = 'Singleplayer';

        -- Moved ahead of stg_game (below needs it for the owners-floor genre lookup).
        -- 'Early Access'/'Free To Play' are denylisted upstream (release-state/monetization
        -- labels, not genres — user-reported 2026-08-28), so they left the deprioritized
        -- CASE list: a game keeps its best REMAINING real genre, and a game whose ONLY
        -- genres are denylisted gets no row here -> NULL primary_genre downstream (every
        -- consumer LEFT JOINs this table or filters primary_genre IS NOT NULL).
        CREATE TEMP TABLE stg_primary_genre AS
        -- Same trim + case-fold as stg_genre_membership above, and for the same reason: this
        -- is a SECOND copy of the denylist filter, so fixing only the other one still let
        -- 'early access' through as a game's PRIMARY genre. Two filters over one list is the
        -- hazard; they must be normalised identically or they drift apart silently.
        WITH g AS (
            SELECT gg.appid, trim(gg.genre) AS genre,
                row_number() OVER (PARTITION BY gg.appid ORDER BY
                    CASE WHEN trim(gg.genre) IN ('Indie','Casual','Massively Multiplayer')
                         THEN 1 ELSE 0 END,
                    trim(gg.genre)) AS rn
            FROM src.game_genres gg
            WHERE trim(COALESCE(gg.genre, '')) <> ''
              AND lower(trim(gg.genre)) NOT IN (SELECT lower(trim(genre)) FROM denylist_genre)
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

        -- COMPLETE-SAMPLE games only: launch curves are HISTORIC shapes, and a partial
        -- sample (recency-biased fetch order, 20k deepen cap) lies about shape. A game
        -- feeds day-since-release curves only when its sampled review count covers its
        -- reconciled true total (0.95 tolerance: totals keep moving between scrapes).
        -- >20k-review megahits are therefore permanently excluded — acceptable, they're
        -- unrepresentative for launch-shape medians anyway. Population grows nightly as
        -- the deepen coverage keeper fills samples toward min(true, 20k).
        CREATE TEMP TABLE _complete_sample AS
        SELECT r.appid
        FROM src.reviews r
        JOIN stg_game g ON g.appid = r.appid
        GROUP BY r.appid, g.total_reviews
        HAVING COUNT(*) >= 0.95 * g.total_reviews;

        CREATE TEMP TABLE stg_review_dsr AS
        SELECT r.appid,
            datediff('day', g.release_date, CAST(to_timestamp(r.timestamp_created) AS DATE)) AS dsr
        FROM src.reviews r
        JOIN stg_game g ON g.appid = r.appid
        JOIN _complete_sample cs ON cs.appid = r.appid
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

        -- Phase 3 (Game Teardown): the English review KEY SET for aspect mining — and
        -- NO REVIEW TEXT. Scoped to language='english' + non-empty review_text because
        -- aspect mining is English-only by design (the fixed keyword lexicon is English);
        -- not joined to stg_game / release date since aspect mining doesn't need
        -- days-since-release.
        --
        -- NO TEXT (2026-08-31). This table used to be stg_review_text and carried
        -- review_text for the whole population, held as a TEMP table from staging until
        -- mart_game_teardown.sql dropped it, so it also ate the spill budget of every query
        -- that ran in between. That is what put eight consecutive nightlies over the box's
        -- headroom (~29GB free, ~30GB needed). Measured on the live source, both shapes
        -- materialised for the full population:
        --     BEFORE  24,864,168 rows, 8.45GB of review_text (avg 340 chars/review)
        --     AFTER   the same rows at 282MB on disk                          -> 30x smaller
        -- (recommendationid averages 8.6 chars, so the key set compresses hard; the text
        -- does not.)
        --
        -- It existed for exactly two readers, and NEITHER needs the whole corpus's text:
        --   * mart_game_teardown.sql re-derived per-(appid, aspect, voted_up) keyword
        --     counts by running the SAME 10 aspect regexes a SECOND time over every
        --     review — facts compute_aspect_sentiment had already computed and cached in
        --     cache.aspect_mention. It now reads those counts (stg_aspect_keyword_votes)
        --     and this table's (appid, voted_up) keys instead. See that file's header.
        --   * compute_aspect_sentiment needs text only for the NIGHTLY DELTA — reviews not
        --     yet in cache.scored_review — and now reads that delta's text straight from
        --     src.reviews at the point of use (_sent_new), which is the only place in the
        --     build that materialises review text at all.
        -- Everything else about the population is unchanged, so the teardown's eligibility
        -- floor (COUNT(*) >= TEARDOWN_MIN_REVIEWS) counts exactly the same rows it did.
        --
        -- THE CANDIDATE SET, NOT THE FINAL POOL (2026-09-05): compute_aspect_sentiment applies
        -- the floor and the per-game cap (SENTIMENT_POOL_CAP_PER_GAME) to this table and then
        -- REPLACES it, under this same name, with the pool it scored — see the hand-off at
        -- the end of that function — so the teardown's floor and n_reviews_sampled describe
        -- the reviews the aspect counts came from. --rescore-only and --light never reach
        -- that hand-off and leave this table exactly as built here.
        CREATE TEMP TABLE stg_review_key AS
        SELECT r.appid, r.recommendationid, r.voted_up
        FROM src.reviews r
        WHERE r.language = 'english'
          AND r.review_text IS NOT NULL
          AND length(trim(r.review_text)) > 0;

        -- SHARED press base (2026-08): the journalist-article set — articles fuzzy-linked
        -- to a game, Steam News excluded, match_confidence-floored — one row per
        -- (article, mentioned appid), ~1.12M rows. This exact join + filter used to be
        -- re-derived in five mart files (mart_game_teardown, mart_press, mart_niche_press,
        -- mart_channel_mix); deriving it ONCE here means the definition of "a journalist
        -- article about a game" cannot drift between marts, and the 3-way sqlite join runs
        -- once instead of five times. published_at is pre-TRY_CAST so every consumer reads
        -- the same TIMESTAMP (or NULL for unparseable dates).
        -- NOT this table's population (deliberately): mart_press.sql's buzz corpus
        -- (_buzz_articles) — that is ALL journalist articles, mention-matched or not, with
        -- no confidence floor, one row per article; it keeps its own src.articles read.
        CREATE TEMP TABLE stg_press_base AS
        SELECT m.appid, a.id AS article_id, a.source, a.author, a.title, a.url,
            TRY_CAST(a.published_at AS TIMESTAMP) AS published_at,
            m.match_confidence
        FROM src.article_game_mentions m
        JOIN src.articles a ON a.id = m.article_id
        WHERE a.source != 'steam_news'
          AND m.match_confidence >= @PRESS_MIN_CONFIDENCE@;
        """,
        params,
    )
    con.execute(staging_sql)


# --------------------------------------------------------------------------------------
# Guarded staging for OPTIONAL source tables. Some scraper tables (player_counts,
# player_history_external, review_histogram, game_socials) roll out independently of this
# ETL and may genuinely be absent on an older source DB. Each create_*_staging() below
# builds real staging when its table exists, else an empty, correctly-typed temp table so
# the downstream mart .sql files run unconditionally (real rows flow through, or every
# join resolves to zero rows) without knowing which mode they're in.
#
# HONESTY FIX (2026-08): the old probe ran `SELECT 1 FROM src."<table>" LIMIT 0` under a
# bare `except duckdb.Error: return False`, which made a broken ATTACH / sqlite-extension
# failure indistinguishable from a genuinely absent table — whole mart families (timing /
# players / socials) went silently empty with exit 0. Now the source catalog is enumerated
# ONCE via duckdb_tables() — a query that hard-fails the build if the attached source
# cannot be read at all — and table presence is a plain name lookup against that listing.
# Genuinely-absent tables are additionally recorded in mart_meta (absent_sources).
# --------------------------------------------------------------------------------------

# Optional source tables the guarded staging probes for. Their absence is legitimate
# (older source DB); anything else the ETL reads (games, reviews, articles, ...) is
# required and fails the build naturally when missing.
GUARDED_SOURCE_TABLES = (
    "player_counts", "player_history_external", "review_histogram", "game_socials",
)


def _source_table_names(con: duckdb.DuckDBPyConnection) -> set[str]:
    """Enumerate every table the attached source exposes, via DuckDB's own catalog metadata
    (duckdb_tables()). Matches both shapes the codebase uses: the real ETL's ATTACHed sqlite
    (database_name='src') and the tests' in-memory `src` SCHEMA (schema_name='src').

    Raises (hard build failure) if the catalog itself cannot be read — that is a broken
    ATTACH / sqlite-extension problem, never "the table is absent"."""
    try:
        rows = con.execute(
            "SELECT table_name FROM duckdb_tables() "
            "WHERE database_name = 'src' OR schema_name = 'src'"
        ).fetchall()
    except duckdb.Error as e:
        raise RuntimeError(
            f"cannot enumerate the attached source's tables (broken ATTACH or sqlite "
            f"extension?): {e}"
        ) from e
    return {r[0] for r in rows}


def _verify_source_attach(con: duckdb.DuckDBPyConnection) -> set[str]:
    """Called once right after ATTACH: returns the source's table names, hard-failing the
    build when the source exposes no tables at all — an attached-but-unreadable source must
    never masquerade as 'every optional table is absent'."""
    names = _source_table_names(con)
    if not names:
        raise RuntimeError(
            "attached source database exposes no tables at all — broken ATTACH, wrong file, "
            "or sqlite-extension failure; refusing to build empty marts from it"
        )
    return names


def _sqlite_table_exists(con: duckdb.DuckDBPyConnection, table: str,
                         src_tables: set[str] | None = None) -> bool:
    """Membership probe against the enumerated source catalog (see _source_table_names).
    `src_tables` lets main() pass the once-verified listing; direct callers (tests) may omit
    it and pay for a fresh enumeration."""
    if src_tables is None:
        src_tables = _source_table_names(con)
    return table in src_tables


def create_ccu_staging(con: duckdb.DuckDBPyConnection,
                       src_tables: set[str] | None = None) -> bool:
    """Live concurrent-player staging from the scraper's `player_counts` table
    (steam_players_bulk.py — keyless GetNumberOfCurrentPlayers snapshots). Guarded (see the
    guarded-staging block above): builds real staging when the table exists, else empty typed
    tables so downstream marts never crash on an older source DB. Two tables:

      stg_player_count_latest — newest snapshot per game (mart_game.live_players);
      stg_player_counts_daily — one row per (appid, UTC capture date): the LAST capture of the
          day (max_by), i.e. a stable evening point sample at the nightly ~21-22:00 UTC sweep —
          deliberately NOT a daily peak. Feeds mart_players.sql (daily/niche series).

    This is REAL live traction, distinct from SteamSpy's stale daily-peak stg_game.ccu."""
    if _sqlite_table_exists(con, "player_counts", src_tables):
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
        have = True
    else:
        con.execute("CREATE TEMP TABLE stg_player_count_latest (appid INTEGER, live_players INTEGER, captured_at TIMESTAMP)")
        con.execute("CREATE TEMP TABLE stg_player_counts_daily (appid INTEGER, cap_date DATE, players INTEGER, n_captures INTEGER)")
        have = False

    # Externally-sourced player HISTORY (steamcharts_backfill.py -> player_history_external):
    # period AVERAGES (+ monthly peaks), a DIFFERENT measure from our instantaneous point
    # samples — never blended, the `source` column stays the discriminator all the way to
    # the charts. Guarded separately: the table only exists once the backfill has run.
    if _sqlite_table_exists(con, "player_history_external", src_tables):
        con.execute(
            """
            CREATE TEMP TABLE stg_player_history_external AS
            SELECT appid,
                TRY_CAST(date AS DATE) AS date,
                CAST(avg_players AS DOUBLE) AS avg_players,
                CAST(peak_players AS INTEGER) AS peak_players,
                source
            FROM src.player_history_external
            WHERE TRY_CAST(date AS DATE) IS NOT NULL AND avg_players IS NOT NULL;
            """
        )
    else:
        con.execute(
            "CREATE TEMP TABLE stg_player_history_external "
            "(appid INTEGER, date DATE, avg_players DOUBLE, peak_players INTEGER, source VARCHAR)"
        )
    return have


def create_timing_staging(con: duckdb.DuckDBPyConnection,
                          src_tables: set[str] | None = None) -> bool:
    """TRUE monthly review counts per game from the scraper's `review_histogram` table
    (Steam's own per-month review-graph totals — uncapped, unlike the sampled `reviews`
    table; covers every game with >=50 total reviews, ~40K appids). Guarded exactly like
    create_ccu_staging(): builds stg_review_histogram when the table exists, else an empty
    typed table so mart_timing.sql builds empty marts (never crashes) on an older source
    DB. n_reviews = up + down votes — demand is measured as review-WRITING velocity
    regardless of verdict."""
    if _sqlite_table_exists(con, "review_histogram", src_tables):
        con.execute(
            """
            CREATE TEMP TABLE stg_review_histogram AS
            SELECT rh.appid,
                CAST(rh.period || '-01' AS DATE) AS period_month,
                COALESCE(rh.recommendations_up, 0) + COALESCE(rh.recommendations_down, 0) AS n_reviews,
                COALESCE(rh.recommendations_up, 0) AS n_positive
            FROM src.review_histogram rh
            WHERE rh.period IS NOT NULL;
            """
        )
        return True
    con.execute(
        "CREATE TEMP TABLE stg_review_histogram (appid INTEGER, period_month DATE, n_reviews BIGINT, n_positive BIGINT)"
    )
    return False


def create_socials_staging(con: duckdb.DuckDBPyConnection,
                           src_tables: set[str] | None = None) -> bool:
    """Official social links per game from the scraper's `game_socials` table. These are
    harvested from developer-CONTROLLED pages (the Steam store page + the dev's own
    website, `source` says which), NOT from the platforms themselves — so a handle may be
    the game's account, the studio's, or the dev's personal one, and we cannot tell which
    without platform API access. Downstream surfaces must label it "official social
    linked from the game's pages", never "the game's account".

    Guarded exactly like create_ccu_staging()/create_timing_staging(): builds
    stg_game_socials when the table exists, else an empty typed temp table so downstream
    marts never crash on an older source DB. rk = sqlite ROWID (insertion order — the
    scraper inserts store_page rows before website rows per game), so MIN(rk) per
    (appid, platform) = the game's most PROMINENT link for that platform."""
    if _sqlite_table_exists(con, "game_socials", src_tables):
        con.execute(
            """
            CREATE TEMP TABLE stg_game_socials AS
            SELECT appid, platform, handle, url, source, rowid AS rk
            FROM src.game_socials;
            """
        )
        return True
    con.execute(
        "CREATE TEMP TABLE stg_game_socials "
        "(appid INTEGER, platform VARCHAR, handle VARCHAR, url VARCHAR, source VARCHAR, rk BIGINT)"
    )
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


def _stream_vader_and_classify(con: duckdb.DuckDBPyConnection, select_sql: str, insert_sql: str,
                               clf) -> int:
    """Same streaming contract as _stream_vader_scores, but each window is ALSO passed through the
    aspect classifier, so one pass over the corpus produces both the VADER compound (which still
    feeds the numeric text_* columns) and the classifier's verdict on what the fragment is really
    about. Scoring both here rather than in a second pass matters: the window text is the
    expensive thing to produce, and it is already in hand."""
    analyzer = _get_analyzer()
    read = con.cursor()
    read.execute(select_sql)
    n = 0
    while True:
        batch = read.fetchmany(SENTIMENT_SCORE_BATCH)
        if not batch:
            break
        rows = []
        for row in batch:
            text = row[-1] or ""
            compound = float(analyzer.polarity_scores(text)["compound"])
            clf_aspect, clf_sent, margin = clf.classify(text)
            rows.append((*row[:-1], compound, clf_aspect, clf_sent, float(margin)))
        con.executemany(insert_sql, rows)
        n += len(rows)
    read.close()
    return n


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


# One excerpt arm of mart_game_aspect_reviews.sql's _aspectrev_matched, byte-for-byte the
# shape the file hand-maintained until 2026-09-01 — ten near-identical SELECTs differing
# only in the aspect keyword regex and the kw_aspect filter. The windowing algebra (and why
# it is exact + cheap) is documented at _aspectrev_matched's header IN THE SQL FILE; this is
# only its mechanical side. Generated here, from the same ASPECT_LEXICON the @RX_*@
# placeholders render from, so a lexicon edit moves all ten arms at once and the file cannot
# drift arm-by-arm (the review that found this also found two arms had once drifted into a
# scoring-stream cutoff — see _build_aspect_keyword_votes' KNOWN GAP). The window-size
# constants are baked in as their literal values (same numbers @ASPECT_WINDOW_SLICE_*@ /
# @ASPECT_SENTENCE_CHARS@ would render to), so the rendered SQL is byte-identical to the
# hand-maintained original — pinned by rendering before/after in review, and any future
# change to this template must keep the rendered output diffable against the marts.
_ASPECT_EXCERPT_ARM = """    SELECT appid, recommendationid, aspect, sentiment, votes_up, playtime_minutes,
        timestamp_created, language,
        CASE WHEN kw_pos - {slice_before} > 1
             THEN regexp_replace(substr(review_text, kw_pos - {slice_before}, {slice_chars}), '^\\S+', '')
             ELSE substr(review_text, 1, {slice_chars})
        END AS slice,
        length(regexp_extract(slice, '^([\\s\\S]*?)(?:{rx})', 1, 'i')) + 1 AS kw_off,
        reverse(regexp_extract(reverse(substr(slice, 1, kw_off - 1)), '^[^.!?;\\n]*', 0)) AS clause_l,
        regexp_extract(substr(slice, kw_off), '^[^.!?;\\n]*', 0) AS clause_r,
        CASE WHEN regexp_matches(slice, '{rx}', 'i')
             THEN substr(regexp_extract(
                      CASE WHEN length(clause_l) > {sentence_chars}
                           THEN substr(clause_l || clause_r, length(clause_l) - {sentence_chars})
                           ELSE ' ' || clause_l || clause_r
                      END,
                      '^[\\s\\S][\\s\\S]{{0,{sentence_chars}}}(?:{rx})[\\s\\S]{{0,{sentence_chars}}}', 0, 'i'
                  ), 2)
             ELSE ''
        END AS window_text,
        COALESCE(window_text, substr(review_text, 1, 2 * {sentence_chars})) AS excerpt_body,
        strpos(review_text, window_text) AS win_start,
        length(review_text) AS text_len,
        list_distinct(list_transform(regexp_extract_all(excerpt_body, '{rx}', 1, 'i'), x -> lower(x))) AS matched_keywords
    FROM (SELECT *, length(regexp_extract(review_text, '^([\\s\\S]*?)(?:{rx})', 1, 'i')) + 1 AS kw_pos
          FROM _aspectrev_surv WHERE kw_aspect = '{label}')"""


def _aspect_excerpt_arms_sql() -> str:
    """The ten _aspectrev_matched arms, rendered into mart_game_aspect_reviews.sql via the
    @ASPECT_REVIEW_ARMS@ placeholder (see _ASPECT_EXCERPT_ARM above for why this lives in
    Python). Same single-source-of-truth contract as _aspect_window_sql."""
    arms = []
    for label, _placeholder, rx in ASPECT_LEXICON:
        arms.append(_ASPECT_EXCERPT_ARM.format(
            rx=rx.replace("'", "''"),            # SQL single-quote escape (none today, but be safe)
            label=label.replace("'", "''"),
            slice_before=ASPECT_WINDOW_SLICE_BEFORE,
            slice_chars=ASPECT_WINDOW_SLICE_CHARS,
            sentence_chars=ASPECT_SENTENCE_CHARS,
        ))
    return "\n\n    UNION ALL\n".join(arms)


def _rescore_bucket_count(n_new_reviews: int) -> int:
    """How many hash buckets to slice this run's delta into — derived from the delta's SIZE, not
    fixed. See RESCORE_BUCKET_REVIEWS for the sizing arithmetic and why a fixed count cannot
    serve both an ordinary night and a config-wipe rescore.

    PROSPECT_RESCORE_BUCKET_REVIEWS overrides the target; a wrong value is refused up front by
    _env_config_errors rather than hours in. Always >= 1, so an empty delta still type-checks
    into the loop (which then has nothing to iterate)."""
    target = RESCORE_BUCKET_REVIEWS
    raw = os.environ.get("PROSPECT_RESCORE_BUCKET_REVIEWS", "").strip()
    if raw:
        try:
            target = max(1, int(raw))
        except ValueError:
            pass  # refused by _env_config_errors(); fall back rather than crash mid-build
    return max(1, -(-max(0, n_new_reviews) // target))  # ceil division, no math import


def _repair_bucket_count(n_reviews: int) -> int:
    """How many hash buckets repair_sentiment_arms slices its candidate set into — the same
    ceil arithmetic as _rescore_bucket_count over REPAIR_BUCKET_REVIEWS (see it for why the
    two targets differ by 8x). PROSPECT_REPAIR_BUCKET_REVIEWS overrides the target; a wrong
    value is refused up front by _env_config_errors."""
    target = REPAIR_BUCKET_REVIEWS
    raw = os.environ.get("PROSPECT_REPAIR_BUCKET_REVIEWS", "").strip()
    if raw:
        try:
            target = max(1, int(raw))
        except ValueError:
            pass  # refused by _env_config_errors(); fall back rather than crash mid-run
    return max(1, -(-max(0, n_reviews) // target))


# Stamped at IMPORT, which for the nightly is within a second of the `timeout 21600` clock
# starting. The deadline below is expressed against it so the budget an operator sets is
# "seconds of wall clock from the moment the ETL started", the same thing `timeout` measures —
# not "seconds from whenever staging happened to finish", which varies by an hour.
_PROC_T0 = time.monotonic()


def _sentiment_deadline() -> float | None:
    """The monotonic instant after which compute_aspect_sentiment starts NO NEW BUCKET, or None
    for no deadline (unset = the default, so a manual/detached rescore runs until it is done).

    WHY THIS EXISTS. The nightly runs the ETL under `timeout 21600`
    (deploy/prospect-refresh.sh). A rescore that is still scoring when that fires is SIGKILLed
    at an arbitrary instant — mid-bucket, mid-batch — and everything that bucket had done is
    rolled back by the next run's DELETE. Worse, the kill takes the whole build with it: no
    marts, no swap, and (2026-08-21) not even a log line, because a killed process never
    flushes. Stopping BETWEEN buckets instead costs at most the buckets we chose not to start,
    keeps every completed bucket permanently recorded, and lets the rest of the build finish
    normally and say what it did.

    The budget is deliberately NOT derived from `timeout` inside Python: build_marts has no way
    to know it is running under one, and guessing would be worse than being told. The deploy
    script sets it next to the timeout it is paired with, so the two move together."""
    raw = os.environ.get("PROSPECT_SENTIMENT_DEADLINE_SECONDS", "").strip()
    if not raw:
        return None
    try:
        budget = float(raw)
    except ValueError:
        return None  # refused by _env_config_errors(); never crash the build over a knob
    if budget <= 0:
        return None
    return _PROC_T0 + budget


def _sentiment_cache_enabled() -> bool:
    """Kill-switch: PROSPECT_SENTIMENT_CACHE=off (or =0) disables the cache entirely — no ATTACH,
    no cache reads/writes, every run does a full rescore exactly as it did before this feature
    existed. Unset, or any other value, leaves the cache on (the default)."""
    return os.environ.get("PROSPECT_SENTIMENT_CACHE", "").strip().lower() not in ("off", "0")


def _sentiment_pool_cap() -> int:
    """The per-game pool cap in force for this run: PROSPECT_SENTIMENT_POOL_CAP if set, else
    SENTIMENT_POOL_CAP_PER_GAME (see that constant). 0 means uncapped.

    A garbled, negative, or below-the-floor value is refused up front by _env_config_errors;
    here it falls back to the constant rather than crash the build hours in, the same contract
    as the other sentiment knobs. Below the floor is refused because the pool is handed to the
    teardown as its floored population (see the end of compute_aspect_sentiment): a cap under
    TEARDOWN_MIN_REVIEWS would leave every capped game short of the floor and silently drop it."""
    raw = os.environ.get("PROSPECT_SENTIMENT_POOL_CAP", "").strip()
    if raw:
        try:
            cap = int(raw)
        except ValueError:
            return SENTIMENT_POOL_CAP_PER_GAME
        if cap == 0 or cap >= TEARDOWN_MIN_REVIEWS:
            return cap
    return SENTIMENT_POOL_CAP_PER_GAME


def _aspect_model_fingerprint(path: str | None = None) -> str:
    """SHA-256 of the shipped classifier's CONTENT, folded into the sentiment config hash.
    Swapping the model changes what a cached mention's clf_* verdict would be, so it must
    invalidate the cache exactly like a lexicon edit does — otherwise a new model would silently
    serve old verdicts.

    Content hash, deliberately NOT size+mtime: the model ships via scp/git checkout, and both
    reset mtime freely — a re-copy of the IDENTICAL file used to change the old size:mtime
    fingerprint and wipe the 16M-row sentiment cache, triggering a multi-hour full rescore for
    nothing (real incident; see the `scp -p` workaround it forced). Hashing the 6MB file takes
    milliseconds and only ever changes when the model's bytes actually change.

    Switching to a content hash necessarily changes the fingerprint's VALUE once, which would
    have wiped the cache on the first build after this shipped — the very thing it exists to
    prevent. _legacy_aspect_model_fingerprint() + the migration in _refresh_sentiment_cache()
    carry the existing entries over to the new key instead. See both for the safety argument.

    `path` is a test seam; production callers use the default (next to the ETL code)."""
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), aspect_classifier.MODEL_FILENAME)
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return "absent"
    return h.hexdigest()


def _legacy_aspect_model_fingerprint(path: str | None = None) -> str:
    """The PRE-2026-08 fingerprint, byte-for-byte: f"{st_size}:{int(st_mtime)}". Kept for one
    purpose only — recomputing the config hash a cache written by the old code would carry, so
    _refresh_sentiment_cache() can re-key those entries instead of wiping 16M rows."""
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), aspect_classifier.MODEL_FILENAME)
    try:
        st = os.stat(path)
        return f"{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        return "absent"


def _sentiment_config_hash(model_fingerprint: str | None = None) -> str:
    """Hash of every knob that can change what a cached score's VALUE would be: the aspect keyword
    lexicon, the gaming-domain VADER overrides applied in _get_analyzer(), the sentence/window
    sizing, the pos/neg classification thresholds, plus a manually-bumpable version escape hatch.
    Any edit to any of these changes the hash — _refresh_sentiment_cache wipes the cache whenever
    the stored hash disagrees with this one, so a lexicon/window/threshold change can't silently
    keep serving scores computed under the old config.

    Deliberately NOT hashed: TEARDOWN_MIN_REVIEWS and the other eligibility floors that decide
    which reviews/articles are IN SCOPE this run — those don't change what an already-scored
    mention's compound IS, and _sent_pool/_press_score_set are recomputed fresh every run
    regardless of the cache, so a floor change is picked up automatically.
    SENTIMENT_POOL_CAP_PER_GAME (and its PROSPECT_SENTIMENT_POOL_CAP override) is in the same
    class and is kept out for the same reason: it decides WHICH reviews are in the pool, never
    what their scores are, and a scope change must never wipe and refill a 24M-row cache.
    test_sentiment_pool_cap.py pins that moving the cap leaves this hash unchanged.

    `model_fingerprint` overrides only the model component (the migration below passes the old
    size:mtime form to reconstruct what a pre-2026-08 cache stored); everything else is the
    live config, so the reconstruction only matches when nothing ELSE changed either."""
    payload = "\n".join([
        f"version={SENTIMENT_CACHE_VERSION}",
        f"aspect_model={_aspect_model_fingerprint() if model_fingerprint is None else model_fingerprint}",
        f"aspect_lexicon={ASPECT_LEXICON!r}",
        f"gaming_overrides={sorted(GAMING_LEXICON_OVERRIDES.items())!r}",
        f"sentence_chars={ASPECT_SENTENCE_CHARS!r}",
        f"slice_before={ASPECT_WINDOW_SLICE_BEFORE!r}",
        f"slice_chars={ASPECT_WINDOW_SLICE_CHARS!r}",
        f"pos_threshold={SENTIMENT_POS_THRESHOLD!r}",
        f"neg_threshold={SENTIMENT_NEG_THRESHOLD!r}",
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _attach_sentiment_cache(con: duckdb.DuckDBPyConnection, data_dir: Path,
                            wait_seconds: float | None = None) -> Path:
    """ATTACH the persistent, cross-run sentiment cache read-write as `cache`, creating its file
    and/or tables on first use. Caller MUST _detach_sentiment_cache() when done — both compute_*
    functions do this in a try/finally, since DuckDB holds a write lock on an attached file for as
    long as it stays attached, and a second ATTACH of the same path (e.g. the next compute_*
    call, or a re-run in the same process) would otherwise fail.

    WAITS FOR ANOTHER PROCESS instead of dying on it (2026-09-02). The lock is per FILE and
    cross-process, and it is exclusive in both directions — measured, not read off the docs:
    while one process holds the cache read-write, a second process's ATTACH fails immediately
    with

        IOException: Could not set lock on file "...sentiment_cache.duckdb": Conflicting lock

    and so does a READ_ONLY attach, so there is no read-only escape hatch. That exact error
    killed the 2026-08-31 light build. It matters far more now: a detached ~52h rescore and the
    13:30 light build have to share this file for days. Both sides poll instead of failing, and
    because the release is instant (a waiter re-acquires within one poll of the holder's DETACH)
    a bounded wait is all the coordination either side needs — no lock files, no ordering
    protocol, nothing to leave stale if a process is killed.

    The wait is BOUNDED and loud: a genuinely stuck holder must still fail the build rather than
    hang a nightly forever."""
    cache_path = Path(data_dir) / SENTIMENT_CACHE_DB_NAME
    if wait_seconds is None:
        wait_seconds = SENTIMENT_CACHE_LOCK_WAIT_SECONDS
    _deadline = time.monotonic() + max(0.0, wait_seconds)
    _waited_from = None
    while True:
        try:
            con.execute(f"ATTACH '{cache_path}' AS cache")
            break
        except duckdb.IOException as e:
            # Only the cross-process file lock is retryable. Anything else (a corrupt file, a
            # missing directory, the in-PROCESS "Unique file handle conflict" that means this
            # code attached twice without detaching) is a bug or an outage and must surface now.
            if "Conflicting lock" not in str(e) or time.monotonic() >= _deadline:
                raise
            if _waited_from is None:
                _waited_from = time.monotonic()
                print(f"[etl] sentiment cache is locked by another process — waiting up to "
                      f"{wait_seconds:,.0f}s for it (this is the rescore/light-build handoff)")
            time.sleep(SENTIMENT_CACHE_LOCK_POLL_SECONDS)
    if _waited_from is not None:
        print(f"[etl] sentiment cache acquired after waiting "
              f"{time.monotonic() - _waited_from:,.1f}s")
    con.execute(
        "CREATE TABLE IF NOT EXISTS cache.aspect_mention("
        "recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE, "
        # clf_* are the classifier's verdict on the same window: which aspect the text is REALLY
        # about (possibly NONE) and its praise/complaint/neutral read. `aspect` stays as the
        # keyword arm that generated the candidate, so a model swap can be diffed against it.
        "clf_aspect VARCHAR, clf_sentiment VARCHAR, clf_margin DOUBLE)"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS cache.press_article(article_id BIGINT, compound DOUBLE)"
    )
    # Did scored_review EXIST before this attach? The seed below turns on the answer, and
    # "the table is empty" is not the same question: a legacy cache file has no such table at
    # all, whereas a run that died mid-scoring leaves the table present and empty next to a
    # part-filled aspect_mention. Asked before the CREATE, because after it the two states are
    # indistinguishable.
    had_scored_review = con.execute(
        "SELECT count(*) FROM duckdb_tables() "
        "WHERE database_name = 'cache' AND table_name = 'scored_review'"
    ).fetchone()[0] > 0
    # Which reviews have been SCANNED — regardless of whether the scan produced any mention rows.
    # This table exists because aspect_mention cannot answer that question: a review whose text
    # matches no aspect keyword produces zero rows there, so "not in aspect_mention" conflates
    # "never scanned" with "scanned, found nothing". The old code made exactly that conflation and
    # bet it was cheap ("the vast majority of reviews match at least one arm"). Measured on
    # 2026-08-22, the bet was off by an order of magnitude: three consecutive nightlies re-scanned
    # 10.96M / 10.38M / 10.77M "new" reviews — one of them producing literally 0 new mention rows —
    # burning ~20 minutes of the 2-core box EVERY night on regex over text that can never match.
    con.execute("CREATE TABLE IF NOT EXISTS cache.scored_review(recommendationid VARCHAR)")
    con.execute("CREATE TABLE IF NOT EXISTS cache.meta(key VARCHAR, value VARCHAR)")
    # HOW FAR ALONG IS THE RESCORE — answerable from the cache file alone, with no build
    # running and no log to grep:
    #
    #   duckdb data/sentiment_cache.duckdb -c 'SELECT * FROM rescore_status'
    #
    # One row, rewritten at the end of every scoring run. It is a REPORT, never a source of
    # truth: what is and is not scored is decided by scored_review and nothing else, so a
    # corrupt or absent row here can never cause a review to be skipped. reviews_in_pool is
    # recorded because the cache cannot otherwise know the denominator (the eligible pool is
    # rebuilt by staging every run and does not live in this file).
    #
    # buckets_* describe ONE RUN's slicing, not global progress. The bucket count is derived
    # from the size of the remaining delta, so it shrinks as the rescore advances and
    # "7 of 196" followed by "7 of 189" is correct, not a bug. reviews_scored/reviews_in_pool
    # is the progress number that means the same thing every night. Both count POOL reviews:
    # since the per-game cap (SENTIMENT_POOL_CAP_PER_GAME) the cache also holds rows for
    # reviews outside the pool, so scored_review's own size is not the numerator.
    con.execute(
        "CREATE TABLE IF NOT EXISTS cache.rescore_status("
        "updated_at TIMESTAMP, reviews_in_pool BIGINT, reviews_scored BIGINT, "
        "mention_rows BIGINT, buckets_total INTEGER, buckets_done INTEGER, "
        "stopped_early VARCHAR, slowest_bucket_seconds DOUBLE)"
    )
    # Migration seed, ONE-TIME: reviews with mention rows in a pre-2026-08-22 cache file are
    # proof of a past scan, so count them scanned instead of re-scanning ~1.8M of them. The
    # ~10M zero-mention reviews have no trace anywhere and get their one final rescan.
    #
    # GUARDED ON THE TABLE'S ABSENCE, NOT ON ITS EMPTINESS (2026-09-02). The old guard was
    # `scored_review is empty`, which is also true of the wreckage a run that died mid-scoring
    # leaves behind: aspect_mention part-filled, scored_review empty. The seed then did exactly
    # what scored_review exists to prevent — declare "has rows in aspect_mention" to mean
    # "fully scanned" — and the reviews whose arms the crash split mid-stream were frozen with
    # a PREFIX of their arms, invisibly and permanently. That is not a hypothetical: it is the
    # 2026-08-22 seed re-run over an OOM-killed build's leftovers, and it is where the 0.62%
    # hole documented in _build_aspect_keyword_votes came from. It also silently defeated the
    # DELETE-and-rescan recovery in compute_aspect_sentiment, which is the ONLY repair path
    # that block has. A file that has the table has been through this code before, so the
    # migration is done; anything empty in it after that is a crash to be redone, not history
    # to be preserved.
    if not had_scored_review:
        con.execute(
            "INSERT INTO cache.scored_review "
            "SELECT DISTINCT recommendationid FROM cache.aspect_mention "
            "WHERE recommendationid IS NOT NULL"
        )
    # CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists — it does NOT add
    # columns. A cache file created before the classifier landed therefore keeps the old
    # three-column shape, and the six-value INSERT below fails at runtime, hours into a build.
    # (That is not hypothetical: it cost a 4.5-hour run on 2026-08-20.) Add anything missing
    # explicitly; ALTER ... ADD COLUMN is cheap and idempotent here because we check first.
    have = {r[0] for r in con.execute("DESCRIBE cache.aspect_mention").fetchall()}
    for col, typ in (("clf_aspect", "VARCHAR"), ("clf_sentiment", "VARCHAR"), ("clf_margin", "DOUBLE")):
        if col not in have:
            con.execute(f"ALTER TABLE cache.aspect_mention ADD COLUMN {col} {typ}")
    return cache_path


def _detach_sentiment_cache(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("DETACH cache")


def _refresh_sentiment_cache(con: duckdb.DuckDBPyConnection) -> bool:
    """Wipe both cache tables when the scoring config changed since they were last populated (or
    when they're empty/newly created) — makes a lexicon/window/threshold edit, or a
    SENTIMENT_CACHE_VERSION bump, force a full rescore instead of silently serving stale scores
    computed under a different config. Returns True iff it invalidated (callers log that).

    ONE-TIME MIGRATION (2026-08): the model fingerprint moved from size:mtime to a content hash
    (see _aspect_model_fingerprint). That is a strict improvement, but it changes the config
    hash's value once, so the first build after the change would wipe the 16M-row cache and pay
    for a multi-hour rescore — exactly the cost the change exists to avoid. If the stored hash
    is the one the OLD fingerprint would have produced for the model file sitting there right
    now, the entries were scored under this same model and this same config, and the hash is
    simply re-keyed instead of wiped. Safety: the migration only fires when every other hashed
    knob already matches, so the sole risk is a DIFFERENT model with byte-identical size AND the
    same integer mtime — which nothing short of deliberate forgery produces. If the model's mtime
    HAS moved since the last build (an scp without -p), the reconstruction misses and the normal
    wipe happens, exactly as it does today."""
    current = _sentiment_config_hash()
    row = con.execute("SELECT value FROM cache.meta WHERE key = 'config_hash'").fetchone()
    if row is not None and row[0] == current:
        return False
    if row is not None and row[0] == _sentiment_config_hash(_legacy_aspect_model_fingerprint()):
        con.execute("DELETE FROM cache.meta WHERE key = 'config_hash'")
        con.execute("INSERT INTO cache.meta VALUES ('config_hash', ?)", [current])
        print("[etl] sentiment cache: re-keyed from the old size:mtime model fingerprint to "
              "the content hash — same model, same config, cache KEPT (one-time migration)")
        return False
    con.execute("DELETE FROM cache.aspect_mention")
    con.execute("DELETE FROM cache.press_article")
    # scored_review must die with aspect_mention: it asserts "scanned under the current config",
    # and keeping it across a config change would silently skip the full rescore this wipe exists
    # to force.
    con.execute("DELETE FROM cache.scored_review")
    # ...and so must the progress report, for the same reason: it describes how far a rescore
    # under the OLD config got, and leaving it would show a fresh wipe as 100% complete.
    con.execute("DELETE FROM cache.rescore_status")
    con.execute("DELETE FROM cache.meta WHERE key = 'config_hash'")
    con.execute("INSERT INTO cache.meta VALUES ('config_hash', ?)", [current])
    return True


_CLF = None
_CLF_ABSENT = False  # set only when PROSPECT_ALLOW_NO_CLASSIFIER=1 accepted a missing model;
                     # write_meta() records it as a sentiment_classifier=absent provenance row.


def _get_classifier():
    """One classifier per process, loaded lazily. A MISSING (or unloadable) model is FATAL by
    default: without it the pipeline silently degrades — the 'NONE' aspect class (alone ~22% of
    keyword matches) stops being dropped and aspect counts inflate ~28%, which then ships as if
    it were real data. A bad deploy should fail loudly, not publish quietly-wrong marts.

    Escape hatch: PROSPECT_ALLOW_NO_CLASSIFIER=1 runs the old degraded keyword-aspect fallback
    (for emergencies only); write_meta() then stamps sentiment_classifier=absent into mart_meta
    so the degraded build is identifiable after the fact."""
    global _CLF, _CLF_ABSENT
    if _CLF is None and not _CLF_ABSENT:
        allow_degraded = os.environ.get("PROSPECT_ALLOW_NO_CLASSIFIER", "").strip() == "1"
        try:
            _CLF = aspect_classifier.load_default("")
            load_error = None
        except Exception as e:  # unloadable (corrupt/truncated) model — same fatality as missing
            _CLF, load_error = None, e
        if _CLF is None:
            reason = f"unloadable: {load_error}" if load_error is not None else "not found"
            if allow_degraded:
                _CLF_ABSENT = True
                print(f"[etl] WARNING: aspect model {reason} — DEGRADED keyword-aspect mode "
                      "(PROSPECT_ALLOW_NO_CLASSIFIER=1): 'NONE' windows are not dropped, "
                      "aspect counts inflate ~28%")
            else:
                model_path = os.path.join(
                    os.path.dirname(os.path.abspath(__file__)), aspect_classifier.MODEL_FILENAME)
                raise RuntimeError(
                    f"aspect classifier model {reason} ({model_path}). Without it the pipeline "
                    "silently degrades (keyword aspects only, 'NONE' class kept, counts inflated "
                    "~28%). Restore the model file, or set PROSPECT_ALLOW_NO_CLASSIFIER=1 to run "
                    "degraded on purpose."
                ) from load_error
        else:
            print(f"[etl] aspect classifier loaded ({_CLF.n_train:,} training examples)")
    return _CLF


def _probe_classifier() -> None:
    """Fail-fast presence/loadability check, run at the TOP of main().

    The fatal check above is LAZY — it first fires from inside compute_aspect_sentiment,
    which is reached only after create_staging() has run for an hour AND after
    _refresh_sentiment_cache() has already WIPED the 16M-row sentiment cache. (A missing
    model makes _aspect_model_fingerprint() return "absent"; that changes the sentiment
    config hash; that change IS the wipe.) So "fail fast" failed slow and took the cache
    with it, turning a clean abort into a multi-hour rescore on the next run. Worse in
    --light mode, which never calls _get_classifier() at all: it wiped the cache via
    compute_press_sentiment and exited 0, and the NEXT full build paid for the rescore.

    Probing here costs ~0.2s and aborts before staging, before the cache is attached, before
    any scratch is written. The model is dropped again immediately afterwards: it is ~150MB
    resident and there is no reason to hold it through staging on a 2.5GB droplet — the
    sentiment phase reloads it lazily, from the same cached-global path as before.
    PROSPECT_ALLOW_NO_CLASSIFIER=1 is unaffected: _get_classifier() sets _CLF_ABSENT and
    returns None, and that flag is deliberately NOT reset, so write_meta() still records
    sentiment_classifier=absent on the degraded build."""
    global _CLF
    _get_classifier()
    _CLF = None


def _build_aspect_keyword_votes(con: duckdb.DuckDBPyConnection, mention_table: str,
                                n_buckets: int = 1) -> None:
    """Build stg_aspect_keyword_votes: per (appid, keyword aspect, voted_up), how many reviews
    matched that aspect's keyword regex. This is mart_game_review_aspects'
    n_pos_mentions / n_neg_mentions, and it is the ONLY thing mart_game_teardown.sql used to
    need full review text for.

    WHY THIS IS THE SAME NUMBER the 10-arm regex scan produced (the whole point of the change):

      * ONE ROW PER (review, keyword arm). Both mention sources are written by
        _aspect_window_sql, whose per-arm SELECT filters the pool with
        `WHERE regexp_matches(review_text, '<rx>', 'i')` — the identical predicate, from the
        identical ASPECT_LEXICON entry, that mart_game_teardown.sql's _review_aspect_flags
        evaluated as a boolean column. It emits a row per MATCHING REVIEW, not per keyword
        occurrence, so a review naming "combat" five times contributes exactly 1, exactly as
        the boolean flag did. Verified on the live cache 2026-08-31: 21,679,495 rows, ZERO
        duplicate (recommendationid, aspect) pairs, so COUNT(*) here needs no DISTINCT (and a
        DISTINCT would reintroduce the 21.7M-row sort/aggregate that killed two nightlies).
      * `aspect` IS THE KEYWORD ARM, not the classifier's verdict. clf_aspect is stored
        alongside it precisely so the raw arm survives reassignment, and rows the classifier
        read as NONE are STORED, not discarded (2,450,174 of them today). There is deliberately
        NO clf filter here: these are the vote-split bars, which count keyword matches. The
        NONE-drop and the reassignment belong to the TEXT-sentiment columns, which come from
        stg_aspect_sentiment.
      * SAME POPULATION, SAME FLOOR, SAME CAP. _sent_pool_meta is stg_review_key (english +
        non-empty text) narrowed by the same COUNT(*) >= TEARDOWN_MIN_REVIEWS floor
        _teardown_elig applies, then capped to the newest SENTIMENT_POOL_CAP_PER_GAME reviews
        per game (2026-09-05) — and it is handed to the teardown AS stg_review_key when
        compute_aspect_sentiment finishes, so _teardown_elig counts exactly the reviews these
        votes were mined from. compute_aspect_sentiment scores every pool review not already in
        cache.scored_review BEFORE the mart loop runs — so by the time the teardown reads this,
        every in-scope review has been scanned. A game below the floor is scored by neither
        path; a game that crosses the floor gets its whole back-catalogue scored on the run it
        crosses, because the anti-join is against scored_review, not against the appid.
      * Reviews that match NOTHING contribute no rows on either side (they were `false` in all
        ten flag columns), and are still recorded in scored_review so they are never rescanned.

    Empirically diffed against the raw-regex path per (appid, aspect, voted_up) — see the
    equivalence run in the commit message and test_teardown_counts_from_cache.py.

    KNOWN GAP IN THE LIVE CACHE FILE — a DATA defect, not a defect in the argument above, but
    read this before trusting the numbers on the current droplet. Diffed over 316,485 reviews /
    600 games on 2026-08-31: the cache produced ZERO rows the raw regex does not reproduce
    (it is a strict subset, so nothing is over-counted), but 1,962 of 314,626 raw mentions
    (0.62%, in 118 of 9,404 cells, touching 73 of 600 games) were MISSING from it. Every single
    missing row is in the last two arms of _aspect_window_sql's UNION ALL — 1,902 Price & Value
    (arm 10) and 60 Content & Length (arm 9), zero in arms 1-8 — and every affected review has a
    cached arm set that is a clean PREFIX of the arms its text matches. That is the fingerprint
    of a scoring stream cut off mid-corpus by one of the OOM-killed builds, back when the delta
    was "not in aspect_mention" and a partially-scored review therefore looked finished; the
    2026-08-22 scored_review seed migration (`INSERT ... SELECT DISTINCT recommendationid FROM
    aspect_mention`) then froze that state in. The CURRENT code cannot create new holes:
    scored_review is written last, after every mention row, and a crash before it leaves the
    review out so the next run DELETEs its partial rows and rescans.
    The gap is not reachable from the cache alone (an incomplete arm set is indistinguishable
    from a review that genuinely mentions nothing else without re-reading the text), so the only
    repair is one full rescore: bump SENTIMENT_CACHE_VERSION, which makes
    _refresh_sentiment_cache wipe and refill.
    Until it is done, the same rows are already missing from the TEXT-sentiment columns and the
    drill-down excerpts, which have read this cache since 2026-07; the keyword-vote change makes
    the vote-split bars agree with them rather than introducing a new discrepancy.

    REPAIR STATUS (2026-09-01): the bump IS APPLIED — SENTIMENT_CACHE_VERSION is 2, changed by
    this commit and by nothing else in it, which is the whole reason the repair was deferred out
    of the earlier 37-file change (see the constant's own comment for that history). The FIRST
    FULL build after this lands wipes all three cache tables and refills them, closing the frozen
    hole; it is scheduled for the 21:00 UTC nightly_refresh of 2026-09-01 with an operator
    watching. A --light build never scores, so the 13:30 light_build cannot and will not do it.
    Live blast radius, measured on the droplet 2026-09-01: cache file 0.46 GB, aspect_mention
    21,684,113 rows, scored_review 24,458,199 rows, press_article 205,508 rows — all discarded
    and recomputed. Everything above remains the historical record of how the hole was created,
    found and measured; do not delete it just because the repair has shipped.

    WHY THIS RESCORE IS CHEAPER THAN THE ONES THAT DIED (re-verified against the current code,
    2026-09-01, because it is what makes running it survivable): a wipe puts the WHOLE eligible
    pool through _sent_new, the delta text table in compute_aspect_sentiment's cached branch.
    That table used to be the SECOND corpus-wide copy of review text alive at that moment — the
    first being staging's stg_review_text, 24.8M rows / 8.45GB, held as a TEMP table from
    create_staging until mart_game_teardown.sql dropped it. It is gone: create_staging now builds
    the text-free stg_review_key (same population, 282MB), _sent_new reads its text straight from
    src.reviews by key, and mart_game_aspect_reviews.sql's _aspectrev_base lost its own 8.45GB
    text column the same day (2026-08-31), re-reading text for the ranking survivors only. Grep
    confirms it: every remaining mention of stg_review_text in this repo is a comment about its
    removal. So the rescore's peak text is one full-pool copy instead of two concurrent ones.
    HONEST CAVEAT, not covered by that halving — AND IT IS WHAT KILLED THE 09-01 RUN. _sent_new
    was one TEMP table holding the whole delta, i.e. the whole pool on a wipe, and _sent_windows
    (the 10-arm window explosion built from it) was live alongside it for the entire scoring
    pass. TEMP tables are stored in DuckDB's temp directory and count against
    max_temp_directory_size, so that copy WAS the spill budget, and the 2026-09-01 nightly died
    on it: "failed to offload data block of size 256.0 KiB (14.9 GiB/15.0 GiB used)", 13,473s in,
    with the cache wiped and unrefilled. FIXED 2026-09-02: compute_aspect_sentiment scores in
    hash(recommendationid) buckets (PROSPECT_SENTIMENT_BUCKETS, default 8, the same knob this
    function takes), materialising one bucket of text and one bucket of windows at a time, so
    neither is ever more than 1/N of the pool. The wipe path is no longer a full-copy case; what
    remains is N streams of src.reviews instead of one. Left on the record because the reasoning
    above — that the halving alone made the rescore survivable — was wrong, and the next person
    sizing this phase should see why.

    `n_buckets` > 1 splits the scan on hash(recommendationid) — used for the 21.7M-row cache,
    where a single hash join against the 24.4M-row pool would not fit the box's memory budget.
    Bucketing is safe for a SUM: recommendationid is not part of the output grouping key, so a
    group's rows may land in several buckets, and the per-bucket partials are summed at the end.
    """
    con.execute("DROP TABLE IF EXISTS _kw_votes_part")
    con.execute(
        "CREATE TEMP TABLE _kw_votes_part("
        "appid INTEGER, aspect VARCHAR, voted_up BIGINT, n BIGINT)"
    )
    for b in range(n_buckets):
        # The bucket predicate is applied to BOTH sides. On p it is redundant by the equijoin
        # (equal ids hash equally), but stating it lets DuckDB shrink the join's build side
        # with the bucket instead of hashing all 24.4M pool rows once per bucket.
        bucket = (f"WHERE hash(m.recommendationid) % {n_buckets} = {b} "
                  f"AND hash(p.recommendationid) % {n_buckets} = {b}") if n_buckets > 1 else ""
        con.execute(
            f"""
            INSERT INTO _kw_votes_part
            SELECT p.appid, m.aspect, p.voted_up, COUNT(*)
            FROM {mention_table} m
            JOIN _sent_pool_meta p ON p.recommendationid = m.recommendationid
            {bucket}
            GROUP BY p.appid, m.aspect, p.voted_up
            """
        )
    con.execute(
        """
        CREATE TEMP TABLE stg_aspect_keyword_votes AS
        SELECT appid, aspect, voted_up, SUM(n) AS n_mentions
        FROM _kw_votes_part
        GROUP BY appid, aspect, voted_up
        """
    )
    con.execute("DROP TABLE IF EXISTS _kw_votes_part")


def compute_aspect_sentiment(con: duckdb.DuckDBPyConnection, data_dir: Path,
                             scoring_only: bool = False) -> int:
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

    THE POOL IS CAPPED PER GAME (2026-09-05): per eligible game only the newest
    SENTIMENT_POOL_CAP_PER_GAME reviews (highest recommendationid) are in scope — see that
    constant for the sizing and for why "newest" rather than "most helpful". The cap is applied
    once, where _sent_pool_meta is built, and every consumer derives from that table: the delta
    scored tonight, the read-back that builds the mention table, the keyword votes, the
    rescore_status pool figures and — via the stg_review_key hand-off at the very end — the
    teardown's n_reviews_sampled. Cache rows for reviews outside the cap are ignored, never
    deleted, so the cap can move in either direction without touching the cache.

    Scoring streams through _stream_vader_scores (a per-mention window table built in SQL, read
    via an independent cursor in bounded batches) — peak memory is one batch, never the whole
    ~1.7M-row corpus (matters on the 2GB Droplet).

    scoring_only=True (the --rescore-only mode) stops after the scoring loop: it refills the
    cache and writes the progress row, but skips the read-back and the keyword votes, which
    exist only to feed the marts this mode does not build. It returns the number of REVIEWS
    recorded this run rather than the in-scope mention count, since there is no in-scope set.

    THE CACHE IS NOT HELD WHILE SCORING (2026-09-02). The lock on sentiment_cache.duckdb is
    exclusive and cross-process, so anything this function holds it through, it denies to every
    other process (see _attach_sentiment_cache). A ~52h detached rescore holding it for the
    duration would block every light build for two and a half days, which is the whole reason
    --rescore-only would otherwise be pointless. So the cache is attached in three SHORT phases
    — plan, commit-each-bucket, finish — and the expensive part (the 10-arm window regex and the
    VADER+classifier stream, ~16 min per bucket) runs with it DETACHED, writing into a local
    staging table. Measured hold to commit one 125k-review bucket into a production-sized cache:
    ~0.8s on a dev laptop, ~3s scaled to the droplet, i.e. a duty cycle around 0.3%."""
    # Idempotent per connection: the nightly calls this once per process, but tests (and any
    # future re-entry) may not, and CREATE TEMP TABLE has no IF NOT EXISTS to fall back on.
    con.execute("DROP TABLE IF EXISTS stg_aspect_mention_sentiment")
    con.execute("DROP TABLE IF EXISTS stg_aspect_sentiment")
    con.execute("DROP TABLE IF EXISTS _sent_pool")
    con.execute("DROP TABLE IF EXISTS _sent_pool_meta")
    con.execute("DROP TABLE IF EXISTS stg_aspect_keyword_votes")
    # The eligible pool is stg_review_key (built by create_staging, same filters as the old
    # stg_review_text minus the text column) plus the per-game floor, CAPPED to the newest
    # SENTIMENT_POOL_CAP_PER_GAME reviews per game (see that constant for the why; 0 = uncapped).
    # THE CAP IS APPLIED HERE AND NOWHERE ELSE. This meta table is what every id-keyed step
    # below reads — the delta (_sent_new_ids), the uncached full-pool path (_sent_pool), the
    # read-back that builds stg_aspect_mention_sentiment, the keyword votes, the rescore_status
    # pool count — and the marts inherit it too: it is handed to them AS stg_review_key at the
    # end of this function, so mart_game_teardown.sql's floor and n_reviews_sampled describe
    # the same rows the mentions were mined from.
    #
    # The floor is evaluated on the UNCAPPED count (elig), the cap on the survivors; a game
    # with fewer reviews than the cap keeps all of them.
    #
    # voted_up rides along (2026-08-31) so stg_aspect_keyword_votes can be aggregated here,
    # while the cache is attached, without a second pass over anything. It is one byte a row
    # and it is what lets mart_game_teardown.sql stop re-running the 10 aspect regexes over
    # 24.8M reviews to recover a fact this function already knows.
    _cap = _sentiment_pool_cap()
    # Newest first = highest recommendationid, compared as a NUMBER. The ids are digit strings
    # of unequal length (8 digits until ~2016, 9 since), so a string sort would rank every
    # 2015 review above every 2024 one. TRY_CAST keeps a non-numeric id (test fixtures) from
    # failing the cast, and the trailing raw key keeps the order total for those too — the
    # ids are unique, so there are no ties and the pool is the same set night after night.
    _newest = (
        "QUALIFY row_number() OVER (PARTITION BY t.appid "
        "ORDER BY TRY_CAST(t.recommendationid AS BIGINT) DESC NULLS LAST, "
        f"t.recommendationid DESC) <= {_cap}"
    ) if _cap > 0 else ""
    con.execute(
        f"""
        CREATE TEMP TABLE _sent_pool_meta AS
        WITH elig AS (
            SELECT appid FROM stg_review_key
            GROUP BY appid HAVING COUNT(*) >= {TEARDOWN_MIN_REVIEWS}
        )
        SELECT t.appid, t.recommendationid, t.voted_up
        FROM stg_review_key t
        JOIN elig e ON e.appid = t.appid
        {_newest}
        """
    )

    if not _sentiment_cache_enabled():
        # Original, uncached path: score the WHOLE pool every run. This branch does still
        # materialize the text copy — _aspect_window_sql fans its source into a 10-arm UNION,
        # and 10 re-executions of a join-view cost far more than one copy (measured on the
        # cached path, 2026-08-23: 9.7h and a 22.7GiB spill). Acceptable here because the
        # uncached path is the explicit PROSPECT_SENTIMENT_CACHE=off fallback, not the nightly.
        # Text comes from src.reviews directly (the same filters staging applies) — there is no
        # corpus-wide text table in the build any more for it to copy from.
        con.execute(
            """
            CREATE TEMP TABLE _sent_pool AS
            SELECT p.appid, p.recommendationid, r.review_text
            FROM _sent_pool_meta p
            JOIN src.reviews r ON r.recommendationid = p.recommendationid
            """
        )
        con.execute("DROP TABLE IF EXISTS _sent_windows")
        con.execute(f"CREATE TABLE _sent_windows AS {_aspect_window_sql('_sent_pool')}")
        clf = _get_classifier()
        con.execute(
            "CREATE TEMP TABLE _sent_raw("
            "appid INTEGER, recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE, "
            "clf_aspect VARCHAR, clf_sentiment VARCHAR, clf_margin DOUBLE)"
        )
        if clf is not None:
            n_scored = _stream_vader_and_classify(
                con,
                "SELECT appid, recommendationid, aspect, window_text FROM _sent_windows",
                "INSERT INTO _sent_raw VALUES (?, ?, ?, ?, ?, ?, ?)",
                clf,
            )
        else:
            n_scored = _stream_vader_scores(
                con,
                "SELECT appid, recommendationid, aspect, window_text FROM _sent_windows",
                "INSERT INTO _sent_raw (appid, recommendationid, aspect, compound) VALUES (?, ?, ?, ?)",
            )
        # Same NONE-drop + one-row-per-(review, aspect) rule as the cached branch — the two paths
        # must produce identical tables or PROSPECT_SENTIMENT_CACHE=off would quietly mean
        # "different numbers", which is worse than being slow.
        con.execute(
            f"""
            CREATE TEMP TABLE stg_aspect_mention_sentiment AS
            SELECT appid, recommendationid, aspect, kw_aspect, compound,
                   -- Same praise/complaint source as the cached branch; the two paths must agree.
                   COALESCE(clf_sentiment,
                            CASE WHEN compound >= {SENTIMENT_POS_THRESHOLD} THEN 'praise'
                                 WHEN compound <= {SENTIMENT_NEG_THRESHOLD} THEN 'complaint'
                                 ELSE 'neutral' END) AS text_sentiment
            FROM (
                SELECT r.appid, r.recommendationid,
                       COALESCE(r.clf_aspect, r.aspect) AS aspect,
                       r.clf_sentiment,
                       -- See the cached branch: the excerpt regex needs the arm that cut the
                       -- window, not the aspect the classifier moved it to. Qualified with the
                       -- table alias on purpose — bare `aspect` here would be ambiguous with the
                       -- COALESCE alias above it, and resolving to that would silently defeat
                       -- the whole point of carrying this column.
                       r.aspect AS kw_aspect,
                       r.compound,
                       row_number() OVER (
                           PARTITION BY r.appid, r.recommendationid, COALESCE(r.clf_aspect, r.aspect)
                           ORDER BY r.clf_margin DESC NULLS LAST
                       ) AS rn
                FROM _sent_raw r
                WHERE clf_aspect IS NULL OR clf_aspect <> 'NONE'
            ) WHERE rn = 1
            """
        )
        n_scored = con.execute("SELECT COUNT(*) FROM stg_aspect_mention_sentiment").fetchone()[0]
        # The teardown's RAW keyword counts, off the same rows the cached branch reads out of
        # cache.aspect_mention — _sent_raw is one row per (review, keyword arm) too, and it is
        # written from the identical `WHERE regexp_matches(review_text, rx, 'i')` filter. NO
        # clf_aspect filter here on purpose: mart_game_review_aspects' n_pos/n_neg_mentions
        # count KEYWORD matches, which is what the 10-arm scan it replaces counted. (The
        # classifier's NONE-drop and its aspect reassignment apply to the TEXT-sentiment
        # columns only — those come from stg_aspect_sentiment, built below.)
        _build_aspect_keyword_votes(con, "_sent_raw")
        con.execute("DROP TABLE IF EXISTS _sent_raw")
        con.execute("DROP TABLE IF EXISTS _sent_windows")
    else:
        # PHASE 1 of three, and the cache is attached for ONLY these few seconds: work out what
        # this run has to score. See the docstring — the lock is exclusive and cross-process, so
        # every second spent holding it is a second denied to the light build sharing the box.
        _attach_sentiment_cache(con, data_dir)
        try:
            if _refresh_sentiment_cache(con):
                print("[etl] sentiment cache: config/version changed -> cache cleared, full rescore")

            # _new = pool reviews not yet SCANNED, per cache.scored_review — NOT "not in
            # aspect_mention". The old membership test conflated "never scanned" with "scanned,
            # matched no keyword", and the second class is ~10M reviews on this corpus: three
            # consecutive nightlies re-ran the regex over 10.96M / 10.38M / 10.77M reviews
            # (~20 min/night on 2 cores), one of them yielding exactly 0 new mention rows.
            # scored_review records the scan itself, so a zero-mention review is scanned once,
            # ever. Invariant (maintained by construction below): a recommendationid enters
            # scored_review only in the same run that inserted ALL the aspect rows it matches, so
            # membership there always means "fully represented in aspect_mention".
            # The anti-join runs over the LEAN meta table (~30 bytes/row) — never over text.
            # History of this block, because four builds in a row died here in four ways:
            # a text-carrying NOT IN CTAS (25.3GiB spill), then a view whose ids-to-pool join
            # _aspect_window_sql's 10-arm UNION re-executed ten times (22.7GiB / a 9.7h phase),
            # then a delta CTAS off a second full text pool (22.5GiB — cumulative: staging's
            # stg_review_text AND _sent_pool both held the same ~7GB of text), and finally the
            # single remaining corpus-wide copy on its own (8.45GB / 24.8M rows) once review
            # volume doubled. The invariant that survived all four, and that is now absolute:
            # ids live in lean tables, and the ONLY review text the build ever materialises is
            # the delta's own rows, below.
            con.execute("DROP TABLE IF EXISTS _sent_new_ids")
            con.execute(
                """
                CREATE TEMP TABLE _sent_new_ids AS
                SELECT p.appid, p.recommendationid
                FROM _sent_pool_meta p
                WHERE NOT EXISTS (
                    SELECT 1 FROM cache.scored_review s
                    WHERE s.recommendationid = p.recommendationid
                )
                """
            )
            n_new_reviews = con.execute("SELECT COUNT(*) FROM _sent_new_ids").fetchone()[0]
            con.execute("DROP VIEW IF EXISTS _sent_new")
            con.execute("DROP TABLE IF EXISTS _sent_new")
            con.execute("DROP TABLE IF EXISTS _sent_windows")

            # SCORED IN HASH BUCKETS (2026-09-02), not in one pass. Everything from here to the
            # scored_review INSERT runs once per bucket of hash(recommendationid) % _n_buckets,
            # so the two delta-proportional materialisations — the delta's review TEXT and the
            # 10-arm window explosion built from it — are never larger than 1/_n_buckets of the
            # pool at any instant.
            #
            # WHY. The 2026-09-01 nightly, the first full build after SENTIMENT_CACHE_VERSION
            # went 1 -> 2 and wiped the cache, died in this block after 13,473s with
            #     OutOfMemoryException: failed to offload data block of size 256.0 KiB
            #     (14.9 GiB/15.0 GiB used)   [the 'max_temp_directory_size' cap set in main()]
            # and left the cache WIPED BUT NOT REFILLED (aspect_mention/scored_review/
            # press_article all 0), which makes every subsequent build attempt the identical
            # full-corpus rescore and hit the identical wall. A wipe empties scored_review, so
            # the anti-join above returns the WHOLE 24.4M-review pool and this "delta" is the
            # entire corpus. In steady state it is ~1-2M reviews and none of this is expensive;
            # a wipe is rare, which is exactly why the bucketing the rest of this function grew
            # in 2026-08 never reached the code below.
            #
            # WHAT ACTUALLY EATS THE 15GiB (measured on duckdb 1.5.4, not assumed — the naive
            # reading blames _sent_windows and would have fixed nothing):
            #   * TEMP tables are stored in DuckDB's temp directory and DO count against
            #     max_temp_directory_size. A `CREATE TEMP TABLE ... AS` of ~700MB of
            #     incompressible text under a 400MB cap fails with this error verbatim.
            #   * A REGULAR table costs ZERO temp — the same CTAS into a regular table spends
            #     0 bytes there, because its rows go into the database file.
            # _sent_new is TEMP and, on a wipe, is the whole corpus: it, plus the 24.4M-row
            # build side of the join that fills it, is the spill budget. _sent_windows is
            # REGULAR (it must be — see below), so its cost lands on the .building file's
            # DISK instead: the other budget, the one whose exhaustion killed the 2026-08-30
            # run ("20.6 GiB/20.6 GiB used", i.e. every free byte on the volume). Bucketing
            # divides BOTH by _n_buckets, which is why the loop wraps both statements and not
            # just the window build.
            #
            # NOT FIXED BY RAISING THE CAP. max_temp_directory_size is deliberately below free
            # disk so a runaway query fails on its own budget instead of taking the filesystem,
            # the scraper's SQLite and the serving mart down with it. It did its job here.
            #
            # THE BUCKET IS THE UNIT OF WORK (2026-09-02), and that is what makes a rescore
            # RESUMABLE ACROSS RUNS. Each iteration below does three things to ONE bucket, all
            # three selected by the IDENTICAL predicate over the IDENTICAL table (_sent_pred,
            # applied to _sent_new_ids):
            #
            #     DELETE that bucket's stale mention rows
            #  -> SCORE that bucket, streaming into cache.aspect_mention
            #  -> RECORD that bucket's ids in cache.scored_review
            #
            # so "the id-set written to scored_review is exactly the id-set whose mention rows
            # were just fully committed" is true BY CONSTRUCTION, at any slicing granularity.
            # That is stronger than the previous shape (one write of the whole delta at the
            # end), which was safe only because the bucket boundary happened to coincide with
            # the review boundary — an accident that would silently stop holding the moment
            # anything sliced a review's own keyword arms across iterations, re-creating the
            # 0.62% prefix hole this rescore exists to repair. Here the invariant does not
            # depend on how the loop is sliced, only on the three predicates being the same
            # one; keep them literally the same string.
            #
            # WHAT THIS BUYS: a run that stops for ANY reason — deadline, OOM, SIGKILL, a
            # crash three buckets in — leaves every COMPLETED bucket permanently done. The
            # next run's anti-join (above) does not see those reviews, so it slices only what
            # remains and carries on. A 52-hour full rescore does not fit the nightly's
            # `timeout 21600`, and with an end-of-delta write it never could: every night
            # would redo the same first hours and throw them away. With this, ~7 buckets a
            # night stick, and the cache refills over ~4 weeks of nightlies (or in one
            # detached weekend run, which is the same code path with no deadline set).
            #
            # DIFFERENT BUCKET COUNT FROM THE READ-BACK BELOW, deliberately — they are bounding
            # different things. The read-back's PROSPECT_SENTIMENT_BUCKETS (default 8) bounds
            # MEMORY over a fixed 21.7M-row input that every run processes in full, so a fixed
            # count is right. This loop bounds TIME over an input that is 1.1M reviews on an
            # ordinary night and 24.4M on a wipe, so its count is derived from the delta's size
            # (see RESCORE_BUCKET_REVIEWS): ~9 buckets nightly, ~196 on a wipe. Pinning both to
            # one knob would either give the wipe 6.5-hour buckets that can never complete, or
            # give the ordinary night ~200 pointless re-streams of src.reviews.
            _score_buckets = _rescore_bucket_count(n_new_reviews)
            # Which buckets have work, from one lean pass over the ids (no text). This is not
            # an optimisation for the wipe — there every bucket is full — it is what keeps the
            # ORDINARY night honest: each bucket's text query streams the whole sqlite reviews
            # table past a hash join, so an unguarded loop would run _score_buckets full scans
            # of 24.8M rows on a night with nothing (or three things) to score.
            _todo = sorted(int(b) for (b,) in con.execute(
                f"SELECT DISTINCT hash(recommendationid) % {_score_buckets} FROM _sent_new_ids"
            ).fetchall())

            # Stop starting new buckets once the budget is gone. Checked BETWEEN buckets only:
            # the whole design rests on a bucket being atomic, so interrupting one mid-scoring
            # would just throw that bucket's work away on the next run's DELETE.
            _deadline = _sentiment_deadline()
            # What one bucket costs, for deciding whether the next one fits. Seeded from the
            # slowest bucket the PREVIOUS run recorded, because run one of a multi-night
            # rescore would otherwise have no estimate at all for its first bucket and could
            # start a 16-minute unit with two minutes left. Slowest, not average: the cost of
            # over-estimating is one idle bucket slot, the cost of under-estimating is the
            # SIGKILL this exists to avoid.
            _bucket_cost = con.execute(
                "SELECT COALESCE(MAX(slowest_bucket_seconds), 0.0) FROM cache.rescore_status"
            ).fetchone()[0] or 0.0

            # Baseline for "how many reviews did THIS run actually record", which a deadline
            # stop makes different from the size of the delta.
            _scored_before = con.execute("SELECT COUNT(*) FROM cache.scored_review").fetchone()[0]
        finally:
            # END OF PHASE 1. Everything below — the regex, the window explosion, the
            # VADER+classifier stream, i.e. all of the time — runs with the cache DETACHED and
            # therefore available to any other process on the box.
            _detach_sentiment_cache(con)

        # ---- SCORING. The cache is DETACHED for all of it except each bucket's own commit. --
        clf = _get_classifier()
        n_new_mentions = 0
        n_done = 0
        _stopped_early = None
        for _b in _todo:
            if _deadline is not None and time.monotonic() + _bucket_cost >= _deadline:
                _stopped_early = (
                    f"sentiment deadline reached "
                    f"({time.monotonic() - _PROC_T0:,.0f}s into the build; "
                    f"~{_bucket_cost:,.0f}s needed for the next bucket)"
                )
                break
            _t_bucket = time.monotonic()
            # ONE predicate, used verbatim by the DELETE, the text build and the
            # scored_review INSERT below. See the block comment above: the three agreeing
            # is the whole invariant, so they share the string rather than each spelling
            # it out.
            _sent_pred = f"hash(recommendationid) % {_score_buckets} = {_b}"
            _bucket_ids = f"SELECT recommendationid FROM _sent_new_ids WHERE {_sent_pred}"
            # THE ONLY REVIEW TEXT THIS BUILD MATERIALISES. Scope is one bucket of the
            # delta: pool reviews with no cache.scored_review record — reviews nobody has
            # ever run the aspect regexes over — narrowed to this bucket. In steady state
            # the whole delta is ~1-2M reviews / a few hundred MB against a 24.8M-row /
            # 8.45GB corpus; on a config-wipe rescore the delta is the whole pool, and
            # this bucket predicate is the only thing standing between that and the spill
            # budget.
            #
            # Text is read straight from src.reviews (sqlite) rather than from a staging
            # copy: there is no corpus-wide text table any more, and streaming the source
            # to pick out the bucket's rows never materialises the rows it discards. The
            # cost of bucketing is one such stream per bucket instead of one in total —
            # paid deliberately, because the alternative (one full-pool copy, sliced
            # afterwards) is the 8.45GB TEMP table that just killed the build.
            #
            # A TABLE, not a VIEW, so the 10-arm window scan below reads it without
            # re-running the join per arm (a view here cost a 9.7h phase and a 22.7GiB
            # spill in 2026-08).
            #
            # The bucket filter is applied inside the subquery rather than as an aliased
            # WHERE on the join, so the predicate text is the SAME _sent_pred the DELETE
            # above and the INSERT below use. It also shrinks the join's build side to the
            # bucket instead of hashing the whole delta once per bucket.
            con.execute(
                f"""
                CREATE TEMP TABLE _sent_new AS
                SELECT n.appid, n.recommendationid, r.review_text
                FROM (SELECT appid, recommendationid FROM _sent_new_ids
                      WHERE {_sent_pred}) n
                JOIN src.reviews r ON r.recommendationid = n.recommendationid
                """
            )
            # The expensive regex runs ONLY over this bucket of the delta, never the full
            # pool. REGULAR (not TEMP) so the INDEPENDENT read cursor in
            # _stream_vader_scores / _stream_vader_and_classify can see it — that is a
            # correctness requirement, not a preference, and bucketing must not quietly
            # turn it into a TEMP table to save spill. Dropped at the end of every
            # iteration so only one bucket's windows exist at a time and none of it ever
            # ships in the versioned .duckdb.
            con.execute(f"CREATE TABLE _sent_windows AS {_aspect_window_sql('_sent_new')}")
            # Scored into a LOCAL table, not straight into cache.aspect_mention. This is the
            # single change that makes a multi-day rescore coexist with the nightly light
            # build: the stream below is ~16 minutes per bucket, and it used to run with the
            # cache attached, i.e. with every other process on the box locked out of it for
            # the whole rescore. Nothing about the scoring needs the cache — only the commit
            # does — so the expensive part now runs detached and the hold drops to ~3s.
            con.execute("DROP TABLE IF EXISTS _bucket_mentions")
            con.execute(
                "CREATE TEMP TABLE _bucket_mentions("
                "recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE, "
                "clf_aspect VARCHAR, clf_sentiment VARCHAR, clf_margin DOUBLE)"
            )
            if clf is not None:
                n_bucket_mentions = _stream_vader_and_classify(
                    con,
                    "SELECT recommendationid, aspect, window_text FROM _sent_windows",
                    "INSERT INTO _bucket_mentions VALUES (?, ?, ?, ?, ?, ?)",
                    clf,
                )
            else:
                n_bucket_mentions = _stream_vader_scores(
                    con,
                    "SELECT recommendationid, aspect, window_text FROM _sent_windows",
                    "INSERT INTO _bucket_mentions (recommendationid, aspect, compound) VALUES (?, ?, ?)",
                )
            n_new_mentions += n_bucket_mentions
            con.execute("DROP TABLE IF EXISTS _sent_windows")
            con.execute("DROP TABLE IF EXISTS _sent_new")

            # PHASE 2, once per bucket: COMMIT THE BUCKET. The cache is attached for exactly
            # these three statements — measured at ~0.8s for a 125k-review bucket against a
            # production-sized cache on a laptop, ~3s scaled to the droplet — and released
            # again before the next bucket's 16 minutes of scoring. If a light build holds
            # the cache right now, _attach_sentiment_cache waits for it rather than dying
            # (the 2026-08-31 failure mode).
            #
            # ORDER IS THE INVARIANT, and all three use the SAME _sent_pred over the SAME
            # table:
            #   DELETE  — idempotent rescan: a previous run that died after writing some of
            #             these reviews' rows but before recording them leaves those rows
            #             behind, and they must go before the re-insert or the bucket
            #             double-counts. Scoped to this bucket, so it can never touch one
            #             this run has already finished or will never reach.
            #   INSERT mentions — every row for exactly these ids.
            #   INSERT ids      — LAST, and only now. From this statement onward "in
            #             scored_review" means "fully represented in aspect_mention" for
            #             them, and the next run's anti-join skips them forever. Interrupt
            #             anything above and the bucket simply never happened.
            # That identity — not the fact that buckets happen to split on review
            # boundaries — is what makes the completeness invariant hold, and it keeps
            # holding if this loop is ever sliced some other way.
            _attach_sentiment_cache(con, data_dir)
            try:
                con.execute(
                    f"DELETE FROM cache.aspect_mention WHERE recommendationid IN ({_bucket_ids})"
                )
                con.execute(
                    "INSERT INTO cache.aspect_mention "
                    "SELECT recommendationid, aspect, compound, clf_aspect, clf_sentiment, "
                    "clf_margin FROM _bucket_mentions"
                )
                con.execute(f"INSERT INTO cache.scored_review {_bucket_ids}")
            finally:
                _detach_sentiment_cache(con)
            con.execute("DROP TABLE IF EXISTS _bucket_mentions")
            _elapsed = time.monotonic() - _t_bucket
            _bucket_cost = max(_bucket_cost, _elapsed)
            n_done += 1

        con.execute("DROP TABLE IF EXISTS _sent_new_ids")

        # PHASE 3, the last attach: record progress, and (unless this is --rescore-only) read
        # the in-scope set back out for the marts. The read-back is the one genuinely long hold
        # left in this function — it materialises the whole 21.7M-row cache — which is exactly
        # why --rescore-only skips it: a mode whose job is to run for days beside a nightly must
        # not take the lock for minutes at a time.
        _attach_sentiment_cache(con, data_dir)
        try:
            # DURABLE PROGRESS. Written here, while the cache is still attached, so a
            # multi-night rescore can be followed from the cache file alone:
            #     duckdb data/sentiment_cache.duckdb -c 'SELECT * FROM rescore_status'
            # One row, replaced each run. See _attach_sentiment_cache for why this is a report
            # and never a source of truth.
            _pool_reviews = con.execute("SELECT COUNT(*) FROM _sent_pool_meta").fetchone()[0]
            _scored_reviews, _mention_rows = con.execute(
                "SELECT (SELECT COUNT(*) FROM cache.scored_review), "
                "       (SELECT COUNT(*) FROM cache.aspect_mention)"
            ).fetchone()
            # Progress is POOL reviews scored, not the cache's row count. Since the per-game
            # cap (SENTIMENT_POOL_CAP_PER_GAME) the cache legitimately holds rows for reviews
            # outside the pool — ignored, never deleted — so scored_review's size can exceed
            # the pool and would read as >100%. Every id this run recorded came from the delta,
            # which is exactly the pool's unscored part as of phase 1, so the pool's scored
            # count follows from those two numbers without another join over the cache.
            _pool_scored = _pool_reviews - n_new_reviews + (_scored_reviews - _scored_before)
            con.execute("DELETE FROM cache.rescore_status")
            con.execute(
                "INSERT INTO cache.rescore_status VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [datetime.now(timezone.utc), _pool_reviews, _pool_scored, _mention_rows,
                 len(_todo), n_done, _stopped_early, _bucket_cost],
            )
            _pct = (100.0 * _pool_scored / _pool_reviews) if _pool_reviews else 100.0
            print(f"[etl] aspect sentiment: {n_done}/{len(_todo)} bucket(s) scored this run "
                  f"({_score_buckets} bucket(s) planned over {n_new_reviews:,} unscored review(s)); "
                  f"pool {_pool_scored:,}/{_pool_reviews:,} reviews scored ({_pct:.1f}%)")
            if _stopped_early is not None:
                # A CLEAN stop, not a failure: the build carries on and publishes, every bucket
                # this run finished is permanently recorded, and the next run resumes from the
                # anti-join. The alternative is `timeout` SIGKILLing the process mid-bucket,
                # which loses that bucket AND the whole build.
                print(f"[etl] aspect sentiment: STOPPED EARLY between buckets — {_stopped_early}. "
                      f"{len(_todo) - n_done} bucket(s) deferred to the next run; progress is "
                      f"recorded in the cache (rescore_status).")

            if scoring_only:
                # --rescore-only stops here. Everything below builds staging tables that exist
                # solely to feed marts this mode does not build, and the read-back in particular
                # is the long cache hold this mode is designed to avoid.
                print(f"[etl] rescore-only: {_scored_reviews - _scored_before:,} review(s) "
                      f"recorded this run; {_pool_reviews - _pool_scored:,} still unscored")
                return _scored_reviews - _scored_before

            # Full in-scope set, read back from the cache (untouched old rows + just-inserted new
            # ones alike). Same shape/columns as the uncached branch above.
            #
            # BUILT IN HASH BUCKETS (2026-08-31), not one statement. This materialises the whole
            # scored corpus — 21,679,495 mention rows in, 17,441,773 out, and growing by ~1M a
            # night since review_refresh started working. As one statement it spilled past every
            # budget it was given and killed two consecutive nightlies:
            #   08-30: failed to offload data block (20.6 GiB/20.6 GiB used)  [= all free disk]
            #   08-31: failed to offload data block (14.9 GiB/15.0 GiB used)  [= the new cap]
            # Neither preserve_insertion_order=false nor swapping the dedup window for a hash
            # aggregate was enough on its own: the output is ~17.4M rows no matter how it is
            # computed, and 2500MB of memory cannot hold the intermediates for that in one go.
            #
            # Bucketing on hash(recommendationid) is SAFE because recommendationid is part of the
            # grouping key — every row of a given (appid, recommendationid, aspect) group lands in
            # the same bucket, so no group is ever split and each bucket's aggregate is final.
            # Peak memory is one bucket's worth; the cost is N scans of the cache instead of one.
            #
            # A MEMORY bound over a fixed, always-full-corpus input, which is why this one is a
            # flat count and the scoring loop's is derived from the delta (see the long note at
            # _score_buckets). Every run materialises the whole in-scope cache here — 21.7M rows
            # today — no matter how much of it was scored tonight, so there is no "size of the
            # work" to scale to and PROSPECT_SENTIMENT_BUCKETS=8 is simply what fits 2500MB.
            _n_buckets = max(1, int(os.environ.get("PROSPECT_SENTIMENT_BUCKETS", "8")))
            con.execute(
                """
                CREATE TEMP TABLE stg_aspect_mention_sentiment(
                    appid INTEGER, recommendationid VARCHAR, aspect VARCHAR,
                    kw_aspect VARCHAR, compound DOUBLE, text_sentiment VARCHAR)
                """
            )
            for _b in range(_n_buckets):
                con.execute(
                    f"""
                INSERT INTO stg_aspect_mention_sentiment
                -- The keyword arm only nominated this window; the classifier decides what it is
                -- ABOUT. Rows it reads as NONE are dropped outright — that class alone is 22% of
                -- keyword matches, and the regex had no way to express it. Fall back to the
                -- keyword aspect only when no verdict exists (model absent at scoring time).
                -- The aggregate below keeps one row per (review, aspect): several keyword arms of
                -- the same review routinely resolve to the same true aspect, and without that the
                -- winner would be counted two or three times.
                SELECT appid, recommendationid, aspect, kw_aspect, compound,
                       -- Praise/complaint now comes from the model's sentiment head, not VADER's
                       -- compound. On a blind 120-window sample VADER agreed with a human read
                       -- 65.8% of the time and the head 81.7%, winning 28 disagreements to 9 —
                       -- VADER has no idea what "not worth full price" or "the boss is not so
                       -- cool" mean, because it scores words, not the clause they sit in.
                       -- Falls back to the VADER band when no verdict exists, so a missing model
                       -- degrades to the old behaviour rather than blanking the column.
                       COALESCE(clf_sentiment,
                                CASE WHEN compound >= {SENTIMENT_POS_THRESHOLD} THEN 'praise'
                                     WHEN compound <= {SENTIMENT_NEG_THRESHOLD} THEN 'complaint'
                                     ELSE 'neutral' END) AS text_sentiment
                FROM (
                    -- ONE ROW PER (appid, review, aspect), by hash aggregate rather than a
                    -- window (2026-08-31). This was:
                    --     row_number() OVER (PARTITION BY ... ORDER BY clf_margin DESC NULLS LAST)
                    --     ... WHERE rn = 1
                    -- which makes DuckDB SORT the entire in-scope cache — 15,051,784 rows and
                    -- growing — to keep one row per group. That sort is what killed the 08-30
                    -- and 08-31 builds: "failed to offload data block (20.6 GiB/20.6 GiB used)",
                    -- i.e. it spilled until the disk was gone, 5.35h in, with nothing built.
                    -- arg_max is the same pick (highest clf_margin in the group) done as a hash
                    -- aggregate, which avoids the global sort. On its own that was NOT enough —
                    -- measured, not assumed: the 08-31 run still hit the cap, because the groups
                    -- here are nearly as numerous as the rows (17.4M groups from 21.7M rows, since
                    -- most reviews mention an aspect once). The bucketing above is what actually
                    -- bounds it; this just removes a sort that bought nothing.
                    --
                    -- COALESCE(clf_margin, -1e30) reproduces NULLS LAST exactly: arg_max
                    -- ignores rows whose ordering value is NULL, so a group whose margins are
                    -- ALL NULL (no classifier verdict — the documented model-absent path)
                    -- would otherwise vanish from the mart entirely instead of falling back to
                    -- the VADER band below. The sentinel keeps those groups and still ranks
                    -- them behind any real margin.
                    --
                    -- Ties are resolved arbitrarily, exactly as row_number() did — same
                    -- semantics, and nothing downstream depends on which tied row wins because
                    -- the tied rows agree on the aspect that keys the group.
                    SELECT p.appid,
                           m.recommendationid,
                           COALESCE(m.clf_aspect, m.aspect) AS aspect,
                           arg_max(m.clf_sentiment, COALESCE(m.clf_margin, -1e30)) AS clf_sentiment,
                           -- The arm whose regex CUT this window, kept alongside the verdict.
                           -- mart_game_aspect_reviews re-extracts the excerpt text with one
                           -- aspect's keyword regex, and after reassignment the displayed aspect
                           -- is no longer the one that matched — extracting by it yields '' and
                           -- the user sees an empty excerpt. Extracting by kw_aspect returns the
                           -- exact window the classifier actually judged.
                           arg_max(m.aspect, COALESCE(m.clf_margin, -1e30)) AS kw_aspect,
                           arg_max(m.compound, COALESCE(m.clf_margin, -1e30)) AS compound
                    -- _sent_pool_meta, not _sent_pool: the pool's text was shed right after
                    -- the delta materialized (see above); this join only needs appid + id.
                    FROM cache.aspect_mention m
                    JOIN _sent_pool_meta p ON p.recommendationid = m.recommendationid
                    WHERE (m.clf_aspect IS NULL OR m.clf_aspect <> 'NONE')
                      AND hash(m.recommendationid) % {_n_buckets} = {_b}
                    GROUP BY p.appid, m.recommendationid, COALESCE(m.clf_aspect, m.aspect)
                )
                """
                )
            n_scored = con.execute("SELECT COUNT(*) FROM stg_aspect_mention_sentiment").fetchone()[0]
            # The teardown's raw keyword counts, aggregated HERE — while the cache is still
            # attached — into a table small enough to hand to the mart loop (one row per
            # (eligible appid, aspect, voted_up), ~46k x 10 x 2 at most). Same bucketing as
            # above and for the same reason: the input is the 21.7M-row cache. See
            # _build_aspect_keyword_votes for why these counts equal the 10-arm regex scan
            # mart_game_teardown.sql used to run over all 24.8M reviews.
            _build_aspect_keyword_votes(con, "cache.aspect_mention", _n_buckets)
            # REVIEWS ACTUALLY SCORED THIS RUN, not the size of the delta it set out to score —
            # a deadline stop makes those two different, and this line is what an operator
            # reads to decide whether the night did anything. Derived from scored_review's own
            # growth, so it cannot drift from what was really recorded.
            n_reviews_scored = _scored_reviews - _scored_before
            print(f"[etl] aspect sentiment cache: {n_reviews_scored:,} new review(s) scored "
                  f"of {n_new_reviews:,} unscored "
                  f"({n_new_mentions:,} new mention rows); {n_scored:,} mention rows in scope total")
        finally:
            _detach_sentiment_cache(con)

    con.execute("DROP TABLE IF EXISTS _sent_pool")
    # HAND THE POOL TO THE MARTS (2026-09-05). mart_game_teardown.sql derives its eligibility
    # floor and n_reviews_sampled from stg_review_key, and the mention counts it publishes next
    # to that number were just mined from _sent_pool_meta — so from here on stg_review_key IS
    # the pool (floor + per-game cap), not staging's uncapped candidate set, and "N sampled
    # English reviews" means the N reviews the aspect bars were actually computed from. A
    # rename rather than a copy: same three columns, same rows every step above read, and the
    # teardown's own DROP at the end of its file still cleans it up. mart_game_aspect_reviews.sql
    # needs nothing: it reaches reviews only through stg_aspect_mention_sentiment, which is
    # pool-scoped already. Idempotent — the floor and cap applied to this table give this table.
    # (--rescore-only returned above and builds no marts, so it leaves staging's table alone.)
    con.execute("DROP TABLE IF EXISTS stg_review_key")
    con.execute("ALTER TABLE _sent_pool_meta RENAME TO stg_review_key")

    # Aggregate per (appid, aspect). pos/neg/neutral use VADER's ±0.05 band; sum_compound lets
    # the genre baseline pool a mention-weighted mean compound downstream.
    con.execute(
        f"""
        CREATE TEMP TABLE stg_aspect_sentiment AS
        SELECT appid, aspect,
            COUNT(*) AS n_text_scored,
            COALESCE(SUM(CASE WHEN text_sentiment = 'praise' THEN 1 ELSE 0 END), 0) AS n_text_pos,
            COALESCE(SUM(CASE WHEN text_sentiment = 'complaint' THEN 1 ELSE 0 END), 0) AS n_text_neg,
            COALESCE(SUM(CASE WHEN text_sentiment = 'neutral' THEN 1 ELSE 0 END), 0) AS n_text_neutral,
            -- sum_compound stays VADER: mean_compound is exposed as its own numeric signal, and
            -- the model's head is a 3-way label with no magnitude to average.
            SUM(compound) AS sum_compound
        FROM stg_aspect_mention_sentiment
        GROUP BY appid, aspect
        """
    )
    return n_scored


def repair_sentiment_arms(con: duckdb.DuckDBPyConnection, data_dir: Path) -> dict | None:
    """--repair-arms: find the reviews whose cached keyword-arm set is a strict SUBSET of the
    arms their text matches, and rescore exactly those — nothing else in the cache is touched.

    THE DEFECT IT REPAIRS is the one measured on 2026-08-31 and written up in
    _build_aspect_keyword_votes' KNOWN GAP paragraph: 1,962 of 314,626 raw mentions (0.62%)
    missing from cache.aspect_mention, every one in the last two arms of _aspect_window_sql's
    UNION ALL (1,902 Price & Value, 60 Content & Length), on reviews whose scoring stream an
    OOM-killed build cut mid-corpus and whose partial arm set the 2026-08-22 scored_review
    seed then froze in as "scanned" — every affected review's cached arms are a clean PREFIX
    of its raw arms. The repair chosen then was a SENTIMENT_CACHE_VERSION bump: a wipe and a
    57-hour rescore of 24.4M reviews that held three nightlies. The same hole is reachable
    for a fraction of that: one regex pass to find the mismatched reviews, and a rescore of
    only those.

    WHY THE SUBSET TEST IS SOUND. Every cached arm row was produced by the same per-arm
    `WHERE regexp_matches(review_text, rx, 'i')` filter, from the same ASPECT_LEXICON entry,
    that _aspect_window_sql evaluates here. The lexicon is part of _sentiment_config_hash, so
    while the stored hash equals the current one the regex cannot have changed under the
    cache, and a review's cached arm set is always a subset of its raw one; the only way the
    two can differ is rows that were never written, which is exactly the hole. Hence:
      * cached == raw           the ~99% case: intact, left alone;
      * cached STRICT SUBSET    the hole: DELETE the review's rows and rescore it in the same
                                bucket through the same scorer the nightly uses;
      * cached has an arm raw lacks (superset or mixed): the regex DID move under the cache,
                                which is the config hash's job, not this mode's — counted,
                                reported, left alone.
    An incomplete arm set is indistinguishable from a review that mentions nothing else
    WITHOUT re-reading the text — the reason the cache alone could never find the hole, and
    the reason this pass reads the text of every scored in-scope review exactly once. "In
    scope" is the nightly's own pool — the TEARDOWN_MIN_REVIEWS floor and the newest
    SENTIMENT_POOL_CAP_PER_GAME reviews per game — so a capped-out review's rows, which the
    nightly ignores, are never re-read or rewritten here either.

    COST, and why this is a pass and not a rescore. The raw arm set comes from
    _aspect_window_sql itself (one source of truth for what an arm matches), selecting only
    (recommendationid, aspect) out of it: DuckDB prunes the unreferenced window_text and
    kw_pos projections (verified with EXPLAIN on 1.5.4 — the plan holds the ten
    regexp_matches filters and nothing else), so the pass costs the ten keyword regexes over
    the text — the scan mart_game_teardown.sql ran nightly until 2026-08-31, ~20 min for
    ~11M reviews on the droplet — plus one src.reviews stream per bucket. VADER and the
    classifier run only over the mismatched reviews' windows: ~1% of the pool if the
    2026-08-31 measurement holds, i.e. tens of minutes rather than 52 hours.

    SAME DISCIPLINE AS THE SCORING LOOP, because it has the same neighbours:
      * BUCKETED on hash(recommendationid), so review text is never more than one bucket's
        worth at a time (REPAIR_BUCKET_REVIEWS — see it for why a repair bucket is 8x a
        scoring bucket);
      * the cache is attached for SHORT windows only — the plan, one read of each bucket's
        cached arms, one commit per bucket — and detached for the text stream, the regexes
        and the scoring, so a light build's press pass can take it meanwhile;
      * each commit is ORDERED so that a death anywhere inside it leaves the review unscanned
        rather than holed: its scored_review rows go first (from then on the nightly's
        anti-join would rescan it), its mention rows are replaced, and scored_review is
        re-inserted LAST — the same "an id is recorded only after all of its rows" invariant
        compute_aspect_sentiment's loop rests on;
      * the stored config hash is re-read at every commit and the run aborts if it moved: a
        concurrent wipe must never be handed rows scored under the previous config.

    RESUMABLE per bucket, from the cache file alone. cache.repair_arms_status holds one row
    per completed bucket of the current PASS (keyed by config hash and bucket count, so the
    partition is pinned for the pass even if the pool grows between runs); a rerun skips
    those buckets; once every bucket has a row the pass is complete and the next run reports
    its totals, clears them and starts a fresh pass — which is what makes the mode
    idempotent: a second pass over a repaired cache finds zero mismatches.
        duckdb data/sentiment_cache.duckdb -c 'SELECT * FROM repair_arms_status'
    A row is written only after its bucket's commit, so unlike rescore_status it is never
    stale. Honours PROSPECT_SENTIMENT_DEADLINE_SECONDS between buckets like the scoring loop.

    Returns the pass totals (checked, mismatched, rescored, raw_mentions, missing_mentions,
    superset, mixed, buckets, done) — main() prints them as the summary an operator compares
    against the 2026-08-31 measurement — or None when the cache is not keyed to the current
    scoring config (nothing in it is repairable; a full build or --rescore-only wipes it)."""
    for t in ("_repair_pool_meta", "_repair_ids", "_repair_text", "_repair_raw",
              "_repair_cached", "_repair_diff", "_repair_mismatch", "_repair_fix_text",
              "_repair_windows", "_repair_mentions"):
        con.execute(f"DROP TABLE IF EXISTS {t}")
    # The in-scope pool: the SAME population compute_aspect_sentiment scores — stg_review_key
    # under the per-game TEARDOWN_MIN_REVIEWS floor, then capped to the newest
    # SENTIMENT_POOL_CAP_PER_GAME reviews per game (2026-09-05; _sentiment_pool_cap reads the
    # PROSPECT_SENTIMENT_POOL_CAP override, 0 = uncapped). Spelled out rather than shared
    # because that function builds its copy inline as part of its own staging; the floor, the
    # cap and the QUALIFY ordering (numeric id, then the raw key — see the note at its
    # _sent_pool_meta CTAS) are kept identical to that CTAS on purpose, so this mode checks
    # exactly the reviews the nightly scores and never re-reads a capped-out review's text:
    # its cache rows are out of scope, ignored by the nightly and left alone here.
    _cap = _sentiment_pool_cap()
    _newest = (
        "QUALIFY row_number() OVER (PARTITION BY t.appid "
        "ORDER BY TRY_CAST(t.recommendationid AS BIGINT) DESC NULLS LAST, "
        f"t.recommendationid DESC) <= {_cap}"
    ) if _cap > 0 else ""
    con.execute(
        f"""
        CREATE TEMP TABLE _repair_pool_meta AS
        WITH elig AS (
            SELECT appid FROM stg_review_key
            GROUP BY appid HAVING COUNT(*) >= {TEARDOWN_MIN_REVIEWS}
        )
        SELECT t.appid, t.recommendationid
        FROM stg_review_key t
        JOIN elig e ON e.appid = t.appid
        {_newest}
        """
    )
    current_hash = _sentiment_config_hash()

    def _stored_hash() -> str | None:
        row = con.execute("SELECT value FROM cache.meta WHERE key = 'config_hash'").fetchone()
        return None if row is None else row[0]

    # PHASE 1: the plan, cache attached for seconds.
    _attach_sentiment_cache(con, data_dir)
    try:
        stored = _stored_hash()
        if stored != current_hash:
            print("ERROR: --repair-arms: the sentiment cache is not keyed to the current scoring "
                  f"config (stored {stored!r}, current {current_hash[:12]}...) — nothing in it "
                  "is repairable. The next full build or --rescore-only run wipes and refills it.",
                  file=sys.stderr)
            return None
        con.execute(
            "CREATE TABLE IF NOT EXISTS cache.repair_arms_status("
            "config_hash VARCHAR, n_buckets INTEGER, bucket INTEGER, checked BIGINT, "
            "raw_mentions BIGINT, mismatched BIGINT, missing_mentions BIGINT, rescored BIGINT, "
            "superset BIGINT, mixed BIGINT, seconds DOUBLE, completed_at TIMESTAMP)"
        )
        # CANDIDATES: pool reviews the cache claims to have scanned. Reviews it has NOT are the
        # nightly's delta and stay its business; reviews outside the per-game cap are not in
        # the pool at all, so their rows are neither checked nor touched. Lean (ids only), the
        # size of _sent_new_ids on a wipe.
        con.execute(
            """
            CREATE TEMP TABLE _repair_ids AS
            SELECT p.appid, p.recommendationid
            FROM _repair_pool_meta p
            WHERE EXISTS (
                SELECT 1 FROM cache.scored_review s
                WHERE s.recommendationid = p.recommendationid
            )
            """
        )
        n_candidates = con.execute("SELECT COUNT(*) FROM _repair_ids").fetchone()[0]
        # Rows from a previous config describe a cache that no longer exists.
        con.execute("DELETE FROM cache.repair_arms_status WHERE config_hash <> ?", [current_hash])
        prev = con.execute(
            "SELECT n_buckets, bucket, seconds FROM cache.repair_arms_status "
            "WHERE config_hash = ? ORDER BY bucket", [current_hash]
        ).fetchall()
        done: dict[int, float] = {}
        n_buckets = _repair_bucket_count(n_candidates)
        if prev and any(r[0] != prev[0][0] for r in prev):
            print("[etl] repair-arms: repair_arms_status holds rows from more than one bucket "
                  "count — discarding them and starting a fresh pass")
            con.execute("DELETE FROM cache.repair_arms_status WHERE config_hash = ?",
                        [current_hash])
        elif prev and len(prev) >= prev[0][0]:
            t = con.execute(
                "SELECT SUM(checked), SUM(mismatched), SUM(rescored), MAX(completed_at) "
                "FROM cache.repair_arms_status WHERE config_hash = ?", [current_hash]
            ).fetchone()
            print(f"[etl] repair-arms: the previous pass is complete ({prev[0][0]} bucket(s), "
                  f"finished {t[3]}): checked {t[0]:,}, mismatched {t[1]:,}, rescored {t[2]:,} "
                  "— starting a fresh pass")
            con.execute("DELETE FROM cache.repair_arms_status WHERE config_hash = ?",
                        [current_hash])
        elif prev:
            n_buckets = int(prev[0][0])
            done = {int(b): float(s or 0.0) for _n, b, s in prev}
            print(f"[etl] repair-arms: resuming — {len(done)}/{n_buckets} bucket(s) already "
                  "checked by a previous run")
    finally:
        _detach_sentiment_cache(con)
    con.execute("DROP TABLE IF EXISTS _repair_pool_meta")
    print(f"[etl] repair-arms: {n_candidates:,} scanned review(s) in scope, "
          f"{n_buckets} bucket(s), {n_buckets - len(done)} to check")

    clf = _get_classifier()
    _deadline = _sentiment_deadline()
    _bucket_cost = max(done.values(), default=0.0)
    n_done = 0
    _stopped_early = None
    for _b in range(n_buckets):
        if _b in done:
            continue
        if _deadline is not None and time.monotonic() + _bucket_cost >= _deadline:
            _stopped_early = (
                f"sentiment deadline reached ({time.monotonic() - _PROC_T0:,.0f}s into the run; "
                f"~{_bucket_cost:,.0f}s needed for the next bucket)"
            )
            break
        _t_bucket = time.monotonic()
        # ONE predicate for the bucket, used verbatim by every id-keyed step below — the same
        # rule as the scoring loop, and for the same reason.
        _pred = f"hash(recommendationid) % {n_buckets} = {_b}"
        _bucket_ids = f"SELECT recommendationid FROM _repair_ids WHERE {_pred}"
        checked = con.execute(f"SELECT COUNT(*) FROM _repair_ids WHERE {_pred}").fetchone()[0]
        raw = mismatched = missing = superset = mixed = 0
        con.execute("CREATE TEMP TABLE _repair_mismatch(recommendationid VARCHAR)")
        if checked:
            # THE ONLY REVIEW TEXT THIS RUN MATERIALISES: one bucket of the candidates, read
            # straight from src.reviews — the same shape as the scoring loop's _sent_new.
            con.execute(
                f"""
                CREATE TEMP TABLE _repair_text AS
                SELECT n.appid, n.recommendationid, r.review_text
                FROM (SELECT appid, recommendationid FROM _repair_ids WHERE {_pred}) n
                JOIN src.reviews r ON r.recommendationid = n.recommendationid
                """
            )
            # RAW ARMS: the (review, arm) pairs the text matches TODAY, from the one generator
            # that defines an arm. Only the two key columns are selected, so the window and
            # position regexes are pruned and this is the ten-filter keyword scan.
            con.execute(
                "CREATE TEMP TABLE _repair_raw AS "
                "SELECT DISTINCT recommendationid, aspect FROM ("
                f"{_aspect_window_sql('_repair_text')}"
                ")"
            )
            # CACHED ARMS for the same reviews — the one cache read per bucket, held for the
            # seconds it takes; the hash filter lets DuckDB cut the 21.7M-row table down to
            # the bucket before the semi-join.
            _attach_sentiment_cache(con, data_dir)
            try:
                con.execute(
                    f"""
                    CREATE TEMP TABLE _repair_cached AS
                    SELECT DISTINCT m.recommendationid, m.aspect
                    FROM cache.aspect_mention m
                    WHERE hash(m.recommendationid) % {n_buckets} = {_b}
                      AND m.recommendationid IN ({_bucket_ids})
                    """
                )
            finally:
                _detach_sentiment_cache(con)
            # THE COMPARISON, as sets: per review, arms the text matches that the cache lacks
            # (`missing`) and arms the cache holds that the text does not match (`extra`).
            # A review with no rows on either side is intact and never appears here.
            con.execute(
                """
                CREATE TEMP TABLE _repair_diff AS
                SELECT COALESCE(r.recommendationid, c.recommendationid) AS recommendationid,
                       COUNT(*) FILTER (WHERE c.aspect IS NULL) AS missing,
                       COUNT(*) FILTER (WHERE r.aspect IS NULL) AS extra
                FROM _repair_raw r
                FULL OUTER JOIN _repair_cached c
                  ON c.recommendationid = r.recommendationid AND c.aspect = r.aspect
                GROUP BY 1
                """
            )
            raw = con.execute("SELECT COUNT(*) FROM _repair_raw").fetchone()[0]
            mismatched, missing, superset, mixed = con.execute(
                """
                SELECT COUNT(*) FILTER (WHERE missing > 0 AND extra = 0),
                       COALESCE(SUM(missing) FILTER (WHERE missing > 0 AND extra = 0), 0),
                       COUNT(*) FILTER (WHERE missing = 0 AND extra > 0),
                       COUNT(*) FILTER (WHERE missing > 0 AND extra > 0)
                FROM _repair_diff
                """
            ).fetchone()
            mismatched, missing, superset, mixed = (int(mismatched), int(missing),
                                                    int(superset), int(mixed))
            con.execute(
                "INSERT INTO _repair_mismatch "
                "SELECT recommendationid FROM _repair_diff WHERE missing > 0 AND extra = 0"
            )
            if mismatched:
                # RESCORE the mismatched reviews — their text is already in hand — through
                # the identical window build and scorer the nightly uses, into a LOCAL table
                # committed below. REGULAR window table: the streaming cursor must see it.
                con.execute(
                    """
                    CREATE TEMP TABLE _repair_fix_text AS
                    SELECT t.appid, t.recommendationid, t.review_text
                    FROM _repair_text t
                    JOIN _repair_mismatch m ON m.recommendationid = t.recommendationid
                    """
                )
                con.execute(
                    f"CREATE TABLE _repair_windows AS {_aspect_window_sql('_repair_fix_text')}"
                )
                con.execute(
                    "CREATE TEMP TABLE _repair_mentions("
                    "recommendationid VARCHAR, aspect VARCHAR, compound DOUBLE, "
                    "clf_aspect VARCHAR, clf_sentiment VARCHAR, clf_margin DOUBLE)"
                )
                if clf is not None:
                    _stream_vader_and_classify(
                        con,
                        "SELECT recommendationid, aspect, window_text FROM _repair_windows",
                        "INSERT INTO _repair_mentions VALUES (?, ?, ?, ?, ?, ?)",
                        clf,
                    )
                else:
                    _stream_vader_scores(
                        con,
                        "SELECT recommendationid, aspect, window_text FROM _repair_windows",
                        "INSERT INTO _repair_mentions (recommendationid, aspect, compound) "
                        "VALUES (?, ?, ?)",
                    )
                con.execute("DROP TABLE IF EXISTS _repair_windows")
                con.execute("DROP TABLE IF EXISTS _repair_fix_text")
            for t in ("_repair_diff", "_repair_cached", "_repair_raw", "_repair_text"):
                con.execute(f"DROP TABLE IF EXISTS {t}")

        # COMMIT THE BUCKET — the cache attached for these few statements only. See the
        # docstring for the order: scored_review out FIRST, back in LAST.
        _attach_sentiment_cache(con, data_dir)
        try:
            if _stored_hash() != current_hash:
                raise RuntimeError(
                    "--repair-arms: the sentiment cache's config hash changed while the pass "
                    "was running (a concurrent build wiped or re-keyed it) — aborting before "
                    "any row scored under the previous config is committed"
                )
            if mismatched:
                con.execute(
                    "DELETE FROM cache.scored_review WHERE recommendationid IN "
                    "(SELECT recommendationid FROM _repair_mismatch)"
                )
                con.execute(
                    "DELETE FROM cache.aspect_mention WHERE recommendationid IN "
                    "(SELECT recommendationid FROM _repair_mismatch)"
                )
                con.execute(
                    "INSERT INTO cache.aspect_mention "
                    "SELECT recommendationid, aspect, compound, clf_aspect, clf_sentiment, "
                    "clf_margin FROM _repair_mentions"
                )
                con.execute(
                    "INSERT INTO cache.scored_review SELECT recommendationid FROM _repair_mismatch"
                )
            _elapsed = time.monotonic() - _t_bucket
            con.execute(
                "INSERT INTO cache.repair_arms_status VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [current_hash, n_buckets, _b, checked, raw, mismatched, missing, mismatched,
                 superset, mixed, _elapsed, datetime.now(timezone.utc)],
            )
        finally:
            _detach_sentiment_cache(con)
        con.execute("DROP TABLE IF EXISTS _repair_mentions")
        con.execute("DROP TABLE IF EXISTS _repair_mismatch")
        _bucket_cost = max(_bucket_cost, _elapsed)
        n_done += 1
        _drift = (f"; {superset + mixed:,} left alone (cached arms the text does not match)"
                  if superset or mixed else "")
        print(f"[etl] repair-arms bucket {_b + 1}/{n_buckets}: checked {checked:,}, "
              f"mismatched {mismatched:,}, rescored {mismatched:,} "
              f"({missing:,} missing mention row(s) of {raw:,} raw{_drift}; {_elapsed:,.1f}s)")
    con.execute("DROP TABLE IF EXISTS _repair_ids")

    # THE PASS TOTALS, from the status rows — this run's buckets plus any a previous run of
    # the same pass completed — so the summary means the same thing however many runs it took.
    _attach_sentiment_cache(con, data_dir)
    try:
        t = con.execute(
            "SELECT COUNT(*), COALESCE(SUM(checked), 0), COALESCE(SUM(mismatched), 0), "
            "COALESCE(SUM(rescored), 0), COALESCE(SUM(raw_mentions), 0), "
            "COALESCE(SUM(missing_mentions), 0), COALESCE(SUM(superset), 0), "
            "COALESCE(SUM(mixed), 0) "
            "FROM cache.repair_arms_status WHERE config_hash = ?", [current_hash]
        ).fetchone()
    finally:
        _detach_sentiment_cache(con)
    totals = {"buckets": n_buckets, "done": int(t[0]), "checked": int(t[1]),
              "mismatched": int(t[2]), "rescored": int(t[3]), "raw_mentions": int(t[4]),
              "missing_mentions": int(t[5]), "superset": int(t[6]), "mixed": int(t[7]),
              "stopped_early": _stopped_early, "buckets_this_run": n_done}
    _pct_reviews = (100.0 * totals["mismatched"] / totals["checked"]) if totals["checked"] else 0.0
    _pct_mentions = ((100.0 * totals["missing_mentions"] / totals["raw_mentions"])
                     if totals["raw_mentions"] else 0.0)
    # The two fractions an operator compares with the 2026-08-31 measurement (1,962 of
    # 314,626 raw mentions = 0.62%; 73 of 600 games touched): mismatched reviews over
    # checked, and missing mention rows over raw.
    print(f"[etl] repair-arms summary: {totals['done']}/{n_buckets} bucket(s) checked "
          f"({n_done} this run); checked {totals['checked']:,} review(s), "
          f"mismatched {totals['mismatched']:,} ({_pct_reviews:.3f}%), "
          f"rescored {totals['rescored']:,}; {totals['missing_mentions']:,} of "
          f"{totals['raw_mentions']:,} raw mention row(s) were missing ({_pct_mentions:.2f}%)"
          + (f"; {totals['superset'] + totals['mixed']:,} review(s) left alone with cached "
             "arms the text does not match" if totals["superset"] or totals["mixed"] else ""))
    if _stopped_early is not None:
        print(f"[etl] repair-arms: STOPPED EARLY between buckets — {_stopped_early}. "
              f"{n_buckets - totals['done']} bucket(s) deferred; rerun to continue "
              "(progress is in the cache: SELECT * FROM repair_arms_status)")
    return totals


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


def write_meta(con: duckdb.DuckDBPyConnection, source_db: str, mart_version: str,
               build_mode: str = "full", absent_sources: list[str] | tuple[str, ...] = (),
               classifier_absent: bool = False, fulltext_mode: str = "build",
               fulltext_built_at: str = "", fulltext_scored_reviews: str = "") -> None:
    """Provenance/meta rows for the mart. Beyond the headline stats:

      build_mode           'full' | 'light' — a --light build copies the heavy teardown/aspect
                           tables verbatim from the previous mart, so downstream consumers (and
                           the light-overwrite guard in main()) need to be able to tell the two
                           apart; the filename alone (prospect_<YYYYMMDD>.duckdb) cannot.
      fulltext_mode        'build' | 'copy' — whether THIS build ran the two full-text mart
                           files (mart_game_teardown.sql, mart_game_aspect_reviews.sql) or
                           copied their tables from the published mart. A --light build always
                           copies; a full build decides after scoring (see _decide_fulltext)
                           and stays build_mode='full' either way — every other mart is fresh.
      fulltext_built_at    when the full-text tables were last actually BUILT (ISO-8601 UTC),
      fulltext_scored_reviews
                           and how many reviews the sentiment cache had scored at that point
                           (COUNT(*) of scored_review; '' when the cache was off and there was
                           nothing to count). A copy carries BOTH forward unchanged from the
                           mart it copied, so they describe the tables' real provenance however
                           many marts have copied them since, and the next full build's `auto`
                           verdict reads them back (age / scored-delta thresholds). Blank or
                           missing means unknown, and unknown means rebuild next time.
      absent_sources       comma-joined optional source tables (GUARDED_SOURCE_TABLES) that were
                           genuinely absent this run — the queryable record of which mart
                           families were built empty on purpose (empty string = none).
      sentiment_classifier written only as 'absent', when PROSPECT_ALLOW_NO_CLASSIFIER=1
                           accepted a missing aspect model — flags a degraded build whose
                           aspect counts are keyword-only (inflated ~28%).
      source_db_mtime/size the source SQLite's mtime (ISO-8601 UTC) + size in bytes, from
                           os.stat at build time — lets a mart be matched back to the exact
                           source snapshot it was built from ('' when unreadable: the build
                           obviously succeeded, so this is provenance, not a gate).
      etl_git_sha          the ETL code's git SHA (best-effort `git rev-parse HEAD` from the
                           repo root; '' when not in a git checkout or git is unavailable).
      duckdb_version       the duckdb library version that built the file.
    """
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

    # Provenance (2026-09-01): best-effort on purpose — a failure here empties a row, it
    # never fails a build that otherwise succeeded.
    try:
        st = os.stat(source_db)
        source_mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(timespec="seconds")
        source_size = str(st.st_size)
    except OSError:
        source_mtime, source_size = "", ""
    try:
        git_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=HERE.parent,
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        git_sha = ""

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
        # v1 `opportunity` — frozen, still published alongside the v2 headline.
        "opportunity_weights": f"demand={W_DEMAND},competition={W_COMPETITION},quality_gap={W_QUALITY}",
        # v2 headline (rebuilt 2026-08-31): a renormalised blend of four 0..100 sub-scores,
        # multiplied by the supply brake. decline_gate survives as a falsification TELL and
        # is reported separately below — it no longer multiplies anything.
        "opportunity_v2_model": (
            f"core=mean(momentum={W2_MOMENTUM},market_pull={W2_MARKET},"
            f"revenue_spread={W2_SPREAD},quality_gap={W2_QUALITY}) over non-null terms; "
            f"score=core*supply_brake, brake={SUPPLY_BRAKE_FLOOR}+"
            f"{round(1 - SUPPLY_BRAKE_FLOOR, 2)}*supply_room/100; "
            f"anchors enter_pct={OPP_ENTER_PCT},flood_yoy={OPP_FLOOD_YOY},"
            f"winner_take_most={OPP_WINNER_TAKE_MOST},entrant_norm={OPP_ENTRANT_NORM}"
        ),
        "opportunity_v2_gate": (
            f"DIAGNOSTIC ONLY (not a score factor since 2026-08-31): "
            f"gate=1-(1-{GATE_FLOOR})*max(sat_severity,entrant_severity); "
            f"sat_full_decline={GATE_SAT_FULL_DECLINE},entrant_full={GATE_ENTRANT_FULL},"
            f"umbrella_n_games={UMBRELLA_N_GAMES}"
        ),
        "solo_tier_bars": (
            f"solo>={SOLO_TIER_SOLO_MIN},team<{SOLO_TIER_TEAM_MAX} "
            f"(solo_viability is a FLAG not a scale: catalog median 0.975, p10 0.913)"
        ),
        "ccu_panel_games": str(ccu_panel_games),
        "ccu_history_days": str(ccu_history_days),
        "build_mode": build_mode,
        "fulltext_mode": fulltext_mode,
        "fulltext_built_at": fulltext_built_at,
        "fulltext_scored_reviews": fulltext_scored_reviews,
        "absent_sources": ",".join(absent_sources),
        "source_db_mtime": source_mtime,
        "source_db_size": source_size,
        "etl_git_sha": git_sha,
        "duckdb_version": duckdb.__version__,
    }
    if classifier_absent:
        rows["sentiment_classifier"] = "absent"
    con.execute("DROP TABLE IF EXISTS mart_meta")
    con.execute("CREATE TABLE mart_meta(key VARCHAR, value VARCHAR)")
    con.executemany("INSERT INTO mart_meta VALUES (?, ?)", list(rows.items()))


# --------------------------------------------------------------------------------------
# Pre-swap validation gate. The build used to swap current.duckdb unconditionally — a
# silently-degraded build (broken source join, empty staging, a regressed mart file) went
# straight to production with exit 0. Before the os.replace/symlink swap, the finished
# .building file is compared table-by-table against the currently published mart and the
# build FAILS (non-zero exit, no swap, current.duckdb untouched) when data went missing.
# --------------------------------------------------------------------------------------
VALIDATE_MAX_DROP_PCT = 40.0     # a mart table shrinking more than this vs the published mart
                                 # fails the build; env-overridable via
                                 # PROSPECT_VALIDATE_MAX_DROP_PCT (nightly source growth means
                                 # real drops of this size are never organic).
VALIDATE_MAX_GROWTH_X = 5.0      # ...and the mirror image (2026-09-01): a table present in BOTH
                                 # artifacts growing to more than this many TIMES its previous
                                 # row count fails the build. That shape is the fingerprint of a
                                 # JOIN FAN-OUT (a duplicated join key multiplying rows), which
                                 # inflates every downstream aggregate while the row-count print
                                 # still looks superficially sane. Organic growth is additive —
                                 # a night's new releases/reviews — never multiplicative; on the
                                 # live catalog no table has ever moved more than a few % between
                                 # consecutive builds.
# Absolute sanity floors for the core tables, checked on EVERY build (a previous mart is not
# needed to know these are wrong). Floors sit far below the real counts so organic shrinkage
# never trips them, but a structurally broken build cannot clear them:
#   mart_game  ~174K rows on the 2026-08 catalog (the full live-games universe) -> floor 100K
#   mart_niche ~414 tags x windows x MIN_REVIEWS_LEVELS cuts, a few thousand rows  -> floor 1K
#   mart_game_review_aspects ~319K rows (teardown-eligible games x 10 aspects)    -> floor 100K
#   mart_entity ~225K rows (developer + publisher entities)                       -> floor 100K
VALIDATE_MIN_ROWS: dict[str, int] = {
    "mart_game": 100_000,
    "mart_niche": 1_000,
    "mart_game_review_aspects": 100_000,
    "mart_entity": 100_000,
}
# Deliberately NOT exempted by an absent source (below): none of these tables is derived from
# an optional source table, so nothing can legitimately explain their falling under the floor.

# Which mart tables draw their POPULATION from an OPTIONAL (guarded) source table. When
# that source is genuinely absent, those tables coming out empty — or much smaller — is the
# documented degraded mode (see GUARDED_SOURCE_TABLES and the create_*_staging functions),
# recorded in mart_meta.absent_sources by write_meta(). The gate exempts exactly those
# tables from the zero-row and max-drop checks, so a legitimately-absent optional source no
# longer kills a nightly that did precisely what it is documented to do. The exemption is
# keyed on the BUILD'S OWN recorded provenance: the same table emptying while its source is
# PRESENT is unexplained, and still fails.
#
# game_socials is absent from this map on purpose: its absence only NULLs columns
# (dev_x_handle/x_handle in mart_game), it never empties a table, so nothing needs exempting.
ABSENT_SOURCE_EMPTY_MARTS: dict[str, tuple[str, ...]] = {
    "player_counts": (
        "mart_game_players_daily",     # the daily CCU panel itself
        "mart_game_players_history",   # prospect_sample half of the all-sources history
        "mart_niche_players",          # + everything rolled up from the panel
        "mart_niche_players_hist",
        "mart_niche_players_top",
        "mart_game_trends",            # ccu-only months drop out of the (rev UNION ccu) spine
    ),
    "player_history_external": (
        "mart_game_players_history",   # steamcharts half of the same table
        "mart_niche_players_monthly",
        "mart_market_lifetime",        # survival curve is steamcharts-monthly only
    ),
    "review_histogram": (
        "mart_timing_demand",          # (mart_timing_congestion is NOT here: it is built from
        "mart_timing_decay",           #  stg_game/genres and survives an absent histogram)
        "mart_game_reviews_timeline",  # sample fallback only covers fully-sampled games
        "mart_game_trends",            # falls back to the reviews sample -> far fewer months
    ),
}


def _validate_max_drop_pct() -> float:
    raw = os.environ.get("PROSPECT_VALIDATE_MAX_DROP_PCT", "").strip()
    if raw:
        try:
            return float(raw)
        except ValueError:
            print(f"[etl] WARNING: ignoring non-numeric PROSPECT_VALIDATE_MAX_DROP_PCT={raw!r}")
    return VALIDATE_MAX_DROP_PCT


def _mart_row_counts(db_path: Path) -> dict[str, int]:
    """Row count of every mart% table in a mart file, opened READ-ONLY (the previous mart may
    be concurrently served; the new one is finished and closed)."""
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        tables = [r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_name LIKE 'mart%' ORDER BY table_name"
        ).fetchall()]
        return {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    finally:
        con.close()


def _mart_table_columns(db_path: Path) -> dict[str, set[str]]:
    """Column-name set of every mart% table in a mart file, opened READ-ONLY (same
    concurrency story as _mart_row_counts). Row counts alone cannot see a renamed or dropped
    column — the table keeps its name and roughly its size while a consumer's query breaks."""
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = 'main' AND table_name LIKE 'mart%' ORDER BY table_name"
        ).fetchall()
    finally:
        con.close()
    cols: dict[str, set[str]] = {}
    for tbl, col in rows:
        cols.setdefault(tbl, set()).add(col)
    return cols


def _recorded_absent_sources(db_path: Path) -> set[str]:
    """The optional source tables THIS build recorded as absent (write_meta's
    mart_meta.absent_sources). Read back out of the artifact rather than passed in, so the
    gate reaches the same verdict when it is re-run by hand against a preserved .building
    file. An unreadable/absent mart_meta yields no exemptions — refuse to explain away
    emptiness we cannot prove was intended."""
    try:
        con = duckdb.connect(str(db_path), read_only=True)
        try:
            row = con.execute(
                "SELECT value FROM mart_meta WHERE key = 'absent_sources'"
            ).fetchone()
        finally:
            con.close()
    except duckdb.Error:
        return set()
    if not row or not row[0]:
        return set()
    return {s.strip() for s in str(row[0]).split(",") if s.strip()}


def _validation_exemptions(new_path: Path) -> dict[str, list[str]]:
    """mart table -> the absent source table(s) that explain its emptiness this run."""
    exempt: dict[str, list[str]] = {}
    for src_tbl in sorted(_recorded_absent_sources(Path(new_path))):
        for mart_tbl in ABSENT_SOURCE_EMPTY_MARTS.get(src_tbl, ()):
            exempt.setdefault(mart_tbl, []).append(src_tbl)
    return exempt


def validate_mart(new_path: Path, prev_path: Path | None) -> list[str]:
    """The pre-swap gate. Prints a per-table old-vs-new comparison and returns the list of
    failures (empty = pass):

      - absolute floors (VALIDATE_MIN_ROWS) checked on every build, previous mart or not;
      - any table that had >0 rows in the previous mart and has 0 (or is gone) now;
      - any table that dropped more than the max-drop threshold vs the previous mart;
      - any table that GREW to more than VALIDATE_MAX_GROWTH_X times its previous row count
        (join-fan-out protection — see the constant's comment);
      - any table present in BOTH artifacts whose column-name set changed (a renamed or
        dropped column breaks consumers even when every row count looks fine). New tables
        (absent from the previous artifact) are exempt — nothing to compare against.

    UNEXPLAINED emptiness/shrinkage only. A mart family whose optional source table is
    genuinely absent this run is documented to build EMPTY (see ABSENT_SOURCE_EMPTY_MARTS
    and mart_meta.absent_sources) — failing the whole nightly for doing exactly that is how
    a gate gets switched off at 3am, so those tables are exempted from the empty/drop checks
    and the report says which ones and why. The exemption reads the build's own provenance,
    so the same table emptying with its source PRESENT still fails. (It never exempts the
    growth check: an absent source can only explain emptiness, never a >5x explosion.)

    First build (no previous mart) skips the comparison with a note — only the floors apply.
    A previous mart that exists but cannot be opened read-only (e.g. an exotic lock state)
    downgrades to a loud warning + floors-only: blocking every nightly on a transient lock
    would hurt more than one uncompared swap. mart_meta is exempt from the comparison (it is
    a small provenance key/value table whose keys legitimately come and go)."""
    failures: list[str] = []
    new_counts = _mart_row_counts(Path(new_path))
    max_drop = _validate_max_drop_pct()
    exempt = _validation_exemptions(Path(new_path))

    # Floors stay unconditional: no VALIDATE_MIN_ROWS table is derived from an optional
    # source, so an absent source can never explain one falling through its floor.
    for tbl, floor in VALIDATE_MIN_ROWS.items():
        n = new_counts.get(tbl, 0)
        if n < floor:
            failures.append(f"{tbl}: {n:,} rows is below the absolute sanity floor of {floor:,}")

    if exempt:
        absent = sorted({s for srcs in exempt.values() for s in srcs})
        print(f"[etl] validation: optional source(s) absent this run "
              f"(mart_meta.absent_sources: {', '.join(absent)}) — the tables below are "
              f"built empty BY DESIGN and are EXEMPT from the empty/drop checks:")
        for tbl in sorted(exempt):
            print(f"        {tbl:32s} exempt: no {', '.join(exempt[tbl])}")

    prev_counts: dict[str, int] | None = None
    prev_cols: dict[str, set[str]] | None = None
    if prev_path is None or not Path(prev_path).exists():
        print("[etl] validation: no previous mart to compare against (first build) — "
              "comparison skipped, absolute floors only")
    else:
        try:
            prev_counts = _mart_row_counts(Path(prev_path))
            prev_cols = _mart_table_columns(Path(prev_path))
        except duckdb.Error as e:
            print(f"[etl] validation WARNING: previous mart {prev_path} unreadable ({e}) — "
                  "comparison skipped, absolute floors only")

    if prev_counts is not None:
        print(f"[etl] validation: comparing against {prev_path} "
              f"(max allowed drop {max_drop:.0f}%, max growth {VALIDATE_MAX_GROWTH_X:.0f}x)")
        print(f"        {'table':32s} {'previous':>12s} {'new':>12s} {'change':>9s}")
        for tbl in sorted(set(prev_counts) | set(new_counts)):
            if tbl == "mart_meta":
                continue
            prev_n = prev_counts.get(tbl)
            new_n = new_counts.get(tbl, 0)
            if prev_n is None:
                print(f"        {tbl:32s} {'—':>12s} {new_n:>12,} {'NEW':>9s}")
                continue
            pct = ((new_n - prev_n) * 100.0 / prev_n) if prev_n > 0 else 0.0
            flag = ""
            # Growth first, EXEMPT or not: an absent optional source can only explain a table
            # going empty/small, never exploding — >VALIDATE_MAX_GROWTH_X is join fan-out
            # until proven otherwise, and fan-out corrupts everything downstream of the join.
            # prev_n == 0 is deliberately NOT checked: a previously-empty optional-source
            # family legitimately appears in one jump when its source table enters the
            # scrape (0 -> anything is not a multiple).
            if prev_n and new_n > VALIDATE_MAX_GROWTH_X * prev_n:
                flag = f"  FAIL (growth > {VALIDATE_MAX_GROWTH_X:.0f}x)"
                failures.append(f"{tbl}: {prev_n:,} -> {new_n:,} rows ({new_n / prev_n:.1f}x, "
                                f"exceeds the {VALIDATE_MAX_GROWTH_X:.0f}x runaway-growth cap — "
                                "suspect a join fan-out")
            elif tbl in exempt:
                flag = f"  EXEMPT ({', '.join(exempt[tbl])} absent)"
            elif prev_n > 0 and new_n == 0:
                flag = "  FAIL (was non-empty, now 0)"
                failures.append(f"{tbl}: {prev_n:,} rows -> 0 (previously non-empty table is empty)")
            elif prev_n > 0 and -pct > max_drop:
                flag = f"  FAIL (drop > {max_drop:.0f}%)"
                failures.append(f"{tbl}: {prev_n:,} -> {new_n:,} rows ({pct:+.1f}%, exceeds the "
                                f"{max_drop:.0f}% max drop)")
            print(f"        {tbl:32s} {prev_n:>12,} {new_n:>12,} {pct:>+8.1f}%{flag}")

        # Column-shape check (2026-09-01): a renamed/dropped column leaves row counts intact
        # while every consumer query against the old name breaks. Tables NEW vs the previous
        # artifact have nothing to compare against and are skipped. mart_meta's shape is
        # fixed (key, value) and rides the same comparison unremarkably.
        new_cols = _mart_table_columns(Path(new_path))
        for tbl in sorted(set(prev_cols or {}) & set(new_cols)):
            if tbl == "mart_meta":
                continue
            dropped = sorted(prev_cols[tbl] - new_cols[tbl])
            added = sorted(new_cols[tbl] - prev_cols[tbl])
            # ONLY `dropped` fails. An ADDED column is what every feature PR does, and failing
            # on it would mean the first nightly after any such merge refuses to swap
            # current.duckdb — a guaranteed 21:00 page whose only escape hatch is
            # --skip-validation, which is precisely how a gate gets switched off for good at
            # 3am (this file argues exactly that a few hundred lines up). A dropped or renamed
            # column is the one that breaks consumers, so that is what the gate guards.
            if added:
                print(f"        {tbl:32s} note: {len(added)} new column(s) {added} "
                      f"(informational — additions do not break consumers)")
            if dropped:
                failures.append(f"{tbl}: column(s) {dropped} disappeared vs the previous mart "
                                f"— a rename or drop breaks every consumer that reads them")
                print(f"        {tbl:32s} FAIL (columns dropped: {dropped})")
    return failures


def _light_overwrite_error(versioned: Path) -> str | None:
    """Guard for task '--light must never replace a same-day FULL build': a --light build
    writes the same prospect_<YYYYMMDD>.duckdb name as a full build, and its copied-stale
    teardown/aspect tables would silently supersede a full build's fresh ones. Returns an
    error string when the existing same-version file must not be overwritten by a light
    build, else None. Unknown provenance (no mart_meta / no build_mode key — a pre-marker
    build — or an unreadable file) counts as full: refuse unless proven light."""
    if not versioned.exists():
        return None
    try:
        c = duckdb.connect(str(versioned), read_only=True)
        try:
            row = c.execute("SELECT value FROM mart_meta WHERE key = 'build_mode'").fetchone()
        finally:
            c.close()
        mode = row[0] if row else None
    except duckdb.Error as e:
        return (f"--light refused: cannot read {versioned.name}'s mart_meta ({e}); "
                "it may be a full build, and a light build must never replace one. "
                "Run a full build, or remove the file deliberately first.")
    if mode != "light":
        described = f"build_mode={mode!r}" if mode is not None else "an unmarked (pre-build_mode) build, assumed full"
        return (f"--light refused: {versioned.name} already exists and is {described}. "
                "A light build (stale copied teardown/aspect tables) must never replace a "
                "same-day full build. Run a full build instead, or remove the file "
                "deliberately first.")
    return None


# --------------------------------------------------------------------------------------
# Full-text mart cadence (2026-09-04). The two full-text monsters — mart_game_teardown.sql's
# table family and mart_game_aspect_reviews — are re-derived from the WHOLE scored corpus
# every night, and they are the nightly's cost centre: on the last clean run
# mart_game_aspect_reviews.sql alone took 1401s of a 3154s build, and its materialisation is
# the ~18GB spill that filled the disk on 2026-08-30. Yet their input only changes as new
# reviews get scored into the sentiment cache — tens of thousands a night against a ~16M-row
# corpus — so a nightly rebuild recomputes the same tables from all but identical data.
#
# A FULL build therefore decides, AFTER scoring the night's delta, whether to rebuild them or
# to copy them verbatim from the published mart — the copy the 13:30 --light build has always
# done — and records the choice in mart_meta (fulltext_mode) next to the provenance the
# decision reads (fulltext_built_at, fulltext_scored_reviews). A copy carries that provenance
# forward UNCHANGED, so "how old are the full-text tables" is answered by their own build time
# however many marts have copied them since; and build_mode stays 'full' on a copy night —
# every other mart is fresh, and the --light overwrite guard keys on build_mode precisely so
# a light build cannot replace a same-day full one.
# --------------------------------------------------------------------------------------
FULLTEXT_MAX_AGE_HOURS = 44.0     # `auto` rebuilds once the published full-text tables are older
                                  # than this. 44h at a nightly cadence = every second night: the
                                  # age is read at decision time (~half an hour into a run), so
                                  # consecutive nights see ~23.5h then ~47.5h. Env override
                                  # PROSPECT_FULLTEXT_MAX_AGE_HOURS; 0 = rebuild every night.
FULLTEXT_REBUILD_DELTA = 500_000  # ...or once this many reviews were scored into the cache since
                                  # they were built, whichever comes first — a corpus that moved
                                  # this much is worth the 23 minutes. Env override
                                  # PROSPECT_FULLTEXT_REBUILD_DELTA.

# mart file -> the output tables it produces, copied verbatim from the published mart whenever
# the full-text marts are not rebuilt (every --light build; a full build whose verdict is
# 'copy'). Was LIGHT_COPY, a local of main(), until the full build started sharing it.
FULLTEXT_COPY_TABLES: dict[str, list[str]] = {
    "mart_game_teardown.sql": [
        "mart_game_review_aspects", "mart_genre_aspect_baseline",
        "mart_game_press_summary", "mart_game_press_by_source",
        "mart_game_press_timeline", "mart_game_press_notable",
    ],
    "mart_game_aspect_reviews.sql": ["mart_game_aspect_reviews"],
}


def _fulltext_max_age_hours() -> float:
    raw = os.environ.get("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "").strip()
    if raw:
        try:
            return float(raw)
        except ValueError:
            print(f"[etl] WARNING: ignoring non-numeric PROSPECT_FULLTEXT_MAX_AGE_HOURS={raw!r}")
    return FULLTEXT_MAX_AGE_HOURS


def _fulltext_rebuild_delta() -> int:
    raw = os.environ.get("PROSPECT_FULLTEXT_REBUILD_DELTA", "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            print(f"[etl] WARNING: ignoring non-integer PROSPECT_FULLTEXT_REBUILD_DELTA={raw!r}")
    return FULLTEXT_REBUILD_DELTA


def _read_mart_meta(db_path: Path) -> dict[str, str]:
    """Every mart_meta row of a mart file, opened READ-ONLY (it is the mart being served).
    {} when the file, or its mart_meta, cannot be read — the cadence reads that as "no
    provenance" and rebuilds, the same verdict a pre-cadence mart gets."""
    try:
        con = duckdb.connect(str(db_path), read_only=True)
        try:
            rows = con.execute("SELECT key, value FROM mart_meta").fetchall()
        finally:
            con.close()
    except duckdb.Error:
        return {}
    return {str(k): "" if v is None else str(v) for k, v in rows}


@dataclass(frozen=True)
class FulltextPlan:
    """What one build does with the full-text marts, and the provenance it records for it.

      mode            'build' | 'copy' (mart_meta.fulltext_mode).
      reason          one log line's worth of why; main() prints it verbatim.
      built_at        mart_meta.fulltext_built_at — the decision's own UTC timestamp for a
                      build, the published mart's value carried forward unchanged for a copy.
      scored_reviews  mart_meta.fulltext_scored_reviews — COUNT(*) of the sentiment cache's
                      scored_review at build time ('' with the cache off: nothing to count),
                      again carried forward unchanged for a copy."""
    mode: str
    reason: str
    built_at: str
    scored_reviews: str


def _parse_fulltext_provenance(meta: dict[str, str]) -> tuple[datetime, int] | None:
    """(fulltext_built_at, fulltext_scored_reviews) of a published mart, or None when either is
    absent, blank or unparseable — a pre-cadence mart, or one built with the cache off."""
    try:
        built_at = datetime.fromisoformat(meta.get("fulltext_built_at", ""))
        scored = int(meta.get("fulltext_scored_reviews", ""))
    except (TypeError, ValueError):
        return None
    if built_at.tzinfo is None:
        built_at = built_at.replace(tzinfo=timezone.utc)
    return built_at, scored


def _decide_fulltext(requested: str, prev_name: str | None, prev_meta: dict[str, str],
                     scored_now: int | None, now: datetime | None = None,
                     max_age_hours: float | None = None,
                     rebuild_delta: int | None = None) -> FulltextPlan:
    """The cadence verdict for one build, evaluated after the night's delta has been scored.

      requested    the --fulltext flag. 'build' and 'copy' are obeyed as-is (main() passes
                   'copy' for --light). 'auto' rebuilds when there is no published mart to
                   copy from, when its provenance is missing (the first night after this
                   landed, or a cache-off build), when its full-text tables are older than
                   max_age_hours, or when more than rebuild_delta reviews were scored since
                   they were built — and copies otherwise.
      prev_name    the published mart's name, for the log (None = nothing is published).
      prev_meta    its mart_meta rows (_read_mart_meta).
      scored_now   COUNT(*) of cache.scored_review after this run's scoring; None when the
                   cache is disabled, which 'auto' reads as "the delta cannot be bounded" and
                   rebuilds (with the cache off every run rescans the whole corpus anyway).
      now / max_age_hours / rebuild_delta
                   injectable for tests; None = the clock and the env knobs.

    Pure by design — no I/O — so every branch is unit-testable (tests/test_fulltext_cadence)."""
    now = datetime.now(timezone.utc) if now is None else now
    max_age_hours = _fulltext_max_age_hours() if max_age_hours is None else max_age_hours
    rebuild_delta = _fulltext_rebuild_delta() if rebuild_delta is None else rebuild_delta

    def build(reason: str) -> FulltextPlan:
        return FulltextPlan("build", reason, now.isoformat(timespec="seconds"),
                            "" if scored_now is None else str(scored_now))

    def copy(reason: str) -> FulltextPlan:
        return FulltextPlan("copy", reason, prev_meta.get("fulltext_built_at", ""),
                            prev_meta.get("fulltext_scored_reviews", ""))

    if requested == "build":
        return build("rebuilding (--fulltext build)")
    if requested == "copy":
        return copy(f"copied from {prev_name or '<nothing published>'} (--fulltext copy)")
    if requested != "auto":
        raise ValueError(f"unknown --fulltext mode {requested!r}")

    if prev_name is None:
        return build("rebuilding (no published mart to copy from)")
    provenance = _parse_fulltext_provenance(prev_meta)
    if provenance is None:
        return build(f"rebuilding ({prev_name} carries no full-text provenance: the first build "
                     "since the cadence landed, or a cache-off build)")
    prev_built_at, prev_scored = provenance
    age_h = (now - prev_built_at).total_seconds() / 3600.0
    if age_h > max_age_hours:
        return build(f"rebuilding (age {age_h:.1f}h > {max_age_hours:g}h)")
    thresholds = f"thresholds {max_age_hours:g}h / {rebuild_delta:,}"
    if scored_now is None:
        return build("rebuilding (sentiment cache disabled, so the scored delta cannot be "
                     f"bounded; {thresholds})")
    delta = scored_now - prev_scored
    if delta > rebuild_delta:
        return build(f"rebuilding ({delta:+,} scored since {prev_name}'s full-text build "
                     f"{age_h:.1f}h ago > {rebuild_delta:,})")
    return copy(f"copied from {prev_name} (built {age_h:.1f}h ago, {delta:+,} scored since; "
                f"{thresholds})")


def _count_scored_reviews(con: duckdb.DuckDBPyConnection, data_dir: Path) -> int | None:
    """COUNT(*) of the sentiment cache's scored_review — the cadence's measure of how far the
    scored corpus has moved. Read through one short attach of its own (the lock is exclusive
    and cross-process, see _attach_sentiment_cache; a count holds it for milliseconds) rather
    than threaded out of compute_aspect_sentiment, whose attach phases stay as they are.
    None with the cache disabled: there is then no durable scored set to count."""
    if not _sentiment_cache_enabled():
        return None
    _attach_sentiment_cache(con, data_dir)
    try:
        return con.execute("SELECT COUNT(*) FROM cache.scored_review").fetchone()[0]
    finally:
        _detach_sentiment_cache(con)


# --------------------------------------------------------------------------------------
# Build scratch: `prospect_<version>.duckdb.building` (the in-progress build), its `.wal`,
# and the `.building.tmp/` DuckDB spill directory (documented to reach 18GB on the droplet).
# Disk is the droplet's scarcest resource, so a dead build must not leave any of it behind —
# but the globs used to be UNSCOPED, so a run's pre-build sweep deleted EVERY version's
# scratch, including the live 18GB spill of a concurrent build (the midday --light run vs a
# nightly that overran, both writing the same-day version). Sweeping is now scoped to this
# run's version plus other versions' provably-dead leftovers, and never touches scratch that
# was written recently enough to belong to a build still in flight.
# --------------------------------------------------------------------------------------
SCRATCH_STALE_HOURS = 12.0      # another version's scratch older than this is provably dead
                                # (no build here has ever run longer than ~10h)
SCRATCH_ACTIVE_SECONDS = 3600   # anything written more recently than this may belong to a
                                # RUNNING build — never delete it, whatever version it is.
                                # Generous on purpose: the cost of guessing "dead" wrongly is
                                # a destroyed multi-hour build + its 18GB spill; the cost of
                                # guessing "alive" wrongly is that we build into an existing
                                # scratch file (every mart file DROPs before it CREATEs).
_SCRATCH_RE = re.compile(r"^prospect_(.+?)\.duckdb\.building(\.wal|\.tmp)?$")

# --rescore-only gets its OWN scratch name, outside the prospect_<version>.duckdb.building
# family entirely (2026-09-02). It publishes nothing — it writes the staging it needs to find
# the unscored delta, scores buckets into the sentiment cache, and exits — so naming its
# working file after a mart it will never write was a collision waiting to happen:
#
#   * the nightly derives prospect_<YYYYMMDD>.duckdb.building from the SAME UTC date, so a
#     multi-day rescore and a nightly that starts under it open the IDENTICAL file (plus the
#     GB-scale .building.tmp/ spill beside it), and prospect-refresh.sh has no guard that
#     would stop the nightly from trying;
#   * deploy/light-build-cron.sh sweeps `prospect_*.duckdb.building*` by age, and
#     prospect-refresh.sh's post-success cleanup does it with no age test at all — both would
#     happily delete a live rescore's spill;
#   * the only way to keep those apart used to be a build hold, which freezes ALL published
#     data for the length of the rescore — precisely what --rescore-only exists to avoid.
#
# The name is deliberately NOT `prospect_*`: it cannot match those shell globs, and it cannot
# match main()'s `prospect_*.duckdb` retention glob either, so no --keep value can ever see it
# as a dated mart. Nothing in it is durable (progress lives in the sentiment cache), so it is
# safe to reuse, recreate or delete between runs.
#
# LIFECYCLE — it must survive a multi-DAY rescore and still never linger forever:
#   * a clean or crashed exit removes it in main()'s finally, like any other scratch;
#   * a SIGKILL leaves it behind, so it is swept HERE instead, by every build_marts run
#     (nightly + light build = at least twice a day) under the same age rules as the versioned
#     scratch. Age is measured with _scratch_age_seconds, which looks one level INTO the spill
#     dir — a scoring rescore writes there continuously and to the scratch file once a bucket
#     (~16 min), so a live rescore is never mistaken for a dead one;
#   * a rescore that resumes reuses the file if it is there, and DuckDB's own file lock is then
#     what stops a SECOND rescore from starting on top of the first (see main()).
RESCORE_SCRATCH_DB_NAME = "rescore_scratch.duckdb"
# The pseudo-version this scratch is grouped under, so _sweep_stale_scratch's existing
# own-version/other-version rules apply to it unchanged. Never a real mart version (those are
# YYYYMMDD), which is what keeps "a rescore is running" and "a mart build is running" separate.
RESCORE_SCRATCH_VERSION = "rescore"


def _scratch_paths(data_dir: Path) -> dict[str, list[Path]]:
    """Every build-scratch path in data_dir, grouped by the mart version it belongs to
    (--rescore-only's scratch groups under RESCORE_SCRATCH_VERSION). Never matches
    prospect_*.duckdb, current.duckdb or the sentiment cache."""
    groups: dict[str, list[Path]] = {}
    for p in sorted(data_dir.glob("prospect_*.duckdb.building*")):
        m = _SCRATCH_RE.match(p.name)
        if m:
            groups.setdefault(m.group(1), []).append(p)
    # The rescore scratch, its .wal and its .tmp/ spill dir — one glob, since the name is a
    # fixed prefix rather than a version pattern.
    rescore = sorted(data_dir.glob(f"{RESCORE_SCRATCH_DB_NAME}*"))
    if rescore:
        groups[RESCORE_SCRATCH_VERSION] = rescore
    return groups


def _scratch_label(version: str) -> str:
    """How a version's scratch is named on disk — for log lines, which must print the glob the
    reader would actually type."""
    if version == RESCORE_SCRATCH_VERSION:
        return f"{RESCORE_SCRATCH_DB_NAME}*"
    return f"prospect_{version}.duckdb.building*"


def _scratch_age_seconds(paths: list[Path]) -> float:
    """Seconds since the newest write anywhere in this version's scratch. The spill dir is
    checked one level deep: DuckDB writes its temp blocks INSIDE it, and on some filesystems
    that never touches the directory's own mtime — reading only the dir would make a
    furiously-spilling build look idle."""
    newest = 0.0
    for p in paths:
        try:
            newest = max(newest, p.stat().st_mtime)
            if p.is_dir():
                for child in p.iterdir():
                    newest = max(newest, child.stat().st_mtime)
        except OSError:
            continue
    return (time.time() - newest) if newest else float("inf")


def _remove_scratch(paths: list[Path], keep_artifact: bool = False) -> None:
    """Delete the given scratch paths. `keep_artifact` spares the finished `.building` file
    and its `.wal` — a validation failure keeps the artifact so it can be inspected or
    landed without a 3-6 hour rebuild — but still removes the `.tmp/` spill dir, which is up
    to 18GB nobody can do anything with.

    The spill test is the `.tmp` SUFFIX, not `.building.tmp`: DuckDB names the spill after
    whatever database file it was given, so the rescore scratch's is rescore_scratch.duckdb.tmp
    and the narrower test silently left every byte of it on the disk (it is a directory, so the
    `is_file()` arm below skipped it too — a leak with no error and no log line)."""
    import shutil

    for p in sorted(paths):
        is_spill = p.name.endswith(".tmp")
        if keep_artifact and not is_spill:
            print(f"[etl] kept scratch {p.name} (validation failed — see the remedy above)")
            continue
        try:
            if is_spill and p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
                print(f"[etl] swept scratch dir {p.name}/")
            elif p.is_file():
                p.unlink()
                print(f"[etl] swept scratch {p.name}")
        except OSError as e:
            print(f"[etl] WARNING: could not remove scratch {p.name}: {e}")


def _sweep_stale_scratch(data_dir: Path, version: str) -> None:
    """PRE-BUILD sweep. Removes this run's own leftovers (a crashed earlier run of the same
    version) plus any OTHER version's scratch that is provably dead, and leaves everything
    else strictly alone. A version whose scratch was touched within SCRATCH_ACTIVE_SECONDS
    is treated as a build in flight and skipped loudly — if it really is running, DuckDB's
    own file lock stops us from opening it a moment later, which is the correct outcome.

    `version` is RESCORE_SCRATCH_VERSION for a --rescore-only run, so the rescore scratch is
    "own" to a rescore (reclaimed once provably dead) and "another version's" to a mart build
    (spared for SCRATCH_STALE_HOURS) — which is what lets a multi-day rescore and the nightly
    share the data dir. It is also why every build_marts run is what stops a SIGKILLed
    rescore's scratch from living on the disk forever: nothing else sweeps that name."""
    for v, paths in sorted(_scratch_paths(data_dir).items()):
        age = _scratch_age_seconds(paths)
        if age < SCRATCH_ACTIVE_SECONDS:
            print(f"[etl] NOT sweeping {_scratch_label(v)} — written "
                  f"{age / 60:.0f} min ago, a build may still be using it "
                  f"(remove it by hand if you know it is dead)")
            continue
        if v != version and age < SCRATCH_STALE_HOURS * 3600:
            print(f"[etl] NOT sweeping {_scratch_label(v)} — another version's "
                  f"scratch, only {age / 3600:.1f}h old (stale threshold "
                  f"{SCRATCH_STALE_HOURS:.0f}h)")
            continue
        _remove_scratch(paths)


def _sweep_own_scratch(data_dir: Path, version: str, keep_artifact: bool = False) -> None:
    """POST-BUILD sweep (main()'s finally): only THIS run's scratch, which is unambiguously
    ours to clean up. On success only the `.wal`/`.tmp` leftovers still exist — the
    `.building` file has already been os.replace()d into place."""
    _remove_scratch(_scratch_paths(data_dir).get(version, []), keep_artifact=keep_artifact)


def _refuse_publishing_rescore_scratch(building: Path) -> None:
    """The rescore scratch holds staging and NOT ONE mart row, so landing it as a mart would
    publish an empty catalog over a working one. --rescore-only returns from main() long
    before the validation gate, the os.replace or the symlink swap, so reaching any of them
    with this file means that early return was removed or bypassed — fail loudly instead of
    letting the next refactor discover the difference in production."""
    if building.name == RESCORE_SCRATCH_DB_NAME:
        raise RuntimeError(
            f"refusing to publish {building.name}: it is the --rescore-only scratch "
            "(staging only, no marts) and must never be validated, landed as a versioned "
            "mart or swapped into current.duckdb"
        )


def _live_mart_build_scratch(data_dir: Path) -> str | None:
    """The scratch label of a MART build (a nightly or a --light run, never the rescore
    family) written within SCRATCH_ACTIVE_SECONDS — i.e. one that may still be running — or
    None. --repair-arms refuses to start beside one: it deletes and rewrites cache rows a
    full build's read-back treats as settled, and a config wipe under it would be fed rows
    scored under the previous config. The other direction is enforced by the cron guards
    (deploy/prospect-refresh.sh and deploy/light-build-cron.sh skip themselves while any
    build_marts that is not a --rescore-only run is alive), and two rescore-family runs are
    kept apart by DuckDB's file lock on the scratch they share. Same liveness test as
    _sweep_stale_scratch, so a scratch this refuses is one the sweep would also have spared."""
    for v, paths in sorted(_scratch_paths(data_dir).items()):
        if v == RESCORE_SCRATCH_VERSION:
            continue
        if _scratch_age_seconds(paths) < SCRATCH_ACTIVE_SECONDS:
            return _scratch_label(v)
    return None


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Build Prospect DuckDB marts.")
    # Default source: PROSPECT_SOURCE_DB env first (the droplet's layout differs from the
    # laptop's), then the historical local path so a plain `task etl` keeps working.
    ap.add_argument("--source",
                    default=os.environ.get(
                        "PROSPECT_SOURCE_DB",
                        "/Users/maximbaginskiy/hobby/steam-scraper/steam_games.db"),
                    help="Path to the read-only steam_games.db SQLite source "
                         "(default: $PROSPECT_SOURCE_DB, else the local steam-scraper path).")
    ap.add_argument("--data-dir", default=str(HERE.parent / "data"),
                    help="Directory for versioned duckdb files + current.duckdb symlink.")
    # 2 = the serving mart + one rollback. Disk is the droplet's scarcest resource and the
    # deploy script's own duplicate prune is being removed separately — retention is owned
    # here, and 3 versions of a ~4GB mart was one version of pure waste.
    ap.add_argument("--keep", type=int, default=2,
                    help="How many versioned marts to retain (default 2: current + one rollback).")
    ap.add_argument("--light", action="store_true",
                    help="Fast partial build: rebuild every mart EXCEPT the two full-text "
                         "monsters (teardown family + aspect excerpts), whose tables are "
                         "copied verbatim from the currently published mart instead. Turns a "
                         "~3h build into ~30min so a data/mart fix is visible the same hour; "
                         "the copied review-text tables stay as fresh as the last full build.")
    ap.add_argument("--skip-validation", action="store_true",
                    help="Escape hatch: skip the pre-swap row-count validation gate and swap "
                         "unconditionally (e.g. after a deliberate mart removal or an expected "
                         "large shrink).")
    ap.add_argument("--rescore-only", action="store_true",
                    help="Refill the sentiment cache and NOTHING else: staging, then the "
                         "resumable bucket scoring loop, then exit. No marts, no press "
                         "sentiment, no validation, no swap — current.duckdb is never touched. "
                         "For running a multi-day full rescore beside the nightly: the cache "
                         "lock is only held for each bucket's ~3s commit, so --light builds "
                         "keep publishing fresh prices/players meanwhile. Resumable — rerun it "
                         "and it picks up where it stopped (progress: SELECT * FROM "
                         "rescore_status in the cache file).")
    ap.add_argument("--fulltext", choices=("auto", "build", "copy"), default="auto",
                    help="FULL builds only: what to do with the two full-text monsters "
                         "(mart_game_teardown.sql's tables and mart_game_aspect_reviews), "
                         "decided after the night's reviews are scored. auto (default) "
                         "rebuilds them when the published mart's copies are older than "
                         f"PROSPECT_FULLTEXT_MAX_AGE_HOURS ({FULLTEXT_MAX_AGE_HOURS:g}h, i.e. "
                         "every second night) or more than PROSPECT_FULLTEXT_REBUILD_DELTA "
                         f"({FULLTEXT_REBUILD_DELTA:,}) reviews were scored since they were "
                         "built, and otherwise copies them verbatim from the published mart "
                         "(~23 minutes and most of the spill saved); build / copy force either "
                         "way. --light always copies and never scores.")
    ap.add_argument("--repair-arms", action="store_true",
                    help="Repair the sentiment cache's frozen mention hole and NOTHING else: "
                         "staging, then one bucketed regex pass over every scored in-scope "
                         "review comparing the keyword arms its text matches with the arms "
                         "cached for it, rescoring only the reviews whose cached set is a "
                         "strict subset (the 2026-08-31 measurement: 0.62%% of mentions, all in "
                         "the last two arms). No marts, no press sentiment, no validation, no "
                         "swap; a full 24M-review rescore is never needed for this again. "
                         "Resumable per bucket (progress: SELECT * FROM repair_arms_status in "
                         "the cache file); a second run finds zero mismatches. Must not run "
                         "beside a nightly, a --light build or a --rescore-only run.")
    return ap


def _env_config_errors() -> list[str]:
    """Fail-fast validation of the env knobs main() honours (2026-09-01). A garbled value
    used to survive to its first USE — PROSPECT_SENTIMENT_BUCKETS all the way inside
    compute_aspect_sentiment, i.e. after an hour of staging and a sentiment-cache wipe — and
    crash the build hours in for want of a 10-second check. Unset values are fine (each knob
    has a default); only SET-but-unparseable values are errors."""
    errors: list[str] = []
    raw = os.environ.get("PROSPECT_SENTIMENT_BUCKETS", "").strip()
    if raw:
        try:
            buckets = int(raw)
        except ValueError:
            buckets = 0
        if buckets < 1:
            errors.append(f"PROSPECT_SENTIMENT_BUCKETS={raw!r} is not a positive integer "
                          "(hash-bucket count for the sentiment materialisation; unset = 8)")
    raw = os.environ.get("PROSPECT_RESCORE_BUCKET_REVIEWS", "").strip()
    if raw:
        try:
            per_bucket = int(raw)
        except ValueError:
            per_bucket = 0
        if per_bucket < 1:
            errors.append(f"PROSPECT_RESCORE_BUCKET_REVIEWS={raw!r} is not a positive integer "
                          "(target reviews per scoring bucket; unset = "
                          f"{RESCORE_BUCKET_REVIEWS:,})")
    raw = os.environ.get("PROSPECT_REPAIR_BUCKET_REVIEWS", "").strip()
    if raw:
        try:
            per_bucket = int(raw)
        except ValueError:
            per_bucket = 0
        if per_bucket < 1:
            errors.append(f"PROSPECT_REPAIR_BUCKET_REVIEWS={raw!r} is not a positive integer "
                          "(target reviews per --repair-arms bucket; unset = "
                          f"{REPAIR_BUCKET_REVIEWS:,})")
    raw = os.environ.get("PROSPECT_SENTIMENT_DEADLINE_SECONDS", "").strip()
    if raw:
        try:
            budget = float(raw)
        except ValueError:
            budget = -1.0
        if budget <= 0:
            errors.append(f"PROSPECT_SENTIMENT_DEADLINE_SECONDS={raw!r} is not a positive number "
                          "(wall-clock seconds from process start after which no NEW sentiment "
                          "bucket is started; unset = no deadline)")
    raw = os.environ.get("PROSPECT_SENTIMENT_POOL_CAP", "").strip()
    if raw:
        try:
            cap = int(raw)
        except ValueError:
            cap = -1
        if cap < 0 or 0 < cap < TEARDOWN_MIN_REVIEWS:
            errors.append(f"PROSPECT_SENTIMENT_POOL_CAP={raw!r} is not 0 (uncapped) or an "
                          f"integer >= TEARDOWN_MIN_REVIEWS ({TEARDOWN_MIN_REVIEWS}) — a cap "
                          "below the floor leaves every capped game short of it and drops it "
                          "from the teardown; unset = "
                          f"{SENTIMENT_POOL_CAP_PER_GAME:,} newest reviews per game")
    raw = os.environ.get("PROSPECT_DUCKDB_MEMORY_LIMIT", "").strip()
    # Deploy sets e.g. 2500MB (deploy/prospect-refresh.sh), so the contract is DuckDB's own
    # memory-limit grammar — a bare integer or an integer + size unit — not a bare int alone.
    if raw and not re.fullmatch(r"\d+\s*(?:[KMGT]B?)?", raw, re.IGNORECASE):
        errors.append(f"PROSPECT_DUCKDB_MEMORY_LIMIT={raw!r} is not an integer or an "
                      "integer + size unit (e.g. 2500MB) as `SET memory_limit` expects")
    # The full-text cadence knobs are read AFTER staging and scoring — exactly where a typo
    # would cost the most — so they are checked here with the rest.
    raw = os.environ.get("PROSPECT_FULLTEXT_MAX_AGE_HOURS", "").strip()
    if raw:
        try:
            hours = float(raw)
        except ValueError:
            hours = -1.0
        if not hours >= 0.0:   # written this way round so nan is refused too
            errors.append(f"PROSPECT_FULLTEXT_MAX_AGE_HOURS={raw!r} is not a non-negative number "
                          "(hours since the published full-text marts were built beyond which "
                          f"a full build rebuilds them; unset = {FULLTEXT_MAX_AGE_HOURS:g})")
    raw = os.environ.get("PROSPECT_FULLTEXT_REBUILD_DELTA", "").strip()
    if raw:
        try:
            delta = int(raw)
        except ValueError:
            delta = -1
        if delta < 0:
            errors.append(f"PROSPECT_FULLTEXT_REBUILD_DELTA={raw!r} is not a non-negative integer "
                          "(reviews scored since the published full-text marts were built beyond "
                          f"which a full build rebuilds them; unset = {FULLTEXT_REBUILD_DELTA:,})")
    return errors


def main() -> int:
    args = build_arg_parser().parse_args()

    source_db = str(Path(args.source).resolve())
    if not Path(source_db).exists():
        print(f"ERROR: source DB not found: {source_db}", file=sys.stderr)
        return 2

    # Garbled env knobs are refused HERE, next to the classifier probe, for the same reason
    # the probe is: left unchecked they crash the build HOURS in (see _env_config_errors).
    env_errors = _env_config_errors()
    for err in env_errors:
        print(f"ERROR: {err}", file=sys.stderr)
    if env_errors:
        return 2

    # A missing/unloadable aspect model is fatal — but the check has to happen HERE, before
    # create_staging() and before anything attaches (and invalidates) the sentiment cache.
    # See _probe_classifier: left lazy, the fatal check fired hours in, AFTER the 16M-row
    # cache had already been wiped by the very absence it was about to abort on.
    try:
        _probe_classifier()
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    mart_version = date.today().strftime("%Y%m%d")
    versioned = data_dir / f"prospect_{mart_version}.duckdb"
    current = data_dir / "current.duckdb"

    # --rescore-only builds no mart at all, so it has nothing to say about --light's copies or
    # the validation gate's swap. Refusing the combinations up front beats discovering an hour
    # in that the flags disagreed about what this run was for.
    if args.rescore_only:
        bad = [f for f, on in (("--light", args.light),
                               ("--skip-validation", args.skip_validation),
                               (f"--fulltext {args.fulltext}", args.fulltext != "auto")) if on]
        if bad:
            print(f"ERROR: --rescore-only cannot be combined with {', '.join(bad)} — it builds "
                  "no marts and never swaps, so there is nothing for those flags to affect.",
                  file=sys.stderr)
            return 2
        if not _sentiment_cache_enabled():
            print("ERROR: --rescore-only needs the sentiment cache, but "
                  "PROSPECT_SENTIMENT_CACHE is off — there would be nothing to refill.",
                  file=sys.stderr)
            return 2

    # --repair-arms is the same shape from here: staging, cache work, exit — no mart, no swap
    # — so it takes the same refusals, plus --rescore-only itself: it rewrites rows a rescore
    # regards as settled, and the two would fight over one scratch file anyway.
    if args.repair_arms:
        bad = [f for f, on in (("--light", args.light),
                               ("--rescore-only", args.rescore_only),
                               ("--skip-validation", args.skip_validation),
                               (f"--fulltext {args.fulltext}", args.fulltext != "auto")) if on]
        if bad:
            print(f"ERROR: --repair-arms cannot be combined with {', '.join(bad)} — it builds "
                  "no marts and never swaps, and it must not run inside a rescore.",
                  file=sys.stderr)
            return 2
        if not _sentiment_cache_enabled():
            print("ERROR: --repair-arms repairs the sentiment cache, but "
                  "PROSPECT_SENTIMENT_CACHE is off — there is nothing to repair.",
                  file=sys.stderr)
            return 2

    # A --light build must never replace a same-day FULL build (its teardown/aspect tables
    # are stale copies) — checked up front so the mistake costs seconds, not the 30min build.
    if args.light:
        err = _light_overwrite_error(versioned)
        if err is not None:
            print(f"ERROR: {err}", file=sys.stderr)
            return 2

    # --fulltext is a FULL build's choice. --light never scores, so it has nothing to build the
    # full-text marts from and always copies: `build` contradicts it outright (`copy`/`auto` are
    # what it does anyway). And an explicit `copy` with nothing published to copy from is
    # refused HERE, for the same reason as the --light guard: seconds, not an hour of staging.
    if args.light and args.fulltext == "build":
        print("ERROR: --light cannot be combined with --fulltext build — a light build never "
              "scores and always copies the full-text tables. Drop --light to rebuild them.",
              file=sys.stderr)
        return 2
    if args.fulltext == "copy" and not args.light and not current.exists():
        print("ERROR: --fulltext copy needs a published mart to copy the full-text tables from "
              f"({current} missing) — run a full build first.", file=sys.stderr)
        return 2

    # Build into a scratch file and only os.replace() it over the versioned name once the
    # build succeeds. A SAME-DAY rerun otherwise deletes and rebuilds the very file
    # current.duckdb points at, so the serving app and the ETL fight over a DuckDB file
    # lock — any app (re)start mid-build then crash-loops on "Conflicting lock is held"
    # (took the site down on 2026-08-04 after several manual same-day rebuilds). The
    # nightly never hits this only because each day gets a fresh filename; this makes
    # reruns safe regardless of restart timing. A failed/killed run leaves stale .building
    # scratch (the file, its .wal, an up-to-18GB .tmp spill dir) — swept here before the
    # build (scoped: this version plus provably-dead leftovers, never a live build's spill)
    # and again in the try/finally below, so a failed run cleans up after itself.
    #
    # --rescore-only builds into RESCORE_SCRATCH_DB_NAME instead, under its own pseudo-version.
    # It writes no mart, so naming its scratch after the date's mart made a multi-day rescore
    # and the nightly fight over one filename (and one spill dir) with nothing but a build hold
    # — i.e. a total publishing freeze — to keep them apart. See RESCORE_SCRATCH_DB_NAME.
    #
    # --repair-arms shares that scratch and its pseudo-version: it too writes only the sentiment
    # cache, may run for hours, and must not be swept by a nightly's stale-scratch sweep. Unlike
    # a rescore it must never run BESIDE a mart build, which is checked right after the sweep
    # on the sweep's own liveness test (see _live_mart_build_scratch).
    cache_only = args.rescore_only or args.repair_arms
    scratch_version = RESCORE_SCRATCH_VERSION if cache_only else mart_version
    _sweep_stale_scratch(data_dir, scratch_version)
    if args.repair_arms:
        live = _live_mart_build_scratch(data_dir)
        if live is not None:
            print(f"ERROR: --repair-arms must not run beside a mart build, and {live} was written "
                  f"less than {SCRATCH_ACTIVE_SECONDS / 60:.0f} min ago — a nightly or --light "
                  "build may be in flight. Wait for it to finish (or remove that scratch by hand "
                  "if you know it is dead).", file=sys.stderr)
            return 2
    building = (data_dir / RESCORE_SCRATCH_DB_NAME if cache_only
                else data_dir / f"prospect_{mart_version}.duckdb.building")

    params = build_params()
    print(f"[etl] source     : {source_db}")
    if cache_only:
        # Deliberately NOT the versioned mart path: these modes never write one, and printing
        # one would put a filename in the log that nothing on disk will ever match.
        print(f"[etl] output     : none — "
              f"{'--rescore-only' if args.rescore_only else '--repair-arms'} (scratch: {building})")
    else:
        print(f"[etl] output     : {versioned}")
    t0 = time.perf_counter()

    # Set only when the BUILD SUCCEEDED and the validation gate refused the swap: the
    # finished artifact is then kept on disk (see the remedy printed below). Every other
    # exit — success, crash, source error — cleans its scratch up as before.
    validation_failed = False
    # Resuming is the NORMAL case for a multi-night rescore, so the scratch it opens is often
    # the one a SIGKILL left behind minutes ago — the sweep above spares those on purpose (it
    # cannot tell a killed run's file from a running one's). Reusing it is safe and REQUIRES NO
    # CLEANUP: nothing in this file is durable (progress lives in the sentiment cache, staging
    # is rebuilt from src every run), and every working table the scoring path creates is either
    # TEMP or DROP-IF-EXISTS'd immediately before it is created — keep it that way, because a
    # plain CREATE TABLE added there would turn every resume into "Table with name X already
    # exists". test_a_killed_rescore_resumes_on_the_same_scratch pins exactly that.
    #
    # Not deleting the file first is also deliberate: DuckDB's file lock refusing this connect
    # is the ONLY thing that keeps a second rescore off a live one's scratch, and unlinking the
    # name would hand both processes their own inode and let them both run.
    reused_scratch = cache_only and building.exists()
    try:
      con = duckdb.connect(str(building))
      if reused_scratch:
          print(f"[etl] reusing the scratch {building.name} left by a previous run "
                "(nothing in it is durable — see the rescore-scratch notes)")
      try:
        # On memory-constrained hosts (e.g. a small Droplet) cap DuckDB's memory so it spills
        # to its on-disk temp dir instead of being OOM-killed. Env-driven; unset = default.
        _mem = os.environ.get("PROSPECT_DUCKDB_MEMORY_LIMIT")
        if _mem:
            con.execute(f"SET memory_limit='{_mem}'")
            print(f"[etl] duckdb memory_limit={_mem}")

        # SPILL CONTROL (2026-08-31). The 2026-08-30 nightly died here:
        #   OutOfMemoryException: failed to offload data block (20.6 GiB/20.6 GiB used)
        #   This limit was set by the 'max_temp_directory_size' setting.
        # It defaults to ALL free disk, so DuckDB spilled until the volume was full and then
        # failed — after 5.35h, with nothing built. Two settings, both straight out of that
        # error's own "possible solutions":
        #
        # preserve_insertion_order=false is the big one. Nothing here depends on insertion
        # order: every mart that has a meaningful order states it in an explicit ORDER BY
        # (and mart_game_aspect_reviews' was just given a unique tiebreak, so it no longer
        # varies at all), and the pre-swap validation gate compares row COUNTS. Turning it off
        # lets DuckDB stream large materialisations instead of buffering to preserve an order
        # nobody reads — which is exactly what the 15M-row rebuild of
        # stg_aspect_mention_sentiment at compute_aspect_sentiment() was buffering.
        #
        # max_temp_directory_size caps the spill BELOW free disk so a runaway query fails on
        # its own budget while the box still has room, instead of taking the filesystem — and
        # the scraper's SQLite, the app's mart and the next build's scratch down with it.
        con.execute("SET preserve_insertion_order=false")
        _tmp_max = os.environ.get("PROSPECT_DUCKDB_TEMP_MAX")
        if _tmp_max:
            con.execute(f"SET max_temp_directory_size='{_tmp_max}'")
        print(f"[etl] duckdb preserve_insertion_order=false"
              f"{f' max_temp_directory_size={_tmp_max}' if _tmp_max else ''}")
        con.execute("INSTALL sqlite; LOAD sqlite;")
        con.execute(f"ATTACH '{source_db}' AS src (TYPE sqlite, READ_ONLY)")

        # Verify the ATTACH actually exposes tables (hard fail if not) and enumerate them
        # once — the guarded staging below probes THIS listing, so a broken attach can no
        # longer masquerade as "every optional table is absent" (see the guarded-staging
        # block above create_ccu_staging).
        src_tables = _verify_source_attach(con)
        absent_sources = sorted(t for t in GUARDED_SOURCE_TABLES if t not in src_tables)

        print("[etl] building staging tables ...")
        create_staging(con, params)

        have_ccu = create_ccu_staging(con, src_tables)
        print("[etl] player_counts (live CCU): "
              + ("found" if have_ccu else "ABSENT — live_players will be NULL"))

        have_timing = create_timing_staging(con, src_tables)
        print("[etl] review_histogram (true monthly review counts): "
              + ("found" if have_timing else "ABSENT — mart_timing_* will be empty"))

        have_socials = create_socials_staging(con, src_tables)
        print("[etl] game_socials (official social links): "
              + ("found" if have_socials else "ABSENT — dev_x_handle/x_handle will be NULL"))

        if _sentiment_cache_enabled():
            print(f"[etl] sentiment cache  : {data_dir / SENTIMENT_CACHE_DB_NAME}")
        else:
            print("[etl] sentiment cache  : DISABLED (PROSPECT_SENTIMENT_CACHE=off) "
                  "-- full rescore every run, cache file untouched")

        # --rescore-only stops HERE, right after staging: score the delta into the sentiment
        # cache and return, without building a single mart. Staging is required and not
        # optional — the eligible pool comes from stg_review_key, so there is nothing to score
        # without it — but everything after this point exists to produce an artifact this mode
        # deliberately does not produce. Nothing is swapped, nothing is validated,
        # current.duckdb is not touched, and the .building scratch is swept by the finally
        # below exactly as it is for a failed build.
        if args.rescore_only:
            print("[etl] RESCORE-ONLY: refilling the sentiment cache; no marts, no swap")
            t_sent = time.perf_counter()
            n_sent = compute_aspect_sentiment(con, data_dir, scoring_only=True)
            print(f"[etl] rescore-only done: {n_sent:,} review(s) scored "
                  f"({time.perf_counter() - t_sent:.1f}s). Rerun to continue; check progress "
                  f"with: duckdb {data_dir / SENTIMENT_CACHE_DB_NAME} "
                  f"-c 'SELECT * FROM rescore_status'")
            return 0

        # --repair-arms stops HERE too, and for the same reason: staging's stg_review_key is
        # what tells it the in-scope pool, and nothing after this point exists for it. See
        # repair_sentiment_arms for what it does and why it is not a rescore.
        if args.repair_arms:
            print("[etl] REPAIR-ARMS: rescoring reviews whose cached arm set is a strict subset "
                  "of what their text matches; no marts, no swap")
            t_rep = time.perf_counter()
            totals = repair_sentiment_arms(con, data_dir)
            if totals is None:
                return 2
            print(f"[etl] repair-arms done: {totals['rescored']:,} review(s) rescored of "
                  f"{totals['checked']:,} checked ({time.perf_counter() - t_rep:.1f}s). Rerun to "
                  "continue, or to verify — a complete pass reports mismatched 0; progress: "
                  f"duckdb {data_dir / SENTIMENT_CACHE_DB_NAME} "
                  f"-c 'SELECT * FROM repair_arms_status'")
            return 0

        # The two full-text monsters (teardown family + aspect excerpts) are ~80% of a full
        # build. Instead of running them, their OUTPUT TABLES can be copied verbatim from the
        # currently published mart (FULLTEXT_COPY_TABLES). The copies happen at each file's
        # slot in MART_FILES, so downstream marts that read them (mart_niche_themes reads
        # mart_game_review_aspects) see them exactly where the build would have put them.
        #   --light  always copies, and skips aspect sentiment scoring with them — its staging
        #            is read by those two files only (the delta stays in src and is scored by
        #            the next full build; the cache loses nothing).
        #   full     ALWAYS scores the night's delta, then lets the cadence verdict (--fulltext
        #            auto|build|copy, see _decide_fulltext) choose copy or rebuild: the tables
        #            only change as reviews get scored, so at the defaults they are rebuilt
        #            every second night, or sooner when the scored corpus moved a lot.
        prev_mart = current.resolve() if current.exists() else None
        if args.light:
            if prev_mart is None:
                print("ERROR: --light needs a published mart to copy the heavy tables from "
                      f"({current} missing) — run a full build first.", file=sys.stderr)
                return 2
            print(f"[etl] LIGHT build: heavy tables copied from {prev_mart.name}, "
                  "aspect sentiment scoring skipped")
            n_sent = 0
            # Carries the copied tables' provenance forward (see write_meta). The line above
            # already says it copied, so the verdict is not printed a second time.
            fulltext = _decide_fulltext("copy", prev_mart.stem, _read_mart_meta(prev_mart), None)
        else:
            print("[etl] scoring aspect text sentiment (VADER) ...")
            t_sent = time.perf_counter()
            n_sent = compute_aspect_sentiment(con, data_dir)
            print(f"[etl] aspect sentiment: scored {n_sent:,} aspect mentions "
                  f"({time.perf_counter() - t_sent:.1f}s)")
            # Decided HERE: after the delta is scored, so the verdict reads tonight's cache, and
            # before the mart loop, so the timestamp it stamps is the tables' own input freeze.
            fulltext = _decide_fulltext(
                args.fulltext,
                None if prev_mart is None else prev_mart.stem,
                {} if prev_mart is None else _read_mart_meta(prev_mart),
                _count_scored_reviews(con, data_dir),
            )
            print(f"[etl] full-text marts: {fulltext.reason}")
        copy_fulltext = fulltext.mode == "copy"
        if copy_fulltext:
            con.execute(f"ATTACH '{prev_mart}' AS prevmart (READ_ONLY)")

        print("[etl] scoring press-coverage sentiment (VADER) ...")
        t_press = time.perf_counter()
        n_press = compute_press_sentiment(con, data_dir)
        print(f"[etl] press sentiment: scored {n_press:,} articles "
              f"({time.perf_counter() - t_press:.1f}s)")

        for fname in MART_FILES:
            t = time.perf_counter()
            if copy_fulltext and fname in FULLTEXT_COPY_TABLES:
                for tbl in FULLTEXT_COPY_TABLES[fname]:
                    con.execute(f'CREATE TABLE "{tbl}" AS SELECT * FROM prevmart."{tbl}"')
                print(f"[etl] copied {fname:21s} ({time.perf_counter() - t:5.2f}s, "
                      f"{len(FULLTEXT_COPY_TABLES[fname])} table(s) from previous mart)")
                continue
            sql_path = HERE / "marts" / fname
            sql = render(sql_path.read_text(), params)
            con.execute(sql)
            print(f"[etl] ran {fname:24s} ({time.perf_counter() - t:5.2f}s)")

        if copy_fulltext:
            con.execute("DETACH prevmart")

        write_meta(con, source_db, mart_version,
                   build_mode="light" if args.light else "full",
                   absent_sources=absent_sources,
                   classifier_absent=_CLF_ABSENT,
                   fulltext_mode=fulltext.mode,
                   fulltext_built_at=fulltext.built_at,
                   fulltext_scored_reviews=fulltext.scored_reviews)

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

      # Nothing below this line may run against the rescore scratch — see the helper.
      _refuse_publishing_rescore_scratch(building)

      # Pre-swap validation gate: compare the finished build against the currently
      # published mart and refuse to swap when data went missing (see validate_mart).
      if args.skip_validation:
          print("[etl] validation: SKIPPED (--skip-validation)")
      else:
          prev_mart = current.resolve() if current.exists() else None
          failures = validate_mart(building, prev_mart)
          if failures:
              # The build itself SUCCEEDED — only the gate objected. Sweeping the finished
              # file here would make every remedy cost a fresh 3-6 hour build and leave the
              # operator nothing to inspect, which is how "--skip-validation" turns into a
              # habit. Keep the artifact (the .tmp spill dir still goes) and print exactly
              # what is on disk and what each option actually costs.
              validation_failed = True
              print(f"\n[etl] VALIDATION FAILED — {len(failures)} problem(s); "
                    f"current.duckdb is NOT being swapped:", file=sys.stderr)
              for f in failures:
                  print(f"        - {f}", file=sys.stderr)
              print(
                  f"\n        The finished build is KEPT for inspection (only its spill dir\n"
                  f"        was removed):  {building}\n"
                  f"        Nothing was swapped — current.duckdb still serves the previous mart.\n"
                  f"        None of these need a rebuild:\n"
                  f"          inspect : duckdb -readonly {building}\n"
                  f"          ship it : mv {building} {versioned} && \\\n"
                  f"                    ln -sfn {versioned.name} {current}\n"
                  f"          discard : rm -rf {building} {building}.wal\n"
                  f"        (--skip-validation swaps unconditionally but REBUILDS from scratch;\n"
                  f"         the next build of version {mart_version} sweeps this file.)",
                  file=sys.stderr)
              return 1

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

      # Retention: keep the newest N versioned files (default 2 = current + one rollback;
      # disk is the droplet's scarcest resource). Never matches the sentiment cache, the
      # .building scratch or the rescore scratch — the glob is exact-suffix AND
      # prospect_-prefixed, which is exactly why RESCORE_SCRATCH_DB_NAME is neither.
      versions = sorted(data_dir.glob("prospect_*.duckdb"), key=lambda p: p.name, reverse=True)
      for old in versions[args.keep:]:
          old.unlink()
          print(f"[etl] pruned old mart {old.name}")
    finally:
        # Scratch is owned by the tool: a failed/aborted build removes its own .building
        # file, .wal, and spill dir (disk beats post-mortem artifacts — the log has the
        # diagnostics); on success this only sweeps the .wal/.tmp leftovers, since the
        # .building file itself was just os.replace()d into place. The ONE exception is a
        # validation failure, where the build finished and only the gate objected: the
        # artifact is worth 3-6 hours and is kept (its spill dir is not).
        #
        # For --rescore-only this is what keeps the data dir clean between nights: the scratch
        # is disposable (progress is in the sentiment cache), so every exit that runs a finally
        # removes it. Only a SIGKILL can leave it behind, and the next run's _sweep_stale_scratch
        # collects it.
        _sweep_own_scratch(data_dir, scratch_version, keep_artifact=validation_failed)

    print(f"[etl] done in {time.perf_counter() - t0:.1f}s  (version {mart_version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
