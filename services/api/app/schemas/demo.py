from __future__ import annotations

from app.schemas.common import ApiModel


class DemoSeedResponse(ApiModel):
    farmer_id: str
    device_id: str
    token: str
    batch_ids: list[str] = []
    created: bool  # False when the seed already existed (idempotent)
