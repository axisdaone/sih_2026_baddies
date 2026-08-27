"""Batches: create (idempotent), list, detail, patch, shelf-life, simulate. Bodies: PHASE2."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query

from app.deps import CurrentFarmer, DbDep
from app.schemas import BatchCreate, BatchOut, BatchPatch, ShelfLifeEstimate

router = APIRouter(prefix="/batches", tags=["batches"])

SimProfile = Literal["hot_afternoon", "cool_chain", "overnight_truck"]


@router.post("", response_model=BatchOut, status_code=201)
def create_batch(body: BatchCreate, farmer: CurrentFarmer, db: DbDep) -> BatchOut:
    """Idempotent on client `id`: an existing batch returns 200 with the stored row."""
    raise HTTPException(501, "PHASE2")


@router.get("", response_model=list[BatchOut])
def list_batches(farmer: CurrentFarmer, db: DbDep) -> list[BatchOut]:
    """Farmer's non-deleted batches, each with embedded latest `shelf_life`."""
    raise HTTPException(501, "PHASE2")


@router.get("/{batch_id}", response_model=BatchOut)
def get_batch(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> BatchOut:
    """Batch + readings (by seq) + shelf_life + chain_head."""
    raise HTTPException(501, "PHASE2")


@router.patch("/{batch_id}", response_model=BatchOut)
def patch_batch(batch_id: str, body: BatchPatch, farmer: CurrentFarmer, db: DbDep) -> BatchOut:
    """status/notes/qty_kg, last-writer-wins per field by `client_seq`."""
    raise HTTPException(501, "PHASE2")


@router.get("/{batch_id}/shelf-life", response_model=ShelfLifeEstimate)
def get_shelf_life(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> ShelfLifeEstimate:
    """Server-authoritative evaluation via app.kinetics.engine.evaluate."""
    raise HTTPException(501, "PHASE2")


@router.post("/{batch_id}/simulate", response_model=BatchOut)
def simulate_batch(
    batch_id: str,
    farmer: CurrentFarmer,
    db: DbDep,
    profile: Annotated[SimProfile, Query()] = "hot_afternoon",
) -> BatchOut:
    """Demo: append `source: "sim"` readings from data/demo_scenarios/{profile}.json."""
    raise HTTPException(501, "PHASE2")
