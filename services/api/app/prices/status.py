"""Price cache provenance for GET /health (read-only; never loads the snapshot)."""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.prices.service import newest_meta
from app.schemas import PriceMeta

log = logging.getLogger(__name__)


def get_price_status(db: Session) -> PriceMeta:
    """{source, fetched_at, stale} of the newest cached row; `unknown` before the first poll."""
    try:
        return newest_meta(db)
    except Exception:  # noqa: BLE001 - /health must never raise
        log.exception("price status lookup failed")
        return PriceMeta()
