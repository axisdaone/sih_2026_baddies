"""Settings guards: ENV=prod refuses placeholder / short JWT secrets (config.py)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings

HEX_64 = "9f" * 32  # what `openssl rand -hex 32` produces


def _settings(**overrides: object) -> Settings:
    # `_env_file=None`: never read a developer's .env; explicit kwargs override the test env.
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "secret",
    [
        "farmsignal-dev-secret-change-me-before-deploying-0000",  # config.py default
        "farmsignal-dev-secret-change-me",  # infra/docker-compose.yml fallback (31 bytes)
        "change-me-in-prod-use-at-least-32-random-bytes",  # .env.example
        "CHANGEME" * 5,
        "put-your-secret-here-and-make-it-long-enough",
        "short-but-random-3f9a1c",  # < 32 bytes
    ],
)
def test_prod_rejects_placeholder_or_short_secret(secret: str) -> None:
    with pytest.raises(ValidationError, match="JWT_SECRET must be set"):
        _settings(ENV="prod", JWT_SECRET=secret)


def test_prod_accepts_a_real_secret() -> None:
    settings = _settings(ENV="prod", JWT_SECRET=HEX_64)
    assert settings.JWT_SECRET == HEX_64
    assert len(settings.JWT_SECRET.encode()) >= 32


@pytest.mark.parametrize("env", ["dev", "test"])
def test_non_prod_tolerates_the_placeholder(env: str) -> None:
    settings = _settings(ENV=env, JWT_SECRET="farmsignal-dev-secret-change-me")
    assert settings.ENV == env


def test_new_settings_have_safe_defaults() -> None:
    settings = _settings(ENV="dev")
    assert settings.TRUST_PROXY is False  # never trust client-controlled proxy headers by default
    # `?reset=true` is off until an operator sets the token (conftest sets one for the suite).
    assert Settings.model_fields["DEMO_ADMIN_TOKEN"].default is None
    fields = Settings.model_fields
    assert fields["AUTH_RATE_LIMIT_PER_MIN"].default < fields["RATE_LIMIT_PER_MIN"].default
    assert settings.PRICE_REFRESH_COOLDOWN_S >= 60
    assert settings.MAX_REQUEST_BODY_BYTES == 2 * 1024 * 1024  # == nginx client_max_body_size
