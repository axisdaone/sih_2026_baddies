"""POST /demo/seed — idempotent demo farmer + batches + readings (DEMO_MODE only). PHASE2."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.config import get_settings
from app.deps import DbDep
from app.schemas import DemoSeedResponse

router = APIRouter(prefix="/demo", tags=["demo"])


@router.post("/seed", response_model=DemoSeedResponse)
def seed_demo(db: DbDep) -> DemoSeedResponse:
    """Seed via app.demo.seed; returns the demo device token so the PWA can log in."""
    if not get_settings().DEMO_MODE:
        raise HTTPException(403, "demo mode is disabled")
    raise HTTPException(501, "PHASE2")
