"""Demo endpoints (DEMO_MODE only, no auth): seed the pitch dataset, list telemetry scenarios.

`POST /demo/seed` mints the demo farmer's token for anyone while DEMO_MODE is on (documented,
acceptable for the pitch). The destructive `?reset=true` is *not* anonymous: it needs the
`X-Demo-Admin-Token` header matching `DEMO_ADMIN_TOKEN` (403 when the setting is unset or the
header mismatches). Re-seeding with reset re-anchors `harvested_at` and therefore changes every
chain head, so printed QR codes must be regenerated afterwards.
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.alerts.thresholds import batch_alerts
from app.config import get_settings
from app.demo.seed import seed_demo as _seed_demo
from app.deps import DbDep, rate_limited, require_demo_mode
from app.schemas.demo import DemoScenarioOut, DemoSeedResponse, ScenarioReading
from app.security import create_token
from app.services.batches import build_batch_outs, list_batches
from app.services.simulate import load_profiles

router = APIRouter(
    prefix="/demo",
    tags=["demo"],
    dependencies=[Depends(require_demo_mode), Depends(rate_limited("demo"))],
)

ADMIN_HEADER = "X-Demo-Admin-Token"


def require_demo_admin(token: str | None) -> None:
    """403 unless `token` equals the configured DEMO_ADMIN_TOKEN (constant-time compare)."""
    expected = get_settings().DEMO_ADMIN_TOKEN
    if not expected or token is None or not hmac.compare_digest(token, expected):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"reset requires a valid {ADMIN_HEADER} header"
        )


@router.post("/seed", response_model=DemoSeedResponse)
def seed_demo(
    db: DbDep,
    reset: bool = False,
    admin_token: Annotated[str | None, Header(alias=ADMIN_HEADER)] = None,
) -> DemoSeedResponse:
    """Seed via app.demo.seed (idempotent: fixed ids); returns the demo device token.

    `?reset=true` (operator only, see the module docstring) wipes the demo farmer's batches
    first and re-anchors `harvested_at` to now — for a pitch days after the first seed.
    """
    if reset:
        require_demo_admin(admin_token)
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
            expected_story=profile.expected_story,
        )
        for profile in load_profiles().values()
    ]
