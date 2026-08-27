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

from fastapi.testclient import TestClient  # noqa: E402

from app.deps import rate_limiter  # noqa: E402
from app.main import app  # noqa: E402

DEVICE_ID = "test-device-0001"


@pytest.fixture(scope="session")
def client() -> Iterator[TestClient]:
    """App client with lifespan (create_all + seeding) run once per session."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _reset_rate_limiter() -> Iterator[None]:
    rate_limiter.reset()
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
