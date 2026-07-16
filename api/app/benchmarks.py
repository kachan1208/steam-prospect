"""Researched indie-market benchmark constants.

These are CITED reference points (VG Insights / GameDiscoverCo / HowToMarketAGame /
GameDeveloper Boxleiter work), not values derived from our catalog. They are surfaced as
annotation marks on charts and drive the estimator. Where our computed medians differ from
these, that is expected: our figures are Boxleiter gross-lifetime over games that cleared a
review floor, while several cited figures are first-year/net over ALL releases.
"""
from __future__ import annotations

# --- Revenue reality -------------------------------------------------------------------
MEDIAN_INDIE_GROSS_USD = 249        # median indie gross, 2025 (VG Insights)
PCT_NEW_RELEASES_OVER_100K = 0.085  # ~8.5% of new releases clear $100K gross
BOTTOM_30_PCT_GROSS_USD = 37        # bottom ~30% of releases
REVIEWS_1000_REVENUE_USD = 150000   # ~1,000 reviews ≈ $150K+ (order-of-magnitude)

# --- Reviews -> owners (Boxleiter) -----------------------------------------------------
# "New Boxleiter": 20-55 owners per review, genre-dependent, mid ~30.
BOXLEITER_OWNERS_PER_REVIEW_MIN = 20
BOXLEITER_OWNERS_PER_REVIEW_MID = 30
BOXLEITER_OWNERS_PER_REVIEW_MAX = 55

# --- Wishlists -> sales ----------------------------------------------------------------
WISHLIST_CONVERSION_FIRST_WEEK = 0.10   # ~10% of wishlists convert in launch week
WISHLIST_CONVERSION_RANGE = (0.08, 0.12)
FIRST_WEEK_TO_FIRST_YEAR_MULT = 5       # first-week sales x5 ≈ first-year sales

# --- Steam economics -------------------------------------------------------------------
STEAM_REVENUE_SHARE_TO_DEV = 0.70       # dev keeps ~70% after Steam's 30% cut (gross->net)

# --- Dev tiers (by lifetime copies sold) ----------------------------------------------
# label, min_copies, max_copies (exclusive upper, None = open), rough revenue anchor.
DEV_TIERS = [
    {"label": "Hobby", "min_copies": 2_000, "max_copies": 20_000, "revenue_anchor_usd": 50_000},
    {"label": "Small", "min_copies": 20_000, "max_copies": 200_000, "revenue_anchor_usd": 1_000_000},
    {"label": "Middle", "min_copies": 200_000, "max_copies": 1_000_000, "revenue_anchor_usd": 10_000_000},
    {"label": "Triple-I", "min_copies": 1_000_000, "max_copies": None, "revenue_anchor_usd": 50_000_000},
]

# --- Opportunity score weights (mirror etl/build_marts.py) -----------------------------
OPPORTUNITY_WEIGHTS = {"demand": 0.50, "competition": 0.35, "quality_gap": 0.30}

# --- Chart annotation marks ------------------------------------------------------------
REVENUE_BENCHMARK_MARKS = [
    {"label": "Median indie ($249)", "value": MEDIAN_INDIE_GROSS_USD, "cite": "VG Insights 2025"},
    {"label": "$100K milestone", "value": 100_000, "cite": "~8.5% of releases clear it"},
    {"label": "Small tier ($1M)", "value": 1_000_000, "cite": "20K-200K copies"},
    {"label": "Middle tier ($10M)", "value": 10_000_000, "cite": "200K-1M copies"},
]


def tier_for_copies(copies: float | None) -> str:
    """Map a copies (owners) estimate to a dev tier label."""
    if copies is None:
        return "Unknown"
    if copies < DEV_TIERS[0]["min_copies"]:
        return "Below Hobby"
    for tier in DEV_TIERS:
        hi = tier["max_copies"]
        if hi is None or copies < hi:
            return tier["label"]
    return DEV_TIERS[-1]["label"]


def as_dict() -> dict:
    """Full benchmark payload for GET /api/market/benchmarks."""
    return {
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
        "opportunity_weights": OPPORTUNITY_WEIGHTS,
        "revenue_benchmark_marks": REVENUE_BENCHMARK_MARKS,
    }
