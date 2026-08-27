from __future__ import annotations

from app.enums import BatchStatus, ReadingSource
from app.schemas.common import ApiModel, UtcDatetime
from app.schemas.shelf_life import ShelfLifeEstimate


class PassReading(ApiModel):
    seq: int
    temp_c: float
    taken_at: UtcDatetime
    source: ReadingSource
    hash: str


class QualityPassPayload(ApiModel):
    """Public batch view: no farmer identity beyond an opted-in display_name."""

    batch_id: str
    crop: str
    protocol_id: str
    protocol_name: str
    qty_kg: float
    harvested_at: UtcDatetime
    status: BatchStatus
    display_name: str | None = None
    readings: list[PassReading] = []
    shelf_life: ShelfLifeEstimate | None = None
    chain_head: str | None = None
    chain_length: int = 0
    verify_url: str
    simulated: bool = False


class QualityPassVerify(ApiModel):
    valid: bool
    chain_head: str | None = None
    length: int = 0
    first_bad_seq: int | None = None
