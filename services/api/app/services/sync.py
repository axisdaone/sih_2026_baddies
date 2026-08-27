"""POST /sync applier (contract section 7): ordered, idempotent, skew-corrected outbox drain.

* Ops are applied in `client_seq` order (stable on request order for ties).
* `op_id` is deduped via `sync_ops`: an op already applied/duplicate is answered `duplicate`
  without touching the DB; an op previously *rejected* is re-attempted (the PWA re-sends failed
  ops, and a transient rejection must never become a permanent "done").
* Each op runs inside a SAVEPOINT; validation / domain errors become a per-op `rejected` result
  and never fail the whole request.
* Clock skew: `skew = client_now - server_now`; when |skew| > 120 s every `harvested_at`,
  `client_created_at` and `taken_at` in the request is shifted by `-skew` before it is applied
  and the result carries `clock_adjusted: true`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session, SessionTransaction

from app.alerts.thresholds import batch_alerts
from app.enums import SyncOpKind, SyncOpStatus
from app.models import Batch, Farmer, Reading, SyncOp, utcnow
from app.schemas import BatchCreate, BatchOut, BatchPatch, ReadingCreate, ReadingOut, is_uuid
from app.schemas.sync import SyncOpIn, SyncRequest, SyncResponse, SyncResult
from app.services import InvalidRequestError, NotFoundError, ServiceError
from app.services.batches import (
    build_batch_out,
    build_batch_outs,
    list_batches,
    patch_batch,
    upsert_batch,
)
from app.services.readings import append_reading

log = logging.getLogger(__name__)

SKEW_THRESHOLD_S = 120.0
BATCH_NOT_FOUND = "batch_not_found"
# Constant detail for unexpected failures: the class name is logged, never echoed to clients.
INTERNAL_ERROR = "internal error"


@dataclass(frozen=True, slots=True)
class OpOutcome:
    status: SyncOpStatus
    entity: BatchOut | ReadingOut | None = None
    error: str | None = None
    clock_adjusted: bool = False


def clock_skew_seconds(client_now: datetime, server_now: datetime) -> float:
    return (client_now - server_now).total_seconds()


def skew_shift(skew_seconds: float) -> timedelta | None:
    """The correction to add to client timestamps, or None when the clocks agree well enough."""
    if abs(skew_seconds) <= SKEW_THRESHOLD_S:
        return None
    return timedelta(seconds=-skew_seconds)


def apply_sync(
    db: Session, farmer: Farmer, body: SyncRequest, *, server_now: datetime | None = None
) -> SyncResponse:
    """Apply `body.ops` for `farmer` and return the full sync response (results + batches)."""
    now = utcnow() if server_now is None else server_now
    skew = clock_skew_seconds(body.client_now, now)
    shift = skew_shift(skew)

    ordered = sorted(enumerate(body.ops), key=lambda item: (item[1].client_seq, item[0]))
    results = [apply_op(db, farmer, op, body.device_id, shift) for _, op in ordered]

    batches = build_batch_outs(db, list_batches(db, farmer), include_readings=True)
    return SyncResponse(
        server_now=now,
        clock_skew_seconds=round(skew, 3),
        results=results,
        batches=batches,
        alerts=batch_alerts(batches),
    )


def apply_op(
    db: Session, farmer: Farmer, op: SyncOpIn, device_id: str, shift: timedelta | None
) -> SyncResult:
    """Dedupe, apply inside a savepoint, record the op; never raises for a bad op."""
    existing = db.get(SyncOp, op.op_id)
    if existing is not None and existing.status != SyncOpStatus.REJECTED:
        return SyncResult(
            op_id=op.op_id,
            status=SyncOpStatus.DUPLICATE,
            entity=_resolve_entity(db, farmer, op),
        )

    outcome = _apply_guarded(db, farmer, op, shift)
    _record(db, existing, op, device_id, outcome.status)
    return SyncResult(
        op_id=op.op_id,
        status=outcome.status,
        error=outcome.error,
        entity=outcome.entity,
        clock_adjusted=outcome.clock_adjusted,
    )


def _apply_guarded(db: Session, farmer: Farmer, op: SyncOpIn, shift: timedelta | None) -> OpOutcome:
    """Run one op inside a SAVEPOINT; any failure rolls back just that op and is reported.

    The savepoint is driven by hand (not as a context manager): the services commit the outer
    transaction themselves on success, which closes the savepoint, and the wire view is built
    afterwards on a fresh autobegun transaction.
    """
    nested = db.begin_nested()
    try:
        outcome = _dispatch(db, farmer, op, shift)
    except ValidationError as exc:
        _discard(db, nested)
        return OpOutcome(SyncOpStatus.REJECTED, error=_validation_message(exc))
    except ServiceError as exc:
        _discard(db, nested)
        return OpOutcome(SyncOpStatus.REJECTED, error=str(exc.detail))
    except Exception as exc:  # one broken op must not poison the rest of the drain
        log.exception("sync op %s (%s) failed: %s", op.op_id, op.kind, type(exc).__name__)
        _discard(db, nested)
        return OpOutcome(SyncOpStatus.REJECTED, error=INTERNAL_ERROR)
    if nested.is_active:  # the op made no commit of its own (e.g. a no-op duplicate)
        nested.commit()
    return outcome


def _discard(db: Session, nested: SessionTransaction) -> None:
    """Roll back to the savepoint (if still open) and clear any failed-flush state."""
    if nested.is_active:
        nested.rollback()
    if not db.is_active:
        db.rollback()


def _dispatch(db: Session, farmer: Farmer, op: SyncOpIn, shift: timedelta | None) -> OpOutcome:
    if op.kind == SyncOpKind.BATCH_CREATE:
        return _apply_batch_create(db, farmer, op.payload, shift)
    if op.kind == SyncOpKind.BATCH_UPDATE:
        return _apply_batch_update(db, farmer, op.payload)
    if op.kind == SyncOpKind.READING_APPEND:
        return _apply_reading_append(db, farmer, op.payload, shift)
    raise InvalidRequestError(f"unknown op kind {op.kind!r}")  # pragma: no cover - enum-validated


def _apply_batch_create(
    db: Session, farmer: Farmer, payload: dict[str, Any], shift: timedelta | None
) -> OpOutcome:
    body = BatchCreate.model_validate(payload)
    if shift is not None:
        body = body.model_copy(
            update={
                "harvested_at": body.harvested_at + shift,
                "client_created_at": body.client_created_at + shift,
            }
        )
    batch, created = upsert_batch(db, farmer, body)
    return OpOutcome(
        SyncOpStatus.APPLIED if created else SyncOpStatus.DUPLICATE,
        entity=build_batch_out(db, batch),
        clock_adjusted=created and shift is not None,
    )


def _apply_batch_update(db: Session, farmer: Farmer, payload: dict[str, Any]) -> OpOutcome:
    batch_id = payload.get("id")
    if not isinstance(batch_id, str) or not is_uuid(batch_id):
        raise InvalidRequestError("batch.update payload needs the batch `id`")
    patch = BatchPatch.model_validate(payload)  # `id` is ignored by the patch schema
    batch = patch_batch(db, farmer, batch_id, patch)
    return OpOutcome(SyncOpStatus.APPLIED, entity=build_batch_out(db, batch))


def _apply_reading_append(
    db: Session, farmer: Farmer, payload: dict[str, Any], shift: timedelta | None
) -> OpOutcome:
    body = ReadingCreate.model_validate(payload)
    if shift is not None:
        body = body.model_copy(update={"taken_at": body.taken_at + shift})
    batch = _owned_batch(db, farmer, body.batch_id)
    if batch is None:
        raise NotFoundError(BATCH_NOT_FOUND)
    reading, created = append_reading(db, batch, body)  # existing id -> stored row, untouched
    return OpOutcome(
        SyncOpStatus.APPLIED if created else SyncOpStatus.DUPLICATE,
        entity=ReadingOut.model_validate(reading),
        clock_adjusted=created and shift is not None,
    )


def _resolve_entity(db: Session, farmer: Farmer, op: SyncOpIn) -> BatchOut | ReadingOut | None:
    """Current state of the entity a duplicate op refers to (None when it cannot be resolved)."""
    entity_id = op.payload.get("id")
    if not isinstance(entity_id, str) or not is_uuid(entity_id):
        return None
    if op.kind == SyncOpKind.READING_APPEND:
        reading = db.get(Reading, entity_id)
        if reading is None or _owned_batch(db, farmer, reading.batch_id) is None:
            return None
        return ReadingOut.model_validate(reading)
    batch = _owned_batch(db, farmer, entity_id)
    return None if batch is None else build_batch_out(db, batch)


def _owned_batch(db: Session, farmer: Farmer, batch_id: str) -> Batch | None:
    batch = db.get(Batch, batch_id)
    if batch is None or batch.deleted_at is not None or batch.farmer_id != farmer.id:
        return None
    return batch


def _record(
    db: Session, existing: SyncOp | None, op: SyncOpIn, device_id: str, status: SyncOpStatus
) -> None:
    """Insert (or, for a re-attempted rejected op, update) the dedupe row."""
    if existing is None:
        db.add(
            SyncOp(
                op_id=op.op_id,
                device_id=device_id,
                client_seq=op.client_seq,
                kind=str(op.kind),
                status=str(status),
            )
        )
    else:
        existing.status = str(status)
        existing.client_seq = op.client_seq
        existing.received_at = utcnow()
    db.commit()


def _validation_message(exc: ValidationError, limit: int = 3) -> str:
    parts = [
        f"{'.'.join(str(p) for p in err['loc']) or 'payload'}: {err['msg']}"
        for err in exc.errors()[:limit]
    ]
    return "invalid payload: " + "; ".join(parts)
