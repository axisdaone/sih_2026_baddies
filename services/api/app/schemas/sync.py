from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from app.enums import ShelfLifeStatus, SyncOpKind, SyncOpStatus
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


class AlertEvent(ApiModel):
    """A shelf-life threshold crossing (PRD F6). `message_key` doubles as the voice-clip key."""

    threshold: Literal[75, 50, 25] | None  # None for the `sell_now` event
    status: ShelfLifeStatus
    message_key: str  # alert_75 | alert_50 | alert_25 | sell_now


class BatchAlert(AlertEvent):
    batch_id: str


class SyncResponse(ApiModel):
    server_now: UtcDatetime
    clock_skew_seconds: float
    results: list[SyncResult] = []
    batches: list[BatchOut] = []
    # Server-side view of F6 for every open batch of this farmer (computed from `batches`).
    alerts: list[BatchAlert] = []
