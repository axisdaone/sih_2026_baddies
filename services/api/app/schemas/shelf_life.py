from __future__ import annotations

from pydantic import Field

from app.enums import Confidence, ShelfLifeStatus
from app.schemas.common import ApiModel, UtcDatetime
from app.schemas.protocol import ThresholdType


class ScenarioHours(ApiModel):
    low: float
    mid: float
    high: float


class ScenarioEnd(ApiModel):
    low: UtcDatetime
    mid: UtcDatetime
    high: UtcDatetime


class Segment(ApiModel):
    """Piecewise-constant temperature segment; `from` on the wire, `from_` in Python."""

    from_: UtcDatetime = Field(alias="from")
    to: UtcDatetime
    temp_c: float
    hours: float
    rate: float
    assumed: bool


class Breach(ApiModel):
    """First hard-threshold breach: the threshold's type/value_c/label and the offending reading."""

    type: ThresholdType
    value_c: float
    reading_id: str | None = None
    at: UtcDatetime
    # The hard_threshold `label` (e.g. "heat_damage", "freeze"); None if the protocol has none.
    label: str | None = None


class ShelfLifeEstimate(ApiModel):
    """Evaluator output (contract section 2.2). Identical JSON in Python and TypeScript."""

    protocol_id: str
    model_version: str = "kinetics-1.0"
    computed_at: UtcDatetime
    status: ShelfLifeStatus
    confidence: Confidence
    consumed_fraction: float  # mid scenario, 4 dp
    remaining_fraction: float
    remaining_hours: ScenarioHours  # 1 dp
    expected_end: ScenarioEnd
    current_temp_c: float
    current_temp_assumed: bool
    hours_since_last_reading: float | None = None
    thermal_load_degree_hours: float
    alerts_crossed: list[int] = []
    breach: Breach | None = None
    segments: list[Segment] = []
