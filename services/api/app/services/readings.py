"""Reading use-cases: append-only, hash-chained, idempotent on the client id."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.kinetics.engine import round_half_up
from app.models import Batch, Reading
from app.quality_pass.chain import canonical_payload, genesis_hash, reading_hash
from app.schemas import ReadingCreate
from app.services import ConflictError, InvalidRequestError
from app.services.batches import ID_IN_USE, readings_for

# Seq assignment races only on the unique(batch_id, seq) constraint; retry a couple of times.
_SEQ_ATTEMPTS = 3


def append_reading(db: Session, batch: Batch, body: ReadingCreate) -> tuple[Reading, bool]:
    """Append `body` to `batch`'s chain. Returns `(reading, created)`.

    * Idempotent: an existing reading id returns the stored row unchanged (`created=False`);
      readings are never updated.
    * `seq` = max(seq) + 1 for the batch, assigned inside the insert transaction.
    * `temp_c` is rounded to 1 dp (half-up, identical to JS `Math.round(x*10)/10`) *before*
      hashing so client and server hash the same number; a negative zero (e.g. from -0.04)
      is normalised to `0.0` so the stored value and the canonical form agree with TS.
    * Nothing else is triggered — recommendations are computed on demand by their router.
    """
    if body.batch_id != batch.id:
        raise InvalidRequestError("payload batch_id does not match the batch in the path")
    existing = db.get(Reading, body.id)
    if existing is not None:
        return _same_batch(existing, batch), False

    temp_c = round_half_up(body.temp_c, 1) + 0.0  # `+ 0.0`: -0.0 -> 0.0 (TS renders '0.0')
    for _attempt in range(_SEQ_ATTEMPTS):
        last = db.scalar(
            select(Reading)
            .where(Reading.batch_id == batch.id)
            .order_by(Reading.seq.desc())
            .limit(1)
        )
        seq = 1 if last is None else last.seq + 1
        prev_hash = genesis_hash(batch.id) if last is None else last.hash
        payload = canonical_payload(
            batch_id=batch.id,
            reading_id=body.id,
            seq=seq,
            temp_c=temp_c,
            taken_at=body.taken_at,
            source=str(body.source),
            geohash=body.geohash,
        )
        reading = Reading(
            id=body.id,
            batch_id=batch.id,
            temp_c=temp_c,
            taken_at=body.taken_at,
            source=str(body.source),
            geohash=body.geohash,
            seq=seq,
            client_seq=body.client_seq,
            hash=reading_hash(prev_hash, payload),
            prev_hash=prev_hash,
        )
        db.add(reading)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.get(Reading, body.id)
            if existing is not None:  # concurrent replay of the same reading
                return _same_batch(existing, batch), False
            continue  # lost the seq race; recompute from the new tail
        return reading, True
    raise ConflictError("could not assign a reading sequence number; retry")


def list_readings(db: Session, batch: Batch) -> list[Reading]:
    """Ordered by seq ascending."""
    return readings_for(db, batch.id)


def _same_batch(existing: Reading, batch: Batch) -> Reading:
    if existing.batch_id != batch.id:
        raise ConflictError(ID_IN_USE)
    return existing
