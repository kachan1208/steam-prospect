"""Entitlements seam. In solo mode everything is unlimited; later this reads the org's
subscription/plan to gate features and quotas."""
from __future__ import annotations

from dataclasses import dataclass

from .config import settings
from .models import Org


@dataclass(frozen=True)
class Entitlements:
    plan: str
    can_export: bool
    api_access: bool
    max_saved_views: int | None      # None = unlimited
    max_watchlist_items: int | None
    max_niche_rows: int | None


def entitlements(org: Org) -> Entitlements:
    if settings.solo_mode or org.plan == "solo":
        return Entitlements(
            plan="solo",
            can_export=True,
            api_access=True,
            max_saved_views=None,
            max_watchlist_items=None,
            max_niche_rows=None,
        )
    # Placeholder for future paid tiers.
    return Entitlements(
        plan=org.plan,
        can_export=False,
        api_access=False,
        max_saved_views=10,
        max_watchlist_items=50,
        max_niche_rows=100,
    )
