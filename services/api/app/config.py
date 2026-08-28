"""Application settings (pydantic-settings). Values come from env vars / `.env`.

`get_settings()` is cached; tests override env *before* importing `app.*`.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# services/api/app/config.py -> parents[3] is the repo root (…/farmsignal)
REPO_ROOT = Path(__file__).resolve().parents[3]

# data.gov.in public sample key (rate-limited, fine for demo)
DEFAULT_AGMARKNET_KEY = "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b"
DEFAULT_AGMARKNET_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"

# The scripted demo farmer's device id (data/demo_scenarios/demo_seed.json, PWA DemoSection).
# Lives here (not in app.demo) so schemas can reference it without importing the seeder.
DEMO_DEVICE_ID = "demo-device-001"

# Substrings that mark a shipped placeholder secret (config default, compose, .env.example).
_PLACEHOLDER_SECRET_MARKERS = ("change-me", "changeme", "secret-here")
MIN_SECRET_BYTES = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    APP_NAME: str = "FarmSignal API"
    VERSION: str = "0.1.0"
    ENV: Literal["dev", "test", "prod"] = "dev"

    DATABASE_URL: str = "sqlite:///./farmsignal.db"

    JWT_SECRET: str = "farmsignal-dev-secret-change-me-before-deploying-0000"  # >= 32 bytes
    JWT_TTL_DAYS: int = 30

    AGMARKNET_API_KEY: str = DEFAULT_AGMARKNET_KEY
    AGMARKNET_RESOURCE_ID: str = DEFAULT_AGMARKNET_RESOURCE_ID
    AGMARKNET_TIMEOUT_S: float = 5.0
    PRICE_POLL_HOURS: int = 6
    PRICE_STALE_HOURS: int = 30

    PUBLIC_BASE_URL: str = "http://localhost:5173"

    # Routing constants (contract §3)
    ROAD_FACTOR: float = 1.3
    AVG_SPEED_KMH: float = 35.0
    SAFETY_FACTOR: float = 0.8
    TRANSPORT_COST_PER_KM_INR: float = 12.0

    DEMO_MODE: bool = True
    # Shared secret for destructive demo operations (`POST /demo/seed?reset=true`); unset = off.
    DEMO_ADMIN_TOKEN: str | None = None
    DATA_DIR: Path = Field(default=REPO_ROOT / "data")

    # Comma-separated in env (NoDecode disables pydantic-settings' JSON parsing).
    CORS_ORIGINS: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    RATE_LIMIT_PER_MIN: int = 60
    # POST /auth/device mints tokens for any UUID device id: keep it much tighter than the rest.
    AUTH_RATE_LIMIT_PER_MIN: int = 10
    # Honour X-Real-IP / X-Forwarded-For only when a trusted reverse proxy (nginx) sets them.
    TRUST_PROXY: bool = False
    # Manual POST /prices/refresh calls are single-flight and at most one per cooldown.
    PRICE_REFRESH_COOLDOWN_S: int = 300
    # Request bodies above this are refused with 413 (nginx caps at 2 MB too; uvicorn does not).
    MAX_REQUEST_BODY_BYTES: int = 2 * 1024 * 1024

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @model_validator(mode="after")
    def _require_real_secret_in_prod(self) -> Settings:
        """ENV=prod refuses the shipped placeholder secrets: tokens would be forgeable with a public
        key and `pass_events.ip_hash` (keyed on JWT_SECRET) reversible over the IPv4 space."""
        if self.ENV == "prod":
            secret = self.JWT_SECRET
            weak = len(secret.encode()) < MIN_SECRET_BYTES or any(
                marker in secret.lower() for marker in _PLACEHOLDER_SECRET_MARKERS
            )
            if weak:
                raise ValueError(
                    "JWT_SECRET must be set to >= 32 random bytes when ENV=prod "
                    "(e.g. `openssl rand -hex 32`); the shipped placeholder is public and also "
                    "keys pass_events.ip_hash"
                )
        return self

    @property
    def is_sqlite(self) -> bool:
        return self.DATABASE_URL.startswith("sqlite")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
