from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import analytics_db, benchmarks
from ..auth import get_current_org
from ..models import Org
from ..schemas import EstimateRequest, EstimateResponse, Range

router = APIRouter(tags=["estimate"])


def _genre_owners_per_review(genre: str | None) -> tuple[str, float]:
    """Return (genre_used, mid owners/review) from the fitted Boxleiter slope, clamped to
    the cited 20-55 band. Falls back to the global slope, then the benchmark mid."""
    lo = benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MIN
    hi = benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MAX
    default = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MID)

    for candidate in [genre, "__all__"]:
        if not candidate:
            continue
        row = analytics_db.query_one(
            "SELECT genre, slope FROM mart_market_boxleiter WHERE genre = ?", [candidate]
        )
        if row and row["slope"] is not None:
            slope = max(lo, min(hi, float(row["slope"])))
            return (row["genre"], slope)
    return ("__all__", default)


@router.post("/api/estimate", response_model=EstimateResponse)
def estimate(req: EstimateRequest, org: Org = Depends(get_current_org)) -> EstimateResponse:
    if (req.reviews is None) == (req.wishlists is None):
        raise HTTPException(
            status_code=400, detail="Provide exactly one of `reviews` or `wishlists`."
        )

    lo = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MIN)
    hi = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MAX)
    genre_used, opr_mid = _genre_owners_per_review(req.genre)
    opr_used = Range(low=lo, mid=opr_mid, high=hi)
    notes: list[str] = []

    if req.reviews is not None:
        basis = "reviews"
        owners = Range(
            low=req.reviews * lo,
            mid=req.reviews * opr_mid,
            high=req.reviews * hi,
        )
        notes.append(
            f"Owners = reviews x Boxleiter ({lo:.0f}-{hi:.0f} owners/review; "
            f"fitted mid for '{genre_used}' = {opr_mid:.0f})."
        )
    else:
        basis = "wishlists"
        wl_lo, wl_hi = benchmarks.WISHLIST_CONVERSION_RANGE
        wl_mid = benchmarks.WISHLIST_CONVERSION_FIRST_WEEK
        mult = benchmarks.FIRST_WEEK_TO_FIRST_YEAR_MULT
        owners = Range(
            low=req.wishlists * wl_lo * mult,
            mid=req.wishlists * wl_mid * mult,
            high=req.wishlists * wl_hi * mult,
        )
        notes.append(
            f"Sales = wishlists x first-week conversion ({wl_lo:.0%}-{wl_hi:.0%}, mid "
            f"{wl_mid:.0%}) x first-year multiplier ({mult}x)."
        )
        notes.append("owners_per_review shown for reference only (not used on the wishlist path).")

    revenue_gross = Range(
        low=owners.low * req.price,
        mid=owners.mid * req.price,
        high=owners.high * req.price,
    )
    share = benchmarks.STEAM_REVENUE_SHARE_TO_DEV
    revenue_net = Range(
        low=revenue_gross.low * share,
        mid=revenue_gross.mid * share,
        high=revenue_gross.high * share,
    )
    notes.append(f"Net = gross x {share:.0%} (after Steam's ~30% cut, before taxes/refunds).")
    notes.append(f"Gross revenue = owners x ${req.price:.2f} price (box revenue, lifetime).")

    return EstimateResponse(
        basis=basis,
        genre=genre_used,
        owners_per_review_used=opr_used,
        owners=owners,
        revenue_gross_usd=revenue_gross,
        revenue_net_usd=revenue_net,
        dev_tier=benchmarks.tier_for_copies(owners.mid),
        notes=notes,
    )
