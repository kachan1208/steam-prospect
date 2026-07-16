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

    # Analytics Chat (api/app/routers/chat.py) runs on the local Claude Code CLI + the user's
    # subscription — no API key needed. chat_model is an OPTIONAL override passed to
    # `claude --model` (PROSPECT_CHAT_MODEL); left unset, the chat uses the subscription's
    # default model. anthropic_api_key is retained (unused by chat now) for a possible future
    # API-billed path; validation_alias keeps the Anthropic SDK's own env var name.
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
    chat_model: str | None = None

    # Transactional email (api/app/email.py) + the alert evaluator (api/app/alerts_eval.py).
    # Default provider "console" logs the email and never fails — zero config needed. Set
    # PROSPECT_EMAIL_PROVIDER to "smtp" or "resend" to send for real; an incomplete/missing
    # config for the selected provider falls back to console with a warning rather than
    # crashing the caller.
    email_provider: str = "console"          # PROSPECT_EMAIL_PROVIDER: console | smtp | resend
    email_from: str = "Prospect <alerts@prospect.local>"    # PROSPECT_EMAIL_FROM
    app_base_url: str = "http://localhost:5173"             # PROSPECT_APP_BASE_URL (for links in emails)

    resend_api_key: str | None = None        # PROSPECT_RESEND_API_KEY

    # Deliberately un-prefixed (the common convention for these vars, matching most
    # SMTP-sending libraries/services).
    smtp_host: str | None = Field(default=None, validation_alias="SMTP_HOST")
    smtp_port: int = Field(default=587, validation_alias="SMTP_PORT")
    smtp_user: str | None = Field(default=None, validation_alias="SMTP_USER")
    smtp_password: str | None = Field(default=None, validation_alias="SMTP_PASSWORD")
    smtp_from: str | None = Field(default=None, validation_alias="SMTP_FROM")
    smtp_use_tls: bool = Field(default=True, validation_alias="SMTP_USE_TLS")


settings = Settings()
