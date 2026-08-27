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
    # Price fields are null only for `rejected` entries with reason "no_price".
    modal_price_per_quintal: float | None
    price_reported_on: date | None
    price_fetched_at: UtcDatetime | None
    price_is_stale: bool
    price_source: PriceSource = PriceSource.UNKNOWN
    transit_temp_c: float
    consumed_at_arrival: float
    spoilage_at_arrival: float
    gross_value_inr: float
    transport_cost_inr: float
    expected_value_inr: float
    # Explanation codes translated by the UI: highest_expected_value, closest, price_stale,
    # infeasible_travel_time, no_price, origin_assumed.
    reasons: list[str] = []
    # Contract section 3 rejection code for `rejected[]`: too_far_for_shelf_life | no_price.
    reason: str | None = None


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
    # Every feasible mandi in rank order (top + alternatives + the rest) for map / FPO views.
    ranked: list[MandiCandidate] = []
    uplift_vs_nearest_pct: float | None = None
    reason: str | None = None  # e.g. "batch_spoiled", "no_prices"
    constants: RoutingConstants
    simulated: bool = False
