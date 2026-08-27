"""JWT device tokens (HS256): sub = farmer_id, did = device_id, 30-day TTL (contract section 6)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

from app.config import get_settings

ALGORITHM = "HS256"


@dataclass(frozen=True, slots=True)
class TokenClaims:
    farmer_id: str
    device_id: str
    issued_at: datetime
    expires_at: datetime


def create_token(
    farmer_id: str,
    device_id: str,
    *,
    ttl_days: int | None = None,
    now: datetime | None = None,
) -> str:
    """Mint a signed token for a (farmer, device) pair."""
    settings = get_settings()
    issued = now or datetime.now(UTC)
    expires = issued + timedelta(days=ttl_days if ttl_days is not None else settings.JWT_TTL_DAYS)
    payload = {
        "sub": farmer_id,
        "did": device_id,
        "iat": int(issued.timestamp()),
        "exp": int(expires.timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=ALGORITHM)


def decode_token(token: str) -> TokenClaims:
    """Verify signature + expiry and return claims.

    Raises `jwt.InvalidTokenError` (any PyJWT error) on a bad/expired/malformed token.
    """
    settings = get_settings()
    payload = jwt.decode(
        token,
        settings.JWT_SECRET,
        algorithms=[ALGORITHM],
        options={"require": ["sub", "did", "exp", "iat"]},
    )
    sub, did = payload.get("sub"), payload.get("did")
    if not isinstance(sub, str) or not isinstance(did, str):
        raise jwt.InvalidTokenError("sub/did must be strings")
    return TokenClaims(
        farmer_id=sub,
        device_id=did,
        issued_at=datetime.fromtimestamp(int(payload["iat"]), tz=UTC),
        expires_at=datetime.fromtimestamp(int(payload["exp"]), tz=UTC),
    )
