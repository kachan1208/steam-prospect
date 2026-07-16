"""Auth seam. Every route depends on get_current_org().

Solo mode resolves to the single seeded org (no login). Later this becomes: read a session
cookie / API key, look up the membership, and return the caller's org — same dependency,
same call sites, no route changes.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .control_db import get_db
from .entitlements import Entitlements, entitlements
from .models import Org


def get_current_org(db: Session = Depends(get_db)) -> Org:
    if settings.solo_mode:
        org = db.scalar(select(Org).where(Org.slug == settings.solo_org_slug))
        if org is None:
            raise HTTPException(status_code=503, detail="Solo org not seeded; restart the API.")
        return org
    raise HTTPException(status_code=401, detail="Authentication required.")


def get_entitlements(org: Org = Depends(get_current_org)) -> Entitlements:
    return entitlements(org)
