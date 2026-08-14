"""Prospect MCP server — Steam market-intelligence marts exposed as agent tools.

Mirrors the pattern in steam-scraper/steam_scraper/mcp_server.py (FastMCP, read-only DB,
`python <this file>` / stdio transport) but reads Prospect's CURATED DuckDB marts
(data/current.duckdb in the main `prospect` app, built by `task etl`) instead of the raw
source catalog — answers are precomputed, so they're both fast and token-cheap. This file
owns its own thin read queries against the marts; it deliberately does NOT import or
refactor api/app/* (that's a separate, concurrently-edited part of the app) — some query
and constant duplication vs. the FastAPI routers is intentional, see api/app/routers/*.py
and api/app/benchmarks.py for the endpoints this mirrors.

Every tool returns compact, top-N / summarized JSON (never a raw mart dump) so an agent's
context stays lean. Read the `prospect-data-dictionary` resource first for what
opportunity/demand/competition/quality_gap mean and what each mart covers.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Literal

import duckdb
from mcp.server.fastmcp import FastMCP

# ----------------------------------------------------------------------------------------
# DB connection — single read-only connection + lock, same idiom as api/app/analytics_db.py
# (this file's only relationship to that module: mirroring its idiom, not importing it).
# ----------------------------------------------------------------------------------------
DB_PATH = Path(
    os.environ.get("PROSPECT_ANALYTICS_DB_PATH", "/Users/maximbaginskiy/hobby/prospect/data/current.duckdb")
)

if not DB_PATH.exists():
    raise FileNotFoundError(
        f"Analytics DB not found at {DB_PATH}. Build it in the main `prospect` checkout "
        "first (`task etl`), or set PROSPECT_ANALYTICS_DB_PATH to point at a built "
        "current.duckdb."
    )

_conn = duckdb.connect(str(DB_PATH), read_only=True)
_lock = threading.Lock()


def query(sql: str, params: list[Any] | None = None) -> list[dict]:
    with _lock:
        cur = _conn.cursor()
        cur.execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return [dict(zip(cols, row)) for row in rows]


def query_one(sql: str, params: list[Any] | None = None) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


# Whether the mart carries mart_game.name_lower (persisted lower(name)); if so game_search
# filters via the cheaper contains(name_lower, ?) rather than name ILIKE '%q%'. Falls back to
# ILIKE on older marts. Read once — the DB is swapped + process restarted on each ETL build.
_HAS_NAME_LOWER = bool(
    query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'name_lower'"
    )
)

# Whether the mart carries the live-player (CCU) marts/columns (mart_players.sql — daily
# per-game history, niche rollup, and the players_* summary columns on mart_game/mart_niche).
# Both column sets land in the same ETL build; checked together so a half-present state
# (impossible via the atomic mart swap) still degrades safely. Same read-once idiom as
# _HAS_NAME_LOWER.
_HAS_PLAYERS = bool(
    query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_game' AND column_name = 'players_7d_avg'"
    )
) and bool(
    query(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'mart_niche' AND column_name = 'total_players_now'"
    )
)

_PLAYERS_MISSING = (
    "this analytics DB predates the live-player (CCU) marts (mart_game_players_daily / "
    "mart_niche_players and the players_* columns on mart_game/mart_niche) — it was built "
    "by an older ETL. Re-run the ETL (`task etl` in the main prospect checkout) and retry."
)

# Shared caveats for every players/CCU read — the two ways these series lie if unstated.
_PLAYERS_POINT_SAMPLE_CAVEAT = (
    "players values are nightly point samples (one capture per game per day, ~21-22:00 UTC "
    "sweep) — NOT daily peaks. SteamDB-style peak numbers run higher (our sample is "
    "typically ~60-90% of the daily peak)."
)
_PLAYERS_HISTORY_CAVEAT = (
    "History starts 2026-07-18. Games outside the top-8k-by-reviews head are captured on a "
    "~3-8 night rotation, so their daily series have gaps — a gap means UNMEASURED, never "
    "zero. Tail games are especially sparse before ~2026-08-14 (pre-rotation collector); "
    "do not read that sparsity as player decline."
)


def _round(v: Any, nd: int) -> Any:
    if isinstance(v, float):
        return round(v, nd)
    if isinstance(v, dict):
        return {k: _round(x, nd) for k, x in v.items()}
    if isinstance(v, list):
        return [_round(x, nd) for x in v]
    return v


def clean(row: dict, nd: int = 4) -> dict:
    """Round floats (recursively) so DuckDB float noise like 75524.40000000001 doesn't
    burn agent context on garbage digits."""
    return {k: _round(v, nd) for k, v in row.items()}


def clean_rows(rows: list[dict], nd: int = 4) -> list[dict]:
    return [clean(r, nd) for r in rows]


# ----------------------------------------------------------------------------------------
# Researched indie-market benchmark constants — mirrors api/app/benchmarks.py's CITED
# figures (VG Insights / GameDiscoverCo / Boxleiter-method research), duplicated
# intentionally per this file's header (own thin reads, not a shared import).
# ----------------------------------------------------------------------------------------
MEDIAN_INDIE_GROSS_USD = 249
PCT_NEW_RELEASES_OVER_100K = 0.085
BOTTOM_30_PCT_GROSS_USD = 37
REVIEWS_1000_REVENUE_USD = 150_000

BOXLEITER_OWNERS_PER_REVIEW_MIN = 20
BOXLEITER_OWNERS_PER_REVIEW_MID = 30
BOXLEITER_OWNERS_PER_REVIEW_MAX = 55

WISHLIST_CONVERSION_FIRST_WEEK = 0.10
WISHLIST_CONVERSION_RANGE = (0.08, 0.12)
FIRST_WEEK_TO_FIRST_YEAR_MULT = 5

STEAM_REVENUE_SHARE_TO_DEV = 0.70

DEV_TIERS = [
    {"label": "Hobby", "min_copies": 2_000, "max_copies": 20_000, "revenue_anchor_usd": 50_000},
    {"label": "Small", "min_copies": 20_000, "max_copies": 200_000, "revenue_anchor_usd": 1_000_000},
    {"label": "Middle", "min_copies": 200_000, "max_copies": 1_000_000, "revenue_anchor_usd": 10_000_000},
    {"label": "Triple-I", "min_copies": 1_000_000, "max_copies": None, "revenue_anchor_usd": 50_000_000},
]


def _tier_for_copies(copies: float | None) -> str:
    if copies is None:
        return "Unknown"
    if copies < DEV_TIERS[0]["min_copies"]:
        return "Below Hobby"
    for tier in DEV_TIERS:
        hi = tier["max_copies"]
        if hi is None or copies < hi:
            return tier["label"]
    return DEV_TIERS[-1]["label"]


def _genre_owners_per_review(genre: str | None) -> tuple[str, float]:
    """(genre_used, mid owners/review) from the fitted Boxleiter slope for `genre`,
    clamped to the cited 20-55 band; falls back to the catalog-wide ('__all__') slope,
    then the cited mid. Mirrors api/app/routers/estimate.py's helper of the same name."""
    lo, hi = float(BOXLEITER_OWNERS_PER_REVIEW_MIN), float(BOXLEITER_OWNERS_PER_REVIEW_MAX)
    default = float(BOXLEITER_OWNERS_PER_REVIEW_MID)
    for candidate in [genre, "__all__"]:
        if not candidate:
            continue
        row = query_one("SELECT genre, slope FROM mart_market_boxleiter WHERE genre = ?", [candidate])
        if row and row["slope"] is not None:
            return (row["genre"], max(lo, min(hi, float(row["slope"]))))
    return ("__all__", default)


mcp = FastMCP(
    "prospect-market-intel",
    instructions=(
        "Steam market-intelligence tools over Prospect's curated DuckDB marts: find "
        "under-served niches, benchmark the market, estimate revenue, check launch "
        "timing, look up games and rank a game's closest competitors (find_comparables), "
        "profile developers/publishers and scout publishers active in a genre "
        "(entity_profile, publisher_pitch_list), and find press/creator pitch targets "
        "across every marketing channel (Press, YouTube, Reddit, Twitch, X). Read the "
        "prospect-data-dictionary resource first. "
        "For 'what should I build' questions, keep find_niches' defaults (24m window, "
        "opportunity_v2 sort, micro+theme tags only) and apply its falsification rules: "
        "low competition with negative saturation_yoy is usually a market in DECLINE "
        "(everyone stopped entering), not an opportunity — check entrant_ratio "
        "(catalog-median tag ~1.08; <1 = recent entrants underearn) before recommending; "
        "winner_concentration > 0.85 means winner-take-most (judge by the median, not "
        "the hits); and for solo devs check solo_viability (~0.9 is the norm; below ~0.8 "
        "leans multiplayer — e.g. Extraction Shooter — and is not solo-buildable without "
        "flagging it). "
        "For 'is this niche HOT right now' questions use the live-player lens: "
        "find_niches sort=total_players_now (where the players are) or "
        "players_trend_7d_pct (what's heating up), then niche_player_history / "
        "game_player_history for the daily series — nightly point samples, not daily "
        "peaks, and totals are dominated by each niche's biggest games."
    ),
)


# ==========================================================================================
# Resource — data dictionary
# ==========================================================================================
@mcp.resource(
    "data://prospect/data-dictionary",
    name="prospect-data-dictionary",
    title="Prospect data dictionary",
    description="Definitions of opportunity/demand/competition/quality_gap + what each mart covers. Read before interpreting tool output.",
    mime_type="text/markdown",
)
def data_dictionary() -> str:
    return """# Prospect data dictionary

Prospect's marts are built from a Steam catalog snapshot (~142K apps) + SteamSpy owner
estimates + ~3.1M sampled reviews + ~1.12M press/news articles, via DuckDB ETL
(`etl/marts/*.sql`). All figures are ESTIMATES, several with real biases — read the
caveats at the bottom before treating any number as ground truth.

## The opportunity score (mart_niche)

For each niche (a Steam community `tag` or a Steam `genre`), computed at 4 cuts —
`window` in {`all`, `24m`} x `min_reviews` in {`50`, `100`} — as percentile ranks (0-100)
against every other niche in the SAME cut:

- **demand** = 0.4 x percentile(median revenue) + 0.3 x percentile(median owners) +
  0.3 x percentile(recent 24m review velocity). Higher = bigger, hotter market.
- **competition** = 0.6 x percentile(n_recent, count of recently-released games) +
  0.4 x percentile(winner_concentration, share of niche revenue held by the top ~10% of
  games). Higher = more crowded / more winner-take-most — BAD for a new entrant.
- **quality_gap** (aka `beatable_share`) = percentile(share of incumbents that are weak:
  low rating OR thin review count). Higher = easier to out-execute the field.
- **opportunity** = clamp(0.5 x demand − 0.35 x competition + 0.3 x quality_gap, 0, 100).
  The ORIGINAL score, kept for continuity. KNOWN FAILURE MODE: it rewards low
  competition without asking WHY it's low — a niche everyone abandoned scores like an
  open market.
- **opportunity_v2** = opportunity x decline_gate. `find_niches`' default ranking
  metric. The gate (returned as `decline_gate`, in [0.5, 1]) shrinks linearly with the
  WORSE of two decline signals and never penalizes on missing data:
  - sat_severity = clamp(−saturation_yoy / 0.30, 0, 1) — full penalty at a −30%/yr
    release-pipeline decline.
  - entrant_severity = clamp((1 − entrant_ratio) / 0.5, 0, 1) — full penalty at
    entrant_ratio 0.5.
  - decline_gate = 1 − 0.5 x max(sat_severity, entrant_severity).
  MAX (either-signal) semantics on purpose: entrant_ratio >= 1 is the catalog NORM (see
  below), so it must not excuse a collapsing release pipeline.

### Niche-score v2 fields (mart_niche, additive)

- **entrant_ratio** = (24m median_rev) / (all-time median_rev) for the same (dimension,
  key, min_reviews) — same value on both window rows. INTERPRET AGAINST THE NORM: the
  catalog-median tag sits at ~1.08 (price inflation + the review floor filters recent
  releases harder), so ~1.0-1.3 is unremarkable; <1 is a real warning that newcomers
  earn less than the back catalog did; a high ratio over a SHRINKING pipeline (few
  self-selected survivors) is not health. NULL = no 24m cut or a zero/missing all-time
  median (treated as no evidence, not as decline).
- **solo_viability** = share of the cut's scored games playable single-player (Steam's
  own `categories` field, community-tag fallback), computed per cut. Catalog norm ~0.9;
  below ~0.8 the niche leans multiplayer (Extraction Shooter ~0.6, MMORPG ~0.35) — a
  multiplayer-dependent niche is NOT solo-buildable without netcode/servers/live
  player-base plans, flag it for solo devs.
- **tier** (tags; genre rows get 'genre') = 'micro' (buildable game concept: Colony Sim,
  Souls-like), 'theme' (setting/aesthetic you attach TO a game: Vikings, Pixel
  Graphics), 'umbrella' (genre/mechanic/mode container: Open World, Sandbox, Turn-Based
  — NOT buildable), 'meta' (reception/store tags: Great Soundtrack, Nostalgia — never
  buildable). Curated map + size heuristic (all-time n_games >= 400 -> umbrella) in
  etl/build_marts.py. `find_niches` EXCLUDES umbrella/meta by default because
  recommending them was a real, user-rejected failure mode; a 'theme' answer still needs
  a micro-genre attached to be an actionable recommendation.
- **decline_gate** — the opportunity_v2 multiplier itself, exposed so every score is
  inspectable.

Interpretation playbook for "what should I build": keep the 24m default window (that IS
the market a new entrant faces), require the decline gate near 1.0 or understand exactly
why it isn't, verify recent entrants get paid (24m median_rev, hit_rate_200k, n_recent),
check winner_concentration (> 0.85 = winner-take-most: expect the median outcome, not
the hits), and check solo_viability when the asker builds solo.

### Absolute market size (the "pie") — separate from `demand`

`demand` is a percentile of PER-GAME MEDIANS (typical-game quality), so a narrow niche of
strong titles scores high `demand` yet has a tiny total audience. These fields give the
ABSOLUTE size instead, summed over the niche's scored population (min_reviews floor applies,
so they describe the reviewed market, not every shovelware release):

- **total_owners** = SUM(owners_mid) — total consumer base across the niche.
- **total_rev** = SUM(est_rev_reviews) — total est. gross revenue in the niche.
- **total_reviews** = SUM(total_reviews) — total reviews (engaged-player proxy).
- **market_size** = total_owners as a 0-100 percentile vs other niches in the same cut,
  comparable to demand/competition. Use it (or sort/filter by total_owners) to prefer a
  small slice of a big pie over a big slice of a small one — the solo-dev sizing lens.

`window="all"` scores a niche's full history; `"24m"` restricts to games released in the
last 24 months (current-market read, smaller sample). `min_reviews` is the per-game
review floor before a title counts toward niche stats (10 = broad/noisy, 50 =
stricter/cleaner).

### Live players (CCU) — current traction, not an estimate

Unlike owners/revenue (lifetime ESTIMATES), live players are direct measurements: Steam's
keyless GetNumberOfCurrentPlayers, captured by a nightly ~21-22:00 UTC sweep since
2026-07-18. Semantics that matter for interpretation:

- **Point sample, not peak**: one capture per game per day (the LAST of the UTC date) at
  a consistent evening hour — typically ~60-90% of a SteamDB-style daily peak. Compare
  values to each other, never to peak charts.
- **Coverage model**: the top-8k games by reviews are captured EVERY night (they hold
  ~99% of all Steam CCU); the rest of the >=50-review universe rotates every ~3-8
  nights. A missing day = unmeasured, never zero. Tail games are sparse before
  ~2026-08-14 (pre-rotation collector).
- **Niche rollup (mart_niche_players)**: per (dimension, key, date), total_players sums
  scored member games' values with each game's last capture carried forward up to 7 days
  (LOCF) so rotation gaps don't read as dips; games staler than 7d drop out.
  measured_players / n_games_measured sit alongside as the no-carry reality check.
- **mart_niche columns** (one value per key, identical on all 4 cut rows, like
  entrant_ratio): total_players_now (summed latest captures <= 7d old),
  players_trend_7d_pct (last-7d vs prior-7d, SAME-PANEL — only games measured in both
  windows count, so coverage growth can't fake a trend), players_coverage (share of the
  total measured <= 2d fresh; low = leaning on carried tail values).
- **mart_game columns**: live_players (latest capture), players_7d_avg,
  players_trend_7d_pct (same window semantics, measured days only, no LOCF).
- **Interpretation trap**: a niche's total is its HITS — top-heavy by construction. A
  huge total_players_now says people play the niche's biggest games, not that a new
  entrant will get players; read it with winner_concentration and the median columns.

## Revenue & owners estimates

`est_rev_reviews` (the primary revenue figure used throughout) = owners_mid x
price_initial, where owners_mid comes from SteamSpy's owner-range midpoint (itself modeled
from review counts via the "Boxleiter method": ~20-55 owners per review, genre-dependent).
This is GROSS lifetime box revenue, not net-of-Steam's-cut, not first-year-only. See
`market_benchmarks` for cited vs. computed figures and why they differ (population
differences: cited = first-year/net over ALL releases; computed = gross-lifetime over
games clearing the review floor).

## The marts (grouped by tool)

- **mart_niche / mart_niche_top / mart_niche_hist / mart_niche_trend** — niche
  opportunity scores, representative top games per niche, a revenue histogram, and a
  yearly release/saturation trend. -> `find_niches`, `niche_detail`.
- **mart_tag_lift** — pairwise tag-combination performance: one row per unordered pair
  of community tags (from each game's top-10 tags; games with >=50 reviews; pairs with
  >=15 games), with the pair's median est. revenue, hit_rate_200k, both tags' solo
  medians (mart_niche all/50 baselines), and lift = pair median / better solo median.
  Lift is null for pairs of free-to-play-dominated tags (both solo medians $0).
  -> `tag_combos`.
- **mart_niche_themes** — per (tag|genre niche, aspect): the per-game review-aspect
  signal POOLED to niche level — praise/complaint shares in both signal families
  (vote-based and VADER-text) plus each share's delta vs the all-catalog baseline —
  "what does the whole niche praise/complain about," the concrete counterpart to
  quality_gap. Membership is narrower than mart_niche's (tag must be in a game's TOP-10
  tags; genre = primary genre only) and floored at >=10 games per (niche, aspect), each
  with >=20 sampled English text reviews. -> `niche_review_themes`.
- **mart_market_pct / mart_market_hist / mart_market_boxleiter / mart_market_tiers /
  mart_meta** — catalog-wide (or per-genre) percentile distributions, histograms, the
  fitted Boxleiter owners-per-review slope per genre, dev-tier population counts, and
  global scalar stats. -> `market_benchmarks`, `revenue_distribution`, `estimate_revenue`.
- **mart_launch_curve / mart_game_launch_curve** — cumulative share of a genre's (or one
  game's) first-year reviews landed by day-since-release. -> `launch_shape`.
- **mart_timing_demand / mart_timing_congestion / mart_timing_decay** — launch-window
  intelligence over the TRUE uncapped monthly review histograms (Steam's own per-month
  review-graph totals, ~40K games — exact counts, unlike the sampled `reviews` table).
  demand = share of a genre's pooled monthly review velocity per calendar month, each
  game's first 2 months EXCLUDED so launch spikes don't read as seasonal demand;
  congestion = avg releases (and $200K+ releases) per calendar month over the last 3
  complete years; decay = median per-game share of first-24-months reviews landing in
  each month since release (per-game normalized first). -> `best_launch_timing`.
- **mart_seasonality** — release-month/weekday OUTCOME medians (median revenue of games
  launched then). Web heatmap legacy; superseded for launch advice by the mart_timing_*
  trio above (launch-month medians are composition-confounded — they reflect what kind
  of game launches then, not the calendar).
- **mart_game** — one row per game: metadata, revenue/owners, percentile-vs-genre, top
  tags, review velocity, live players (latest + 7d avg/trend). -> `game_search`,
  `game_profile`, `find_comparables` (closest competitors, ranked on demand by
  tag-Jaccard over `top_tags` within the same primary genre + a price band — no
  precomputed pairwise mart).
- **mart_game_players_daily / mart_niche_players** — daily live-player (CCU) history:
  per-game measured days (point samples, gaps = unmeasured), and the per-niche daily
  rollup (LOCF <= 7d, with measured_players/n_games_measured coverage columns). See the
  "Live players (CCU)" section above. -> `game_player_history`, `niche_player_history`
  (+ the players columns in `find_niches`/`niche_detail`/`game_profile`).
- **mart_entity / mart_entity_games** — one row per (role, developer/publisher name),
  normalized out of mart_game's comma-joined developers/publishers strings (corporate
  suffixes like ", Inc." / ", Ltd." are re-merged into the name instead of becoming fake
  entities), plus a thin (role, name, appid, seq) map where seq 1 = the entity's earliest
  release. Carries game counts, first/last release year, n_recent_24m (the active/dormant
  signal), revenue medians/hit rate, self_published_share, top genres, and (publishers)
  n_partners = distinct developer names published. Names are self-reported strings — the
  same studio under variant spellings ("Ubisoft" vs "UBISOFT") counts as separate
  entities. -> `entity_profile`, `publisher_pitch_list`.
- **mart_game_review_aspects / mart_genre_aspect_baseline / mart_game_press_summary /
  mart_game_press_by_source / mart_game_press_timeline / mart_game_press_notable** —
  per-game praise/complaint aspect mining (10 fixed aspects) + press footprint.
  -> `game_teardown`.
- **mart_press_outlet_genre / mart_press_author** — outlet x genre and journalist x genre
  coverage, precomputed pitch-list source. -> `press_pitch_list`.
- **mart_buzz_trends / mart_buzz_trends_summary** — rising/cooling game-concept bigrams
  mined from journalist article titles. -> `buzz_trends`.
- **mart_creator_pitch** — per (genre, platform, creator): reach x recent-activity ranked
  creator pitch list, for YouTube/Reddit/Twitch/X (the creator-platform analogue of
  mart_press_author). -> `creator_pitch_list`.
- **mart_channel_mix** — per (genre, channel): share of marketing attention (raw mention
  count AND reach-weighted) across Press/YouTube/Reddit/Twitch/X — "where does this genre
  actually get attention." -> `channel_mix`.
- **mart_channel_buzz / mart_channel_buzz_summary** — reach-weighted trending game-concept
  bigrams across EVERY channel (press + creator platforms combined), the multi-channel,
  audience-weighted sequel to mart_buzz_trends. -> `channel_buzz`.
  All three are empty until the channel scrapers (steam-scraper's creator/
  game_creator_mention/creator_reach_snapshot tables) have been run — degrades to zero rows,
  never an error.

## Caveats that apply broadly (also repeated per-tool where most relevant)

- **Sampling**: reviews/press are SAMPLES of the true Steam data, recency-biased toward
  older/popular titles (reviews) or the last ~365 days (press backfill) — counts describe
  the sample, not Steam's true totals.
  - **Selection bias**: press coverage and "top games" lists reflect games that were
  already notable — descriptive of what happened, not predictive/causal.
- **Correlational, not causal**: `game_teardown`'s "why it works" framing, and any
  press-coverage-vs-outcome read, is evidence toward an explanation, never proof.
- **English-outlet skew**: review-text mining and press analysis both skew English-
  language / Western-outlet.
- Genre = Steam's own small, fixed, EXACT-match genre field (a game usually has several;
  marts use the PRIMARY genre unless noted). Tag = SteamSpy's much larger community-tag
  vocabulary — more specific, better for niche-finding.
"""


# ==========================================================================================
# Niche / opportunity tools
# ==========================================================================================
_NICHE_SORTABLE = {
    "opportunity", "opportunity_v2", "demand", "competition", "quality_gap",
    "market_size", "total_owners", "total_rev", "total_reviews",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity",
    "n_games", "n_recent", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "self_pub_share", "winner_concentration",
    "entrant_ratio", "solo_viability",
    "total_players_now", "players_trend_7d_pct", "players_coverage",
}
# The subset of _NICHE_SORTABLE that only exists on marts with the players columns
# (sorting/filtering on them needs _HAS_PLAYERS; everything else works on older marts).
_NICHE_PLAYERS_COLS = {"total_players_now", "players_trend_7d_pct", "players_coverage"}
_NICHE_TIERS = {"micro", "umbrella", "theme", "meta"}
# Default tier filter (tags only): buildable micro-genres + themes. Umbrella containers
# (Open World, Sandbox, RPG...) and meta/reception tags (Great Soundtrack, Nostalgia...)
# are EXCLUDED by default — they aren't things a developer can build. Pass
# include_tiers=None to see everything, or an explicit list to widen/narrow.
_DEFAULT_INCLUDE_TIERS = ["micro", "theme"]

# Shared soft-fail message: the v2 columns only exist once the ETL that added them has
# rebuilt current.duckdb. Same degrade-cleanly idiom as tag_combos/mart_tag_lift.
_NICHE_V2_MISSING = (
    "mart_niche is missing the niche-score v2 columns (opportunity_v2 / entrant_ratio / "
    "solo_viability / tier / decline_gate) — this analytics DB was built by an older ETL. "
    "Re-run the ETL (`task etl` in the main prospect checkout) and retry."
)


@mcp.tool()
def find_niches(
    dimension: Literal["tag", "genre"] = "tag",
    window: Literal["all", "24m"] = "24m",
    min_reviews: Literal[50, 100] = 50,
    min_median_rev: float | None = None,
    max_competition: float | None = None,
    min_total_owners: float | None = None,
    min_total_players: float | None = None,
    include_tiers: list[str] | None = _DEFAULT_INCLUDE_TIERS,
    sort: str = "opportunity_v2",
    limit: int = 15,
) -> dict:
    """Rank niches (Steam community tags, or Steam genres) by growth-gated opportunity.
    THE headline tool — start here for "what should I build" questions. Defaults are
    tuned for exactly that question: window="24m" (the market a new entrant actually
    faces), sort="opportunity_v2" (decline-gated), include_tiers=["micro","theme"]
    (buildable concepts only). This docstring is an INTERPRETATION PLAYBOOK — the numbers
    lie in specific, known ways; the falsification rules below are how you catch them.

    THE SCORES
      - opportunity = 0.5*demand − 0.35*competition + 0.3*quality_gap, clamped [0,100]
        (all three are 0-100 percentiles vs other niches in the same cut — exact formulas
        in the prospect-data-dictionary resource). KNOWN FAILURE MODE: it rewards LOW
        competition without asking WHY competition is low.
      - opportunity_v2 = opportunity * decline_gate, where decline_gate (in [0.5, 1],
        returned per row) shrinks linearly with the WORSE of two decline signals:
        saturation_yoy below 0 (release pipeline shrinking; full penalty at −30%/yr) and
        entrant_ratio below 1 (recent entrants underearn the niche's history; full
        penalty at 0.5). Sort by this, not by raw opportunity, for build decisions.

    FALSIFICATION RULES — run these before recommending a niche:
      1. Low competition + negative saturation_yoy usually means a market in DECLINE —
         everyone STOPPED entering — not a cracked-open opportunity. Check entrant_ratio
         and the niche_detail saturation_trend before recommending. (This exact failure
         put Naval/Transportation/Diplomacy — new releases shrinking 15-37%/yr — at the
         top of the old raw-opportunity ranking.)
      2. entrant_ratio reads AGAINST THE NORM, not against 1.0: the catalog-median tag
         sits at ~1.08 (price inflation + the review floor filters recent releases
         harder), so ~1.0-1.3 is unremarkable and <1 is a real warning that newcomers
         earn less than the back catalog did. A high ratio over a shrinking pipeline
         (few, self-selected survivors) is NOT health — trust saturation_yoy first.
      3. Verify recent entrants actually get paid: with window="24m", median_rev IS the
         recent-entrant median. Cross-check hit_rate_200k and n_recent (a great median
         over 30 games is thinner evidence than a good median over 300).
      4. winner_concentration > 0.85 = winner-take-most: the niche's revenue lives in a
         few hits, so the MEDIAN outcome (not the visible winners) is what a new entrant
         should expect. Check the revenue_histogram in niche_detail.
      5. If the asker is a solo dev, check solo_viability (share of the niche's scored
         games playable single-player; catalog norm ~0.9). Below ~0.8 the niche leans
         multiplayer (e.g. Extraction Shooter ~0.6): a multiplayer-dependent game needs
         netcode, servers, and a live player base a solo dev usually can't fund — do not
         recommend it for solo builds without flagging that.
      6. tier: rows are 'micro' (buildable game concept), 'theme' (setting/aesthetic you
         attach TO a game), 'umbrella' (genre/mechanic container — NOT buildable: "build
         an Open World game" is not a plan), 'meta' (reception tags like Great
         Soundtrack — never buildable), or 'genre' (dimension="genre" rows). Umbrella and
         meta are EXCLUDED by default because recommending them was the second failure
         mode this tool had; pass include_tiers=None (everything) or an explicit subset
         of ["micro","theme","umbrella","meta"] to widen. The filter only applies when
         dimension="tag". A 'theme' answer means "make a game ABOUT this" and still needs
         a micro-genre attached to be a real recommendation.

    ABSOLUTE SIZE (the "pie"), distinct from the percentile-of-medians `demand`:
      - total_owners / total_rev / total_reviews: summed over the niche's scored games.
      - market_size: total_owners as a 0-100 percentile vs other niches (same cut).
    Use these (or min_total_owners) when a small share of a BIG niche beats a big share
    of a small one — the solo-dev sizing lens.

    LIVE PLAYERS (the "is it hot RIGHT NOW" lens — direct current traction, unlike the
    ownership/revenue estimates above; one value per key, identical across cuts):
      - total_players_now: summed current concurrent players (CCU) of the niche's scored
        games — each game's latest nightly ~21-22:00 UTC point sample (<= 7 days old),
        NOT a daily peak. Sort by this for "where are the players today".
      - players_trend_7d_pct: last-7d vs prior-7d change (%), SAME-PANEL (only games
        measured in both windows count, so coverage growth can't fake a trend). Sort by
        this for "what's heating up this week".
      - players_coverage: share of total_players_now measured fresh (<= 2 days). Low
        values mean the total leans on carried-forward tail captures — trust it less.
      NULL on all three = players never measured for the niche (or the mart predates CCU
      collection). min_total_players is the matching optional post-filter. Follow up with
      niche_player_history(dimension, key) for the daily series. CAVEAT: a niche's total
      is dominated by its biggest games (the top-12k games hold ~99% of all Steam CCU) —
      a huge total_players_now says people play the niche's HITS, not that a new entrant
      gets players.

    EXACT MATERIALISATION: only the precomputed cuts exist — window in {"all","24m"} x
    min_reviews in {50,100} (must stay in sync with MIN_REVIEWS_LEVELS in
    etl/build_marts.py; a value the ETL didn't materialise matches no rows and returns an
    empty list, not an error). window="all" scores full history — use it for context, not
    for entry decisions. min_reviews=50 is broader/noisier, 100 stricter/cleaner.

    min_median_rev / max_competition / min_total_owners are optional post-filters
    (e.g. min_median_rev=200000, max_competition=50, min_total_owners=1000000). sort is
    any returned numeric field. Returns compact rows only — call niche_detail(dimension,
    key) for one niche's saturation trend, revenue histogram, and representative games.
    Returns an {"error": ...} asking you to re-run the ETL if the analytics DB predates
    the v2 columns.
    """
    if sort not in _NICHE_SORTABLE:
        return {"error": f"sort must be one of {sorted(_NICHE_SORTABLE)}"}
    if not _HAS_PLAYERS and (sort in _NICHE_PLAYERS_COLS or min_total_players is not None):
        return {"error": _PLAYERS_MISSING}
    if include_tiers is not None:
        bad = [t for t in include_tiers if t not in _NICHE_TIERS]
        if bad:
            return {"error": f"include_tiers entries must be in {sorted(_NICHE_TIERS)}, got {bad}"}
        if not include_tiers:
            return {"error": "include_tiers must be None or a non-empty list"}

    where = ["dimension = ?", "win = ?", "min_reviews = ?"]
    params: list = [dimension, window, min_reviews]
    if min_median_rev is not None:
        where.append("median_rev >= ?")
        params.append(min_median_rev)
    if max_competition is not None:
        where.append("competition <= ?")
        params.append(max_competition)
    if min_total_owners is not None:
        where.append("total_owners >= ?")
        params.append(min_total_owners)
    if min_total_players is not None:
        where.append("total_players_now >= ?")
        params.append(min_total_players)
    tiers_applied = None
    if dimension == "tag" and include_tiers is not None:
        tiers_applied = list(include_tiers)
        where.append(f"tier IN ({','.join('?' for _ in tiers_applied)})")
        params.extend(tiers_applied)
    limit = max(1, min(limit, 50))

    players_cols = (
        ",\n                   total_players_now, players_trend_7d_pct, players_coverage"
        if _HAS_PLAYERS
        else ""
    )
    try:
        rows = query(
            f"""
            SELECT key, tier, n_games, n_recent, opportunity_v2, opportunity, decline_gate,
                   entrant_ratio, solo_viability, demand, competition, quality_gap,
                   market_size, total_owners, total_rev, total_reviews,
                   median_rev, median_reviews, median_price, median_positive_ratio,
                   median_owners, recent_velocity, hit_rate_200k, hit_rate_500k,
                   saturation_yoy, winner_concentration{players_cols}
            FROM mart_niche
            WHERE {" AND ".join(where)}
            ORDER BY {sort} DESC NULLS LAST, n_games DESC
            LIMIT ?
            """,
            params + [limit],
        )
    except (duckdb.BinderException, duckdb.CatalogException):
        return {"error": _NICHE_V2_MISSING}
    return {
        "dimension": dimension,
        "window": window,
        "min_reviews": min_reviews,
        "include_tiers": tiers_applied,
        "sort": sort,
        "n_returned": len(rows),
        "niches": clean_rows(rows),
    }


@mcp.tool()
def niche_detail(dimension: Literal["tag", "genre"], key: str) -> dict:
    """Deep dive on one niche (get valid `key` values from find_niches — exact match,
    case-sensitive). Returns:
      - tier: 'micro' | 'theme' | 'umbrella' | 'meta' (tags) or 'genre' — an 'umbrella'
        or 'meta' key is a container/reception tag, not a buildable niche.
      - variants: this niche's opportunity_v2/opportunity/demand/competition/etc at all
        4 precomputed cuts — (all|24m) x (min_reviews 50|100) — including entrant_ratio
        (24m-vs-all-time median revenue; catalog-median tag is ~1.08, so <1 means recent
        entrants genuinely underearn), solo_viability (share of scored games playable
        single-player; ~0.9 is the catalog norm, below ~0.8 leans multiplayer — a red
        flag for solo devs), and decline_gate (the opportunity_v2 multiplier, 0.5-1.0).
      - saturation_trend: yearly release counts + median revenue, oldest-first — is this
        niche heating up or cooling off? A shrinking n_releases pipeline is DECLINE even
        when competition looks invitingly low.
      - revenue_histogram: log-scale bucketed distribution of est. lifetime revenue
        across the niche (min_reviews=50 population) — the full shape, not just the
        median.
      - representative_games: top 8 games in the niche by est. revenue.
      - hit_rates: headline (window="all", min_reviews=50) hit_rate_200k / hit_rate_500k
        (share of games clearing $200K/$500K est. revenue), median_rev, n_games,
        winner_concentration.
      - players: the niche's LIVE-player snapshot — latest daily row (date,
        total_players, measured_players, n_games_measured, n_games_covered,
        n_games_panel) + history bounds (first_date, last_date, n_days). total_players
        is summed current CCU (nightly ~21-22:00 UTC point samples, <= 7d carry-forward
        for rotation gaps — not daily peaks). The variants rows also carry
        total_players_now / players_trend_7d_pct / players_coverage (same value on all 4
        cuts). None = never measured or the mart predates CCU collection; call
        niche_player_history(dimension, key) for the full daily series.
    Returns {"error": ...} if dimension/key doesn't match any niche (call find_niches to
    get exact valid keys — spelling and case must match precisely), or asking you to
    re-run the ETL if the analytics DB predates the v2 columns.
    """
    # NOTE: `win` is selected un-aliased (not `AS window`) because `window` is a reserved
    # word in DuckDB SQL (window functions) and can't be used unquoted in ORDER BY — same
    # reason api/app/routers/niches.py renames win -> window in Python, after the fetch,
    # rather than in SQL.
    players_cols = (
        ",\n                   total_players_now, players_trend_7d_pct, players_coverage"
        if _HAS_PLAYERS
        else ""
    )
    try:
        variants = query(
            f"""
            SELECT win, min_reviews, tier, n_games, n_recent, opportunity_v2, opportunity,
                   decline_gate, entrant_ratio, solo_viability, demand,
                   competition, quality_gap, market_size, total_owners, total_rev,
                   total_reviews, median_rev, median_reviews, median_price,
                   median_positive_ratio, median_owners, recent_velocity, hit_rate_200k,
                   hit_rate_500k, beatable_share, saturation_yoy, winner_concentration{players_cols}
            FROM mart_niche WHERE dimension = ? AND key = ? ORDER BY win, min_reviews
            """,
            [dimension, key],
        )
    except (duckdb.BinderException, duckdb.CatalogException):
        return {"error": _NICHE_V2_MISSING}
    if not variants:
        return {
            "error": f"no niche found for dimension={dimension!r} key={key!r}. "
            "Call find_niches to list valid keys — spelling/case must match exactly."
        }
    for v in variants:
        v["window"] = v.pop("win")

    trend = query(
        "SELECT year, n_releases, n_scored, median_rev FROM mart_niche_trend "
        "WHERE dimension = ? AND key = ? ORDER BY year",
        [dimension, key],
    )
    hist = query(
        "SELECT x_min, x_max, count FROM mart_niche_hist "
        "WHERE dimension = ? AND key = ? ORDER BY bucket_index",
        [dimension, key],
    )
    games = query(
        "SELECT rank_in_niche, appid, name, release_year, price_initial, owners_mid, "
        "total_reviews, positive_ratio, est_rev_reviews, self_published FROM mart_niche_top "
        "WHERE dimension = ? AND key = ? ORDER BY rank_in_niche LIMIT 8",
        [dimension, key],
    )
    # Live-player snapshot (daily series lives in niche_player_history; here just the
    # latest row + bounds). None when the mart predates CCU or the niche was never
    # measured — a real answer, not an error.
    players = None
    if _HAS_PLAYERS:
        try:
            latest = query_one(
                "SELECT date, total_players, measured_players, n_games_measured, "
                "n_games_covered, n_games_panel FROM mart_niche_players "
                "WHERE dimension = ? AND key = ? ORDER BY date DESC LIMIT 1",
                [dimension, key],
            )
            if latest is not None:
                bounds = query_one(
                    "SELECT MIN(date) AS first_date, MAX(date) AS last_date, "
                    "COUNT(*) AS n_days FROM mart_niche_players "
                    "WHERE dimension = ? AND key = ?",
                    [dimension, key],
                )
                latest["date"] = str(latest["date"])
                players = {
                    **clean(latest),
                    "history": {
                        "first_date": str(bounds["first_date"]),
                        "last_date": str(bounds["last_date"]),
                        "n_days": bounds["n_days"],
                    },
                }
        except duckdb.CatalogException:
            players = None

    headline = next((v for v in variants if v["window"] == "all" and v["min_reviews"] == 50), variants[0])
    return {
        "dimension": dimension,
        "key": key,
        "tier": headline.get("tier"),
        "variants": clean_rows(variants),
        "players": players,
        "saturation_trend": clean_rows(trend),
        "revenue_histogram": clean_rows(hist),
        "representative_games": clean_rows(games),
        "hit_rates": clean(
            {
                "hit_rate_200k": headline["hit_rate_200k"],
                "hit_rate_500k": headline["hit_rate_500k"],
                "median_rev": headline["median_rev"],
                "n_games": headline["n_games"],
                "winner_concentration": headline["winner_concentration"],
            }
        ),
    }


@mcp.tool()
def tag_combos(tag: str, limit: int = 15) -> dict:
    """Which co-tags does one Steam community tag perform best/worst WITH? Answers "which
    tags should MY game ship with?" — e.g. does 'Roguelike Deckbuilder'+'Horror' outperform
    each tag alone? Reads mart_tag_lift: unordered tag PAIRS exploded from each game's
    top-10 community tags (vote-floored + denylist-filtered, same hygiene as every other
    tag mart), restricted to games with >= 50 total reviews (the same min_reviews=50 floor
    as the niche mart, so pair and solo populations are comparable), and kept only when
    the pair has >= 15 qualifying games (TAG_PAIR_MIN_GAMES in etl/build_marts.py — below
    that a median is noise).

    LIFT = pair median est. revenue / GREATEST(tag A solo median, tag B solo median),
    where the solo medians are mart_niche's (dimension='tag', window='all',
    min_reviews=50) baselines. Lift > 1 means the combination's typical game out-earns
    the BETTER of the two tags alone — it can't be gamed by pairing a strong tag with a
    weak one. Lift is null when both solo medians are $0 (free-to-play-dominated tags:
    est. revenue is reviews x owners-per-review x PRICE, so all-free tags median $0).

    Revenue throughout is est_rev_reviews — a Boxleiter-style ESTIMATE (gross lifetime
    box revenue), never ground truth. pair_hit_rate_200k mirrors mart_niche's
    hit_rate_200k convention (share of the pair's games clearing $200K est. revenue).

    Returns solo context for `tag` (its all/50 baseline), best_combos (highest lift
    first) and worst_combos (lowest lift first, no overlap with best), each row carrying
    partner, n_games, pair_median_rev, pair_hit_rate_200k, the two solo medians,
    best_solo_median_rev, and lift — plus a one-line headline takeaway.

    An empty best/worst list is a real answer: the tag has no pairs meeting the 15-game
    floor. An unknown tag returns {"error": ...} — get valid tags from
    find_niches(dimension="tag") (exact match, case-sensitive). ALWAYS weigh n_games:
    pairs at the floor (~15 games) are often a handful of famous titles wearing both
    tags, not a repeatable pattern. Correlation, not causation — good games choose these
    tag combinations as much as the combinations make games good, and tags are SteamSpy
    community tags (crowd-applied, occasionally wrong/late, top-10-per-game only).
    """
    limit = max(1, min(limit, 50))

    try:
        rows = query(
            """
            SELECT
                CASE WHEN tag_a = ? THEN tag_b ELSE tag_a END AS partner,
                n_games,
                median_rev AS pair_median_rev,
                hit_rate_200k AS pair_hit_rate_200k,
                CASE WHEN tag_a = ? THEN tag_a_solo_median_rev ELSE tag_b_solo_median_rev END AS tag_solo_median_rev,
                CASE WHEN tag_a = ? THEN tag_b_solo_median_rev ELSE tag_a_solo_median_rev END AS partner_solo_median_rev,
                best_solo_median_rev,
                lift
            FROM mart_tag_lift
            WHERE tag_a = ? OR tag_b = ?
            ORDER BY lift DESC NULLS LAST
            """,
            [tag, tag, tag, tag, tag],
        )
    except duckdb.CatalogException:
        return {
            "error": "mart_tag_lift is not present in this analytics DB — it is built by a "
            "newer ETL than the one that produced this current.duckdb. Rebuild the marts "
            "(`task etl` in the main prospect checkout) and retry."
        }

    solo = query_one(
        "SELECT n_games, median_rev, hit_rate_200k FROM mart_niche "
        "WHERE dimension = 'tag' AND win = 'all' AND min_reviews = 50 AND key = ?",
        [tag],
    )
    if not rows and solo is None:
        return {
            "error": f"tag {tag!r} not found — it has neither a solo baseline in mart_niche "
            "nor any pairs meeting the 15-game floor. Get valid tags from "
            "find_niches(dimension='tag'); spelling and case must match exactly."
        }

    ranked = [r for r in rows if r["lift"] is not None]
    unranked_free = len(rows) - len(ranked)  # both-solo-medians-$0 (free-to-play) pairs
    best = ranked[:limit]
    worst = list(reversed(ranked[limit:]))[:limit]  # lowest lift first, never overlaps best

    headline = None
    if best:
        b = best[0]
        headline = (
            f"'{tag}' pairs best with '{b['partner']}': the combo's median est. revenue is "
            f"${b['pair_median_rev']:,.0f} across {b['n_games']} games — {b['lift']:.2f}x the "
            f"better solo tag's median (${b['best_solo_median_rev']:,.0f})."
        )
        if worst:
            w = worst[0]
            headline += (
                f" It pairs worst with '{w['partner']}' ({w['lift']:.2f}x, "
                f"median ${w['pair_median_rev']:,.0f} across {w['n_games']} games)."
            )
    elif solo is not None:
        headline = (
            f"'{tag}' has no tag pairs meeting the 15-game reliability floor — solo baseline "
            f"only (median est. revenue ${solo['median_rev']:,.0f} across {solo['n_games']} games)."
        )

    caveats = [
        "Revenue is est_rev_reviews — a Boxleiter-style estimate (gross lifetime), not ground "
        "truth; lift compares pair median vs the BETTER solo tag's median (mart_niche all/50 cut).",
        "Correlation, not causation: good games choose these tag combinations as much as the "
        "combinations make games good.",
        "Weigh n_games — a pair near the 15-game floor is often a few famous titles wearing "
        "both tags, not a repeatable pattern.",
        "Tags are SteamSpy community tags (crowd-applied, top-10-per-game, vote-floored) — "
        "coverage is imperfect, especially for small/new games.",
    ]
    if unranked_free:
        caveats.append(
            f"{unranked_free} pair(s) omitted from the ranking: lift is undefined because both "
            "tags' solo medians are $0 (free-to-play-dominated tags have no box revenue)."
        )

    return {
        "tag": tag,
        "solo": clean(
            {
                "n_games": solo["n_games"] if solo else None,
                "median_rev": solo["median_rev"] if solo else None,
                "hit_rate_200k": solo["hit_rate_200k"] if solo else None,
            }
        ),
        "n_pairs": len(rows),
        "headline": headline,
        "best_combos": clean_rows(best),
        "worst_combos": clean_rows(worst),
        "caveats": caveats,
    }


_NICHE_THEME_CAVEATS = [
    "Aspect mining is keyword-lexicon based (10 fixed aspects), not semantic — any review "
    "containing e.g. \"boss\" counts toward Combat & Bosses regardless of what it meant.",
    "praise_share/complaint_share are VOTE-based (share of aspect-mentioning reviews that "
    "were thumbs-up/down OVERALL — they sum to 1, and complaint delta = -praise delta); "
    "text_praise_rate/text_complaint_rate are VADER sentiment of the local text window "
    "around the keyword — coarse lexicon scoring, sarcasm-blind, English-only, with a "
    "neutral band so the two rates do NOT sum to 1.",
    "Pooled, review-volume-weighted: heavily-reviewed games dominate their niche's shares. "
    "When n_games is low or one hit dwarfs the niche, a \"niche theme\" can really be one "
    "game's theme — check n_games/n_reviews_sampled.",
    "Niche membership is NARROWER than find_niches': tag = appears in the game's top-10 "
    "community tags; genre = the game's PRIMARY genre only. n_games here is therefore "
    "smaller than the same key's n_games in find_niches.",
    "Deltas vs the all-catalog pooled baseline are typically small (±0.01-0.06) — read "
    "them as leanings, not verdicts. Correlational, not causal.",
]


@mcp.tool()
def niche_review_themes(dimension: Literal["tag", "genre"], key: str) -> dict:
    """What a whole NICHE praises vs complains about — per-aspect review sentiment rolled
    up across every review-mined game in one tag/genre niche, with each share's delta vs
    the all-catalog baseline. This turns find_niches' abstract quality_gap score into a
    concrete gap statement ("Souls-likes complain about Map & Navigation more than games
    in general — ship a great map"). Get valid `key` values from find_niches (exact match,
    case-sensitive).

    What is materialized (mart_niche_themes): games from mart_game_review_aspects (>= 20
    sampled English text reviews — TEARDOWN_MIN_REVIEWS in etl/build_marts.py) are joined
    to tag niches via the game's TOP-10 community tags (mart_game.top_tags) and to genre
    via primary_genre, then mention counts are POOLED per (niche, aspect) — review-volume
    weighted, so a 5-review game can't swamp the signal (flip side: a big hit can dominate
    its niche). A (niche, aspect) row only exists with >= 10 games mentioning the aspect
    (NICHE_THEMES_MIN_GAMES).

    Returns the 10 fixed aspects as two rankings:
      - complaint_themes: sorted by text_complaint_delta_vs_catalog DESC — what this niche
        complains about MORE than games in general (positive delta) at the top.
      - praise_themes: sorted by text_praise_delta_vs_catalog DESC — what it praises more
        than games in general at the top.
    Each row carries both signal families: vote-based praise_share/complaint_share (+
    praise_delta_vs_catalog) and text-sentiment text_praise_rate/text_complaint_rate (+
    their deltas), plus n_games / n_reviews_sampled / total_mentions to judge sample depth.
    An aspect can rank high in BOTH lists (its reviews are polarized) — the neutral-band
    text rates are independent, not complements.

    Empty praise/complaint lists (with a `note`) mean the key IS a real niche but too few
    of its games clear the review/games floors above — an honest "not enough review-text
    signal", not an error. {"error": ...} means the key matched no niche at all — call
    find_niches for valid keys — or the analytics DB predates this mart (re-run the ETL).
    """
    try:
        rows = query(
            """
            SELECT aspect, n_games, n_reviews_sampled, total_mentions,
                   praise_share, complaint_share, praise_delta_vs_catalog,
                   n_text_scored, text_praise_rate, text_complaint_rate,
                   text_praise_delta_vs_catalog, text_complaint_delta_vs_catalog
            FROM mart_niche_themes
            WHERE dimension = ? AND key = ?
            """,
            [dimension, key],
        )
    except duckdb.Error as e:
        # The production DB won't carry mart_niche_themes until the next ETL run builds it
        # — degrade to a clear error instead of crashing the tool call.
        return {
            "error": "mart_niche_themes is missing from this analytics DB — it is built by "
            "etl/marts/mart_niche_themes.sql (registered last in MART_FILES); re-run the ETL "
            f"(`task etl`) so current.duckdb includes it. ({type(e).__name__}: {e})"
        }

    if not rows:
        known = query_one(
            "SELECT 1 AS one FROM mart_niche WHERE dimension = ? AND key = ? LIMIT 1",
            [dimension, key],
        )
        if known is None:
            return {
                "error": f"no niche found for dimension={dimension!r} key={key!r}. "
                "Call find_niches to list valid keys — spelling/case must match exactly."
            }
        return {
            "dimension": dimension,
            "key": key,
            "praise_themes": [],
            "complaint_themes": [],
            "note": "Niche exists but no aspect cleared the reliability floors (>= 10 games "
            "with >= 20 sampled English text reviews each mentioning the aspect) — too few "
            "review-mined games in this niche for a reliable theme read.",
            "caveats": _NICHE_THEME_CAVEATS,
        }

    def _delta_sorted(field: str) -> list[dict]:
        return sorted(
            rows,
            key=lambda r: r[field] if r[field] is not None else float("-inf"),
            reverse=True,
        )[:5]

    return {
        "dimension": dimension,
        "key": key,
        "n_aspects": len(rows),
        "praise_themes": clean_rows(_delta_sorted("text_praise_delta_vs_catalog")),
        "complaint_themes": clean_rows(_delta_sorted("text_complaint_delta_vs_catalog")),
        "caveats": _NICHE_THEME_CAVEATS,
    }


# ==========================================================================================
# Market / revenue tools
# ==========================================================================================
@mcp.tool()
def market_benchmarks() -> dict:
    """Reference anchors for judging any revenue/owners number. Returns:
      - cited: figures from public indie-market research (VG Insights / GameDiscoverCo /
        Boxleiter method) — median indie gross ~$249, ~8.5% of releases clear $100K,
        Boxleiter 20-55 owners-per-review (mid 30), wishlist-conversion assumptions,
        Steam's ~70%-to-dev revenue share, and the 4 dev-tier definitions (Hobby/Small/
        Middle/Triple-I) by lifetime copies sold.
      - computed: this catalog's own figures (global median revenue, fitted catalog-wide
        Boxleiter slope, % of scored games over $100K, population sizes).
      - boxleiter_by_genre: the fitted owners-per-review slope per genre (what
        estimate_revenue uses when you pass a genre).
      - dev_tier_population: how many games in the catalog fall in each dev tier.
    The cited and computed medians differ ON PURPOSE: cited figures are first-year/net
    over ALL releases; computed figures are Boxleiter gross-lifetime over games clearing
    the >=10-review analysis floor. Call this before quoting any dollar figure so the
    answer is anchored to real reference points, not a guess.
    """
    meta = {r["key"]: r["value"] for r in query("SELECT key, value FROM mart_meta")}

    def f(k: str) -> float | None:
        v = meta.get(k)
        return float(v) if v not in (None, "") else None

    boxleiter = query(
        "SELECT genre, n, owners_per_review_median, owners_per_review_p25, "
        "owners_per_review_p75, slope FROM mart_market_boxleiter ORDER BY n DESC LIMIT 25"
    )
    tiers = query("SELECT tier, tier_order, count, pct FROM mart_market_tiers ORDER BY tier_order")

    return {
        "cited": {
            "median_indie_gross_usd": MEDIAN_INDIE_GROSS_USD,
            "pct_new_releases_over_100k": PCT_NEW_RELEASES_OVER_100K,
            "bottom_30_pct_gross_usd": BOTTOM_30_PCT_GROSS_USD,
            "reviews_1000_revenue_usd": REVIEWS_1000_REVENUE_USD,
            "boxleiter_owners_per_review": {
                "min": BOXLEITER_OWNERS_PER_REVIEW_MIN,
                "mid": BOXLEITER_OWNERS_PER_REVIEW_MID,
                "max": BOXLEITER_OWNERS_PER_REVIEW_MAX,
            },
            "wishlist_conversion_first_week": WISHLIST_CONVERSION_FIRST_WEEK,
            "first_week_to_first_year_mult": FIRST_WEEK_TO_FIRST_YEAR_MULT,
            "steam_revenue_share_to_dev": STEAM_REVENUE_SHARE_TO_DEV,
            "dev_tiers": DEV_TIERS,
        },
        "computed": clean(
            {
                "median_revenue_scored": f("global_median_revenue"),
                "median_revenue_paid": f("global_median_revenue_paid"),
                "boxleiter_owners_per_review_slope": f("boxleiter_owners_per_review"),
                "pct_over_100k_scored": f("pct_over_100k"),
                "n_games_total": f("n_games_total"),
                "n_games_scored": f("n_games_scored"),
                "population_note": (
                    "computed medians/pct are Boxleiter gross over games with >=10 reviews "
                    "(paid = price>0, >=1 review); cited $249/8.5% are first-year/net over "
                    "ALL releases"
                ),
            }
        ),
        "boxleiter_by_genre": clean_rows(boxleiter),
        "dev_tier_population": clean_rows(tiers),
    }


@mcp.tool()
def revenue_distribution(
    metric: Literal["revenue", "reviews", "owners", "price"] = "revenue",
    genre: str = "__all__",
    window: Literal["all", "24m"] = "all",
) -> dict:
    """Market-wide distribution for one metric, scoped to a genre and time window.
    metric: "revenue" (est. lifetime gross), "reviews" (total review count), "owners"
    (SteamSpy owners_mid), or "price" (launch price, paid games only). genre="__all__"
    for the whole catalog, or an exact Steam genre label. window="all" or "24m" (last 24
    months only). Returns percentiles (p10..p99) plus a histogram (log-scale bins for
    revenue/reviews/owners since they're extremely right-skewed; linear $2.50 bins for
    price) — use this to see the FULL shape of outcomes, not just one average: revenue in
    particular has a long tail of hits pulling the mean way above the median. Pair with
    market_benchmarks for cited reference points to annotate these numbers.
    """
    pcts = query(
        "SELECT pctile, value, n FROM mart_market_pct WHERE metric = ? AND genre = ? AND win = ? ORDER BY value",
        [metric, genre, window],
    )
    if not pcts:
        return {
            "error": f"no data for metric={metric!r} genre={genre!r} window={window!r}. "
            "genre must be an exact Steam genre label or '__all__'."
        }
    buckets = query(
        "SELECT x_min, x_max, count FROM mart_market_hist WHERE metric = ? AND genre = ? AND win = ? ORDER BY bucket_index",
        [metric, genre, window],
    )
    return {
        "metric": metric,
        "genre": genre,
        "window": window,
        "n": int(pcts[0]["n"]),
        "percentiles": clean_rows(pcts),
        "histogram": clean_rows(buckets),
    }


@mcp.tool()
def estimate_revenue(
    price: float,
    reviews: int | None = None,
    wishlists: int | None = None,
    genre: str | None = None,
) -> dict:
    """Estimate lifetime owners + gross/net revenue from EITHER a review count OR a
    wishlist count — provide exactly one of `reviews` / `wishlists`, plus `price` (launch
    price in USD) and optionally `genre` (exact Steam genre label — STRONGLY recommended
    whenever known, since owners-per-review varies a lot by genre).

    reviews path (Boxleiter method): owners = reviews x 20-55 owners/review, using this
    catalog's fitted per-genre slope as the "mid" estimate (clamped to the cited 20-55
    band); falls back to the catalog-wide slope, then the cited mid (30) if genre is
    omitted/unrecognized.
    wishlists path: owners = wishlists x ~8-12% first-week conversion x 5 (first-week to
    first-year multiplier) — a rougher, earlier-stage estimate than the reviews path.

    Returns owners and revenue as {low, mid, high} ranges throughout (never a single
    number — this is an order-of-magnitude estimate, not a forecast) plus revenue_net_usd
    (after Steam's ~30% cut) and dev_tier (which of the 4 dev tiers the mid estimate lands
    in). Always report the range to the user, not just the midpoint.
    """
    if (reviews is None) == (wishlists is None):
        return {"error": "Provide exactly one of `reviews` or `wishlists`."}

    lo, hi = float(BOXLEITER_OWNERS_PER_REVIEW_MIN), float(BOXLEITER_OWNERS_PER_REVIEW_MAX)
    genre_used, opr_mid = _genre_owners_per_review(genre)
    notes: list[str] = []

    if reviews is not None:
        basis = "reviews"
        owners = {"low": reviews * lo, "mid": reviews * opr_mid, "high": reviews * hi}
        notes.append(
            f"Owners = reviews x Boxleiter ({lo:.0f}-{hi:.0f} owners/review; "
            f"fitted mid for '{genre_used}' = {opr_mid:.0f})."
        )
    else:
        basis = "wishlists"
        wl_lo, wl_hi = WISHLIST_CONVERSION_RANGE
        wl_mid = WISHLIST_CONVERSION_FIRST_WEEK
        mult = FIRST_WEEK_TO_FIRST_YEAR_MULT
        owners = {
            "low": wishlists * wl_lo * mult,
            "mid": wishlists * wl_mid * mult,
            "high": wishlists * wl_hi * mult,
        }
        notes.append(
            f"Sales = wishlists x first-week conversion ({wl_lo:.0%}-{wl_hi:.0%}, mid "
            f"{wl_mid:.0%}) x first-year multiplier ({mult}x)."
        )
        notes.append("owners_per_review shown for reference only (not used on the wishlist path).")

    revenue_gross = {k: v * price for k, v in owners.items()}
    share = STEAM_REVENUE_SHARE_TO_DEV
    revenue_net = {k: v * share for k, v in revenue_gross.items()}
    notes.append(f"Net = gross x {share:.0%} (after Steam's ~30% cut, before taxes/refunds).")
    notes.append(f"Gross revenue = owners x ${price:.2f} price (box revenue, lifetime).")

    return clean(
        {
            "basis": basis,
            "genre": genre_used,
            "owners_per_review_used": {"low": lo, "mid": opr_mid, "high": hi},
            "owners": owners,
            "revenue_gross_usd": revenue_gross,
            "revenue_net_usd": revenue_net,
            "dev_tier": _tier_for_copies(owners["mid"]),
            "notes": notes,
        }
    )


# ==========================================================================================
# Launch timing tools
# ==========================================================================================
_LAUNCH_WINDOWS = [
    ("1w", 0, 7),
    ("2w", 7, 14),
    ("3-4w", 14, 30),
    ("2m", 30, 60),
    ("3m", 60, 90),
    ("4-6m", 90, 180),
    ("7-12m", 180, 365),
]


@mcp.tool()
def launch_shape(genre: str = "__all__") -> dict:
    """How a genre's first-year review volume accumulates after launch, as a MARGINAL
    windowed shape (share of first-year reviews landing in each window: 1w, 2w, 3-4w, 2m,
    3m, 4-6m, 7-12m) — NOT a cumulative curve (which always climbs to 100% and looks
    similar for every genre). Tall early bars = front-loaded (success hinges on launch-
    week splash: wishlists, a big first-week marketing push); a flatter spread = slow-burn
    (sustained post-launch marketing / word-of-mouth / updates pay off over months).
    genre="__all__" for the whole-catalog shape, or an exact Steam genre label. Only
    genres with enough 365+-day-old games with enough sampled first-year reviews are
    present — check n_games for the sample size backing this.
    """
    rows = query(
        "SELECT day, median_cum_fraction, n_games FROM mart_launch_curve WHERE genre = ? ORDER BY day",
        [genre],
    )
    if not rows:
        return {"error": f"no launch-curve data for genre={genre!r}. Try '__all__' or an exact Steam genre label."}

    cum: dict[int, float] = {int(r["day"]): r["median_cum_fraction"] for r in rows}
    cum[0] = 0.0
    n_games = rows[0]["n_games"]

    windows = []
    for label, a, b in _LAUNCH_WINDOWS:
        fa, fb = cum.get(a), cum.get(b)
        share = max(0.0, fb - fa) if fa is not None and fb is not None else None
        windows.append({"window": label, "share_of_first_year_reviews": share})

    return clean({"genre": genre, "n_games": n_games, "windows": windows})


_TIMING_MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@mcp.tool()
def best_launch_timing(genre: str = "__all__") -> dict:
    """When to launch in a genre, from the TRUE uncapped monthly review histograms
    (Steam's own per-month review-graph totals for ~40K games — exact counts, not the
    sampled `reviews` table). Three reads plus a transparent recommendation:
      - demand_by_month: share of the genre's pooled monthly review velocity landing in
        each calendar month over the last 5 complete years — when players in this genre
        ACTUALLY BUY. Each game's first 2 calendar months since release are EXCLUDED, so
        launch spikes can't masquerade as seasonal demand (without that exclusion a
        popular launch window would "demand" itself into the data by construction).
      - congestion_by_month: average releases (and BIG releases, est. revenue >= $200K)
        per calendar month over the last 3 complete years — how crowded each window is.
        Demand high + congestion low = good window.
      - decay: median share of a game's first-24-months review total landing in months
        0-2 / 3-5 / 6-11 / 12-23 since release (per-game normalized FIRST, then median —
        big games don't dominate), plus the month-0 median share. How long a launch pays
        out, i.e. how much of the payoff rides on the window you pick.
      - recommendation: per-month score = demand_share/(1/12) -
        avg_releases/mean(avg_releases) — both components returned per month so the
        arithmetic is auditable — with the best 2-3 months and a plain-language
        rationale.
    genre="__all__" for the whole catalog, or an exact Steam genre label.
    FALSIFICATION CAVEATS: seasonal effects are real but SECOND-ORDER vs. game quality
    and wishlist momentum — timing tilts odds, it never rescues a weak game. Congestion
    is genre-wide, not niche-level: your actual shelf competition may look nothing like
    the genre average. Reviews proxy sales (Boxleiter) and everything here is
    correlational. There is deliberately no weekday read anymore — the old month×weekday
    medians were composition noise ("a tiebreaker, not a strategy" was the honest label).
    """
    try:
        demand = query(
            "SELECT month, demand_share, n_games FROM mart_timing_demand "
            "WHERE genre = ? ORDER BY month",
            [genre],
        )
        congestion = query(
            "SELECT month, avg_releases, avg_big_releases, n_years FROM mart_timing_congestion "
            "WHERE genre = ? ORDER BY month",
            [genre],
        )
        decay = query(
            "SELECT month_since_release, median_share, n_games FROM mart_timing_decay "
            "WHERE genre = ? ORDER BY month_since_release",
            [genre],
        )
    except duckdb.CatalogException:
        return {
            "error": "mart_timing_demand/mart_timing_congestion/mart_timing_decay are not "
            "present in this analytics DB — they are built by a newer ETL than the one that "
            "produced it. Re-run `task etl` in the prospect checkout (needs a source "
            "steam_games.db with the review_histogram table), then retry."
        }
    if not demand and not congestion and not decay:
        return {
            "error": f"no timing data for genre={genre!r} — it may be below the per-genre "
            "size floors. Try '__all__' or an exact Steam genre label."
        }

    for d in demand:
        d["month_name"] = _TIMING_MONTH_NAMES[int(d["month"])]
    for c in congestion:
        c["month_name"] = _TIMING_MONTH_NAMES[int(c["month"])]

    # Transparent window score — same arithmetic as /api/timing/overview.
    recommendation = None
    d_by_m = {int(d["month"]): d for d in demand if d["demand_share"] is not None}
    c_by_m = {int(c["month"]): c for c in congestion}
    if len(d_by_m) == 12 and len(c_by_m) == 12:
        mean_rel = sum(c["avg_releases"] for c in c_by_m.values()) / 12
        months = []
        for m in range(1, 13):
            demand_index = d_by_m[m]["demand_share"] * 12
            congestion_index = c_by_m[m]["avg_releases"] / mean_rel if mean_rel > 0 else None
            months.append({
                "month": m,
                "month_name": _TIMING_MONTH_NAMES[m],
                "demand_index": demand_index,
                "congestion_index": congestion_index,
                "score": demand_index - congestion_index if congestion_index is not None else None,
            })
        scored = [w for w in months if w["score"] is not None]
        if scored:
            best = sorted(scored, key=lambda w: w["score"], reverse=True)[:3]
            top = best[0]
            label = "the catalog" if genre == "__all__" else genre
            recommendation = {
                "best_months": [w["month_name"] for w in best],
                "method": "score = demand_share/(1/12) - avg_releases/mean(avg_releases)",
                "rationale": (
                    f"{', '.join(w['month_name'] for w in best)} look best for {label}: in "
                    f"{top['month_name']}, players do {top['demand_index']:.2f}x an average "
                    f"month's buying while release traffic runs "
                    f"{top['congestion_index']:.2f}x the monthly average — demand outruns "
                    "crowding there. Timing tilts odds; it doesn't rescue a weak game."
                ),
                "months": months,
            }

    # Decay condensed to windows (the full 24-point curve lives on /api/timing/overview).
    decay_summary = None
    med = {int(r["month_since_release"]): r["median_share"] for r in decay
           if r["median_share"] is not None}
    total = sum(med.values())
    if med and total > 0:
        def _win(a: int, b: int) -> float:  # [a, b) renormalized share
            return sum(s for m, s in med.items() if a <= m < b) / total
        decay_summary = {
            "n_games": decay[0]["n_games"],
            "month_0_median_share": med.get(0),
            "share_of_first_24m_reviews": {
                "months_0_2": _win(0, 3),
                "months_3_5": _win(3, 6),
                "months_6_11": _win(6, 12),
                "months_12_23": _win(12, 24),
            },
            "note": "per-game normalized medians, renormalized to sum to 1 across the 24 months",
        }

    return clean({
        "genre": genre,
        "recommendation": recommendation,
        "demand_by_month": demand,
        "congestion_by_month": congestion,
        "decay": decay_summary,
        "caveats": (
            "Seasonal effects are second-order vs. game quality; congestion is genre-wide, "
            "not niche-level; reviews proxy sales; correlational throughout."
        ),
    })


# ==========================================================================================
# Game tools
# ==========================================================================================
_GAME_SORTABLE = {
    "name", "release_year", "price_initial", "owners_mid", "total_reviews",
    "positive_ratio", "est_rev_reviews", "rev_pct_in_genre", "reviews_pct_in_genre",
    "owners_pct_in_genre", "n_reviews_trailing_30d",
}


@mcp.tool()
def game_search(
    q: str | None = None,
    tag: str | None = None,
    genre: str | None = None,
    min_reviews: int = 0,
    sort: str = "total_reviews",
    order: Literal["asc", "desc"] = "desc",
    limit: int = 15,
) -> dict:
    """Search/filter the game catalog (only games clearing the >=10-review analysis
    floor). q = case-insensitive substring match on name. genre = exact Steam genre label
    — matches the game's PRIMARY genre only (a multi-genre game is indexed under one).
    tag = exact match against the game's top-N community tags (not a substring — must be
    one of its actual top tags). Combine q/tag/genre freely (AND, all optional). Use this
    to find an appid for game_profile/game_teardown, or to spot-check who the top players
    in a niche/genre are. sort is any returned numeric field (default total_reviews);
    *_pct_in_genre fields are 0-100 percentile rank within the game's own primary genre.
    """
    if sort not in _GAME_SORTABLE:
        return {"error": f"sort must be one of {sorted(_GAME_SORTABLE)}"}

    where = ["total_reviews >= ?"]
    params: list = [min_reviews]
    if q:
        if _HAS_NAME_LOWER:
            where.append("contains(name_lower, ?)")
            params.append(q.lower())
        else:
            where.append("name ILIKE ?")
            params.append(f"%{q}%")
    if genre:
        where.append("primary_genre = ?")
        params.append(genre)
    if tag:
        where.append("list_contains(top_tags, ?)")
        params.append(tag)
    limit = max(1, min(limit, 50))

    rows = query(
        f"""
        SELECT appid, name, primary_genre, release_year, price_initial, owners_mid,
               total_reviews, positive_ratio, est_rev_reviews, top_tags
        FROM mart_game
        WHERE {" AND ".join(where)}
        ORDER BY {sort} {order.upper()} NULLS LAST, total_reviews DESC
        LIMIT ?
        """,
        params + [limit],
    )
    return {
        "filters": {"q": q, "tag": tag, "genre": genre, "min_reviews": min_reviews},
        "sort": sort,
        "order": order,
        "n_returned": len(rows),
        "games": clean_rows(rows),
    }


@mcp.tool()
def game_profile(appid: int) -> dict:
    """Full profile for one game by Steam appid: metadata (primary genre, developers,
    publishers, self-published?, indie?), price, owners/reviews/est. revenue, percentile
    rank vs OTHER games in the same primary genre (rev_pct_in_genre, reviews_pct_in_genre,
    owners_pct_in_genre — all 0-100), top community tags, and review-velocity (reviews
    landed in the first 30/90/365 days post-release, plus current trailing-30d velocity —
    a live "is this still getting attention" signal). Also live players when the mart
    carries them: live_players (latest nightly ~21-22:00 UTC point sample — NOT a daily
    peak), players_7d_avg (trailing-7d average of those samples) and players_trend_7d_pct
    (vs the prior 7d); NULL = not yet measured — call game_player_history(appid) for the
    daily series. Use game_search to find an appid by name first. Returns {"error": ...}
    if the appid isn't in the catalog or didn't clear the >=10-review analysis floor
    (mart_game only carries scored games).
    """
    players_cols = (
        ",\n               live_players, players_7d_avg, players_trend_7d_pct"
        if _HAS_PLAYERS
        else ""
    )
    row = query_one(
        f"""
        SELECT appid, name, release_year, release_date, price_initial, is_free,
               primary_genre, developers, publishers, self_published, is_indie,
               owners_mid, total_reviews, positive_ratio, est_rev_reviews, est_rev_owners,
               metacritic_score, achievements_count, avg_playtime_forever,
               short_description, rev_pct_in_genre, reviews_pct_in_genre,
               owners_pct_in_genre, top_tags, n_reviews_first_30d, n_reviews_first_90d,
               n_reviews_first_365d, n_reviews_trailing_30d, playtime_p25, playtime_p50,
               playtime_p75{players_cols}
        FROM mart_game WHERE appid = ?
        """,
        [appid],
    )
    if row is None:
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, "
            "or has fewer than 10 sampled reviews and didn't clear the analysis floor."
        }
    out = clean(row)
    if _HAS_PLAYERS:
        out["caveats"] = [_PLAYERS_POINT_SAMPLE_CAVEAT]
    return out


@mcp.tool()
def find_comparables(appid: int, limit: int = 15, min_reviews: int = 10) -> dict:
    """Closest competitors for one game — "who else is fighting for this audience?"
    Tag-overlap comparables computed on demand at query time (never precomputed pairwise
    across the ~142K catalog). Use game_search to find the appid by name first.

    Matching rules (exact):
      - Same PRIMARY Steam genre as the target only. A multi-genre game is indexed under
        one primary genre, so a near-neighbor filed under a different primary won't appear.
      - Price band around the target's launch price: paid games match
        [max(0, 0.5*price − $2), 2*price + $2]; FREE games are only comparable to other
        free games (F2P competes on a different axis than any paid title).
      - Candidates need total_reviews >= min_reviews (default 10 — raise it to keep only
        proven competitors).
      - Ranked by Jaccard similarity over the two games' top community tags (each game's
        top-10 SteamSpy tags): |shared tags| / |union of both tag sets|, ties broken by
        total_reviews. shared_tags shows exactly which tags matched.

    Returns compact rows: appid, name, release_year, price_initial, total_reviews,
    positive_ratio, est_rev_reviews, shared_tags, jaccard (0-1), plus the price band used.

    Honest caveats: tag-Jaccard is MECHANICAL similarity — a high score says the tag sets
    overlap, not that the audiences do (two "Souls-like" matches can serve disjoint
    players); est_rev_reviews is a Boxleiter ESTIMATE (see market_benchmarks), not
    reported revenue; and tags are community-applied, so mistagged or thinly-tagged games
    mismatch. Unknown appid (or one below the >=10-review analysis floor) returns
    {"error": ...} — use game_search to find valid appids. Follow up with
    game_profile(appid) on the closest matches to see how each performs, and
    game_teardown(appid) to see WHY the strongest ones work.
    """
    target = query_one(
        "SELECT appid, name, primary_genre, price_initial, top_tags FROM mart_game WHERE appid = ?",
        [appid],
    )
    if target is None:
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, "
            "or below the >=10-review analysis floor. Use game_search to find appids."
        }

    price = target["price_initial"] or 0.0
    if price <= 0:
        lo, hi = -0.01, 0.01  # free games are only comparable to other free games
    else:
        lo, hi = max(0.0, price * 0.5 - 2.0), price * 2.0 + 2.0
    limit = max(1, min(limit, 50))

    # Jaccard denominator via |A ∪ B| = len(a) + len(b) − |A ∩ B| — exact, because
    # top_tags is duplicate-free by construction (a top-10 ranking). The FastAPI twin
    # (api/app/routers/games.py::game_comparables) computes it as
    # len(list_distinct(list_concat(a, b))) per row, which made it the slowest handler in
    # production (808ms p95); this form skips the per-row concat+distinct and returns the
    # identical ordering.
    rows = query(
        """
        WITH target AS (SELECT appid, primary_genre, top_tags FROM mart_game WHERE appid = ?),
        scored AS (
            SELECT g.appid, g.name, g.release_year, g.price_initial, g.total_reviews,
                g.positive_ratio, g.est_rev_reviews,
                list_intersect(g.top_tags, t.top_tags) AS shared_tags,
                len(list_intersect(g.top_tags, t.top_tags)) AS n_shared,
                len(g.top_tags) + len(t.top_tags) AS len_sum
            FROM mart_game g, target t
            WHERE g.appid != t.appid
              AND g.primary_genre = t.primary_genre
              AND g.price_initial BETWEEN ? AND ?
              AND g.total_reviews >= ?
        )
        SELECT appid, name, release_year, price_initial, total_reviews, positive_ratio,
            est_rev_reviews, shared_tags,
            n_shared * 1.0 / (len_sum - n_shared) AS jaccard
        FROM scored
        WHERE len_sum - n_shared > 0
        ORDER BY jaccard DESC, total_reviews DESC
        LIMIT ?
        """,
        [appid, lo, hi, min_reviews, limit],
    )
    result = {
        "appid": appid,
        "name": target["name"],
        "primary_genre": target["primary_genre"],
        "price_band": {"low": lo, "high": hi},
        "min_reviews": min_reviews,
        "n_returned": len(rows),
        "comparables": clean_rows(rows),
        "caveats": [
            "Tag-Jaccard is mechanical similarity: overlapping tag sets, not overlapping "
            "audiences — sanity-check the top matches with game_profile before leaning on them.",
            "est_rev_reviews is a Boxleiter estimate (gross lifetime), not reported revenue.",
            "Only games sharing the target's PRIMARY genre are candidates; free games only "
            "match other free games.",
        ],
    }
    if not rows:
        result["note"] = (
            "No comparables matched — the target may have a rare primary genre, few/no "
            "community tags, or no same-genre games in its price band clearing min_reviews."
        )
    return clean(result)


@mcp.tool()
def game_teardown(appid: int) -> dict:
    """"Why it works" teardown for one game — fuses (A) review-text aspect mining with
    (B) press/PR footprint. Use game_search to find an appid by name first.

    (A) review_aspects: 10 fixed aspects (Combat & Bosses, World & Exploration, Art &
    Visuals, Music & Audio, Story & Writing, Difficulty, Controls & Performance, Map &
    Navigation/Backtracking, Content & Length, Price & Value), each with pos_share (share
    of keyword-matched review mentions that were praise, i.e. from a positive review) and
    delta_vs_genre (this game's pos_share MINUS its genre's baseline pos_share — the
    differential signal: what makes THIS game stand out from genre peers, not just
    "players like it").
    (B) press: total mentions, distinct outlets, first/last-seen date, top sources, and up
    to 5 notable articles (including the earliest) — the PR footprint / angle.

    Both signals are CORRELATIONAL: evidence toward why a game got popular, never proof.
    Degrades gracefully for low-review/low-press games — always check eligible_reviews and
    press.total_mentions before leaning on the numbers; read `caveats` for this specific
    game's data-quality flags.
    """
    game = query_one("SELECT appid, name, primary_genre FROM mart_game WHERE appid = ?", [appid])
    if game is None:
        return {"error": f"appid {appid} not found in mart_game."}

    aspect_rows = query(
        """
        SELECT a.aspect, a.n_pos_mentions, a.n_neg_mentions, a.total_mentions, a.pos_share,
            a.n_reviews_sampled,
            COALESCE(gb.pos_share, ab.pos_share) AS genre_pos_share,
            a.pos_share - COALESCE(gb.pos_share, ab.pos_share) AS delta_vs_genre
        FROM mart_game_review_aspects a
        LEFT JOIN mart_genre_aspect_baseline gb ON gb.genre = ? AND gb.aspect = a.aspect
        LEFT JOIN mart_genre_aspect_baseline ab ON ab.genre = '__all__' AND ab.aspect = a.aspect
        WHERE a.appid = ?
        ORDER BY a.total_mentions DESC
        """,
        [game["primary_genre"], appid],
    )
    n_reviews_sampled = int(aspect_rows[0]["n_reviews_sampled"]) if aspect_rows else 0

    press_summary = query_one(
        "SELECT total_mentions, n_sources, first_seen, last_seen FROM mart_game_press_summary WHERE appid = ?",
        [appid],
    )
    by_source = query(
        "SELECT source, n_mentions FROM mart_game_press_by_source WHERE appid = ? ORDER BY n_mentions DESC LIMIT 8",
        [appid],
    )
    notable = query(
        "SELECT source, title, author, published_at, is_earliest FROM mart_game_press_notable "
        "WHERE appid = ? ORDER BY published_at LIMIT 5",
        [appid],
    )

    caveats = [
        "Review aspects are mined from a SAMPLE of English-language reviews, recency-biased "
        "toward older/popular titles — not the game's full review history.",
        "Press coverage is fuzzy-matched and confidence-filtered, skews recent (~365-day scrape "
        "backfill) and English-outlet; Steam News (dev-authored posts) is excluded.",
        "Correlational, not causal: evidence toward \"why it got popular,\" not proof.",
    ]
    if 0 < n_reviews_sampled < 50:
        caveats.append(f"Only {n_reviews_sampled} sampled English reviews — aspect shares are thin/noisy.")
    if not aspect_rows:
        caveats.append("Fewer than the review floor of sampled English reviews — review-aspect mining unavailable.")
    if press_summary is None:
        caveats.append("No press coverage found above the match-confidence floor.")

    return clean(
        {
            "appid": appid,
            "name": game["name"],
            "primary_genre": game["primary_genre"],
            "eligible_reviews": len(aspect_rows) > 0,
            "n_reviews_sampled": n_reviews_sampled,
            "review_aspects": aspect_rows,
            "press": {
                "total_mentions": int(press_summary["total_mentions"]) if press_summary else 0,
                "n_sources": int(press_summary["n_sources"]) if press_summary else 0,
                "first_seen": press_summary["first_seen"] if press_summary else None,
                "last_seen": press_summary["last_seen"] if press_summary else None,
                "by_source": by_source,
                "notable_articles": notable,
            },
            "caveats": caveats,
        }
    )


# ==========================================================================================
# Developer / publisher entity tools
# ==========================================================================================
_ENTITY_MARTS_MISSING = {
    "error": "mart_entity / mart_entity_games are not present in this analytics DB — they "
    "are built by a newer ETL than the one that produced this current.duckdb. Rebuild the "
    "marts (`task etl` in the main prospect checkout) and retry."
}

# entity_profile games-list / trajectory compaction: entities up to this many games get the
# full per-game list and per-seq trajectory; bigger ones (top publishers run to ~550 games)
# get head+tail games and a bucketed trajectory so the response stays token-lean.
_ENTITY_FULL_LIST_MAX = 40
_ENTITY_HEAD_TAIL = 20        # games kept from each end when truncating
_ENTITY_TRAJ_BUCKETS = 20     # per-seq trajectory buckets when n_games > _ENTITY_FULL_LIST_MAX


def _median_of(vals: list) -> float | None:
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    import statistics
    return float(statistics.median(vals))


def _entity_trajectory(games: list[dict]) -> dict:
    """Release-trajectory summary from the seq-ordered games list: debut vs latest, early-
    vs-recent median revenue, and a per-seq revenue series (bucketed for large entities) so
    an agent can see the debut -> latest arc without re-fetching anything."""
    n = len(games)

    def _pt(g: dict) -> dict:
        return {"seq": g["seq"], "name": g["name"], "release_year": g["release_year"],
                "est_rev_reviews": g["est_rev_reviews"]}

    out: dict = {
        "debut": _pt(games[0]),
        "latest": _pt(games[-1]),
        "first5_median_rev": _median_of([g["est_rev_reviews"] for g in games[:5]]),
        "last5_median_rev": _median_of([g["est_rev_reviews"] for g in games[-5:]]),
    }
    if n <= _ENTITY_FULL_LIST_MAX:
        out["per_seq"] = [
            {"seq": g["seq"], "release_year": g["release_year"], "est_rev_reviews": g["est_rev_reviews"]}
            for g in games
        ]
    else:
        buckets = []
        per = max(1, -(-n // _ENTITY_TRAJ_BUCKETS))  # ceil division
        for i in range(0, n, per):
            chunk = games[i:i + per]
            years = [g["release_year"] for g in chunk if g["release_year"] is not None]
            buckets.append({
                "seq_from": chunk[0]["seq"], "seq_to": chunk[-1]["seq"], "n": len(chunk),
                "year_from": min(years) if years else None,
                "year_to": max(years) if years else None,
                "median_rev": _median_of([g["est_rev_reviews"] for g in chunk]),
            })
        out["per_seq_bucketed"] = buckets
    return out


@mcp.tool()
def entity_profile(name: str, role: Literal["developer", "publisher"] = "developer") -> dict:
    """Profile one developer or publisher ENTITY by exact name: aggregate track record
    (n_games, first/last release year, n_recent_24m — releases in the last 24 months, the
    active/dormant signal — total/median est. revenue, hit_rate_200k, median reviews/
    rating, self_published_share, top genres, and for publishers n_partners = distinct
    developer names they've published), its games (oldest first by seq: appid, name,
    release_year, price, total_reviews, positive_ratio, est_rev_reviews, primary_genre),
    and a release-trajectory summary (per-seq revenue: debut -> latest arc, plus first-5
    vs last-5 median revenue). Entities with more than 40 games return the earliest +
    latest 20 games and a BUCKETED trajectory (games_omitted says how many middle games
    were elided) — the aggregates always cover ALL games.

    Entities come from mart_game's self-reported developers/publishers strings, split on
    commas with corporate suffixes re-merged (", Inc."/", Ltd." never become entities) —
    but NO fuzzy identity resolution: the same studio under variant spellings/branding
    ("Ubisoft" vs "UBISOFT", "FromSoftware, Inc." vs "FromSoftware") counts as SEPARATE
    entities, so a famous studio's numbers may be split across variants — check the
    suggestions on a miss, and sum variants yourself when it matters. Revenue is
    est_rev_reviews (Boxleiter-style gross lifetime ESTIMATE), never ground truth.
    self_published_share = share of its games where the same name is on both sides
    (developer AND publisher).

    name must match EXACTLY (trimmed, case-sensitive). On a miss, returns {"error": ...}
    with up to 5 close-match suggestions (substring, case-insensitive) — and says so if
    the exact name exists under the OTHER role (e.g. a publisher-only entity queried as
    a developer)."""
    try:
        ent = query_one(
            """
            SELECT role, name, n_games, first_release_year, last_release_year, n_recent_24m,
                   total_rev, median_rev, hit_rate_200k, median_reviews, median_positive_ratio,
                   self_published_share, top_genres, n_partners
            FROM mart_entity WHERE role = ? AND name = ?
            """,
            [role, name],
        )
    except duckdb.CatalogException:
        return dict(_ENTITY_MARTS_MISSING)

    if ent is None:
        other_role = "publisher" if role == "developer" else "developer"
        hints = []
        if query_one("SELECT 1 FROM mart_entity WHERE role = ? AND name = ?", [other_role, name]):
            hints.append(f"{name!r} exists as a {other_role} — call entity_profile(name, role={other_role!r}).")
        suggestions = query(
            "SELECT name, n_games FROM mart_entity WHERE role = ? AND name ILIKE ? "
            "ORDER BY n_games DESC, name LIMIT 5",
            [role, f"%{name}%"],
        )
        return {
            "error": f"no {role} named {name!r} (exact match, case-sensitive). "
            + (hints[0] + " " if hints else "")
            + ("Close matches in `suggestions` — retry with one of those exact names."
               if suggestions else "No close matches either — try a shorter substring."),
            "suggestions": suggestions,
        }

    games = query(
        """
        SELECT meg.seq, g.appid, g.name, g.release_year, g.price_initial AS price,
               g.total_reviews, g.positive_ratio, g.est_rev_reviews, g.primary_genre
        FROM mart_entity_games meg
        JOIN mart_game g ON g.appid = meg.appid
        WHERE meg.role = ? AND meg.name = ?
        ORDER BY meg.seq
        """,
        [role, name],
    )

    trajectory = _entity_trajectory(games) if games else {}
    games_omitted = 0
    if len(games) > _ENTITY_FULL_LIST_MAX:
        games_omitted = len(games) - 2 * _ENTITY_HEAD_TAIL
        games = games[:_ENTITY_HEAD_TAIL] + games[-_ENTITY_HEAD_TAIL:]

    return clean(
        {
            "entity": ent,
            "games": games,
            "games_omitted": games_omitted,
            "trajectory": trajectory,
            "caveats": [
                "Revenue is est_rev_reviews — a Boxleiter-style gross lifetime ESTIMATE.",
                "Entity names are self-reported strings; variant spellings of the same "
                "studio are separate entities (no fuzzy identity resolution).",
                "Population is the full live catalog including 0-review games — medians "
                "and hit_rate_200k are computed over games with revenue estimates only.",
            ],
        }
    )


@mcp.tool()
def publisher_pitch_list(genre: str, min_games: int = 3, limit: int = 15) -> dict:
    """Which publishers to pitch for one Steam genre (exact PRIMARY-genre label, e.g.
    "RPG", "Strategy" — see game_profile/market_benchmarks for valid labels): publishers
    with >= min_games total releases and >= 1 in this genre, ACTIVE ones first (active =
    any release in the last 24 months; dormant publishers rank below every active one —
    check the flag before pitching), then by games in this genre. Per row: n_games (total),
    n_in_genre, n_recent_24m, active, median_rev_in_genre (median est. revenue of THEIR
    games in this genre), example_game (their top-earning title in the genre — name-drop /
    fit-check it), n_partners (distinct developer names they've published — a proxy for
    how many external studios they actually work with), and self_published_share.

    Read the numbers with these falsification rules in mind:
      - Revenue is est_rev_reviews — a Boxleiter-style ESTIMATE, not ground truth.
      - A publisher's median outcome is NOT publisher value-add: good publishers SELECT
        good games (selection bias) — a high median_rev_in_genre says "they pick/attract
        winners", not "they will make yours one".
      - Entity names are self-reported strings; the same publisher under variant
        spellings counts as separate rows.
      - Self-published games are NOT excluded (Steam lists the dev as its own publisher),
        so a "publisher" with self_published_share ~1.0 is really a self-publishing dev
        who has never taken third-party games — filter those out when scouting for an
        actual publishing partner (that's why the share is surfaced per row).

    An empty list is a real answer (no publisher meets the floors in this genre) — but
    double-check the genre label first: it must be an exact Steam PRIMARY genre, not a
    community tag ("Roguelike" is a tag; its games' primary genre is usually "Action" or
    "Strategy"). Use entity_profile(name, role="publisher") to deep-dive a row."""
    min_games = max(1, min_games)
    limit = max(1, min(limit, 50))
    try:
        rows = query(
            """
            WITH in_genre AS (
                SELECT meg.name,
                    COUNT(*) AS n_in_genre,
                    median(g.est_rev_reviews) AS median_rev_in_genre,
                    arg_max(g.name, COALESCE(g.est_rev_reviews, -1)) AS example_game
                FROM mart_entity_games meg
                JOIN mart_game g ON g.appid = meg.appid
                WHERE meg.role = 'publisher' AND g.primary_genre = ?
                GROUP BY meg.name
            )
            SELECT e.name, e.n_games, ig.n_in_genre, e.n_recent_24m,
                   (e.n_recent_24m > 0) AS active,
                   ig.median_rev_in_genre, ig.example_game,
                   e.n_partners, e.self_published_share
            FROM mart_entity e
            JOIN in_genre ig ON ig.name = e.name
            WHERE e.role = 'publisher' AND e.n_games >= ?
            ORDER BY active DESC, ig.n_in_genre DESC, e.n_recent_24m DESC, e.n_games DESC, e.name
            LIMIT ?
            """,
            [genre, min_games, limit],
        )
    except duckdb.CatalogException:
        return dict(_ENTITY_MARTS_MISSING)

    caveats = [
        "Revenue is est_rev_reviews — a Boxleiter-style gross lifetime ESTIMATE.",
        "Selection bias: a publisher's median outcome reflects the games they pick, not "
        "the value they add — descriptive, not a promise for YOUR game.",
        "Entity names are self-reported; the same publisher under variant spellings "
        "counts as separate rows.",
        "Self-published rows are kept: self_published_share ~1.0 means a self-publishing "
        "dev, not a publishing partner — filter on it when scouting.",
        "active = any release in the last 24 months; dormant (active=false) rows may no "
        "longer sign games.",
    ]
    if not rows:
        caveats.insert(
            0,
            f"No publisher meets the floors for genre '{genre}'. genre must be an exact "
            "Steam PRIMARY-genre label (not a community tag) — check spelling/case via "
            "game_profile or market_benchmarks' boxleiter_by_genre.",
        )
    return {
        "genre": genre,
        "min_games": min_games,
        "n_returned": len(rows),
        "publishers": clean_rows(rows),
        "caveats": caveats,
    }


# ==========================================================================================
# Press / buzz tools
# ==========================================================================================
@mcp.tool()
def press_pitch_list(genre: str, limit: int = 15) -> dict:
    """Who to pitch for press coverage in one Steam genre (exact label, e.g. "RPG",
    "Action" — see a game_profile/game_search result's primary_genre, or
    market_benchmarks' boxleiter_by_genre, for valid labels). Returns:
      - outlets: ranked by article count — source, n_articles, n_games_covered, median
        outcome (est. revenue/owners/rating) of the games it covered, one example
        headline+date+url.
      - journalists: ranked by article count — author, n_articles, n_distinct_games,
        which outlets they've written for, one example headline+date+url.
    Steam News (dev-authored posts) is excluded — journalist/trade-press coverage only.
    Ranked by ALL-TIME volume: always check the example article's date (and
    n_articles_recent_24m) before pitching — a prolific past contributor may no longer
    cover the beat. A genre with zero rows is a real, honest answer (selection bias / thin
    coverage), not an error — double-check the exact genre spelling first.
    """
    outlets = query(
        "SELECT source, n_articles, n_articles_recent_24m, n_games_covered, median_est_rev, "
        "median_owners, median_positive_ratio, example_author, example_title, example_url, "
        "example_published_at FROM mart_press_outlet_genre WHERE genre = ? ORDER BY n_articles DESC",
        [genre],
    )
    limit = max(1, min(limit, 50))
    authors = query(
        "SELECT author, n_articles, n_articles_recent_24m, n_distinct_games, outlets, "
        "example_source, example_title, example_url, example_published_at "
        "FROM mart_press_author WHERE genre = ? ORDER BY n_articles DESC LIMIT ?",
        [genre, limit],
    )
    caveats = [
        "Selection bias: these outlets/journalists already chose to cover this genre — "
        "descriptive of the current press landscape, not a guarantee of future coverage.",
        "Ranked by ALL-TIME article volume (archives run back to 1997-2005 depending on "
        "source) — check n_articles_recent_24m and the example date; a past contributor may "
        "no longer cover the beat.",
        "Coverage is fuzzy-matched to games (match_confidence-filtered) — a lower-volume "
        "specialist can still be a sharper pitch target than the top row.",
        "Steam News excluded — journalist/trade-press coverage only.",
        "Genre is Steam's own exact genre field (not a community tag); a game usually has "
        "several genres, so the same article can count toward multiple genre pitch lists.",
    ]
    if not outlets and not authors:
        caveats.insert(
            0,
            f"No confidence-filtered journalist coverage found for genre '{genre}'. genre "
            "must be an exact Steam genre label (not a community tag like \"Roguelike\").",
        )
    return {
        "genre": genre,
        "outlets": clean_rows(outlets),
        "journalists": clean_rows(authors),
        "caveats": caveats,
    }


@mcp.tool()
def buzz_trends(
    direction: Literal["rising", "cooling"] = "rising",
    limit: int = 15,
    include_series: bool = False,
) -> dict:
    """Rising or cooling game-concept buzz: bigram terms (mechanics/genres/tags — e.g.
    "open world", "roguelike deckbuilder") mined from journalist article TITLES over the
    last 12 complete months, restricted to Steam's own tag/genre vocabulary so this reads
    as game concepts, not news noise (sale events, publisher names, franchise titles).
    This is a LEADING indicator — buzz building in press coverage before it shows up in
    actual releases/sales — distinct from niche_detail's saturation_trend (a LAGGING
    signal based on real releases).

    direction="rising" sorts by steepest recent-vs-prior 3-month increase first;
    "cooling" by steepest decrease first. include_series=True adds each term's monthly
    mention-count series (12 points/term) — leave False (default) for a compact
    summary-only response (total_mentions, recent_avg, prior_avg, slope per term).
    """
    order = "DESC" if direction == "rising" else "ASC"
    limit = max(1, min(limit, 50))
    rows = query(
        f"SELECT term, total_mentions, recent_avg, prior_avg, slope FROM mart_buzz_trends_summary "
        f"WHERE direction = ? ORDER BY slope {order} LIMIT ?",
        [direction, limit],
    )
    items = clean_rows(rows)

    if include_series and items:
        terms = [item["term"] for item in items]
        placeholders = ",".join("?" for _ in terms)
        series_rows = query(
            f"SELECT term, period, n_mentions FROM mart_buzz_trends WHERE term IN ({placeholders}) "
            f"ORDER BY term, period",
            terms,
        )
        by_term: dict[str, list[dict]] = {t: [] for t in terms}
        for sr in series_rows:
            by_term[sr["term"]].append({"period": sr["period"], "n_mentions": sr["n_mentions"]})
        for item in items:
            item["series"] = by_term.get(item["term"], [])

    return {
        "direction": direction,
        "n_returned": len(items),
        "terms": items,
        "caveats": [
            "Compares the last 3 complete months to the 3 months before that; the current "
            "in-progress month is excluded.",
            "Mined from journalist article TITLES only, as English stopword-filtered bigrams — "
            "a coarse, cheap leading indicator, not full topic modeling or sentiment analysis.",
            "Restricted to Steam's tag/genre vocabulary (word-level match) so this reads as "
            "game concepts, not franchise names or sale events; an occasional edge case can "
            "still slip through.",
        ],
    }


# ==========================================================================================
# Marketing / multi-channel tools (Track M — Press · YouTube · Reddit · Twitch · X)
# ==========================================================================================
_MARKETING_PLATFORMS = {"youtube", "reddit", "twitch", "x"}


@mcp.tool()
def creator_pitch_list(genre: str, platform: Literal["youtube", "reddit", "twitch", "x"], limit: int = 15) -> dict:
    """Who to pitch on ONE creator platform (YouTube channels, Reddit communities/posters,
    Twitch streamers, or X accounts) for one Steam genre (exact label — see game_profile /
    market_benchmarks for valid labels). For press/journalist pitching use press_pitch_list
    instead — this tool is creator-platform only.

    Ranked by reach x recent activity (pitch_score = latest known reach x (1 + mentions in
    the last 24 months)) — a creator with no reach snapshot yet still appears, ranked by
    recent activity alone (reach shows as null, not zero — a null means "no snapshot
    captured yet," not "no audience"). Each row includes an example mention
    (title/url/date) to sanity-check before pitching.

    Empty results is a real, honest answer — either no scraper has been run for this
    platform yet, or genuinely no confidence-filtered coverage exists for this genre on it.
    """
    if platform not in _MARKETING_PLATFORMS:
        return {"error": f"platform must be one of {sorted(_MARKETING_PLATFORMS)}"}
    limit = max(1, min(limit, 50))
    rows = query(
        "SELECT platform, creator_id, handle, display_name, creator_url, n_mentions, "
        "n_mentions_recent, n_games_covered, reach, reach_captured_at, pitch_score, "
        "example_title, example_url, example_published_at "
        "FROM mart_creator_pitch WHERE genre = ? AND platform = ? ORDER BY pitch_score DESC LIMIT ?",
        [genre, platform, limit],
    )
    caveats = [
        "Selection bias: these creators already chose to cover this genre — descriptive, not a "
        "guarantee of future coverage.",
        "reach is a SNAPSHOT, not live — check reach_captured_at before citing it.",
        "Fuzzy-matched to games and confidence-filtered — not proof of a correct match.",
    ]
    if not rows:
        caveats.insert(
            0,
            f"No {platform} coverage found for genre '{genre}' — run the {platform} channel "
            "scraper to start collecting data, or this genre may genuinely have none yet.",
        )
    return {"genre": genre, "platform": platform, "n_returned": len(rows), "creators": clean_rows(rows), "caveats": caveats}


@mcp.tool()
def channel_mix(genre: str | None = None) -> dict:
    """Share of marketing "attention" by channel (Press vs YouTube vs Reddit vs Twitch vs X)
    for one genre, or the full genre x channel matrix if genre is omitted. Two parallel
    measures per channel: n_mentions (raw coverage volume) and reach_weighted (mentions
    weighted by audience size — press = 1/mention since outlets carry no audience-size
    figure here; creator mentions = reach at the time of the mention, falling back to the
    latest known snapshot, then 1). share_reach_weighted is usually the more decision-
    relevant number ("where do the eyeballs actually come from"), but a single very-large
    channel can dominate it — compare both before deciding where to spend effort. Before any
    channel scraper has run, every genre's mix reads 100% press — a real snapshot of today's
    coverage, not an error.
    """
    where = ""
    params: list = []
    if genre:
        where = "WHERE genre = ?"
        params.append(genre)
    rows = query(
        f"SELECT genre, channel, n_mentions, reach_weighted, share_mentions, share_reach_weighted "
        f"FROM mart_channel_mix {where} ORDER BY genre, share_reach_weighted DESC",
        params,
    )
    if not rows:
        return {
            "genre": genre,
            "items": [],
            "note": "No channel-mix data yet for this genre — either the genre label is "
            "wrong/unrecognized, or no marketing data (press or creator scrapers) has been "
            "collected yet.",
        }
    return {"genre": genre, "n_returned": len(rows), "items": clean_rows(rows)}


@mcp.tool()
def channel_buzz(direction: Literal["rising", "cooling"] = "rising", limit: int = 15, include_series: bool = False) -> dict:
    """Reach-WEIGHTED trending game-concepts across every marketing channel (press + YouTube +
    Reddit + Twitch + X combined) — the multi-channel sequel to buzz_trends (which is press-
    title-only and unweighted). Same bigram/concept-allowlist mining as buzz_trends, but each
    mention is weighted by its audience size (a mega-channel's coverage moves this more than
    a tiny one) instead of counted equally — see total_weighted vs total_mentions (raw count)
    per term, and by_channel for which channel(s) are actually driving a term.

    direction="rising"/"cooling" sorts by steepest recent-vs-prior weighted-average change.
    include_series=True adds each term's per-period (n_mentions, reach_weighted_score) —
    leave False for a compact summary.
    """
    order = "DESC" if direction == "rising" else "ASC"
    limit = max(1, min(limit, 50))
    rows = query(
        f"SELECT term, total_mentions, total_weighted, recent_avg_weighted, prior_avg_weighted, "
        f"slope_weighted FROM mart_channel_buzz_summary WHERE direction = ? "
        f"ORDER BY slope_weighted {order} LIMIT ?",
        [direction, limit],
    )
    items = clean_rows(rows)

    if items:
        terms = [item["term"] for item in items]
        placeholders = ",".join("?" for _ in terms)
        detail_rows = query(
            f"SELECT term, channel, period, n_mentions, reach_weighted_score FROM mart_channel_buzz "
            f"WHERE term IN ({placeholders}) ORDER BY term, period",
            terms,
        )
        breakdown: dict[str, dict[str, dict]] = {t: {} for t in terms}
        series: dict[str, dict[str, dict]] = {t: {} for t in terms}
        for r in detail_rows:
            t, ch, per = r["term"], r["channel"], r["period"]
            cb = breakdown[t].setdefault(ch, {"n_mentions": 0, "reach_weighted_score": 0.0})
            cb["n_mentions"] += r["n_mentions"]
            cb["reach_weighted_score"] += r["reach_weighted_score"]
            sp = series[t].setdefault(per, {"n_mentions": 0, "reach_weighted_score": 0.0})
            sp["n_mentions"] += r["n_mentions"]
            sp["reach_weighted_score"] += r["reach_weighted_score"]
        for item in items:
            item["by_channel"] = clean_rows(
                [
                    {"channel": ch, **v}
                    for ch, v in sorted(breakdown[item["term"]].items(), key=lambda kv: -kv[1]["reach_weighted_score"])
                ]
            )
            if include_series:
                item["series"] = clean_rows([{"period": per, **v} for per, v in sorted(series[item["term"]].items())])

    return {
        "direction": direction,
        "n_returned": len(items),
        "terms": items,
        "caveats": [
            "Weighting: press = 1/mention (no audience-size data); creator mentions = reach at "
            "time of mention, falling back to the latest known snapshot, then 1 — a single very-"
            "large channel can dominate total_weighted.",
            "Compares the last 3 complete months to the 3 before that; the current in-progress "
            "month is excluded.",
            "Restricted to Steam's tag/genre vocabulary (word-level match), same as buzz_trends.",
        ],
    }


# ==========================================================================================
# Live-player (CCU) history tools — daily point-sample series from mart_players.sql
# ==========================================================================================
@mcp.tool()
def game_player_history(appid: int, days: int = 30) -> dict:
    """Daily concurrent-player (CCU) history for one game — REAL current traction over
    time, the direct "are people actually playing this" signal (unlike owners/revenue,
    which are lifetime estimates). One value per day: the LAST capture of the UTC date
    from the nightly ~21-22:00 UTC sweep of Steam's keyless GetNumberOfCurrentPlayers —
    a point sample, NOT the daily peak (SteamDB-style peaks run higher). Gaps in the
    series = unmeasured days, never zero: collection started 2026-07-18 and games outside
    the top-8k-by-reviews head are captured on a ~3-8 night rotation.

    days (clamped 7-365) bounds the returned series. summary always describes the FULL
    measured history (latest sample, trailing-7d avg vs prior-7d trend, window peak,
    measured-day count, first/last measured dates) so a short series still gets context.
    Use game_search to find the appid by name. A game with no history at all is a real
    answer (never captured: below the 50-review CCU floor, or not yet reached by the
    rotation), not an error. Returns {"error": ...} for an unknown appid or a mart that
    predates the CCU marts (re-run the ETL).
    """
    if not _HAS_PLAYERS:
        return {"error": _PLAYERS_MISSING}
    days = max(7, min(days, 365))
    game = query_one(
        "SELECT appid, name, live_players, players_7d_avg, players_trend_7d_pct "
        "FROM mart_game WHERE appid = ?",
        [appid],
    )
    if game is None:
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, "
            "or below the >=10-review analysis floor. Use game_search to find valid appids."
        }

    series = query(
        f"SELECT date, players, n_captures FROM mart_game_players_daily "
        f"WHERE appid = ? AND date >= CURRENT_DATE - INTERVAL {days} DAY ORDER BY date",
        [appid],
    )
    for r in series:
        r["date"] = str(r["date"])

    stats = query_one(
        f"""
        SELECT COUNT(*) AS n_days_measured,
               MIN(date) AS first_date, MAX(date) AS last_date,
               max_by(players, date) AS latest_players,
               MAX(players) FILTER (WHERE date >= CURRENT_DATE - INTERVAL {days} DAY) AS window_peak,
               max_by(date, players) FILTER (WHERE date >= CURRENT_DATE - INTERVAL {days} DAY) AS peak_date,
               AVG(players) FILTER (WHERE date >  CURRENT_DATE - INTERVAL 7 DAY) AS avg_recent_7d,
               AVG(players) FILTER (WHERE date <= CURRENT_DATE - INTERVAL 7 DAY
                                      AND date >  CURRENT_DATE - INTERVAL 14 DAY) AS avg_prior_7d
        FROM mart_game_players_daily WHERE appid = ?
        """,
        [appid],
    )
    notes: list[str] = []
    if not stats or not stats["n_days_measured"]:
        notes.append(
            "never captured — the game is below the 50-review CCU collection floor, or the "
            "capture rotation hasn't reached it yet."
        )
        summary = {"n_days_measured": 0}
    else:
        summary = {
            "latest": {"date": str(stats["last_date"]), "players": stats["latest_players"]},
            # Prefer the mart's precomputed values (tool and mart must never disagree);
            # the live-computed fallback only covers a NULL mart value.
            "players_7d_avg": game["players_7d_avg"] if game["players_7d_avg"] is not None else stats["avg_recent_7d"],
            "players_prior_7d_avg": stats["avg_prior_7d"],
            "players_trend_7d_pct": game["players_trend_7d_pct"],
            "window_peak": {"date": str(stats["peak_date"]), "players": stats["window_peak"]},
            "n_days_measured": stats["n_days_measured"],
            "history": {"first_date": str(stats["first_date"]), "last_date": str(stats["last_date"])},
        }
        if not series:
            notes.append(
                f"measured history exists but none in the last {days} days "
                f"(last measured {stats['last_date']}) — likely rotated out or delisted."
            )

    return {
        "appid": appid,
        "name": game["name"],
        "days": days,
        "summary": clean(summary),
        "series": clean_rows(series),
        "caveats": [_PLAYERS_POINT_SAMPLE_CAVEAT, _PLAYERS_HISTORY_CAVEAT] + notes,
    }


@mcp.tool()
def niche_player_history(dimension: Literal["tag", "genre"], key: str, days: int = 30) -> dict:
    """Daily total-live-players series for one niche — the direct "is this niche hot,
    and which way is it moving" signal. Sums the niche's scored games' (>= 50 reviews)
    daily CCU point samples; each game's last capture is carried forward up to 7 days
    (LOCF) so the collector's tail rotation doesn't read as audience dips — games staler
    than 7 days drop out of the sum. measured_players / n_games_measured expose the raw
    same-day coverage next to the carried total, so the carry is always inspectable.

    Returns summary (the niche's mart_niche players columns: total_players_now,
    players_trend_7d_pct — SAME-PANEL, only games measured in both 7d windows count —
    and players_coverage, the fresh-measured share) + series of {date, total_players,
    measured_players, n_games_measured} rows (days clamped 7-365) + n_games_panel (niche
    games ever measured). An empty series for a real niche is a real answer: fewer than
    10 of its games have ever been measured. Get exact keys from find_niches (exact
    match, case-sensitive); returns {"error": ...} for an unknown niche or a mart that
    predates the CCU marts (re-run the ETL). CAVEAT: totals are dominated by the niche's
    biggest games (the top-12k games hold ~99% of all Steam CCU) — a big total says
    people play the niche's HITS, not that a new entrant gets players.
    """
    if not _HAS_PLAYERS:
        return {"error": _PLAYERS_MISSING}
    days = max(7, min(days, 365))
    niche = query_one(
        "SELECT total_players_now, players_trend_7d_pct, players_coverage "
        "FROM mart_niche WHERE dimension = ? AND key = ? LIMIT 1",
        [dimension, key],
    )
    if niche is None:
        return {
            "error": f"no niche found for dimension={dimension!r} key={key!r}. "
            "Call find_niches to list valid keys — spelling/case must match exactly."
        }

    series = query(
        f"SELECT date, total_players, measured_players, n_games_measured "
        f"FROM mart_niche_players WHERE dimension = ? AND key = ? "
        f"AND date >= CURRENT_DATE - INTERVAL {days} DAY ORDER BY date",
        [dimension, key],
    )
    panel = query_one(
        "SELECT MAX(n_games_panel) AS n_games_panel, MIN(date) AS first_date, "
        "MAX(date) AS last_date, COUNT(*) AS n_days FROM mart_niche_players "
        "WHERE dimension = ? AND key = ?",
        [dimension, key],
    )
    for r in series:
        r["date"] = str(r["date"])

    notes: list[str] = []
    if not panel or not panel["n_days"]:
        notes.append(
            "no players series for this niche — fewer than 10 of its games have ever been "
            "measured (below the CCU floor / not yet rotated in), or the niche is under the "
            "30-scored-games floor."
        )
        history = None
    else:
        history = {
            "first_date": str(panel["first_date"]),
            "last_date": str(panel["last_date"]),
            "n_days": panel["n_days"],
        }

    return {
        "dimension": dimension,
        "key": key,
        "days": days,
        "summary": clean(
            {
                "total_players_now": niche["total_players_now"],
                "players_trend_7d_pct": niche["players_trend_7d_pct"],
                "players_coverage": niche["players_coverage"],
                "n_games_panel": panel["n_games_panel"] if panel else None,
                "history": history,
            }
        ),
        "series": clean_rows(series),
        "caveats": [
            _PLAYERS_POINT_SAMPLE_CAVEAT,
            _PLAYERS_HISTORY_CAVEAT,
            "total_players carries each game's last capture forward up to 7 days (LOCF); "
            "players_trend_7d_pct is same-panel (games measured in BOTH windows), so "
            "coverage growth can't masquerade as audience growth.",
        ] + notes,
    }


if __name__ == "__main__":
    mcp.run()
