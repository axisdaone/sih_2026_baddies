"""Batches: create (idempotent), list, detail, patch, shelf-life, simulate."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Response

from app.deps import CurrentFarmer, DbDep
from app.schemas import BatchCreate, BatchOut, BatchPatch, ShelfLifeEstimate
from app.services.batches import (
    build_batch_out,
    build_batch_outs,
    get_batch_for_farmer,
    readings_for,
    shelf_life_for,
    upsert_batch,
)
from app.services.batches import list_batches as _list_batches
from app.services.batches import patch_batch as _patch_batch
from app.services.simulate import simulate_batch as _simulate_batch

router = APIRouter(prefix="/batches", tags=["batches"])

# Profile ids are validated against data/demo_scenarios/*.json at request time (404 if unknown).
SimProfile = Annotated[str, Query(min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")]


@router.post("", response_model=BatchOut, status_code=201)
def create_batch(
    body: BatchCreate, farmer: CurrentFarmer, db: DbDep, response: Response
) -> BatchOut:
    """Idempotent on client `id`: an existing batch returns 200 with the stored row."""
    batch, created = upsert_batch(db, farmer, body)
    if not created:
        response.status_code = 200
    return build_batch_out(db, batch)


@router.get("", response_model=list[BatchOut])
def list_batches(farmer: CurrentFarmer, db: DbDep) -> list[BatchOut]:
    """Farmer's non-deleted batches, each with embedded latest `shelf_life` (+ chain_head)."""
    return build_batch_outs(db, _list_batches(db, farmer))


@router.get("/{batch_id}", response_model=BatchOut)
def get_batch(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> BatchOut:
    """Batch + readings (by seq) + shelf_life + chain_head."""
    return build_batch_out(db, get_batch_for_farmer(db, farmer, batch_id))


@router.patch("/{batch_id}", response_model=BatchOut)
def patch_batch(batch_id: str, body: BatchPatch, farmer: CurrentFarmer, db: DbDep) -> BatchOut:
    """status/notes/qty_kg, last-writer-wins by `client_seq` (stale patches are ignored)."""
    return build_batch_out(db, _patch_batch(db, farmer, batch_id, body))


@router.get("/{batch_id}/shelf-life", response_model=ShelfLifeEstimate)
def get_shelf_life(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> ShelfLifeEstimate:
    """Server-authoritative evaluation via app.kinetics.engine.evaluate."""
    batch = get_batch_for_farmer(db, farmer, batch_id)
    return shelf_life_for(batch, readings_for(db, batch.id))


@router.post("/{batch_id}/simulate", response_model=BatchOut)
def simulate_batch(
    batch_id: str,
    farmer: CurrentFarmer,
    db: DbDep,
    profile: SimProfile = "hot_afternoon",
    up_to_hours: Annotated[float | None, Query(ge=0)] = None,
) -> BatchOut:
    """Demo: append `source: "sim"` readings from data/demo_scenarios/{profile}.json.

    Deterministic reading ids make replays idempotent; `up_to_hours` limits the profile to
    readings with `offset_hours <= up_to_hours` (the telemetry player's "current hour").
    """
    batch = get_batch_for_farmer(db, farmer, batch_id)
    _simulate_batch(db, batch, profile, up_to_hours)
    return build_batch_out(db, batch)
