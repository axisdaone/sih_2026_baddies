from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator

from app.config import DEMO_DEVICE_ID
from app.schemas.common import ApiModel, UtcDatetime, is_uuid

Locale = Literal["en", "hi", "ta"]


class DeviceAuthRequest(ApiModel):
    """POST /auth/device body. `device_id` is the credential (contract line 8: all ids are UUID
    v4), so anything that is not a UUID is refused — except the scripted demo identity, whose
    availability is decided by the router (`DEMO_MODE`)."""

    device_id: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=120)
    locale: Locale = "en"

    @field_validator("device_id")
    @classmethod
    def _uuid_or_demo(cls, value: str) -> str:
        if is_uuid(value) or value == DEMO_DEVICE_ID:
            return value
        raise ValueError("device_id must be a UUID")


class DeviceAuthResponse(ApiModel):
    token: str
    farmer_id: str


class FarmerOut(ApiModel):
    id: str
    display_name: str | None
    locale: str
    device_id: str
    created_at: UtcDatetime
