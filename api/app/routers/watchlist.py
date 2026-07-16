from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import analytics_db
from ..auth import get_current_org, get_entitlements
from ..control_db import get_db
from ..entitlements import Entitlements
from ..models import Org, Watchlist
from ..schemas import WatchlistIn, WatchlistOut

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

_KIND = "game"


def _enrich(w: Watchlist) -> WatchlistOut:
    appid = int(w.key)
    game = (
        analytics_db.query_one(
            "SELECT name, header_image, primary_genre, price_initial, owners_mid, "
            "total_reviews, positive_ratio, est_rev_reviews FROM mart_game WHERE appid = ?",
            [appid],
        )
        or {}
    )
    # Trailing 12 months of sampled review counts, oldest -> newest, for the sparkline.
    spark_rows = analytics_db.query(
        "SELECT n_reviews FROM mart_game_reviews_timeline WHERE appid = ? "
        "ORDER BY period DESC LIMIT 12",
        [appid],
    )
    sparkline = [int(r["n_reviews"]) for r in reversed(spark_rows)]
    return WatchlistOut(
        id=w.id,
        appid=appid,
        note=w.note,
        created_at=w.created_at.isoformat() if w.created_at else "",
        name=game.get("name"),
        header_image=game.get("header_image"),
        primary_genre=game.get("primary_genre"),
        price_initial=game.get("price_initial"),
        owners_mid=game.get("owners_mid"),
        total_reviews=game.get("total_reviews"),
        positive_ratio=game.get("positive_ratio"),
        est_rev_reviews=game.get("est_rev_reviews"),
        velocity_sparkline=sparkline,
    )


@router.get("", response_model=list[WatchlistOut])
def list_watchlist(org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Watchlist)
        .where(Watchlist.org_id == org.id, Watchlist.kind == _KIND)
        .order_by(Watchlist.created_at.desc())
    ).all()
    return [_enrich(w) for w in rows]


@router.post("", response_model=WatchlistOut, status_code=201)
def add_watchlist(
    payload: WatchlistIn,
    org: Org = Depends(get_current_org),
    ent: Entitlements = Depends(get_entitlements),
    db: Session = Depends(get_db),
):
    exists = analytics_db.scalar("SELECT COUNT(*) FROM mart_game WHERE appid = ?", [payload.appid])
    if not exists:
        raise HTTPException(status_code=404, detail=f"game not found: {payload.appid}")

    key = str(payload.appid)
    row = db.scalar(
        select(Watchlist).where(
            Watchlist.org_id == org.id, Watchlist.kind == _KIND, Watchlist.key == key
        )
    )
    if row is not None:
        # Already watchlisted: treat POST as an upsert of the note rather than erroring.
        row.note = payload.note
        db.commit()
        db.refresh(row)
        return _enrich(row)

    if ent.max_watchlist_items is not None:
        count = len(
            db.scalars(
                select(Watchlist).where(Watchlist.org_id == org.id, Watchlist.kind == _KIND)
            ).all()
        )
        if count >= ent.max_watchlist_items:
            raise HTTPException(status_code=402, detail="Watchlist limit reached for your plan.")

    row = Watchlist(org_id=org.id, kind=_KIND, key=key, note=payload.note)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _enrich(row)


@router.delete("/{appid}", status_code=204)
def remove_watchlist(appid: int, org: Org = Depends(get_current_org), db: Session = Depends(get_db)):
    row = db.scalar(
        select(Watchlist).where(
            Watchlist.org_id == org.id, Watchlist.kind == _KIND, Watchlist.key == str(appid)
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Watchlist item not found.")
    db.delete(row)
    db.commit()
