"""Application settings (pydantic-settings). Values come from env vars / `.env`.

`get_settings()` is cached; tests override env *before* importing `app.*`.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# services/api/app/config.py -> parents[3] is the repo root (…/farmsignal)
REPO_ROOT = Path(__file__).resolve().parents[3]

# data.gov.in public sample key (rate-limited, fine for demo)
DEFAULT_AGMARKNET_KEY = "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b"
DEFAULT_AGMARKNET_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"


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
    DATA_DIR: Path = Field(default=REPO_ROOT / "data")

    # Comma-separated in env (NoDecode disables pydantic-settings' JSON parsing).
    CORS_ORIGINS: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    RATE_LIMIT_PER_MIN: int = 60

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @property
    def is_sqlite(self) -> bool:
        return self.DATABASE_URL.startswith("sqlite")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
