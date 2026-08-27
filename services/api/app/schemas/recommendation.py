from __future__ import annotations

from datetime import date

from app.enums import PriceSource
from app.schemas.common import ApiModel, UtcDatetime
from app.schemas.shelf_life import ShelfLifeEstimate


class MandiCandidate(ApiModel):
    """One scored mandi with the full explanation payload (contract section 3)."""

    mandi_id: str
    name: str
    district: str
    lat: float
    lon: float
    straight_km: float
    distance_km: float
    travel_hours: float
    feasible: bool
    modal_price_per_quintal: float
    price_reported_on: date
    price_fetched_at: UtcDatetime
    price_is_stale: bool
    price_source: PriceSource
    transit_temp_c: float
    consumed_at_arrival: float
    spoilage_at_arrival: float
    gross_value_inr: float
    transport_cost_inr: float
    expected_value_inr: float
    reasons: list[str] = []


class RoutingConstants(ApiModel):
    road_factor: float
    avg_speed_kmh: float
    safety_factor: float
    transport_cost_per_km_inr: float


class Recommendation(ApiModel):
    batch_id: str
    computed_at: UtcDatetime
    model_version: str = "routing-1.0"
    shelf_life: ShelfLifeEstimate
    top: MandiCandidate | None = None
    alternatives: list[MandiCandidate] = []
    nearest: MandiCandidate | None = None
    rejected: list[MandiCandidate] = []
    uplift_vs_nearest_pct: float | None = None
    reason: str | None = None  # e.g. "batch_spoiled"
    constants: RoutingConstants
    simulated: bool = False
