"""Account / Settings surface (Track G2): profile info, saved-view & API-key management,
and a usage summary.

Self-contained — reads only the control-plane tables that already exist in models.py (Org,
User, Membership, SavedView, ApiKey). No schema migration needed: ApiKey has
been defined since the control-plane schema landed but had no router until now.

`usage` intentionally does NOT fabricate query/export/chat-message activity — there is no
request-level usage log yet (that's Track O5's job, gated on the scheduled-refresh/chat
productionization work). It reports the real, currently-derivable counts (saved views,
active API keys) and labels the rest "coming soon" rather than inventing
numbers — consistent with the product's own "never fake precision" ethos.
"""
from __future__ import annotations

import hashlib
import secrets

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_org, get_entitlements
from ..control_db import get_db
from ..entitlements import Entitlements
from ..models import ApiKey, Membership, Org, SavedView, Subscription, User
from ..schemas import (
    AccountCounts,
    AccountEntitlements,
    AccountOrg,
    AccountOut,
    AccountSubscription,
    AccountUser,
    ApiKeyCreated,
    ApiKeyIn,
    ApiKeyOut,
    UsageOut,
)

router = APIRouter(prefix="/api/account", tags=["account"])

# "psk_" + a 32-byte urlsafe token; the prefix (stored, never the secret) is enough to
# recognize a key in a list without ever being able to reconstruct it.
_SECRET_PREFIX = "psk_"
_PREFIX_CHARS = 12


def _solo_user(org: Org, db: Session) -> User | None:
    """The single membership's user for this org (solo mode seeds exactly one)."""
    return db.scalar(
        select(User).join(Membership, Membership.user_id == User.id).where(Membership.org_id == org.id)
    )


def _counts(org: Org, db: Session) -> AccountCounts:
    saved_views = len(db.scalars(select(SavedView).where(SavedView.org_id == org.id)).all())
    api_keys_active = len(
        db.scalars(select(ApiKey).where(ApiKey.org_id == org.id, ApiKey.active.is_(True))).all()
    )
    return AccountCounts(saved_views=saved_views, api_keys_active=api_keys_active)


def _to_api_key_out(k: ApiKey) -> ApiKeyOut:
    return ApiKeyOut(
        id=k.id,
        name=k.name,
        prefix=k.prefix,
        active=k.active,
        created_at=k.created_at.isoformat() if k.created_at else "",
        last_used_at=k.last_used_at.isoformat() if k.last_used_at else None,
    )


@router.get("", response_model=AccountOut)
def get_account(
    org: Org = Depends(get_current_org),
    ent: Entitlements = Depends(get_entitlements),
    db: Session = Depends(get_db),
) -> AccountOut:
    user = _solo_user(org, db)
    sub = db.scalar(select(Subscription).where(Subscription.org_id == org.id))
    member_since = (
        user.created_at.isoformat() if user and user.created_at else org.created_at.isoformat()
    )
    return AccountOut(
        org=AccountOrg(name=org.name, slug=org.slug, plan=org.plan),
        user=AccountUser(
            email=user.email if user else "—",
            display_name=user.display_name if user else None,
            member_since=member_since,
        ),
        subscription=AccountSubscription(
            plan=sub.plan if sub else org.plan,
            status=sub.status if sub else "active",
            current_period_end=sub.current_period_end.isoformat() if sub and sub.current_period_end else None,
        ),
        entitlements=AccountEntitlements(
            plan=ent.plan,
            can_export=ent.can_export,
            api_access=ent.api_access,
            max_saved_views=ent.max_saved_views,
            max_niche_rows=ent.max_niche_rows,
        ),
        counts=_counts(org, db),
    )


@router.get("/usage", response_model=UsageOut)
def get_usage(org: Org = Depends(get_current_org), db: Session = Depends(get_db)) -> UsageOut:
    counts = _counts(org, db)
    return UsageOut(
        saved_views=counts.saved_views,
        api_keys_active=counts.api_keys_active,
        tracking_available=False,
        note=(
            "Per-query, export, and chat-message usage isn't tracked yet — that needs a "
            "request-level usage log (planned, not built). The counts above are real, read "
            "directly from your saved views and API keys."
        ),
    )


@router.get("/api-keys", response_model=list[ApiKeyOut])
def list_api_keys(org: Org = Depends(get_current_org), db: Session = Depends(get_db)) -> list[ApiKeyOut]:
    rows = db.scalars(
        select(ApiKey).where(ApiKey.org_id == org.id).order_by(ApiKey.created_at.desc())
    ).all()
    return [_to_api_key_out(k) for k in rows]


@router.post("/api-keys", response_model=ApiKeyCreated, status_code=201)
def create_api_key(
    payload: ApiKeyIn,
    org: Org = Depends(get_current_org),
    ent: Entitlements = Depends(get_entitlements),
    db: Session = Depends(get_db),
) -> ApiKeyCreated:
    if not ent.api_access:
        raise HTTPException(status_code=402, detail="API access isn't included in your plan.")

    secret = f"{_SECRET_PREFIX}{secrets.token_urlsafe(32)}"
    prefix = secret[:_PREFIX_CHARS]
    hashed = hashlib.sha256(secret.encode("utf-8")).hexdigest()

    row = ApiKey(org_id=org.id, name=payload.name, prefix=prefix, hashed_key=hashed, active=True)
    db.add(row)
    db.commit()
    db.refresh(row)

    return ApiKeyCreated(
        id=row.id,
        name=row.name,
        prefix=row.prefix,
        active=row.active,
        created_at=row.created_at.isoformat() if row.created_at else "",
        last_used_at=None,
        secret=secret,
    )


@router.post("/api-keys/{key_id}/revoke", response_model=ApiKeyOut)
def revoke_api_key(
    key_id: int, org: Org = Depends(get_current_org), db: Session = Depends(get_db)
) -> ApiKeyOut:
    row = db.get(ApiKey, key_id)
    if row is None or row.org_id != org.id:
        raise HTTPException(status_code=404, detail="API key not found.")
    row.active = False
    db.commit()
    db.refresh(row)
    return _to_api_key_out(row)
