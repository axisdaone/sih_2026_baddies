from __future__ import annotations

from typing import Literal

from pydantic import Field

from app.schemas.common import ApiModel, UtcDatetime

Locale = Literal["en", "hi", "ta"]


class DeviceAuthRequest(ApiModel):
    device_id: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=120)
    locale: Locale = "en"


class DeviceAuthResponse(ApiModel):
    token: str
    farmer_id: str


class FarmerOut(ApiModel):
    id: str
    display_name: str | None
    locale: str
    device_id: str
    created_at: UtcDatetime
