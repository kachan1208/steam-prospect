"""Runtime configuration (env-driven, PROSPECT_ prefix)."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]  # app -> api -> prospect


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PROSPECT_", env_file=".env", extra="ignore")

    # Analytics plane: read-only DuckDB marts (the current.duckdb symlink from the ETL).
    analytics_db_path: str = str(REPO_ROOT / "data" / "current.duckdb")
    # Read-only DuckDB cursor pool size — how many analytics queries can run concurrently
    # before requests queue (env: PROSPECT_ANALYTICS_POOL_SIZE). ~2x vCPUs is a good default.
    analytics_pool_size: int = 4

    # Hosted mode: point at the built Vite frontend (web/dist) so the API serves the SPA
    # from its own origin — one deployable, no CORS. Empty in local dev (Vite serves it).
    static_dir: str | None = None

    # Mount the Prospect MCP server (mcp/prospect_mcp.py) at /mcp over Streamable HTTP, so
    # hosted users can add Prospect to their own Claude. Off by default so local dev (Vite +
    # the stdio MCP via .mcp.json) is untouched; the container image turns it on.
    enable_mcp: bool = False

    # Content log of hosted MCP tool calls (tool name + arguments, NO user identifiers),
    # appended as JSONL by the /mcp mount so we can see what people actually ask the data.
    # Lives in the mounted data dir so it survives redeploys. Empty string disables logging.
    mcp_call_log_path: str = str(REPO_ROOT / "data" / "mcp_calls.jsonl")
    # Bearer-style token gating the /api/analytics/mcp-log viewer. Unset (default) = the
    # endpoint 404s — the call log is never publicly readable by accident.
    admin_token: str | None = None

    # Data-refresh changelog: newline-delimited JSON written by the Droplet's refresh cron
    # (one record per run, with data deltas). Served read-only by /api/refresh/history and
    # rendered on the in-app "Data log" page. Default sits in the (mounted) data dir.
    refresh_history_path: str = str(REPO_ROOT / "data" / "refresh_history.json")

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
    ]

    api_title: str = "Prospect API"
    api_version: str = "0.1.0"

    # Per-IP rate limit (api/app/rate_limit.py) on POST /api/analytics/collect and the
    # /mcp mount — requests per minute per client IP, sliding window. 0 disables the
    # limiter entirely (env: PROSPECT_RATE_LIMIT_PER_MIN).
    rate_limit_per_min: int = 120

    # How many TRUSTED reverse proxies sit in front of this app — the number of hops at the
    # RIGHT of X-Forwarded-For that were written by infrastructure we control, and therefore
    # the only part of that header a client cannot forge. Production is exactly one: Caddy on
    # the droplet terminates TLS on :443 and `reverse_proxy 127.0.0.1:8080`s into the
    # container (the port is bound to loopback, so Caddy is the only possible peer), and
    # Caddy APPENDS the real peer to any client-supplied X-Forwarded-For. 0 = nothing
    # trustworthy in front, ignore the header entirely and use the socket peer
    # (env: PROSPECT_TRUSTED_PROXY_HOPS). See rate_limit._client_key.
    trusted_proxy_hops: int = 1

    # Observability (api/app/observability.py). Sentry is fully inert until
    # PROSPECT_SENTRY_DSN is set — local dev runs with zero Sentry footprint, no
    # import side effects beyond a no-op check.
    sentry_dsn: str | None = None
    sentry_environment: str = "development"
    sentry_traces_sample_rate: float = 0.0


settings = Settings()
