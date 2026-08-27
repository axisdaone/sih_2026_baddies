"""Routing engine (contract section 3): rank mandis by expected realised value.

Pure: takes a batch-like object, the current ShelfLifeEstimate, the protocol dict, mandis and
their latest prices, and returns a `Recommendation`. No DB, no I/O (the router persists it).

Per mandi with a price for the protocol's commodity:
    straight_km         = haversine(origin, mandi)
    distance_km         = straight_km * ROAD_FACTOR
    travel_hours        = distance_km / AVG_SPEED_KMH
    feasible            = travel_hours < remaining_hours.mid * SAFETY_FACTOR
    consumed_at_arrival = clamp(consumed_now + travel_hours * r(transit_temp) / L_ref, 0, 1)
    spoilage_at_arrival = consumed_at_arrival            (v1: linear value loss)
    gross_value_inr     = modal_price / 100 * qty_kg * (1 - spoilage_at_arrival)
    transport_cost_inr  = distance_km * TRANSPORT_COST_PER_KM_INR
    expected_value_inr  = gross_value_inr - transport_cost_inr
Transit temperature = last reading when it is <= 2 h old (estimate.current_temp_assumed is
False), else protocol.default_ambient_c. Values are ranked unrounded and rounded on output.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from app.config import Settings
from app.enums import PriceSource
from app.kinetics.engine import consumed_after, round_half_up
from app.routing.geo import haversine_km
from app.schemas import (
    MandiCandidate,
    MandiPriceOut,
    Recommendation,
    RoutingConstants,
    ShelfLifeEstimate,
    to_utc,
)
from app.seed import load_mandis_file

MODEL_VERSION = "routing-1.0"
MAX_ALTERNATIVES = 2

# Explanation codes (the UI translates them).
REASON_TOP = "highest_expected_value"
REASON_CLOSEST = "closest"
REASON_PRICE_STALE = "price_stale"
REASON_INFEASIBLE = "infeasible_travel_time"
REASON_NO_PRICE = "no_price"
REASON_ORIGIN_ASSUMED = "origin_assumed"
REASON_BATCH_SPOILED = "batch_spoiled"
REASON_NO_PRICES = "no_prices"
# Contract section 3 rejection codes (MandiCandidate.reason).
REJECT_TOO_FAR = "too_far_for_shelf_life"
REJECT_NO_PRICE = "no_price"


class BatchLike(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def qty_kg(self) -> float: ...

    @property
    def origin_lat(self) -> float | None: ...

    @property
    def origin_lon(self) -> float | None: ...


class MandiLike(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def name(self) -> str: ...

    @property
    def district(self) -> str: ...

    @property
    def lat(self) -> float: ...

    @property
    def lon(self) -> float: ...


@dataclass(frozen=True, slots=True)
class Origin:
    lat: float
    lon: float
    assumed: bool = False


def demo_origin(settings: Settings) -> Origin:
    """Fallback origin from data/mandis.json (`demo_origin`) for batches without coordinates."""
    doc = load_mandis_file(settings.DATA_DIR / "mandis.json")["demo_origin"]
    return Origin(lat=float(doc["lat"]), lon=float(doc["lon"]), assumed=True)


def resolve_origin(batch: BatchLike, settings: Settings) -> Origin:
    if batch.origin_lat is None or batch.origin_lon is None:
        return demo_origin(settings)
    return Origin(lat=float(batch.origin_lat), lon=float(batch.origin_lon))


def transit_temperature(estimate: ShelfLifeEstimate, protocol: dict[str, Any]) -> float:
    """Last reading when it is fresh (<= 2 h), otherwise the protocol's default ambient."""
    if estimate.current_temp_assumed:
        return float(protocol["default_ambient_c"])
    return float(estimate.current_temp_c)


@dataclass(slots=True)
class _Scored:
    """Unrounded candidate used for ranking; converted to MandiCandidate on output."""

    mandi: MandiLike
    price: MandiPriceOut | None
    straight_km: float
    distance_km: float
    travel_hours: float
    feasible: bool
    price_is_stale: bool
    consumed_at_arrival: float
    gross_value_inr: float
    transport_cost_inr: float
    expected_value_inr: float
    reasons: list[str] = field(default_factory=list)
    reason: str | None = None

    def to_candidate(self, transit_temp_c: float) -> MandiCandidate:
        price = self.price
        return MandiCandidate(
            mandi_id=self.mandi.id,
            name=self.mandi.name,
            district=self.mandi.district,
            lat=self.mandi.lat,
            lon=self.mandi.lon,
            straight_km=round_half_up(self.straight_km, 1),
            distance_km=round_half_up(self.distance_km, 1),
            travel_hours=round_half_up(self.travel_hours, 2),
            feasible=self.feasible,
            modal_price_per_quintal=None if price is None else price.modal_price,
            price_reported_on=None if price is None else price.reported_on,
            price_fetched_at=None if price is None else price.fetched_at,
            price_is_stale=self.price_is_stale,
            price_source=PriceSource.UNKNOWN if price is None else PriceSource(price.source),
            transit_temp_c=transit_temp_c,
            consumed_at_arrival=round_half_up(self.consumed_at_arrival, 4),
            spoilage_at_arrival=round_half_up(self.consumed_at_arrival, 4),
            gross_value_inr=round_half_up(self.gross_value_inr, 2),
            transport_cost_inr=round_half_up(self.transport_cost_inr, 2),
            expected_value_inr=round_half_up(self.expected_value_inr, 2),
            reasons=list(self.reasons),
            reason=self.reason,
        )


def _score(
    mandi: MandiLike,
    price: MandiPriceOut | None,
    *,
    origin: Origin,
    batch: BatchLike,
    estimate: ShelfLifeEstimate,
    protocol: dict[str, Any],
    transit_temp_c: float,
    settings: Settings,
    now: datetime,
) -> _Scored:
    straight = haversine_km(origin.lat, origin.lon, mandi.lat, mandi.lon)
    distance = straight * settings.ROAD_FACTOR
    travel_hours = distance / settings.AVG_SPEED_KMH
    transport_cost = distance * settings.TRANSPORT_COST_PER_KM_INR
    reasons: list[str] = []
    if origin.assumed:
        reasons.append(REASON_ORIGIN_ASSUMED)

    if price is None:
        reasons.append(REASON_NO_PRICE)
        return _Scored(
            mandi=mandi, price=None, straight_km=straight, distance_km=distance,
            travel_hours=travel_hours, feasible=False, price_is_stale=True,
            consumed_at_arrival=estimate.consumed_fraction, gross_value_inr=0.0,
            transport_cost_inr=transport_cost, expected_value_inr=-transport_cost,
            reasons=reasons, reason=REJECT_NO_PRICE,
        )

    feasible = travel_hours < estimate.remaining_hours.mid * settings.SAFETY_FACTOR
    consumed_at_arrival = consumed_after(protocol, estimate, travel_hours, transit_temp_c)
    gross = price.modal_price / 100.0 * float(batch.qty_kg) * (1.0 - consumed_at_arrival)
    expected = gross - transport_cost
    stale_after = now - to_utc(price.fetched_at)
    price_is_stale = stale_after.total_seconds() > settings.PRICE_STALE_HOURS * 3600.0
    if price_is_stale:
        reasons.append(REASON_PRICE_STALE)
    reason: str | None = None
    if not feasible:
        reasons.append(REASON_INFEASIBLE)
        reason = REJECT_TOO_FAR
    return _Scored(
        mandi=mandi, price=price, straight_km=straight, distance_km=distance,
        travel_hours=travel_hours, feasible=feasible, price_is_stale=price_is_stale,
        consumed_at_arrival=consumed_at_arrival, gross_value_inr=gross,
        transport_cost_inr=transport_cost, expected_value_inr=expected,
        reasons=reasons, reason=reason,
    )


def recommend(
    batch: BatchLike,
    estimate: ShelfLifeEstimate,
    protocol: dict[str, Any],
    mandis: Sequence[MandiLike],
    prices: Sequence[MandiPriceOut],
    settings: Settings,
    now: datetime,
    *,
    simulated: bool = False,
) -> Recommendation:
    """Rank mandis for the batch (contract section 3). Never raises for missing prices."""
    now = to_utc(now)
    origin = resolve_origin(batch, settings)
    transit_temp_c = transit_temperature(estimate, protocol)
    commodity = str(protocol.get("commodity") or "")
    price_by_mandi = {p.mandi_id: p for p in prices if p.commodity == commodity}

    scored = [
        _score(
            mandi, price_by_mandi.get(mandi.id), origin=origin, batch=batch, estimate=estimate,
            protocol=protocol, transit_temp_c=transit_temp_c, settings=settings, now=now,
        )
        for mandi in mandis
    ]
    spoiled = estimate.status == "spoiled"
    if spoiled:
        for item in scored:
            if item.price is not None:
                item.feasible = False
                if REASON_INFEASIBLE not in item.reasons:
                    item.reasons.append(REASON_INFEASIBLE)
                item.reason = REJECT_TOO_FAR

    feasible = sorted(
        (s for s in scored if s.feasible), key=lambda s: s.expected_value_inr, reverse=True
    )
    rejected = [s for s in scored if not s.feasible]
    nearest = min(scored, key=lambda s: s.straight_km) if scored else None
    if nearest is not None:
        nearest.reasons.append(REASON_CLOSEST)
    top = feasible[0] if feasible else None
    if top is not None:
        top.reasons.insert(0, REASON_TOP)

    uplift: float | None = None
    if top is not None and nearest is not None and nearest.expected_value_inr > 0:
        uplift = round_half_up(
            (top.expected_value_inr - nearest.expected_value_inr)
            / abs(nearest.expected_value_inr)
            * 100.0,
            1,
        )

    reason: str | None = None
    if spoiled:
        reason = REASON_BATCH_SPOILED
    elif not price_by_mandi:
        reason = REASON_NO_PRICES

    ranked = [s.to_candidate(transit_temp_c) for s in feasible]
    return Recommendation(
        batch_id=batch.id,
        computed_at=now,
        model_version=MODEL_VERSION,
        shelf_life=estimate,
        top=ranked[0] if ranked else None,
        alternatives=ranked[1 : 1 + MAX_ALTERNATIVES],
        nearest=None if nearest is None else nearest.to_candidate(transit_temp_c),
        rejected=[s.to_candidate(transit_temp_c) for s in rejected],
        ranked=ranked,
        uplift_vs_nearest_pct=uplift,
        reason=reason,
        constants=RoutingConstants(
            road_factor=settings.ROAD_FACTOR,
            avg_speed_kmh=settings.AVG_SPEED_KMH,
            safety_factor=settings.SAFETY_FACTOR,
            transport_cost_per_km_inr=settings.TRANSPORT_COST_PER_KM_INR,
        ),
        simulated=simulated,
    )
