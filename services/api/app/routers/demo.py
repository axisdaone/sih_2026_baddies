"""Demo endpoints (DEMO_MODE only, no auth): seed the pitch dataset, list telemetry scenarios."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.alerts.thresholds import batch_alerts
from app.config import get_settings
from app.demo.seed import seed_demo as _seed_demo
from app.deps import DbDep
from app.schemas.demo import DemoScenarioOut, DemoSeedResponse, ScenarioReading
from app.security import create_token
from app.services.batches import build_batch_outs, list_batches
from app.services.simulate import load_profiles

router = APIRouter(prefix="/demo", tags=["demo"])


def _require_demo_mode() -> None:
    if not get_settings().DEMO_MODE:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "demo mode is disabled")


@router.post("/seed", response_model=DemoSeedResponse)
def seed_demo(db: DbDep, reset: bool = False) -> DemoSeedResponse:
    """Seed via app.demo.seed (idempotent: fixed ids); returns the demo device token.

    `?reset=true` wipes the demo farmer's batches first and re-anchors `harvested_at` to now.
    """
    _require_demo_mode()
    result = _seed_demo(db, reset=reset)
    farmer = result.farmer
    batches = build_batch_outs(db, list_batches(db, farmer))
    return DemoSeedResponse(
        farmer_id=farmer.id,
        device_id=farmer.device_id,
        display_name=farmer.display_name,
        token=create_token(farmer.id, farmer.device_id),
        batch_ids=result.batch_ids,
        created=result.batches_created > 0,
        batches_created=result.batches_created,
        batches_existing=result.batches_existing,
        readings_created=result.readings_created,
        loss_comparison=result.loss_comparison,
        alerts=batch_alerts(batches),
    )


@router.get("/scenarios", response_model=list[DemoScenarioOut])
def list_scenarios() -> list[DemoScenarioOut]:
    """The `data/demo_scenarios/*.json` profiles (online source of truth for the PWA player)."""
    _require_demo_mode()
    return [
        DemoScenarioOut(
            id=profile.id,
            name=profile.name,
            description=profile.description,
            suitable_protocols=list(profile.suitable_protocols),
            readings=[
                ScenarioReading(offset_hours=r.offset_hours, temp_c=r.temp_c)
                for r in profile.readings
            ],
        )
        for profile in load_profiles().values()
    ]
