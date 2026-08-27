"""FastAPI dependencies: DB session, current farmer (Bearer JWT), rate limiters, demo gate."""

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
    """Resolve `Authorization: Bearer <jwt>` to a Farmer row; 401 on any failure.

    The detail is deliberately coarse (`expired` vs `invalid`): enough for the PWA's 401
    handling, without echoing PyJWT internals.
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized("missing bearer token")
    try:
        claims = decode_token(credentials.credentials)
    except jwt.ExpiredSignatureError as exc:
        raise _unauthorized("token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise _unauthorized("invalid token") from exc
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


def require_demo_mode() -> None:
    """403 unless DEMO_MODE is on (demo seed/scenarios, telemetry simulator)."""
    if not get_settings().DEMO_MODE:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "demo mode is disabled")


# --------------------------------------------------------------------------------------
# Rate limiting (in-memory sliding window; per process — fine for a single-VPS demo)
# --------------------------------------------------------------------------------------

# Bound the per-key table: sweep expired keys periodically, and evict the oldest-inserted ones
# when a flood of distinct keys (spoofed addresses) would otherwise grow it without limit.
SWEEP_EVERY_CHECKS = 1000
MAX_TRACKED_KEYS = 10_000


class SlidingWindowRateLimiter:
    """Allows at most `limit` hits per `window_s` seconds per key."""

    def __init__(
        self,
        window_s: float = 60.0,
        *,
        max_keys: int = MAX_TRACKED_KEYS,
        sweep_every: int = SWEEP_EVERY_CHECKS,
    ) -> None:
        self.window_s = window_s
        self.max_keys = max_keys
        self.sweep_every = sweep_every
        # dict keeps insertion order, which is the eviction order when the table is full.
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self._checks = 0

    def check(self, key: str, limit: int, now: float | None = None) -> tuple[bool, float]:
        """Record a hit; return (allowed, retry_after_seconds)."""
        ts = time.monotonic() if now is None else now
        cutoff = ts - self.window_s
        with self._lock:
            self._checks += 1
            if self._checks % self.sweep_every == 0:
                self._sweep(cutoff)
            bucket = self._hits.get(key)
            if bucket is None:
                if len(self._hits) >= self.max_keys:
                    self._sweep(cutoff)
                    while len(self._hits) >= self.max_keys:
                        self._hits.pop(next(iter(self._hits)))
                bucket = deque()
                self._hits[key] = bucket
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                return False, max(0.0, bucket[0] + self.window_s - ts)
            bucket.append(ts)
            return True, 0.0

    def _sweep(self, cutoff: float) -> None:
        """Drop every key whose newest hit is outside the window (caller holds the lock)."""
        expired = [key for key, bucket in self._hits.items() if not bucket or bucket[-1] <= cutoff]
        for key in expired:
            del self._hits[key]

    @property
    def tracked_keys(self) -> int:
        with self._lock:
            return len(self._hits)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
            self._checks = 0


rate_limiter = SlidingWindowRateLimiter()


def client_ip(request: Request) -> str:
    """Client IP for rate limiting / pass-event hashing.

    Proxy headers are honoured only when `TRUST_PROXY` is on (nginx in front sets
    `X-Real-IP` to its `$remote_addr` and *appends* to `X-Forwarded-For`). Then `X-Real-IP`
    wins and the fallback is the LAST `X-Forwarded-For` hop — the one the trusted proxy added.
    The first hop is client-controlled and would make the limit trivially bypassable.
    """
    peer = request.client.host if request.client else "unknown"
    if not get_settings().TRUST_PROXY:
        return peer
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    forwarded = request.headers.get("x-forwarded-for", "")
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    return hops[-1] if hops else peer


LimitSpec = int | Callable[[], int] | None


def _resolve_limit(limit: LimitSpec) -> int:
    if limit is None:
        return get_settings().RATE_LIMIT_PER_MIN
    return limit() if callable(limit) else limit


def _check_or_429(bucket_key: str, limit: LimitSpec) -> None:
    allowed, retry_after = rate_limiter.check(bucket_key, _resolve_limit(limit))
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="rate limit exceeded",
            headers={"Retry-After": str(int(retry_after) + 1)},
        )


def rate_limited(key: str = "public", limit: LimitSpec = None) -> Callable[[Request], None]:
    """Dependency factory: `dependencies=[Depends(rate_limited("quality_pass"))]`.

    Per client IP per `key`; `limit` defaults to RATE_LIMIT_PER_MIN and may be an int or a
    zero-arg callable resolved per request (so settings can be monkeypatched in tests).
    Returns HTTP 429 with Retry-After when exceeded.
    """

    def dependency(request: Request) -> None:
        _check_or_429(f"{key}:{client_ip(request)}", limit)

    return dependency


def farmer_rate_limited(key: str = "farmer", limit: LimitSpec = None) -> Callable[[Farmer], None]:
    """Like `rate_limited` but keyed on the authenticated farmer (NAT-shared IPs are irrelevant
    for authenticated routes; what we bound is per-tenant write/compute volume)."""

    def dependency(farmer: CurrentFarmer) -> None:
        _check_or_429(f"{key}:farmer:{farmer.id}", limit)

    return dependency
