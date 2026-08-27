"""POST /sync — outbox drain with dedupe + clock-skew correction (contract section 7)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.deps import CurrentFarmer, DbDep, farmer_rate_limited
from app.schemas import SyncRequest, SyncResponse
from app.services.sync import apply_sync

# Keyed per farmer (not IP): the request-count bound that complements MAX_OPS_PER_REQUEST.
router = APIRouter(
    prefix="/sync", tags=["sync"], dependencies=[Depends(farmer_rate_limited("sync"))]
)


@router.post("", response_model=SyncResponse)
def sync(body: SyncRequest, farmer: CurrentFarmer, db: DbDep) -> SyncResponse:
    """Apply ops in client_seq order; duplicate op_id -> "duplicate"; |skew| > 120 s shifts times.

    The body's `device_id` must be the device the bearer token was minted for (401 otherwise):
    a token never syncs another device's outbox. Per-op failures are reported as `rejected`
    results, so the request itself only fails on auth or a malformed envelope.
    """
    if body.device_id != farmer.device_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="device_id does not match the token's device",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return apply_sync(db, farmer, body)
