"""Quality Pass: public payload, QR PNG, chain verification (contract section 4)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from app.deps import DbDep, client_ip, rate_limited
from app.enums import PassEvent
from app.quality_pass.service import (
    build_pass_payload,
    get_public_batch,
    qr_png_for,
    record_pass_event,
    verify_batch,
)
from app.schemas import QualityPassPayload, QualityPassVerify

router = APIRouter(
    prefix="/quality-pass", tags=["quality-pass"], dependencies=[Depends(rate_limited("public"))]
)


@router.get("/{batch_id}", response_model=QualityPassPayload)
def get_quality_pass(batch_id: str, request: Request, db: DbDep) -> QualityPassPayload:
    """Public read-only batch payload; logs a `view` pass_event with a hashed IP."""
    batch = get_public_batch(db, batch_id)
    payload = build_pass_payload(db, batch)
    record_pass_event(db, batch.id, PassEvent.VIEW, client_ip(request))
    return payload


@router.get(
    "/{batch_id}/qr.png",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
)
def get_quality_pass_qr(batch_id: str, db: DbDep) -> Response:
    """PNG QR encoding {PUBLIC_BASE_URL}/pass/{batch_id}?h={chain_head[:16]}."""
    batch = get_public_batch(db, batch_id)
    return Response(
        content=qr_png_for(db, batch),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{batch_id}/verify", response_model=QualityPassVerify)
def verify_quality_pass(
    batch_id: str,
    request: Request,
    db: DbDep,
    head: Annotated[
        str | None, Query(min_length=16, max_length=64, pattern=r"^[0-9a-fA-F]+$")
    ] = None,
) -> QualityPassVerify:
    """Recompute the hash chain; logs a `verify` pass_event.

    `head` (the QR's chain-head prefix) is optional: without it the response still reports
    whether the stored chain is internally consistent, with `head_matches=false`."""
    batch = get_public_batch(db, batch_id)
    result = verify_batch(db, batch, head)
    record_pass_event(db, batch.id, PassEvent.VERIFY, client_ip(request))
    return result
