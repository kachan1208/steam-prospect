"""Control-plane database (SQLAlchemy 2.0), DSN-driven.

Default DSN is a local SQLite file; point PROSPECT_CONTROL_DSN at Postgres for deploy with
no code change. init_db() creates the schema and seeds the solo org/user in solo mode.
"""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base, Membership, Org, Subscription, User

_connect_args = {}
if settings.control_dsn.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}

engine = create_engine(settings.control_dsn, echo=False, future=True, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, class_=Session)


def init_db() -> None:
    Base.metadata.create_all(engine)
    if settings.solo_mode:
        _seed_solo()


def _seed_solo() -> None:
    with SessionLocal() as db:
        org = db.scalar(select(Org).where(Org.slug == settings.solo_org_slug))
        if org is None:
            org = Org(name=settings.solo_org_name, slug=settings.solo_org_slug, plan="solo")
            db.add(org)
            db.flush()
            user = db.scalar(select(User).where(User.email == settings.solo_user_email))
            if user is None:
                user = User(email=settings.solo_user_email, display_name="Solo Dev")
                db.add(user)
                db.flush()
            db.add(Membership(org_id=org.id, user_id=user.id, role="owner"))
            db.add(Subscription(org_id=org.id, plan="solo", status="active"))
            db.commit()


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
