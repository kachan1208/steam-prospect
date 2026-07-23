"""Prospect API entrypoint."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import analytics_db
from .config import settings
from .control_db import init_db
from .observability import setup_observability
from . import alert_models, input_models, outreach_models, project_models  # noqa: F401 — register watchtower tables on Base.metadata before init_db()
from .routers import (
    account, alerts, chat, estimate, explore, games, health, inputs, market, marketing,
    niches, outreach, press, projects, radar, seasonality, trends, views, watchlist,
)
from .mcp_mount import load_prospect_mcp

# Optionally load the standalone Prospect MCP (mcp/prospect_mcp.py) as a Streamable-HTTP app
# so hosted users can add Prospect to their own Claude. (None, None) when disabled/unavailable
# — the API is unaffected. Mounted below; its session manager is driven in the lifespan.
_prospect_mcp, _mcp_asgi = load_prospect_mcp()


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
    # The mounted MCP's Streamable-HTTP transport needs its session manager running for the
    # whole app lifetime; drive it here when the MCP is enabled.
    if _prospect_mcp is not None:
        async with _prospect_mcp.session_manager.run():
            yield
    else:
        yield
    analytics_db.close()


app = FastAPI(title=settings.api_title, version=settings.api_version, lifespan=lifespan)

# O3 (metrics /metrics + structured request logging + env-gated Sentry) + O4 (rate-limit
# middleware). Registered BEFORE CORSMiddleware below: Starlette's add_middleware() makes
# the LAST-added middleware outermost, so calling this first keeps CORS wrapping
# everything else (including a 429 from the rate limiter) — see observability.py.
setup_observability(app)

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
app.include_router(marketing.router)
app.include_router(explore.router)
app.include_router(chat.router)
app.include_router(alerts.router)
app.include_router(projects.router)
app.include_router(outreach.router)
app.include_router(inputs.router)
app.include_router(radar.router)
app.include_router(trends.router)
app.include_router(account.router)

# Alias the plan's canonical CSV export path to the niches export handler.
app.add_api_route(
    "/api/export/niches.csv",
    niches.export_csv,
    methods=["GET"],
    tags=["niches"],
    name="export_niches_csv",
)


# Mount the Prospect MCP (Streamable HTTP) at /mcp so users can add it to their own Claude.
# Registered before the SPA catch-all below so /mcp routes to the MCP, not to index.html.
if _mcp_asgi is not None:
    app.mount("/mcp", _mcp_asgi)


# ---- Serve the built SPA when running as a single hosted service -------------------------
# In the container image PROSPECT_STATIC_DIR points at the Vite build (web/dist), so this
# service also serves the frontend from the same origin (no CORS, one deployable). Unset in
# local dev — Vite serves the SPA and proxies /api — leaving everything below inert.
_STATIC_DIR = Path(settings.static_dir) if settings.static_dir else None
_INDEX_HTML = (_STATIC_DIR / "index.html") if _STATIC_DIR else None
_SERVE_SPA = bool(_STATIC_DIR and _INDEX_HTML and _INDEX_HTML.exists())


@app.get("/", include_in_schema=False)
def root():
    # Hosted mode: the root path is the app itself. Local/dev: a small JSON pointer.
    if _SERVE_SPA:
        return FileResponse(str(_INDEX_HTML))
    return {
        "name": settings.api_title,
        "version": settings.api_version,
        "docs": "/docs",
        "health": "/api/health",
    }


if _SERVE_SPA:
    # Hashed JS/CSS/images emitted by Vite live under /assets.
    _assets_dir = _STATIC_DIR / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")

    # SPA fallback — registered LAST so it never shadows /api/*, /docs, /openapi.json,
    # /metrics (each matched by its own route above). Any other path returns a real static
    # file if one exists (favicon, etc.), otherwise index.html so client-side routes
    # (/home, /outreach, …) survive a hard refresh.
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        if full_path.startswith(("api", "docs", "redoc", "openapi.json", "metrics", "mcp")):
            raise HTTPException(status_code=404)
        candidate = _STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_INDEX_HTML))
