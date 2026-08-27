"""Readings: append-only, hash-chained (contract section 4). Bodies: PHASE2."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.deps import CurrentFarmer, DbDep
from app.schemas import ReadingCreate, ReadingOut

router = APIRouter(prefix="/batches/{batch_id}/readings", tags=["readings"])


@router.post("", response_model=ReadingOut, status_code=201)
def append_reading(
    batch_id: str, body: ReadingCreate, farmer: CurrentFarmer, db: DbDep
) -> ReadingOut:
    """Idempotent on client `id`; assigns seq/hash/prev_hash; returns 200 on duplicate."""
    raise HTTPException(501, "PHASE2")


@router.get("", response_model=list[ReadingOut])
def list_readings(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> list[ReadingOut]:
    """Ordered by seq ascending."""
    raise HTTPException(501, "PHASE2")
