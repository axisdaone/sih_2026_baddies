from __future__ import annotations

from pydantic import Field

from app.enums import ReadingSource
from app.schemas.common import MAX_CLIENT_SEQ, ApiModel, UtcDatetime, UuidStr


class ReadingCreate(ApiModel):
    """Client payload (client-generated `id`, contract section 6.1)."""

    id: UuidStr
    batch_id: UuidStr
    temp_c: float = Field(ge=-50, le=80)
    taken_at: UtcDatetime
    source: ReadingSource
    geohash: str | None = Field(default=None, max_length=12)
    client_seq: int = Field(ge=0, le=MAX_CLIENT_SEQ)


class ReadingOut(ReadingCreate):
    """Server view: seq / hash chain fields assigned on accept."""

    seq: int
    hash: str
    prev_hash: str
    received_at: UtcDatetime
