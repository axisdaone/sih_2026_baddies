"""POST /sync — outbox drain with dedupe + clock-skew correction (contract section 7). PHASE2."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.deps import CurrentFarmer, DbDep
from app.schemas import SyncRequest, SyncResponse

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("", response_model=SyncResponse)
def sync(body: SyncRequest, farmer: CurrentFarmer, db: DbDep) -> SyncResponse:
    """Apply ops in client_seq order; duplicate op_id -> "duplicate"; skew > 120 s shifts times."""
    raise HTTPException(501, "PHASE2")
