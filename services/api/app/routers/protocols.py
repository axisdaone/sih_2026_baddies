"""GET /protocols, GET /protocols/{id} — public, served from the in-memory registry."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.deps import rate_limited
from app.kinetics.registry import get_protocol, list_protocols
from app.schemas import ProtocolOut

router = APIRouter(
    prefix="/protocols", tags=["protocols"], dependencies=[Depends(rate_limited("protocols"))]
)


@router.get("", response_model=list[ProtocolOut])
def get_protocols() -> list[ProtocolOut]:
    return [ProtocolOut.model_validate(p) for p in list_protocols()]


@router.get("/{protocol_id}", response_model=ProtocolOut)
def get_protocol_by_id(protocol_id: str) -> ProtocolOut:
    try:
        return ProtocolOut.model_validate(get_protocol(protocol_id))
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"unknown protocol {protocol_id!r}"
        ) from exc
