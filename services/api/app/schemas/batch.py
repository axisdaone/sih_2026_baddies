from __future__ import annotations

from pydantic import Field

from app.enums import BatchStatus, Crop
from app.schemas.common import ApiModel, UtcDatetime, UuidStr
from app.schemas.reading import ReadingOut
from app.schemas.shelf_life import ShelfLifeEstimate


class BatchCreate(ApiModel):
    """Client payload (client-generated `id`; idempotent, contract section 6.1)."""

    id: UuidStr
    crop: Crop
    protocol_id: str = Field(min_length=1, max_length=64)
    qty_kg: float = Field(gt=0)
    harvested_at: UtcDatetime
    origin_lat: float | None = Field(default=None, ge=-90, le=90)
    origin_lon: float | None = Field(default=None, ge=-180, le=180)
    notes: str | None = Field(default=None, max_length=2000)
    client_seq: int = Field(ge=0)
    client_created_at: UtcDatetime


class BatchPatch(ApiModel):
    """PATCH /batches/{id}: last-writer-wins per field, ordered by client_seq."""

    status: BatchStatus | None = None
    notes: str | None = Field(default=None, max_length=2000)
    qty_kg: float | None = Field(default=None, gt=0)
    client_seq: int = Field(ge=0)


class BatchOut(BatchCreate):
    """Server view (`Batch` on the wire)."""

    farmer_id: str
    status: BatchStatus
    origin_geohash: str | None = None
    client_created_at: UtcDatetime | None = None  # type: ignore[assignment]
    created_at: UtcDatetime
    updated_at: UtcDatetime
    shelf_life: ShelfLifeEstimate | None = None
    readings: list[ReadingOut] | None = None
    chain_head: str | None = None
