"""Analytics Chat — a Claude tool-use loop grounded in Prospect's DuckDB marts.

`POST /api/chat` streams (SSE) a single turn of a tool-use conversation: the client sends
the full message history (stateless, like every other Anthropic API call), the model calls
zero or more tools, we run them against `analytics_db` and feed the results back, and the
final assistant text streams to the client token-by-token.

This file owns its own thin read queries against the marts, replicated (not imported) from
api/app/routers/{niches,market,games,press,seasonality,estimate}.py per this feature's file
ownership boundary — those routers are concurrently owned/edited by other work, and
mcp/prospect_mcp.py is a separate sibling surface (a stdio MCP server) this file must not
import from either. Some query duplication vs. those files is intentional and expected: both
surfaces answer the same questions against the same marts. Where a small shared module
already exists (`..benchmarks`, `..analytics_db`) this file imports it normally, same as the
routers do.

Ten tools cover niches/market/games/press (the routers explicitly named for this feature);
an eleventh, `best_launch_timing`, additionally covers `routers/seasonality.py` (also named
as a source router) so the assistant can answer "when should I launch" questions too.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Generator
from typing import Any

import anthropic
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from .. import analytics_db, benchmarks
from ..auth import get_current_org
from ..config import settings
from ..models import Org
from ..schemas import ChatRequest, ChatStatus

router = APIRouter(prefix="/api/chat", tags=["chat"])

NO_KEY_MESSAGE = "Set ANTHROPIC_API_KEY in api/.env and restart the API to enable chat."
MARTS_NOT_READY_MESSAGE = "Analytics marts are not loaded — run the ETL and restart the API."
MAX_TOOL_ITERATIONS = 6
MAX_TOKENS = 2048


# ==========================================================================================
# System prompt
# ==========================================================================================
SYSTEM_PROMPT = """You are the in-app analytics assistant for Prospect, a Steam market-\
intelligence tool for solo/indie game developers. You help users research what to build, \
benchmark the market, estimate revenue, find press contacts, and check launch timing — \
grounded in Prospect's own curated DuckDB marts (a Steam catalog snapshot of ~142K apps, \
SteamSpy owner estimates, ~3M sampled reviews, and ~1M press articles).

Ground every quantitative claim in a tool call. Never invent numbers, game names, appids, \
genres, or tag labels — if you don't know a value, call a tool to fetch it, or say plainly \
that you don't have that data. If a tool returns {"error": ...}, read the message (it \
usually names the valid values) and retry with a corrected input rather than guessing.

Key concepts:
- The "opportunity" score (find_niches / niche_detail) fuses demand (bigger/hotter market), \
competition (crowding — HIGH is bad for a new entrant), and quality_gap (share of weak \
incumbents — HIGH means easier to out-execute), each a 0-100 percentile rank.
- dimension="tag" is SteamSpy's large community-tag vocabulary (specific micro-niches, \
usually more actionable); "genre" is Steam's small fixed genre list — get exact genre \
labels from market_benchmarks (boxleiter_by_genre) or a game_search/game_profile result \
before calling genre-scoped tools; a misspelled genre silently returns nothing.
- Revenue figures (est_rev_reviews) are GROSS lifetime box revenue estimated via the \
Boxleiter method (owners ~= reviews x 20-55, genre-dependent), not net-of-Steam's-cut and \
not first-year-only — call market_benchmarks to see cited vs. computed reference points \
before quoting a dollar figure.
- All figures are estimates with real biases: reviews/press are SAMPLES (recency-biased \
toward older/popular titles), and any "why it works" or press-coverage read is \
correlational, not causal. Surface a tool's caveats when they matter to the answer instead \
of dropping them.

Style: answer directly and concisely. Use a small markdown table when comparing several \
rows (niches, games, outlets); otherwise write the concrete number inline in prose. Report \
estimate_revenue's low/mid/high range rather than a single number. Ask a clarifying \
question only if the request is genuinely ambiguous (e.g. no genre/tag given for a \
competition-heavy question) — otherwise make a reasonable default call (window="all", \
min_reviews=10) and proceed."""


# ==========================================================================================
# Tool schemas (Anthropic Messages API tool-use format)
# ==========================================================================================
TOOLS: list[dict[str, Any]] = [
    {
        "name": "find_niches",
        "description": (
            "Rank niches (Steam community tags, or Steam genres) by opportunity score. "
            "THE headline tool for 'what should I build' questions — start here. "
            "opportunity = 0.5*demand - 0.35*competition + 0.3*quality_gap (0-100, "
            "clamped): demand is market size/heat, competition is crowding (high = bad "
            "for a new entrant), quality_gap is the share of weak incumbents (high = "
            "easier to out-execute). Call niche_detail(dimension, key) next for one "
            "niche's saturation trend, revenue histogram, and top games."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "dimension": {
                    "type": "string",
                    "enum": ["tag", "genre"],
                    "description": "'tag' = SteamSpy's large community-tag vocabulary "
                    "(specific, usually more actionable). 'genre' = Steam's small fixed "
                    "genre list. Default 'tag'.",
                },
                "window": {
                    "type": "string",
                    "enum": ["all", "24m"],
                    "description": "'all' scores full history; '24m' restricts to the "
                    "last 24 months (current-market read, smaller n). Default 'all'.",
                },
                "min_reviews": {
                    "type": "integer",
                    "enum": [10, 50],
                    "description": "Per-game review floor before a title counts toward "
                    "niche stats — the only two precomputed cuts. Default 10.",
                },
                "min_median_rev": {
                    "type": "number",
                    "description": "Optional post-filter: require median estimated "
                    "revenue >= this (USD).",
                },
                "max_competition": {
                    "type": "number",
                    "description": "Optional post-filter: exclude niches with a "
                    "competition score above this (0-100).",
                },
                "sort": {
                    "type": "string",
                    "description": "Any returned numeric field, e.g. 'opportunity', "
                    "'median_rev', 'demand'. Default 'opportunity'.",
                },
                "limit": {"type": "integer", "description": "Max rows returned, 1-50. Default 15."},
            },
        },
    },
    {
        "name": "niche_detail",
        "description": (
            "Deep dive on one niche: opportunity/demand/competition at all 4 precomputed "
            "cuts, a yearly saturation trend (heating up or cooling off?), a revenue "
            "histogram (full distribution shape, not just the median), the top games by "
            "estimated revenue, and headline hit-rate stats (share of games clearing "
            "$200K/$500K). Get valid `key` values from find_niches first — exact match, "
            "case-sensitive."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "dimension": {"type": "string", "enum": ["tag", "genre"]},
                "key": {
                    "type": "string",
                    "description": "Exact niche key from find_niches, e.g. 'Souls-like' or 'RPG'.",
                },
            },
            "required": ["dimension", "key"],
        },
    },
    {
        "name": "market_benchmarks",
        "description": (
            "Reference anchors for judging any revenue/owners number: cited public "
            "indie-market research (median indie gross, Boxleiter owners-per-review "
            "range, wishlist-conversion assumptions, Steam's revenue share, dev-tier "
            "definitions), this catalog's own computed figures, the fitted Boxleiter "
            "owners-per-review slope PER GENRE (also the authoritative source of exact "
            "genre spellings for other tools), and dev-tier population counts. Call this "
            "before quoting any dollar figure, and to look up exact genre labels."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "revenue_distribution",
        "description": (
            "Market-wide distribution (percentiles + histogram) for one metric, scoped "
            "to a genre and time window — shows the FULL shape of outcomes, not just an "
            "average (revenue especially has a long tail of hits well above the median)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "metric": {
                    "type": "string",
                    "enum": ["revenue", "reviews", "owners", "price"],
                    "description": "Default 'revenue'.",
                },
                "genre": {
                    "type": "string",
                    "description": "Exact Steam genre label, or '__all__' for the whole "
                    "catalog. Default '__all__'.",
                },
                "window": {"type": "string", "enum": ["all", "24m"], "description": "Default 'all'."},
            },
        },
    },
    {
        "name": "estimate_revenue",
        "description": (
            "Estimate lifetime owners + gross/net revenue from EITHER a review count OR "
            "a wishlist count (provide exactly one), plus price and optionally genre "
            "(strongly recommended — owners-per-review varies a lot by genre). Returns "
            "{low, mid, high} ranges, never a single number — always report the range, "
            "not just the midpoint."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "price": {"type": "number", "description": "Launch price in USD."},
                "reviews": {
                    "type": "integer",
                    "description": "Total review count (Boxleiter-method basis). "
                    "Provide exactly one of reviews/wishlists.",
                },
                "wishlists": {
                    "type": "integer",
                    "description": "Wishlist count (first-week-conversion basis). "
                    "Provide exactly one of reviews/wishlists.",
                },
                "genre": {
                    "type": "string",
                    "description": "Exact Steam genre label — improves accuracy a lot. "
                    "See market_benchmarks for valid labels.",
                },
            },
            "required": ["price"],
        },
    },
    {
        "name": "game_search",
        "description": (
            "Search/filter the game catalog (only games clearing the >=10-review "
            "analysis floor) by name substring, exact tag, and/or exact genre. Use this "
            "to find an appid for game_profile/game_teardown, or to see who the top "
            "players in a niche/genre are."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Case-insensitive substring match on game name."},
                "tag": {
                    "type": "string",
                    "description": "Exact match against the game's top community tags (not substring).",
                },
                "genre": {
                    "type": "string",
                    "description": "Exact Steam genre label — matches the game's PRIMARY genre only.",
                },
                "min_reviews": {"type": "integer", "description": "Default 0."},
                "sort": {"type": "string", "description": "Any returned numeric field. Default 'total_reviews'."},
                "order": {"type": "string", "enum": ["asc", "desc"], "description": "Default 'desc'."},
                "limit": {"type": "integer", "description": "Max rows, 1-50. Default 15."},
            },
        },
    },
    {
        "name": "game_profile",
        "description": (
            "Full profile for one game by Steam appid: metadata, price, owners/reviews/"
            "est. revenue, percentile rank vs OTHER games in the same primary genre, top "
            "community tags, and review-velocity (reviews landed in the first 30/90/365 "
            "days post-release, plus current trailing-30d velocity — a live 'still "
            "getting attention' signal). Use game_search to find an appid by name first."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"appid": {"type": "integer", "description": "Steam app ID."}},
            "required": ["appid"],
        },
    },
    {
        "name": "game_teardown",
        "description": (
            '"Why it works" teardown for one game: review-text aspect mining (10 fixed '
            "aspects — combat, world, art, music, story, difficulty, controls, "
            "map/backtracking, content length, price/value — each with a praise/complaint "
            "share and a delta vs. the genre baseline) fused with the press/PR footprint "
            "(total mentions, top outlets, notable articles). Both signals are "
            "CORRELATIONAL — evidence toward why a game got popular, never proof. Use "
            "game_search to find an appid by name first."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"appid": {"type": "integer", "description": "Steam app ID."}},
            "required": ["appid"],
        },
    },
    {
        "name": "press_pitch_list",
        "description": (
            "Who to pitch for press coverage in one Steam genre: ranked outlets and "
            "named journalists, each with an example headline/date/url. Ranked by "
            "ALL-TIME article volume — check n_articles_recent_24m and the example date "
            "before pitching (a prolific past contributor may no longer cover the beat). "
            "Steam News (dev-authored posts) is excluded — journalist coverage only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "genre": {
                    "type": "string",
                    "description": "Exact Steam genre label, e.g. 'RPG' — see "
                    "market_benchmarks for valid labels.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max journalists returned (outlets are always all). Default 15.",
                },
            },
            "required": ["genre"],
        },
    },
    {
        "name": "buzz_trends",
        "description": (
            "Rising or cooling game-concept buzz: mechanic/genre/tag bigrams mined from "
            "journalist article TITLES over the last 12 months, comparing the last 3 "
            "complete months to the 3 before that. A LEADING indicator (buzz building in "
            "press before it shows up in actual releases) — distinct from niche_detail's "
            "saturation_trend (a LAGGING signal based on real releases)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["rising", "cooling"], "description": "Default 'rising'."},
                "limit": {"type": "integer", "description": "Default 15."},
                "include_series": {
                    "type": "boolean",
                    "description": "Include each term's 12-point monthly series. Default "
                    "false — leave off for a compact summary.",
                },
            },
        },
    },
    {
        "name": "best_launch_timing",
        "description": (
            "Best release timing by month and weekday from historical outcomes (median "
            "est. revenue among games clearing the review floor). Release-timing effects "
            "are usually MILD and correlational (e.g. big open-world titles cluster in "
            "fall) — treat this as a minor tiebreaker, not a strategy."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "genre": {"type": "string", "description": "Exact Steam genre label, or '__all__'. Default '__all__'."},
                "min_scored": {
                    "type": "integer",
                    "description": "Reliability floor (min sample size) for a cell to "
                    "count as 'best'. Default 30.",
                },
            },
        },
    },
]


# ==========================================================================================
# Compact-result helpers — round float noise so tool_result JSON doesn't burn context on
# garbage digits like 75524.40000000001 (same problem mcp/prospect_mcp.py solves; this is
# a generic utility, not analytics logic, so it's fine to have both files carry a copy).
# ==========================================================================================
def _round(v: Any, nd: int = 4) -> Any:
    if isinstance(v, float):
        return round(v, nd)
    if isinstance(v, dict):
        return {k: _round(x, nd) for k, x in v.items()}
    if isinstance(v, list):
        return [_round(x, nd) for x in v]
    return v


def _clean(row: dict) -> dict:
    return {k: _round(v) for k, v in row.items()}


def _clean_rows(rows: list[dict]) -> list[dict]:
    return [_clean(r) for r in rows]


# ==========================================================================================
# Tool implementations — each takes the parsed tool_use.input dict and returns a
# JSON-serializable dict. Replicated from api/app/routers/*.py's queries (see module
# docstring); errors are returned as {"error": "..."} so the model can see and correct
# them instead of the whole turn failing.
# ==========================================================================================

# ---- niches -----------------------------------------------------------------------------
# Mirrors routers/niches.py's SORTABLE whitelist (prevents SQL injection via `sort`).
_NICHE_SORTABLE = {
    "key", "opportunity", "demand", "competition", "quality_gap",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity",
    "n_games", "n_recent", "hit_rate_200k", "hit_rate_500k",
    "beatable_share", "saturation_yoy", "self_pub_share", "winner_concentration",
}


def _find_niches(inp: dict[str, Any]) -> dict[str, Any]:
    dimension = inp.get("dimension") or "tag"
    if dimension not in ("tag", "genre"):
        return {"error": "dimension must be 'tag' or 'genre'"}
    window = inp.get("window") or "all"
    if window not in ("all", "24m"):
        return {"error": "window must be 'all' or '24m'"}
    min_reviews = int(inp.get("min_reviews") or 10)
    if min_reviews not in (10, 50):
        return {"error": "min_reviews must be 10 or 50 (the only precomputed cuts)"}
    sort = inp.get("sort") or "opportunity"
    if sort not in _NICHE_SORTABLE:
        return {"error": f"sort must be one of {sorted(_NICHE_SORTABLE)}"}
    limit = max(1, min(int(inp.get("limit") or 15), 50))

    where = ["dimension = ?", "win = ?", "min_reviews = ?"]
    params: list[Any] = [dimension, window, min_reviews]
    if inp.get("min_median_rev") is not None:
        where.append("median_rev >= ?")
        params.append(float(inp["min_median_rev"]))
    if inp.get("max_competition") is not None:
        where.append("competition <= ?")
        params.append(float(inp["max_competition"]))

    rows = analytics_db.query(
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
        "niches": _clean_rows(rows),
    }


def _niche_detail(inp: dict[str, Any]) -> dict[str, Any]:
    dimension = inp.get("dimension")
    key = inp.get("key")
    if dimension not in ("tag", "genre") or not key:
        return {"error": "dimension ('tag'|'genre') and key are both required"}

    # `win` is selected un-aliased (not `AS window`) because window is a reserved word in
    # DuckDB SQL — same reason routers/niches.py renames win -> window in Python.
    variants = analytics_db.query(
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

    trend = analytics_db.query(
        "SELECT year, n_releases, n_scored, median_rev FROM mart_niche_trend "
        "WHERE dimension = ? AND key = ? ORDER BY year",
        [dimension, key],
    )
    hist = analytics_db.query(
        "SELECT x_min, x_max, count FROM mart_niche_hist "
        "WHERE dimension = ? AND key = ? ORDER BY bucket_index",
        [dimension, key],
    )
    games = analytics_db.query(
        "SELECT rank_in_niche, appid, name, release_year, price_initial, owners_mid, "
        "total_reviews, positive_ratio, est_rev_reviews, self_published FROM mart_niche_top "
        "WHERE dimension = ? AND key = ? ORDER BY rank_in_niche LIMIT 8",
        [dimension, key],
    )
    headline = next((v for v in variants if v["window"] == "all" and v["min_reviews"] == 10), variants[0])
    return {
        "dimension": dimension,
        "key": key,
        "variants": _clean_rows(variants),
        "saturation_trend": _clean_rows(trend),
        "revenue_histogram": _clean_rows(hist),
        "representative_games": _clean_rows(games),
        "hit_rates": _clean(
            {
                "hit_rate_200k": headline["hit_rate_200k"],
                "hit_rate_500k": headline["hit_rate_500k"],
                "median_rev": headline["median_rev"],
                "n_games": headline["n_games"],
                "winner_concentration": headline["winner_concentration"],
            }
        ),
    }


# ---- market -----------------------------------------------------------------------------
_DIST_METRICS = {"revenue", "reviews", "owners", "price"}


def _market_benchmarks(_inp: dict[str, Any]) -> dict[str, Any]:
    meta = {r["key"]: r["value"] for r in analytics_db.query("SELECT key, value FROM mart_meta")}
    boxleiter = analytics_db.query(
        "SELECT genre, n, owners_per_review_median, owners_per_review_p25, "
        "owners_per_review_p75, slope, intercept FROM mart_market_boxleiter ORDER BY n DESC"
    )
    tiers = analytics_db.query(
        "SELECT tier, tier_order, count, pct FROM mart_market_tiers ORDER BY tier_order"
    )

    def _f(k: str) -> float | None:
        v = meta.get(k)
        return float(v) if v not in (None, "") else None

    return _clean(
        {
            "cited": benchmarks.as_dict(),
            "computed": {
                "median_revenue_scored": _f("global_median_revenue"),
                "median_revenue_paid": _f("global_median_revenue_paid"),
                "boxleiter_owners_per_review_slope": _f("boxleiter_owners_per_review"),
                "pct_over_100k_scored": _f("pct_over_100k"),
                "n_games_total": _f("n_games_total"),
                "n_games_scored": _f("n_games_scored"),
                "population_note": (
                    "computed medians/pct are Boxleiter gross over games with >=10 reviews "
                    "(paid = price>0, >=1 review); cited $249/8.5% are first-year/net over "
                    "ALL releases"
                ),
            },
            "boxleiter_by_genre": boxleiter,
            "tiers": tiers,
        }
    )


def _revenue_distribution(inp: dict[str, Any]) -> dict[str, Any]:
    metric = inp.get("metric") or "revenue"
    if metric not in _DIST_METRICS:
        return {"error": f"metric must be one of {sorted(_DIST_METRICS)}"}
    genre = inp.get("genre") or "__all__"
    window = inp.get("window") or "all"
    if window not in ("all", "24m"):
        return {"error": "window must be 'all' or '24m'"}

    pcts = analytics_db.query(
        "SELECT pctile, value, n FROM mart_market_pct WHERE metric = ? AND genre = ? AND win = ? ORDER BY value",
        [metric, genre, window],
    )
    if not pcts:
        return {
            "error": f"no data for metric={metric!r} genre={genre!r} window={window!r}. "
            "genre must be an exact Steam genre label or '__all__'."
        }
    buckets = analytics_db.query(
        "SELECT x_min, x_max, count FROM mart_market_hist WHERE metric = ? AND genre = ? AND win = ? ORDER BY bucket_index",
        [metric, genre, window],
    )
    return _clean(
        {
            "metric": metric,
            "genre": genre,
            "window": window,
            "n": int(pcts[0]["n"]),
            "percentiles": pcts,
            "histogram": buckets,
        }
    )


# ---- estimate ---------------------------------------------------------------------------
def _genre_owners_per_review(genre: str | None) -> tuple[str, float]:
    """(genre_used, mid owners/review) — mirrors routers/estimate.py's helper of the same name."""
    lo = benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MIN
    hi = benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MAX
    default = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MID)
    for candidate in [genre, "__all__"]:
        if not candidate:
            continue
        row = analytics_db.query_one("SELECT genre, slope FROM mart_market_boxleiter WHERE genre = ?", [candidate])
        if row and row["slope"] is not None:
            slope = max(lo, min(hi, float(row["slope"])))
            return (row["genre"], slope)
    return ("__all__", default)


def _estimate_revenue(inp: dict[str, Any]) -> dict[str, Any]:
    reviews = inp.get("reviews")
    wishlists = inp.get("wishlists")
    if (reviews is None) == (wishlists is None):
        return {"error": "Provide exactly one of `reviews` or `wishlists`."}
    price = inp.get("price")
    if price is None:
        return {"error": "`price` (launch price in USD) is required."}
    price = float(price)
    genre = inp.get("genre")

    lo = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MIN)
    hi = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MAX)
    genre_used, opr_mid = _genre_owners_per_review(genre)
    notes: list[str] = []

    if reviews is not None:
        reviews = float(reviews)
        basis = "reviews"
        owners = {"low": reviews * lo, "mid": reviews * opr_mid, "high": reviews * hi}
        notes.append(
            f"Owners = reviews x Boxleiter ({lo:.0f}-{hi:.0f} owners/review; "
            f"fitted mid for '{genre_used}' = {opr_mid:.0f})."
        )
    else:
        wishlists = float(wishlists)
        basis = "wishlists"
        wl_lo, wl_hi = benchmarks.WISHLIST_CONVERSION_RANGE
        wl_mid = benchmarks.WISHLIST_CONVERSION_FIRST_WEEK
        mult = benchmarks.FIRST_WEEK_TO_FIRST_YEAR_MULT
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
    share = benchmarks.STEAM_REVENUE_SHARE_TO_DEV
    revenue_net = {k: v * share for k, v in revenue_gross.items()}
    notes.append(f"Net = gross x {share:.0%} (after Steam's ~30% cut, before taxes/refunds).")
    notes.append(f"Gross revenue = owners x ${price:.2f} price (box revenue, lifetime).")

    return _clean(
        {
            "basis": basis,
            "genre": genre_used,
            "owners_per_review_used": {"low": lo, "mid": opr_mid, "high": hi},
            "owners": owners,
            "revenue_gross_usd": revenue_gross,
            "revenue_net_usd": revenue_net,
            "dev_tier": benchmarks.tier_for_copies(owners["mid"]),
            "notes": notes,
        }
    )


# ---- games ------------------------------------------------------------------------------
# Mirrors routers/games.py's SORTABLE whitelist.
_GAME_SORTABLE = {
    "name", "release_year", "price_initial", "owners_mid", "total_reviews",
    "positive_ratio", "est_rev_reviews", "rev_pct_in_genre", "reviews_pct_in_genre",
    "owners_pct_in_genre", "n_reviews_trailing_30d",
}


def _game_search(inp: dict[str, Any]) -> dict[str, Any]:
    q = inp.get("q")
    tag = inp.get("tag")
    genre = inp.get("genre")
    min_reviews = int(inp.get("min_reviews") or 0)
    sort = inp.get("sort") or "total_reviews"
    if sort not in _GAME_SORTABLE:
        return {"error": f"sort must be one of {sorted(_GAME_SORTABLE)}"}
    order = inp.get("order") or "desc"
    if order not in ("asc", "desc"):
        order = "desc"
    limit = max(1, min(int(inp.get("limit") or 15), 50))

    where = ["total_reviews >= ?"]
    params: list[Any] = [min_reviews]
    if q:
        where.append("name ILIKE ?")
        params.append(f"%{q}%")
    if genre:
        where.append("primary_genre = ?")
        params.append(genre)
    if tag:
        where.append("list_contains(top_tags, ?)")
        params.append(tag)

    rows = analytics_db.query(
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
        "games": _clean_rows(rows),
    }


def _game_profile(inp: dict[str, Any]) -> dict[str, Any]:
    appid = inp.get("appid")
    if appid is None:
        return {"error": "`appid` is required."}
    appid = int(appid)
    row = analytics_db.query_one(
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
    return _clean(row)


def _game_teardown(inp: dict[str, Any]) -> dict[str, Any]:
    appid = inp.get("appid")
    if appid is None:
        return {"error": "`appid` is required."}
    appid = int(appid)

    game = analytics_db.query_one("SELECT appid, name, primary_genre FROM mart_game WHERE appid = ?", [appid])
    if game is None:
        return {"error": f"appid {appid} not found in mart_game."}

    # Genre-differential: prefer the game's own primary_genre baseline, falling back to
    # the '__all__' catalog-wide baseline — mirrors routers/games.py's game_teardown.
    aspect_rows = analytics_db.query(
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

    press_summary = analytics_db.query_one(
        "SELECT total_mentions, n_sources, first_seen, last_seen FROM mart_game_press_summary WHERE appid = ?",
        [appid],
    )
    by_source = analytics_db.query(
        "SELECT source, n_mentions FROM mart_game_press_by_source WHERE appid = ? ORDER BY n_mentions DESC LIMIT 8",
        [appid],
    )
    notable = analytics_db.query(
        "SELECT source, title, author, published_at, is_earliest FROM mart_game_press_notable "
        "WHERE appid = ? ORDER BY published_at LIMIT 5",
        [appid],
    )

    caveats = [
        "Review aspects are mined from a SAMPLE of English-language reviews, recency-biased "
        "toward older/popular titles — not the game's full review history.",
        "Press coverage is fuzzy-matched and confidence-filtered, skews recent and "
        "English-outlet; Steam News (dev-authored posts) is excluded.",
        'Correlational, not causal: evidence toward "why it got popular," not proof.',
    ]
    if 0 < n_reviews_sampled < 50:
        caveats.append(f"Only {n_reviews_sampled} sampled English reviews — aspect shares are thin/noisy.")
    if not aspect_rows:
        caveats.append("Fewer than the review floor of sampled English reviews — review-aspect mining unavailable.")
    if press_summary is None:
        caveats.append("No press coverage found above the match-confidence floor.")

    return _clean(
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


# ---- press ------------------------------------------------------------------------------
def _press_pitch_list(inp: dict[str, Any]) -> dict[str, Any]:
    genre = inp.get("genre")
    if not genre:
        return {"error": "`genre` (exact Steam genre label) is required."}
    limit = max(1, min(int(inp.get("limit") or 15), 50))

    outlets = analytics_db.query(
        "SELECT source, n_articles, n_articles_recent_24m, n_games_covered, median_est_rev, "
        "median_owners, median_positive_ratio, example_author, example_title, example_url, "
        "example_published_at FROM mart_press_outlet_genre WHERE genre = ? ORDER BY n_articles DESC",
        [genre],
    )
    authors = analytics_db.query(
        "SELECT author, n_articles, n_articles_recent_24m, n_distinct_games, outlets, "
        "example_source, example_title, example_url, example_published_at "
        "FROM mart_press_author WHERE genre = ? ORDER BY n_articles DESC LIMIT ?",
        [genre, limit],
    )
    caveats = [
        "Selection bias: these outlets/journalists already chose to cover this genre.",
        "Ranked by ALL-TIME article volume — check n_articles_recent_24m and the example "
        "date before pitching; a prolific past contributor may no longer cover the beat.",
        "Steam News excluded — journalist/trade-press coverage only.",
    ]
    if not outlets and not authors:
        caveats.insert(
            0,
            f"No confidence-filtered journalist coverage found for genre '{genre}'. genre "
            "must be an exact Steam genre label (not a community tag).",
        )
    return _clean({"genre": genre, "outlets": outlets, "journalists": authors, "caveats": caveats})


def _buzz_trends(inp: dict[str, Any]) -> dict[str, Any]:
    direction = inp.get("direction") or "rising"
    if direction not in ("rising", "cooling"):
        return {"error": "direction must be 'rising' or 'cooling'"}
    limit = max(1, min(int(inp.get("limit") or 15), 50))
    include_series = bool(inp.get("include_series", False))

    order = "DESC" if direction == "rising" else "ASC"
    rows = analytics_db.query(
        f"SELECT term, total_mentions, recent_avg, prior_avg, slope, direction "
        f"FROM mart_buzz_trends_summary WHERE direction = ? ORDER BY slope {order} LIMIT ?",
        [direction, limit],
    )
    items = _clean_rows(rows)

    if include_series and items:
        terms = [it["term"] for it in items]
        placeholders = ",".join("?" for _ in terms)
        series_rows = analytics_db.query(
            f"SELECT term, period, n_mentions FROM mart_buzz_trends WHERE term IN ({placeholders}) "
            f"ORDER BY term, period",
            terms,
        )
        by_term: dict[str, list[dict[str, Any]]] = {t: [] for t in terms}
        for sr in series_rows:
            by_term[sr["term"]].append({"period": sr["period"], "n_mentions": sr["n_mentions"]})
        for it in items:
            it["series"] = by_term.get(it["term"], [])

    return {
        "direction": direction,
        "n_returned": len(items),
        "terms": items,
        "caveats": [
            "Compares the last 3 complete months to the 3 months before that; the "
            "current in-progress month is excluded.",
            "Mined from journalist article TITLES only, as English stopword-filtered "
            "bigrams — a coarse leading indicator, not full topic modeling.",
            "Restricted to Steam's tag/genre vocabulary — reads as game concepts, not "
            "franchise names or sale events.",
        ],
    }


# ---- timing (routers/seasonality.py) -----------------------------------------------------
# weekday: 0=Sunday .. 6=Saturday (DuckDB dayofweek — see etl/marts/mart_seasonality.sql).
_MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def _best_launch_timing(inp: dict[str, Any]) -> dict[str, Any]:
    genre = inp.get("genre") or "__all__"
    min_scored = int(inp.get("min_scored") or 30)

    months = analytics_db.query(
        "SELECT month, n_releases, n_scored, median_rev, median_positive_ratio "
        "FROM mart_seasonality WHERE grain = 'month' AND genre = ? ORDER BY month",
        [genre],
    )
    weekdays = analytics_db.query(
        "SELECT weekday, n_releases, n_scored, median_rev, median_positive_ratio "
        "FROM mart_seasonality WHERE grain = 'weekday' AND genre = ? ORDER BY weekday",
        [genre],
    )
    if not months and not weekdays:
        return {"error": f"no seasonality data for genre={genre!r}. Try '__all__' or an exact Steam genre label."}

    for m in months:
        m["month_name"] = _MONTH_NAMES[int(m["month"])]
    for w in weekdays:
        w["weekday_name"] = _WEEKDAY_NAMES[int(w["weekday"])]

    combos = analytics_db.query(
        "SELECT month, weekday, n_releases, n_scored, median_rev FROM mart_seasonality "
        "WHERE grain = 'month_weekday' AND genre = ? AND n_scored >= ? "
        "ORDER BY median_rev DESC NULLS LAST LIMIT 3",
        [genre, min_scored],
    )
    for c in combos:
        c["month_name"] = _MONTH_NAMES[int(c["month"])]
        c["weekday_name"] = _WEEKDAY_NAMES[int(c["weekday"])]

    reliable_months = [m for m in months if m["n_scored"] >= min_scored]
    reliable_weekdays = [w for w in weekdays if w["n_scored"] >= min_scored]
    best_month = max(reliable_months, key=lambda m: m["median_rev"] or 0, default=None)
    best_weekday = max(reliable_weekdays, key=lambda w: w["median_rev"] or 0, default=None)

    return _clean(
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


TOOL_FUNCS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "find_niches": _find_niches,
    "niche_detail": _niche_detail,
    "market_benchmarks": _market_benchmarks,
    "revenue_distribution": _revenue_distribution,
    "estimate_revenue": _estimate_revenue,
    "game_search": _game_search,
    "game_profile": _game_profile,
    "game_teardown": _game_teardown,
    "press_pitch_list": _press_pitch_list,
    "buzz_trends": _buzz_trends,
    "best_launch_timing": _best_launch_timing,
}


def _run_tool(name: str, tool_input: dict[str, Any] | None) -> dict[str, Any]:
    fn = TOOL_FUNCS.get(name)
    if fn is None:
        return {"error": f"unknown tool: {name!r}"}
    try:
        return fn(tool_input or {})
    except Exception as exc:  # noqa: BLE001 - surface the failure to the model, never 500 the stream
        return {"error": f"{type(exc).__name__}: {exc}"}


# ==========================================================================================
# SSE tool-use loop
# ==========================================================================================
def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


def _stream_chat(history: list[dict[str, str]]) -> Generator[bytes, None, None]:
    """One turn of the tool-use loop: model -> tool_use -> run tool -> tool_result -> repeat
    -> final text, streamed as SSE. Never raises — every failure mode (no key, marts not
    built, API error) is surfaced as an `error` event so the endpoint never 500s."""
    if not settings.anthropic_api_key:
        yield _sse("error", {"message": NO_KEY_MESSAGE, "code": "missing_api_key"})
        yield _sse("done", {})
        return
    if not analytics_db.is_ready():
        yield _sse("error", {"message": MARTS_NOT_READY_MESSAGE, "code": "marts_not_ready"})
        yield _sse("done", {})
        return
    if not history:
        yield _sse("error", {"message": "No message provided."})
        yield _sse("done", {})
        return

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    messages: list[dict[str, Any]] = list(history)

    try:
        for _ in range(MAX_TOOL_ITERATIONS):
            with client.messages.stream(
                model=settings.chat_model,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
            ) as stream:
                for event in stream:
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        yield _sse("text", {"text": event.delta.text})
                final = stream.get_final_message()

            messages.append({"role": "assistant", "content": final.content})

            if final.stop_reason != "tool_use":
                break

            tool_results: list[dict[str, Any]] = []
            for block in final.content:
                if block.type == "tool_use":
                    yield _sse("tool_call", {"name": block.name, "input": block.input})
                    result = _run_tool(block.name, block.input)
                    yield _sse("tool_result", {"name": block.name})
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(result)}
                    )
            messages.append({"role": "user", "content": tool_results})
        else:
            yield _sse(
                "error",
                {"message": "Reached the tool-call limit for this turn — try narrowing the question."},
            )
    except anthropic.AuthenticationError:
        yield _sse("error", {"message": "Anthropic API key was rejected. Check ANTHROPIC_API_KEY in api/.env."})
    except anthropic.RateLimitError:
        yield _sse("error", {"message": "Anthropic API rate limit hit — try again shortly."})
    except anthropic.APIStatusError as exc:
        yield _sse("error", {"message": f"Anthropic API error ({exc.status_code}): {exc.message}"})
    except anthropic.APIConnectionError:
        yield _sse("error", {"message": "Could not reach the Anthropic API — check network connectivity."})
    except Exception as exc:  # noqa: BLE001 - never let the stream crash the server
        yield _sse("error", {"message": f"Unexpected error: {exc}"})
    finally:
        yield _sse("done", {})


# ==========================================================================================
# Endpoints
# ==========================================================================================
@router.get("/status", response_model=ChatStatus)
def chat_status(org: Org = Depends(get_current_org)) -> ChatStatus:
    """Cheap readiness probe the frontend polls to decide whether to show the chat
    composer or the "add your API key" empty state — never calls the Anthropic API."""
    return ChatStatus(
        ready=bool(settings.anthropic_api_key) and analytics_db.is_ready(),
        model=settings.chat_model,
    )


@router.post("")
def chat(req: ChatRequest, org: Org = Depends(get_current_org)) -> StreamingResponse:
    history = [{"role": m.role, "content": m.content} for m in req.messages if m.content and m.content.strip()]
    return StreamingResponse(
        _stream_chat(history),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
