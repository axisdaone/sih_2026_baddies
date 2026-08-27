"""GET /mandis — public mandi list with coordinates and Agmarknet mapping."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.deps import DbDep, rate_limited
from app.models import Mandi
from app.schemas import MandiOut

router = APIRouter(
    prefix="/mandis", tags=["mandis"], dependencies=[Depends(rate_limited("mandis"))]
)


@router.get("", response_model=list[MandiOut])
def get_mandis(db: DbDep) -> list[MandiOut]:
    rows = db.scalars(select(Mandi).order_by(Mandi.name)).all()
    return [MandiOut.model_validate(row) for row in rows]
