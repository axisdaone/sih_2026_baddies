from __future__ import annotations

from app.enums import BatchStatus, ReadingSource
from app.schemas.common import ApiModel, UtcDatetime
from app.schemas.shelf_life import ShelfLifeEstimate


class PassReading(ApiModel):
    """One timeline row on the public page; `hash` is a 12-hex display prefix."""

    seq: int
    temp_c: float
    taken_at: UtcDatetime
    source: ReadingSource
    hash: str


class QualityPassPayload(ApiModel):
    """Public batch view: no farmer identity beyond an opted-in display_name, no exact origin."""

    batch_id: str
    crop: str
    protocol_id: str
    protocol_name: str
    qty_kg: float
    harvested_at: UtcDatetime
    status: BatchStatus
    origin_geohash: str | None = None  # precision 4 (~20 km cell), never the exact origin
    region: str | None = None  # coarse label ("Dharmapuri belt") or null
    display_name: str | None = None
    readings: list[PassReading] = []
    shelf_life: ShelfLifeEstimate | None = None
    chain_head: str | None = None
    chain_length: int = 0
    chain_valid: bool = True  # recomputed from the stored readings on every request
    generated_at: UtcDatetime
    simulated: bool = False  # any reading with source "sim" -> UI shows the SIMULATED chip
    pass_url: str
    verify_url: str


class QualityPassVerify(ApiModel):
    valid: bool
    chain_head: str | None = None  # recomputed head (differs from the stored one when tampered)
    length: int = 0
    first_bad_seq: int | None = None
    head_matches: bool = False  # the caller's `head` (>= 16 hex) is a prefix of chain_head
