"""GET /batches/{id}/recommendation — routing engine output (contract section 3).

Loads the farmer's batch + readings (by seq), evaluates shelf life now, fetches the latest
prices for the protocol's commodity (snapshot fallback inside the service), runs the pure
routing engine, stores the payload in `recommendations` and returns it.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.config import get_settings
from app.deps import CurrentFarmer, DbDep
from app.enums import ReadingSource
from app.kinetics.engine import evaluate
from app.kinetics.registry import get_protocol
from app.models import Batch, Mandi
from app.models import Recommendation as RecommendationRow
from app.prices.service import get_latest_prices
from app.routing.engine import MODEL_VERSION, recommend
from app.schemas import Recommendation
from app.seed import seed_mandis

router = APIRouter(prefix="/batches/{batch_id}/recommendation", tags=["recommendations"])


@router.get("", response_model=Recommendation)
def get_recommendation(batch_id: str, farmer: CurrentFarmer, db: DbDep) -> Recommendation:
    """Computed on demand via app.routing.engine and stored in `recommendations`."""
    batch = db.get(Batch, batch_id)
    if batch is None or batch.farmer_id != farmer.id or batch.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="batch not found")
    try:
        protocol = get_protocol(batch.protocol_id)
    except KeyError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"batch references unknown protocol {batch.protocol_id!r}",
        ) from exc

    settings = get_settings()
    now = datetime.now(UTC)
    readings = list(batch.readings)  # relationship is ordered by seq
    estimate = evaluate(protocol, batch.harvested_at, readings, now)

    mandis = list(db.scalars(select(Mandi).order_by(Mandi.id)).all())
    if not mandis:
        seed_mandis(db)
        mandis = list(db.scalars(select(Mandi).order_by(Mandi.id)).all())
    commodity = str(protocol.get("commodity") or "")  # pharma protocols have none
    prices = (
        get_latest_prices(db, commodity, now=now, settings=settings).prices if commodity else []
    )

    result = recommend(
        batch,
        estimate,
        protocol,
        mandis,
        prices,
        settings,
        now,
        simulated=any(r.source == ReadingSource.SIM.value for r in readings),
    )
    db.add(
        RecommendationRow(
            batch_id=batch.id,
            ranked_json=result.model_dump(mode="json"),
            computed_at=now,
            model_version=MODEL_VERSION,
        )
    )
    db.commit()
    return result
