from __future__ import annotations

from typing import Any

from pydantic import Field

from app.enums import SyncOpKind, SyncOpStatus
from app.schemas.batch import BatchOut
from app.schemas.common import ApiModel, UtcDatetime, UuidStr
from app.schemas.reading import ReadingOut


class SyncOpIn(ApiModel):
    op_id: UuidStr
    client_seq: int = Field(ge=0)
    kind: SyncOpKind
    payload: dict[str, Any]  # BatchCreate | BatchPatch(+id) | ReadingCreate, validated per kind
    client_time: UtcDatetime


class SyncRequest(ApiModel):
    device_id: str = Field(min_length=8, max_length=128)
    client_now: UtcDatetime
    ops: list[SyncOpIn] = []


class SyncResult(ApiModel):
    op_id: str
    status: SyncOpStatus
    error: str | None = None
    entity: BatchOut | ReadingOut | None = None
    clock_adjusted: bool = False


class SyncResponse(ApiModel):
    server_now: UtcDatetime
    clock_skew_seconds: float
    results: list[SyncResult] = []
    batches: list[BatchOut] = []
