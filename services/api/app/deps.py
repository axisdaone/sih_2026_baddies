"""FastAPI dependencies: DB session, current farmer (Bearer JWT), public rate limiter."""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import session_scope
from app.models import Farmer
from app.security import decode_token


def get_db() -> Iterator[Session]:
    """Request-scoped SQLAlchemy session."""
    yield from session_scope()


DbDep = Annotated[Session, Depends(get_db)]

_bearer = HTTPBearer(auto_error=False)


def get_current_farmer(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: DbDep,
) -> Farmer:
    """Resolve `Authorization: Bearer <jwt>` to a Farmer row; 401 on any failure."""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized("missing bearer token")
    try:
        claims = decode_token(credentials.credentials)
    except jwt.InvalidTokenError as exc:
        raise _unauthorized(f"invalid token: {exc}") from exc
    farmer = db.get(Farmer, claims.farmer_id)
    if farmer is None or farmer.device_id != claims.device_id:
        raise _unauthorized("unknown farmer/device")
    return farmer


CurrentFarmer = Annotated[Farmer, Depends(get_current_farmer)]


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


# --------------------------------------------------------------------------------------
# Rate limiting (in-memory sliding window; per process — fine for a single-VPS demo)
# --------------------------------------------------------------------------------------


class SlidingWindowRateLimiter:
    """Allows at most `limit` hits per `window_s` seconds per key."""

    def __init__(self, window_s: float = 60.0) -> None:
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, now: float | None = None) -> tuple[bool, float]:
        """Record a hit; return (allowed, retry_after_seconds)."""
        ts = time.monotonic() if now is None else now
        cutoff = ts - self.window_s
        with self._lock:
            bucket = self._hits.setdefault(key, deque())
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                return False, max(0.0, bucket[0] + self.window_s - ts)
            bucket.append(ts)
            return True, 0.0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rate_limiter = SlidingWindowRateLimiter()


def client_ip(request: Request) -> str:
    """Client IP, honouring the first X-Forwarded-For hop (nginx in front)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limited(key: str = "public") -> Callable[[Request], None]:
    """Dependency factory: `dependencies=[Depends(rate_limited("public"))]`.

    Limit is RATE_LIMIT_PER_MIN per client IP per key; returns HTTP 429 with Retry-After.
    """

    def dependency(request: Request) -> None:
        limit = get_settings().RATE_LIMIT_PER_MIN
        allowed, retry_after = rate_limiter.check(f"{key}:{client_ip(request)}", limit)
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="rate limit exceeded",
                headers={"Retry-After": str(int(retry_after) + 1)},
            )

    return dependency
