"""Batch use-cases: idempotent create, LWW patch, farmer-scoped reads, wire-view assembly."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.enums import BatchStatus
from app.kinetics.engine import evaluate
from app.kinetics.registry import get_protocol, load_protocols
from app.models import Batch, Farmer, Reading, utcnow
from app.quality_pass.chain import stored_chain_head
from app.schemas import BatchCreate, BatchOut, BatchPatch, ReadingOut, ShelfLifeEstimate
from app.services import ConflictError, InvalidRequestError, NotFoundError
from app.services.geo import origin_geohash

# Uniform 409 detail for a client id that belongs to someone / something else.
ID_IN_USE = "id already in use"


def upsert_batch(db: Session, farmer: Farmer, body: BatchCreate) -> tuple[Batch, bool]:
    """Create the batch or return the existing one (same id, same farmer).

    Returns `(batch, created)`. The same id owned by another farmer is a 409: client ids are
    UUID v4 so a collision means a replayed/forged payload, never a legitimate create.
    """
    existing = db.get(Batch, body.id)
    if existing is not None:
        return _owned(existing, farmer), False
    if body.protocol_id not in load_protocols():
        raise InvalidRequestError(f"unknown protocol_id {body.protocol_id!r}")

    batch = Batch(
        id=body.id,
        farmer_id=farmer.id,
        crop=str(body.crop),
        protocol_id=body.protocol_id,
        qty_kg=body.qty_kg,
        harvested_at=body.harvested_at,
        origin_lat=body.origin_lat,
        origin_lon=body.origin_lon,
        origin_geohash=origin_geohash(body.origin_lat, body.origin_lon),
        status=BatchStatus.OPEN.value,
        notes=body.notes,
        client_seq=body.client_seq,
        client_created_at=body.client_created_at,
    )
    db.add(batch)
    try:
        db.commit()
    except IntegrityError:
        # Lost a race with a concurrent identical create: fall back to the stored row.
        db.rollback()
        existing = db.get(Batch, body.id)
        if existing is None:  # pragma: no cover - FK/other constraint, not the id race
            raise
        return _owned(existing, farmer), False
    return batch, True


def patch_batch(db: Session, farmer: Farmer, batch_id: str, body: BatchPatch) -> Batch:
    """Last-writer-wins by `client_seq`: a patch older than the stored seq is ignored (the
    current row is still returned). Only fields explicitly present in the request are applied,
    so `{"notes": null}` clears notes while an absent `notes` leaves them alone.
    """
    batch = get_batch_for_farmer(db, farmer, batch_id)
    if body.client_seq < batch.client_seq:
        return batch
    provided = body.model_fields_set
    if "status" in provided and body.status is not None:
        batch.status = str(body.status)
    if "notes" in provided:
        batch.notes = body.notes
    if "qty_kg" in provided and body.qty_kg is not None:
        batch.qty_kg = body.qty_kg
    batch.client_seq = body.client_seq
    batch.updated_at = utcnow()
    db.commit()
    return batch


def get_batch_for_farmer(db: Session, farmer: Farmer, batch_id: str) -> Batch:
    """The farmer's live batch or 404 (also for other farmers' ids — no id leakage)."""
    batch = db.get(Batch, batch_id)
    if batch is None or batch.deleted_at is not None:
        raise NotFoundError("batch not found")
    return _owned(batch, farmer, status_code=404)


def list_batches(db: Session, farmer: Farmer) -> list[Batch]:
    stmt = (
        select(Batch)
        .where(Batch.farmer_id == farmer.id, Batch.deleted_at.is_(None))
        .order_by(Batch.harvested_at.desc(), Batch.created_at.desc())
    )
    return list(db.scalars(stmt).all())


def readings_for(db: Session, batch_id: str) -> list[Reading]:
    """Readings ordered by seq — always a fresh query (the relationship may be stale)."""
    stmt = select(Reading).where(Reading.batch_id == batch_id).order_by(Reading.seq)
    return list(db.scalars(stmt).all())


def readings_by_batch(db: Session, batch_ids: Iterable[str]) -> dict[str, list[Reading]]:
    ids = list(batch_ids)
    grouped: dict[str, list[Reading]] = {batch_id: [] for batch_id in ids}
    if not ids:
        return grouped
    stmt = (
        select(Reading)
        .where(Reading.batch_id.in_(ids))
        .order_by(Reading.batch_id, Reading.seq)
    )
    for reading in db.scalars(stmt):
        grouped.setdefault(reading.batch_id, []).append(reading)
    return grouped


def shelf_life_for(
    batch: Batch, readings: Sequence[Reading], now: datetime | None = None
) -> ShelfLifeEstimate:
    """Server-authoritative evaluation of a batch at `now` (default: UTC now)."""
    return evaluate(
        get_protocol(batch.protocol_id),
        batch.harvested_at,
        readings,
        utcnow() if now is None else now,
    )


def build_batch_out(
    db: Session,
    batch: Batch,
    *,
    include_readings: bool = True,
    include_shelf_life: bool = True,
    readings: Sequence[Reading] | None = None,
    now: datetime | None = None,
) -> BatchOut:
    """Wire view of a batch. `chain_head` is always filled (readings are loaded anyway)."""
    rows = readings_for(db, batch.id) if readings is None else list(readings)
    out = BatchOut.model_validate(batch)
    out.chain_head = stored_chain_head(rows)
    # model_validate picks up the ORM relationship; only embed readings when asked.
    out.readings = [ReadingOut.model_validate(r) for r in rows] if include_readings else None
    if include_shelf_life:
        out.shelf_life = shelf_life_for(batch, rows, now)
    return out


def build_batch_outs(
    db: Session,
    batches: Sequence[Batch],
    *,
    include_readings: bool = False,
    include_shelf_life: bool = True,
    now: datetime | None = None,
) -> list[BatchOut]:
    """Same as `build_batch_out` for many batches with a single readings query."""
    grouped = readings_by_batch(db, (b.id for b in batches))
    at = utcnow() if now is None else now
    return [
        build_batch_out(
            db,
            batch,
            include_readings=include_readings,
            include_shelf_life=include_shelf_life,
            readings=grouped.get(batch.id, []),
            now=at,
        )
        for batch in batches
    ]


def _owned(batch: Batch, farmer: Farmer, status_code: int = 409) -> Batch:
    if batch.farmer_id != farmer.id:
        if status_code == 404:
            raise NotFoundError("batch not found")
        # Neutral wording (same as the reading branch): no ownership oracle for foreign ids.
        raise ConflictError(ID_IN_USE)
    return batch
