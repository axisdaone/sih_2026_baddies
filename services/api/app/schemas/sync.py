from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator

from app.enums import ShelfLifeStatus, SyncOpKind, SyncOpStatus
from app.schemas.batch import BatchOut
from app.schemas.common import MAX_CLIENT_SEQ, ApiModel, UtcDatetime, UuidStr
from app.schemas.reading import ReadingOut

# Per-request work bound (contract section 7): the PWA drains its outbox in slices of this size
# (apps/web/src/sync/index.ts MAX_OPS_PER_REQUEST); every op costs a savepoint + commit + wire view.
MAX_OPS_PER_REQUEST = 200
# The widest per-kind payload (BatchCreate) has 10 keys; unknown keys are ignored, not stored.
MAX_PAYLOAD_KEYS = 32


class SyncOpIn(ApiModel):
    op_id: UuidStr
    client_seq: int = Field(ge=0, le=MAX_CLIENT_SEQ)
    kind: SyncOpKind
    payload: dict[str, Any]  # BatchCreate | BatchPatch(+id) | ReadingCreate, validated per kind
    client_time: UtcDatetime

    @field_validator("payload")
    @classmethod
    def _bounded_payload(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > MAX_PAYLOAD_KEYS:
            raise ValueError(f"payload has more than {MAX_PAYLOAD_KEYS} keys")
        return value


class SyncRequest(ApiModel):
    device_id: str = Field(min_length=8, max_length=128)
    client_now: UtcDatetime
    ops: list[SyncOpIn] = Field(default_factory=list, max_length=MAX_OPS_PER_REQUEST)


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
