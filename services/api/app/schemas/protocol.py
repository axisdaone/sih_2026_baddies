from __future__ import annotations

from typing import Literal

from app.enums import ProtocolKind
from app.schemas.common import ApiModel

ThresholdType = Literal["max_temp", "min_temp"]


class HardThreshold(ApiModel):
    type: ThresholdType
    value_c: float
    label: str


class ProtocolOut(ApiModel):
    """Mirrors the JSON files in app/kinetics/protocols (contract section 2.1)."""

    id: str
    kind: ProtocolKind
    name: str
    commodity: str | None = None
    version: str
    model: Literal["q10", "excursion"]
    reference_temp_c: float
    reference_shelf_life_hours: float
    reference_shelf_life_range_hours: tuple[float, float]
    q10: float | None = None
    q10_range: tuple[float, float] | None = None
    min_effective_temp_c: float | None = None
    max_effective_temp_c: float | None = None
    default_ambient_c: float
    hard_thresholds: list[HardThreshold]
    band_c: tuple[float, float] | None = None
    excursion_budget_minutes: float | None = None
    sources: list[str] = []
