from __future__ import annotations

from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient

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
