from __future__ import annotations

from typing import Literal

from app.schemas.common import ApiModel
from app.schemas.price import PriceMeta


class HealthResponse(ApiModel):
    status: Literal["ok", "degraded"]
    version: str
    db: Literal["ok", "error"]
    prices: PriceMeta
