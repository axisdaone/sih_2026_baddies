"""GET /batches/{id}/recommendation — routing engine output (contract section 3). PHASE2."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.deps import CurrentFarmer, DbDep
from app.schemas import Recommendation

router = APIRouter(prefix="/batches/{batch_id}/recommendation", tags=["recommendations"])


@router.get("", response_model=Recommendation)
def get_recommendation(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> Recommendation:
    """Computed on demand via app.routing.engine and stored in `recommendations`."""
    raise HTTPException(501, "PHASE2")
