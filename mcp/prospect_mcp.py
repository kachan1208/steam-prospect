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
        "timing, look up/compare games, and find press/creator pitch targets across every "
        "marketing channel (Press, YouTube, Reddit, Twitch, X). Read the "
        "prospect-data-dictionary resource first. For 'what should I build' questions, "
        "keep find_niches' defaults (24m window, opportunity_v2 sort, micro+theme tags "
        "only) and apply its falsification rules: low competition with negative "
        "saturation_yoy is usually a market in DECLINE (everyone stopped entering), not "
        "an opportunity — check entrant_ratio (catalog-median tag ~1.08; <1 = recent "
        "entrants underearn) before recommending; winner_concentration > 0.85 means "
        "winner-take-most (judge by the median, not the hits); and for solo devs check "
        "solo_viability (~0.9 is the norm; below ~0.8 leans multiplayer — e.g. Extraction "
        "Shooter — and is not solo-buildable without flagging it)."
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
- **mart_market_pct / mart_market_hist / mart_market_boxleiter / mart_market_tiers /
  mart_meta** — catalog-wide (or per-genre) percentile distributions, histograms, the
  fitted Boxleiter owners-per-review slope per genre, dev-tier population counts, and
  global scalar stats. -> `market_benchmarks`, `revenue_distribution`, `estimate_revenue`.
- **mart_launch_curve / mart_game_launch_curve** — cumulative share of a genre's (or one
  game's) first-year reviews landed by day-since-release. -> `launch_shape`.
- **mart_seasonality** — release-timing outcomes by month / weekday / month×weekday.
  -> `best_launch_timing`.
- **mart_game** — one row per game: metadata, revenue/owners, percentile-vs-genre, top
  tags, review velocity. -> `game_search`, `game_profile`.
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
}
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
    tiers_applied = None
    if dimension == "tag" and include_tiers is not None:
        tiers_applied = list(include_tiers)
        where.append(f"tier IN ({','.join('?' for _ in tiers_applied)})")
        params.extend(tiers_applied)
    limit = max(1, min(limit, 50))

    try:
        rows = query(
            f"""
            SELECT key, tier, n_games, n_recent, opportunity_v2, opportunity, decline_gate,
                   entrant_ratio, solo_viability, demand, competition, quality_gap,
                   market_size, total_owners, total_rev, total_reviews,
                   median_rev, median_reviews, median_price, median_positive_ratio,
                   median_owners, recent_velocity, hit_rate_200k, hit_rate_500k,
                   saturation_yoy, winner_concentration
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
    Returns {"error": ...} if dimension/key doesn't match any niche (call find_niches to
    get exact valid keys — spelling and case must match precisely), or asking you to
    re-run the ETL if the analytics DB predates the v2 columns.
    """
    # NOTE: `win` is selected un-aliased (not `AS window`) because `window` is a reserved
    # word in DuckDB SQL (window functions) and can't be used unquoted in ORDER BY — same
    # reason api/app/routers/niches.py renames win -> window in Python, after the fetch,
    # rather than in SQL.
    try:
        variants = query(
            """
            SELECT win, min_reviews, tier, n_games, n_recent, opportunity_v2, opportunity,
                   decline_gate, entrant_ratio, solo_viability, demand,
                   competition, quality_gap, market_size, total_owners, total_rev,
                   total_reviews, median_rev, median_reviews, median_price,
                   median_positive_ratio, median_owners, recent_velocity, hit_rate_200k,
                   hit_rate_500k, beatable_share, saturation_yoy, winner_concentration
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
    headline = next((v for v in variants if v["window"] == "all" and v["min_reviews"] == 50), variants[0])
    return {
        "dimension": dimension,
        "key": key,
        "tier": headline.get("tier"),
        "variants": clean_rows(variants),
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


@mcp.tool()
def best_launch_timing(genre: str = "__all__", min_scored: int = 30) -> dict:
    """Best release timing by month and weekday, from historical outcomes (median est.
    revenue among games clearing the review floor; n_scored = sample size backing that
    median — always check it before trusting a cell). Directly answers "when should I
    launch":
      - best_month / best_weekday: the single highest-median-revenue month/weekday among
        cells with n_scored >= min_scored (a reliability floor).
      - top_month_weekday_combos: top 3 specific (month, weekday) cells by median
        revenue, same reliability floor.
      - by_month / by_weekday: the full marginal tables, for context.
    genre="__all__" for the whole catalog, or an exact Steam genre label. Release-timing
    effects are usually MILD — treat this as a minor tiebreaker, not a strategy,  and
    remember it's correlational: a high-median month may reflect WHAT KIND of game
    typically launches then (e.g. big open-world titles cluster in fall) rather than the
    calendar date itself mattering.
    """
    months = query(
        "SELECT month, n_releases, n_scored, median_rev, median_positive_ratio "
        "FROM mart_seasonality WHERE grain = 'month' AND genre = ? ORDER BY month",
        [genre],
    )
    weekdays = query(
        "SELECT weekday, n_releases, n_scored, median_rev, median_positive_ratio "
        "FROM mart_seasonality WHERE grain = 'weekday' AND genre = ? ORDER BY weekday",
        [genre],
    )
    if not months and not weekdays:
        return {"error": f"no seasonality data for genre={genre!r}. Try '__all__' or an exact Steam genre label."}

    month_names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    weekday_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]  # DuckDB dayofweek: 0=Sun..6=Sat

    for m in months:
        m["month_name"] = month_names[int(m["month"])]
    for w in weekdays:
        w["weekday_name"] = weekday_names[int(w["weekday"])]

    combos = query(
        "SELECT month, weekday, n_releases, n_scored, median_rev FROM mart_seasonality "
        "WHERE grain = 'month_weekday' AND genre = ? AND n_scored >= ? "
        "ORDER BY median_rev DESC NULLS LAST LIMIT 3",
        [genre, min_scored],
    )
    for c in combos:
        c["month_name"] = month_names[int(c["month"])]
        c["weekday_name"] = weekday_names[int(c["weekday"])]

    reliable_months = [m for m in months if m["n_scored"] >= min_scored]
    reliable_weekdays = [w for w in weekdays if w["n_scored"] >= min_scored]
    best_month = max(reliable_months, key=lambda m: m["median_rev"] or 0, default=None)
    best_weekday = max(reliable_weekdays, key=lambda w: w["median_rev"] or 0, default=None)

    return clean(
        {
            "genre": genre,
            "min_scored": min_scored,
            "best_month": best_month,
            "best_weekday": best_weekday,
            "top_month_weekday_combos": combos,
            "by_month": months,
            "by_weekday": weekdays,
        }
    )


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
    a live "is this still getting attention" signal). Use game_search to find an appid by
    name first. Returns {"error": ...} if the appid isn't in the catalog or didn't clear
    the >=10-review analysis floor (mart_game only carries scored games).
    """
    row = query_one(
        """
        SELECT appid, name, release_year, release_date, price_initial, is_free,
               primary_genre, developers, publishers, self_published, is_indie,
               owners_mid, total_reviews, positive_ratio, est_rev_reviews, est_rev_owners,
               metacritic_score, achievements_count, avg_playtime_forever,
               short_description, rev_pct_in_genre, reviews_pct_in_genre,
               owners_pct_in_genre, top_tags, n_reviews_first_30d, n_reviews_first_90d,
               n_reviews_first_365d, n_reviews_trailing_30d, playtime_p25, playtime_p50,
               playtime_p75
        FROM mart_game WHERE appid = ?
        """,
        [appid],
    )
    if row is None:
        return {
            "error": f"appid {appid} not found in mart_game — either not in the catalog, "
            "or has fewer than 10 sampled reviews and didn't clear the analysis floor."
        }
    return clean(row)


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


if __name__ == "__main__":
    mcp.run()
