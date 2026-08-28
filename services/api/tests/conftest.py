"""Shared fixtures. The DB env override MUST happen before any `app.*` import."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

# Fresh throw-away SQLite file for the whole session; set before importing app.
_TMP_DIR = Path(tempfile.mkdtemp(prefix="farmsignal-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP_DIR / 'test.db').as_posix()}"
os.environ["ENV"] = "test"
os.environ["JWT_SECRET"] = "test-secret-" + "x" * 32
os.environ["RATE_LIMIT_PER_MIN"] = "1000"
os.environ["AUTH_RATE_LIMIT_PER_MIN"] = "1000"
os.environ["DEMO_ADMIN_TOKEN"] = "test-demo-admin-token"

from fastapi.testclient import TestClient  # noqa: E402

from app.deps import rate_limiter  # noqa: E402
from app.main import app  # noqa: E402
from app.prices.service import reset_refresh_throttle  # noqa: E402

# Device ids are UUID v4 on the wire (contract line 8); fixed here so re-logins are idempotent.
DEVICE_ID = "0f3c1a2b-5d6e-4f70-8a9b-0c1d2e3f4a01"
DEMO_ADMIN_HEADERS = {"X-Demo-Admin-Token": "test-demo-admin-token"}


@pytest.fixture(scope="session")
def client() -> Iterator[TestClient]:
    """App client with lifespan (create_all + seeding) run once per session."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _reset_rate_limiter() -> Iterator[None]:
    rate_limiter.reset()
    reset_refresh_throttle()
    yield


@pytest.fixture(scope="session")
def auth_headers(client: TestClient) -> dict[str, str]:
    """Bearer headers for a farmer registered via POST /auth/device."""
    response = client.post(
        "/api/v1/auth/device",
        json={"device_id": DEVICE_ID, "display_name": "Test Farmer", "locale": "en"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}
