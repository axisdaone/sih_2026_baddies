"""POST /auth/device — device-bound JWT (no OTP in demo; contract section 6)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select

from app.config import DEMO_DEVICE_ID, get_settings
from app.deps import CurrentFarmer, DbDep, rate_limited
from app.models import Farmer
from app.schemas import DeviceAuthRequest, DeviceAuthResponse, FarmerOut
from app.security import create_token

router = APIRouter(prefix="/auth", tags=["auth"])


def _auth_limit() -> int:
    return get_settings().AUTH_RATE_LIMIT_PER_MIN


@router.post(
    "/device",
    response_model=DeviceAuthResponse,
    dependencies=[Depends(rate_limited("auth", limit=_auth_limit))],
)
def device_login(body: DeviceAuthRequest, db: DbDep) -> DeviceAuthResponse:
    """Find-or-create the farmer for this device and mint a token (idempotent).

    Unauthenticated by design (the device id is the credential), hence the tight per-IP limit
    (`AUTH_RATE_LIMIT_PER_MIN`) and the UUID-only device ids. The scripted demo identity is a
    public constant, so it is only accepted while DEMO_MODE is on — checked *before* the
    find-or-create so a disabled demo never creates (or renames) that farmer.
    """
    if body.device_id == DEMO_DEVICE_ID and not get_settings().DEMO_MODE:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "demo identity is disabled")
    farmer = db.scalar(select(Farmer).where(Farmer.device_id == body.device_id))
    if farmer is None:
        farmer = Farmer(
            device_id=body.device_id, display_name=body.display_name, locale=body.locale
        )
        db.add(farmer)
    else:
        # Re-login may update the opt-in display name / locale.
        if body.display_name is not None:
            farmer.display_name = body.display_name
        farmer.locale = body.locale
    db.commit()
    db.refresh(farmer)
    return DeviceAuthResponse(
        token=create_token(farmer.id, farmer.device_id), farmer_id=farmer.id
    )


@router.get("/me", response_model=FarmerOut)
def me(farmer: CurrentFarmer) -> FarmerOut:
    return FarmerOut.model_validate(farmer)
