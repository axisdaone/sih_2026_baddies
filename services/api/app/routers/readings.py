"""Readings: append-only, hash-chained (contract section 4)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from app.deps import CurrentFarmer, DbDep, farmer_rate_limited
from app.schemas import ReadingCreate, ReadingOut
from app.services.batches import get_batch_for_farmer
from app.services.readings import append_reading as _append_reading
from app.services.readings import list_readings as _list_readings

router = APIRouter(
    prefix="/batches/{batch_id}/readings",
    tags=["readings"],
    dependencies=[Depends(farmer_rate_limited("farmer"))],
)


@router.post("", response_model=ReadingOut, status_code=201)
def append_reading(
    batch_id: str, body: ReadingCreate, farmer: CurrentFarmer, db: DbDep, response: Response
) -> ReadingOut:
    """Idempotent on client `id`; assigns seq/hash/prev_hash; returns 200 on duplicate."""
    batch = get_batch_for_farmer(db, farmer, batch_id)
    reading, created = _append_reading(db, batch, body)
    if not created:
        response.status_code = 200
    return ReadingOut.model_validate(reading)


@router.get("", response_model=list[ReadingOut])
def list_readings(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> list[ReadingOut]:
    """Ordered by seq ascending."""
    batch = get_batch_for_farmer(db, farmer, batch_id)
    return [ReadingOut.model_validate(r) for r in _list_readings(db, batch)]
