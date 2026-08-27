from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import DEMO_DEVICE_ID, get_settings
from app.deps import rate_limiter
from app.security import create_token, decode_token
from tests.conftest import DEVICE_ID


def test_device_login_roundtrip(client: TestClient, auth_headers: dict[str, str]) -> None:
    me = client.get("/api/v1/auth/me", headers=auth_headers)
    assert me.status_code == 200
    body = me.json()
    assert body["device_id"] == DEVICE_ID
    assert body["display_name"] == "Test Farmer"
    assert body["created_at"].endswith("Z")

    # Same device logs in again -> same farmer id (idempotent).
    again = client.post("/api/v1/auth/device", json={"device_id": DEVICE_ID})
    assert again.status_code == 200
    assert again.json()["farmer_id"] == body["id"]


def test_token_claims_roundtrip() -> None:
    token = create_token("farmer-1", "device-abc")
    claims = decode_token(token)
    assert claims.farmer_id == "farmer-1"
    assert claims.device_id == "device-abc"
    assert claims.expires_at - claims.issued_at == timedelta(days=30)


def test_expired_token_rejected() -> None:
    token = create_token("f", "d", now=datetime.now(UTC) - timedelta(days=31))
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_token(token)


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": "Basic abc"},
    ],
)
def test_bad_or_missing_token_401(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/api/v1/auth/me", headers=headers)
    assert response.status_code == 401


def test_token_for_unknown_farmer_401(client: TestClient) -> None:
    token = create_token("00000000-0000-4000-8000-000000000000", "ghost-device")
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_token_signed_with_other_secret_401(client: TestClient) -> None:
    forged = jwt.encode(
        {"sub": "x", "did": "y", "iat": 0, "exp": 2_000_000_000}, "wrong-" * 8, algorithm="HS256"
    )
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {forged}"})
    assert response.status_code == 401


@pytest.mark.parametrize(
    "device_id",
    ["junk-000001", "test-device-0001", "not a uuid at all", "0f3c1a2b-5d6e-4f70-8a9b"],
)
def test_non_uuid_device_id_is_422(client: TestClient, device_id: str) -> None:
    """The device id is the credential: only UUIDs (or the demo constant) can mint a token."""
    response = client.post("/api/v1/auth/device", json={"device_id": device_id})
    assert response.status_code == 422, response.text


def test_demo_identity_is_403_when_demo_mode_is_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Farmer

    monkeypatch.setattr(get_settings(), "DEMO_MODE", False)
    with SessionLocal() as db:
        before = db.scalar(select(Farmer).where(Farmer.device_id == DEMO_DEVICE_ID))
        name_before = None if before is None else before.display_name
    pwned = client.post(
        "/api/v1/auth/device", json={"device_id": DEMO_DEVICE_ID, "display_name": "pwned"}
    )
    assert pwned.status_code == 403, pwned.text
    with SessionLocal() as db:
        after = db.scalar(select(Farmer).where(Farmer.device_id == DEMO_DEVICE_ID))
    # Neither created nor renamed.
    assert (after is None) == (before is None)
    if after is not None:
        assert after.display_name == name_before
    ok = client.post("/api/v1/auth/device", json={"device_id": str(uuid.uuid4())})
    assert ok.status_code == 200, ok.text


def test_demo_identity_mints_a_token_in_demo_mode(client: TestClient) -> None:
    assert get_settings().DEMO_MODE is True
    response = client.post("/api/v1/auth/device", json={"device_id": DEMO_DEVICE_ID})
    assert response.status_code == 200, response.text


def test_device_login_has_its_own_tight_rate_limit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "AUTH_RATE_LIMIT_PER_MIN", 2)
    rate_limiter.reset()
    body = {"device_id": str(uuid.uuid4())}
    assert client.post("/api/v1/auth/device", json=body).status_code == 200
    assert client.post("/api/v1/auth/device", json=body).status_code == 200
    blocked = client.post("/api/v1/auth/device", json=body)
    assert blocked.status_code == 429
    assert "retry-after" in blocked.headers
    # The auth bucket is separate from the public ones and from the general limit.
    assert client.get("/api/v1/protocols").status_code == 200
