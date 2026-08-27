"""POST /auth/device — device-bound JWT (no OTP in demo; contract section 6)."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from app.deps import CurrentFarmer, DbDep
from app.models import Farmer
from app.schemas import DeviceAuthRequest, DeviceAuthResponse, FarmerOut
from app.security import create_token

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/device", response_model=DeviceAuthResponse)
def device_login(body: DeviceAuthRequest, db: DbDep) -> DeviceAuthResponse:
    """Find-or-create the farmer for this device and mint a token (idempotent)."""
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
