from __future__ import annotations

from datetime import date
from typing import Literal

from app.enums import PriceSource
from app.schemas.common import ApiModel, UtcDatetime


class PriceMeta(ApiModel):
    """Provenance block carried by every price response and by /health."""

    source: PriceSource = PriceSource.UNKNOWN
    fetched_at: UtcDatetime | None = None
    stale: bool = True


class MandiPriceOut(ApiModel):
    mandi_id: str
    commodity: str
    variety: str | None = None
    modal_price: float  # INR per quintal
    min_price: float | None = None
    max_price: float | None = None
    arrival_qty: float | None = None
    reported_on: date
    fetched_at: UtcDatetime
    source: PriceSource


class PricesResponse(PriceMeta):
    commodity: str
    prices: list[MandiPriceOut] = []


class PriceRefreshResponse(PriceMeta):
    status: Literal["ok", "failed", "skipped"]
    rows: int = 0
    error: str | None = None
