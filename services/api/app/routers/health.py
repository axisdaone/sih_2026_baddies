"""GET /health — liveness + DB check + price provenance."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.deps import DbDep, rate_limited
from app.schemas import HealthResponse, PriceMeta

log = logging.getLogger(__name__)
router = APIRouter(tags=["health"], dependencies=[Depends(rate_limited("public"))])


def _price_status(db: Session) -> PriceMeta:
    """Ask the prices package for cache provenance; placeholder until it exists."""
    try:
        from app.prices.status import get_price_status  # PHASE2: implemented by prices agent
    except ImportError:
        return PriceMeta()
    result: PriceMeta = get_price_status(db)
    return result


@router.get("/health", response_model=HealthResponse)
def health(db: DbDep) -> HealthResponse:
    settings = get_settings()
    try:
        db.execute(text("SELECT 1"))
        db_status = "ok"
    except Exception:  # noqa: BLE001 - health must never raise
        log.exception("health: database check failed")
        db_status = "error"
    return HealthResponse(
        status="ok" if db_status == "ok" else "degraded",
        version=settings.VERSION,
        db="ok" if db_status == "ok" else "error",
        prices=_price_status(db),
    )
