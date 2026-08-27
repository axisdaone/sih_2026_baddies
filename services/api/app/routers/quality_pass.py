"""Quality Pass: public payload, QR PNG, chain verification (contract section 4). PHASE2."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.deps import DbDep, rate_limited
from app.schemas import QualityPassPayload, QualityPassVerify

router = APIRouter(
    prefix="/quality-pass", tags=["quality-pass"], dependencies=[Depends(rate_limited("public"))]
)


@router.get("/{batch_id}", response_model=QualityPassPayload)
def get_quality_pass(batch_id: str, request: Request, db: DbDep) -> QualityPassPayload:
    """Public read-only batch payload; logs a `view` pass_event with a hashed IP."""
    raise HTTPException(501, "PHASE2")


@router.get(
    "/{batch_id}/qr.png",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
)
def get_quality_pass_qr(batch_id: str, db: DbDep) -> Response:
    """PNG QR encoding {PUBLIC_BASE_URL}/pass/{batch_id}?h={chain_head[:16]}."""
    raise HTTPException(501, "PHASE2")


@router.get("/{batch_id}/verify", response_model=QualityPassVerify)
def verify_quality_pass(
    batch_id: str,
    request: Request,
    db: DbDep,
    head: Annotated[str, Query(min_length=16, max_length=64)],
) -> QualityPassVerify:
    """Recompute the hash chain; logs a `verify` pass_event."""
    raise HTTPException(501, "PHASE2")
