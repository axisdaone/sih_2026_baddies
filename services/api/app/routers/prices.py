"""Prices: latest per mandi + refresh trigger (contract section 8). Public. Bodies: PHASE2."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.deps import DbDep, rate_limited
from app.schemas import PriceRefreshResponse, PricesResponse

router = APIRouter(
    prefix="/prices", tags=["prices"], dependencies=[Depends(rate_limited("public"))]
)


@router.get("", response_model=PricesResponse)
def get_prices(
    db: DbDep, commodity: Annotated[str, Query(min_length=1, max_length=64)] = "Tomato"
) -> PricesResponse:
    """Latest price per mandi for `commodity` with {source, fetched_at, stale} provenance."""
    raise HTTPException(501, "PHASE2")


@router.post("/refresh", response_model=PriceRefreshResponse)
def refresh_prices(db: DbDep) -> PriceRefreshResponse:
    """Trigger an Agmarknet poll now (demo); falls back to cache/snapshot, never errors."""
    raise HTTPException(501, "PHASE2")
