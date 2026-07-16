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
        "timing, look up/compare games, and find press pitch targets. Read the "
        "prospect-data-dictionary resource first."
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
`window` in {`all`, `24m`} x `min_reviews` in {`10`, `50`} — as percentile ranks (0-100)
against every other niche in the SAME cut:

- **demand** = 0.4 x percentile(median revenue) + 0.3 x percentile(median owners) +
  0.3 x percentile(recent 24m review velocity). Higher = bigger, hotter market.
- **competition** = 0.6 x percentile(n_recent, count of recently-released games) +
  0.4 x percentile(winner_concentration, share of niche revenue held by the top ~10% of
  games). Higher = more crowded / more winner-take-most — BAD for a new entrant.
- **quality_gap** (aka `beatable_share`) = percentile(share of incumbents that are weak:
  low rating OR thin review count). Higher = easier to out-execute the field.
- **opportunity** = clamp(0.5 x demand − 0.35 x competition + 0.3 x quality_gap, 0, 100).
  The headline ranking metric in `find_niches`.

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
    "opportunity", "demand", "competition", "quality_gap",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity",
    "n_games", "n_recent", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "self_pub_share", "winner_concentration",
}


@mcp.tool()
def find_niches(
    dimension: Literal["tag", "genre"] = "tag",
    window: Literal["all", "24m"] = "all",
    min_reviews: Literal[10, 50] = 10,
    min_median_rev: float | None = None,
    max_competition: float | None = None,
    sort: str = "opportunity",
    limit: int = 15,
) -> dict:
    """Rank niches (Steam community tags, or Steam genres) by opportunity score. THE
    headline tool — start here for "what should I build" questions.

    opportunity fuses three 0-100 percentile components (see the prospect-data-dictionary
    resource for exact formulas):
      - demand: bigger/hotter market (revenue + owners + recent review velocity).
      - competition: how crowded/winner-take-most the niche is — HIGH is bad for a new
        entrant.
      - quality_gap: share of incumbents that are weak (low rating / thin reviews) — HIGH
        means it's easier to out-execute the field.
    opportunity = 0.5*demand − 0.35*competition + 0.3*quality_gap, clamped [0,100].

    dimension="tag" = SteamSpy's large community-tag vocabulary (specific micro-niches
    like "Souls-like", "Deckbuilder" — usually more actionable); "genre" = Steam's small
    fixed genre list. window="all" scores full history; "24m" restricts to games released
    in the last 24 months (current-market read, smaller n — use this to catch niches
    heating up NOW). min_reviews is the per-game review floor (10=broad/noisy,
    50=stricter/cleaner) — only these two values are precomputed.

    min_median_rev / max_competition are optional post-filters, e.g. min_median_rev=200000
    to require a real revenue floor, or max_competition=50 to exclude the most saturated
    niches. sort is any returned numeric field (default "opportunity"). Returns compact
    rows only — call niche_detail(dimension, key) for one niche's saturation trend,
    revenue histogram, and representative games.
    """
    if sort not in _NICHE_SORTABLE:
        return {"error": f"sort must be one of {sorted(_NICHE_SORTABLE)}"}

    where = ["dimension = ?", "win = ?", "min_reviews = ?"]
    params: list = [dimension, window, min_reviews]
    if min_median_rev is not None:
        where.append("median_rev >= ?")
        params.append(min_median_rev)
    if max_competition is not None:
        where.append("competition <= ?")
        params.append(max_competition)
    limit = max(1, min(limit, 50))

    rows = query(
        f"""
        SELECT key, n_games, n_recent, opportunity, demand, competition, quality_gap,
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
    return {
        "dimension": dimension,
        "window": window,
        "min_reviews": min_reviews,
        "sort": sort,
        "n_returned": len(rows),
        "niches": clean_rows(rows),
    }


@mcp.tool()
def niche_detail(dimension: Literal["tag", "genre"], key: str) -> dict:
    """Deep dive on one niche (get valid `key` values from find_niches — exact match,
    case-sensitive). Returns:
      - variants: this niche's opportunity/demand/competition/etc at all 4 precomputed
        cuts — (all|24m) x (min_reviews 10|50).
      - saturation_trend: yearly release counts + median revenue, oldest-first — is this
        niche heating up or cooling off?
      - revenue_histogram: log-scale bucketed distribution of est. lifetime revenue
        across the niche (min_reviews=10 population) — the full shape, not just the
        median.
      - representative_games: top 8 games in the niche by est. revenue.
      - hit_rates: headline (window="all", min_reviews=10) hit_rate_200k / hit_rate_500k
        (share of games clearing $200K/$500K est. revenue), median_rev, n_games,
        winner_concentration.
    Returns {"error": ...} if dimension/key doesn't match any niche (call find_niches to
    get exact valid keys — spelling and case must match precisely).
    """
    # NOTE: `win` is selected un-aliased (not `AS window`) because `window` is a reserved
    # word in DuckDB SQL (window functions) and can't be used unquoted in ORDER BY — same
    # reason api/app/routers/niches.py renames win -> window in Python, after the fetch,
    # rather than in SQL.
    variants = query(
        """
        SELECT win, min_reviews, n_games, n_recent, opportunity, demand,
               competition, quality_gap, median_rev, median_reviews, median_price,
               median_positive_ratio, median_owners, recent_velocity, hit_rate_200k,
               hit_rate_500k, beatable_share, saturation_yoy, winner_concentration
        FROM mart_niche WHERE dimension = ? AND key = ? ORDER BY win, min_reviews
        """,
        [dimension, key],
    )
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
    headline = next((v for v in variants if v["window"] == "all" and v["min_reviews"] == 10), variants[0])
    return {
        "dimension": dimension,
        "key": key,
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


if __name__ == "__main__":
    mcp.run()
