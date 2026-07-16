"""Entitlements seam. In solo mode everything is unlimited; later this reads the org's
subscription/plan to gate features and quotas."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException

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
    rate_limit_per_minute: int | None    # None = unlimited (O4 hardening)
    chat_messages_per_day: int | None    # None = unlimited (O5 chat quota hook)


def entitlements(org: Org) -> Entitlements:
    if settings.solo_mode or org.plan == "solo":
        return Entitlements(
            plan="solo",
            can_export=True,
            api_access=True,
            max_saved_views=None,
            max_watchlist_items=None,
            max_niche_rows=None,
            rate_limit_per_minute=None,
            chat_messages_per_day=None,
        )
    # Placeholder for future paid tiers.
    return Entitlements(
        plan=org.plan,
        can_export=False,
        api_access=False,
        max_saved_views=10,
        max_watchlist_items=50,
        max_niche_rows=100,
        rate_limit_per_minute=120,
        chat_messages_per_day=50,
    )


# ---- O4: cross-tenant authorization helper --------------------------------------------
def enforce_org_scope(obj: object | None, org: Org, *, not_found_detail: str = "Not found.") -> None:
    """Cross-tenant guard for per-org rows (saved_views/watchlist/alerts/...). Raises 404
    when the object doesn't exist at all, 403 when it exists but belongs to a different
    org. Apply on every mutating per-org endpoint (see routers/views.py for the first
    caller); watchlist/alerts routers should apply the same helper once their owning
    agent wires it in.

    Mechanism works now but its 403 branch is unreachable in solo mode: there is only
    ever one org, so `obj.org_id != org.id` can never be true — it activates the moment
    multi-tenant auth resolves distinct orgs per caller.
    """
    if obj is None:
        raise HTTPException(status_code=404, detail=not_found_detail)
    if getattr(obj, "org_id", None) != org.id:
        raise HTTPException(
            status_code=403, detail="This resource belongs to a different organization."
        )


# ---- O5: chat quota hook -----------------------------------------------------------------
def chat_quota_exceeded(ent: Entitlements, messages_sent_today: int) -> bool:
    """True once an org has hit its daily chat-message quota. Solo mode's
    chat_messages_per_day is None (unlimited), so this is always False today —
    fully exercised once a paid plan with a real cap exists."""
    return ent.chat_messages_per_day is not None and messages_sent_today >= ent.chat_messages_per_day
