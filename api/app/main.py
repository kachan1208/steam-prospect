"""Prospect API entrypoint."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import analytics_db
from .config import settings
from .control_db import init_db
from .routers import estimate, games, health, market, niches, press, seasonality, views, watchlist


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Control plane: create schema + seed solo org.
    init_db()
    # Analytics plane: open the read-only marts. Fail loud if the ETL hasn't run.
    try:
        analytics_db.init(settings.analytics_db_path)
    except FileNotFoundError as exc:
        # Keep the app up so /docs and a clear error are reachable; endpoints will 503.
        print(f"[api] WARNING: {exc}")
    yield
    analytics_db.close()


app = FastAPI(title=settings.api_title, version=settings.api_version, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(niches.router)
app.include_router(market.router)
app.include_router(seasonality.router)
app.include_router(estimate.router)
app.include_router(views.router)
app.include_router(games.router)
app.include_router(watchlist.router)
app.include_router(press.router)

# Alias the plan's canonical CSV export path to the niches export handler.
app.add_api_route(
    "/api/export/niches.csv",
    niches.export_csv,
    methods=["GET"],
    tags=["niches"],
    name="export_niches_csv",
)


@app.get("/", tags=["health"])
def root() -> dict:
    return {
        "name": settings.api_title,
        "version": settings.api_version,
        "docs": "/docs",
        "health": "/api/health",
    }
