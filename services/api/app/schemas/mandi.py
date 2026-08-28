from __future__ import annotations

from app.schemas.common import ApiModel


class MandiOut(ApiModel):
    id: str
    name: str
    state: str
    district: str
    lat: float
    lon: float
    agmarknet_market: str
    agmarknet_state: str
    agmarknet_district: str
