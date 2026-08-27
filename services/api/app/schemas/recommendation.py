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
    # Same time gate against the pessimistic (`remaining_hours.low`) scenario: a mandi that is
    # only reachable in the mid case is still feasible but ranks after those that are safe in
    # both (reason code `risky_in_pessimistic_case`).
    feasible_pessimistic: bool = True
    # Price fields are null only for `rejected` entries with reason "no_price".
    modal_price_per_quintal: float | None
    price_reported_on: date | None
    price_fetched_at: UtcDatetime | None
    # Whole days between `price_reported_on` and the recommendation date (None without a price).
    price_age_days: int | None = None
    price_is_stale: bool
    price_source: PriceSource = PriceSource.UNKNOWN
    # Reproducibility inputs: the trip integrates r(transit_temp) over travel_hours against L_ref.
    qty_kg: float
    transit_temp_c: float
    transit_rate: float
    reference_shelf_life_hours: float
    trip_consumed_fraction: float
    consumed_at_arrival: float
    spoilage_at_arrival: float
    gross_value_inr: float
    transport_cost_inr: float
    expected_value_inr: float
    # Explanation codes translated by the UI: highest_expected_value, closest, price_stale,
    # infeasible_travel_time, not_worth_the_trip, risky_in_pessimistic_case, no_price,
    # origin_assumed, batch_spoiled.
    reasons: list[str] = []
    # Contract section 3 rejection code for `rejected[]`:
    # too_far_for_shelf_life | negative_expected_value | no_price | batch_spoiled.
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
    reason: str | None = None  # "batch_spoiled" | "no_prices" | "no_profitable_mandi"
    constants: RoutingConstants
    simulated: bool = False
