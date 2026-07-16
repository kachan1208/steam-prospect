"""Runtime configuration (env-driven, PROSPECT_ prefix)."""
from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]  # app -> api -> prospect


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PROSPECT_", env_file=".env", extra="ignore")

    # Analytics plane: read-only DuckDB marts (the current.duckdb symlink from the ETL).
    analytics_db_path: str = str(REPO_ROOT / "data" / "current.duckdb")

    # Control plane: SQLAlchemy DSN. Local default = SQLite file; set to a Postgres URL later.
    control_dsn: str = f"sqlite:///{REPO_ROOT / 'prospect_control.db'}"

    # Solo mode: one seeded org with unlimited entitlements; no login required.
    solo_mode: bool = True
    solo_org_name: str = "Solo Studio"
    solo_org_slug: str = "solo"
    solo_user_email: str = "solo@prospect.local"

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
    ]

    api_title: str = "Prospect API"
    api_version: str = "0.1.0"

    # Analytics Chat (LLM tool-use over the marts, api/app/routers/chat.py). The API key
    # intentionally has NO PROSPECT_ prefix (validation_alias overrides it) so it matches
    # the Anthropic SDK's own env var name and api/.env can use the same key ChatGPT-style
    # tools expect. chat_model still follows the normal prefix, i.e. PROSPECT_CHAT_MODEL.
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
    chat_model: str = "claude-haiku-4-5-20251001"


settings = Settings()
