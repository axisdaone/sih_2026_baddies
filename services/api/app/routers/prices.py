"""Prices: latest per mandi + refresh trigger (contract section 8). GET is public.

POST /prices/refresh needs a farmer token unless DEMO_MODE is on. It runs synchronously in
FastAPI's threadpool; the 5 s per-request timeouts + concurrent slices bound it to ~20 s, so
the service makes it single-flight with a PRICE_REFRESH_COOLDOWN_S cooldown between *attempts*
(a looped refresh cannot starve the threadpool or burn the shared data.gov.in key quota).
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.deps import DbDep, get_current_farmer, rate_limited
from app.enums import PriceSource
from app.prices.client import live_fetch_enabled
from app.prices.service import get_latest_prices, newest_meta, try_refresh_prices
from app.schemas import PriceRefreshResponse, PricesResponse

router = APIRouter(
    prefix="/prices", tags=["prices"], dependencies=[Depends(rate_limited("prices"))]
)

_bearer = HTTPBearer(auto_error=False)


def _refresh_guard(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)], db: DbDep
) -> None:
    """Allow anyone in DEMO_MODE; otherwise require a valid farmer token (401)."""
    if get_settings().DEMO_MODE:
        return
    get_current_farmer(credentials, db)


@router.get("", response_model=PricesResponse)
def get_prices(
    db: DbDep, commodity: Annotated[str, Query(min_length=1, max_length=64)] = "Tomato"
) -> PricesResponse:
    """Latest price per mandi for `commodity` with {source, fetched_at, stale} provenance."""
    return get_latest_prices(db, commodity)


@router.post(
    "/refresh",
    response_model=PriceRefreshResponse,
    dependencies=[Depends(_refresh_guard), Depends(rate_limited("refresh"))],
)
def refresh(db: DbDep) -> PriceRefreshResponse:
    """Poll Agmarknet now (demo); falls back to cache/snapshot, never errors.

    `status: "skipped"` also covers a refresh already in flight or one attempted less than
    PRICE_REFRESH_COOLDOWN_S ago (no network call is made in either case)."""
    live = live_fetch_enabled()
    result = try_refresh_prices(db, live=live)
    meta = newest_meta(db)
    status: Literal["ok", "failed", "skipped"]
    if result is None:
        return PriceRefreshResponse(
            status="skipped",
            source=meta.source,
            fetched_at=meta.fetched_at,
            stale=meta.stale,
            rows=0,
            fetched=0,
            inserted=0,
            updated=0,
            error=None,
        )
    if not result.live_attempted:
        status = "skipped"
    elif result.source == PriceSource.AGMARKNET_LIVE:
        status = "ok"
    else:
        status = "failed"
    return PriceRefreshResponse(
        status=status,
        source=meta.source,
        fetched_at=meta.fetched_at,
        stale=meta.stale,
        rows=result.inserted + result.updated,
        fetched=result.fetched,
        inserted=result.inserted,
        updated=result.updated,
        error=result.error,
    )
