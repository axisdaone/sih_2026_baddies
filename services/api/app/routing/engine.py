"""Routing engine (contract section 3): rank mandis by expected realised value.

Pure: takes a batch-like object, the current ShelfLifeEstimate, the protocol dict, mandis and
their latest prices, and returns a `Recommendation`. No DB, no I/O (the router persists it).

Per mandi with a price for the protocol's commodity:
    straight_km          = haversine(origin, mandi)
    distance_km          = straight_km * ROAD_FACTOR
    travel_hours         = distance_km / AVG_SPEED_KMH
    time_ok              = travel_hours < remaining_at(transit_temp) * SAFETY_FACTOR
    consumed_at_arrival  = clamp(consumed_now + travel_hours * r(transit_temp) / L_ref, 0, 1)
    spoilage_at_arrival  = consumed_at_arrival            (v1: linear value loss)
    gross_value_inr      = modal_price / 100 * qty_kg * (1 - spoilage_at_arrival)
    transport_cost_inr   = distance_km * TRANSPORT_COST_PER_KM_INR
    expected_value_inr   = gross_value_inr - transport_cost_inr
    feasible             = time_ok AND expected_value_inr > 0
    feasible_pessimistic = travel_hours < remaining_at(transit_temp, low scenario) * SAFETY_FACTOR

Feasibility and spoilage are both projected at the *transit* temperature: `remaining_at`
re-projects the mid (resp. low) scenario from the current consumed fraction at that temperature,
so a stale cold reading can never make a trip "reachable" while the same trip is computed to
arrive fully spoiled. Transit temperature = max(last reading if <= 2 h old else
protocol.default_ambient_c, protocol.default_ambient_c): a morning yard reading or a reefer
reading is not assumed to hold for a trip in an open pickup (no vehicle input exists yet).

Ranking of feasible mandis: safe in the pessimistic case first, then fresh-priced before stale,
then `expected_value_inr` desc. When every price is equally stale (bundled snapshot) and every
mandi is pessimistically safe, this is plain expected-value order. Values are ranked unrounded
and rounded on output.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Protocol

from app.config import Settings
from app.enums import PriceSource
from app.kinetics.engine import (
    consumed_after,
    rate_multiplier,
    remaining_hours_at,
    round_half_up,
)
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
REASON_NOT_WORTH_TRIP = "not_worth_the_trip"
REASON_RISKY_PESSIMISTIC = "risky_in_pessimistic_case"
REASON_NO_PRICE = "no_price"
REASON_ORIGIN_ASSUMED = "origin_assumed"
REASON_BATCH_SPOILED = "batch_spoiled"
REASON_NO_PRICES = "no_prices"
REASON_NO_PROFITABLE = "no_profitable_mandi"
# Contract section 3 rejection codes (MandiCandidate.reason).
REJECT_TOO_FAR = "too_far_for_shelf_life"
REJECT_NEGATIVE_VALUE = "negative_expected_value"
REJECT_NO_PRICE = "no_price"
REJECT_BATCH_SPOILED = "batch_spoiled"
_TRIP_GATE_REASONS = frozenset({REASON_INFEASIBLE, REASON_NOT_WORTH_TRIP, REASON_RISKY_PESSIMISTIC})


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
    """Temperature assumed for the trip: the protocol's default ambient, or the last reading
    when it is fresh (<= 2 h) *and* warmer than that — never cooler (no reefer input yet)."""
    ambient = float(protocol["default_ambient_c"])
    if estimate.current_temp_assumed:
        return ambient
    return max(float(estimate.current_temp_c), ambient)


def price_age_days(reported_on: date, now: datetime) -> int:
    """Whole days between the Agmarknet arrival date and the recommendation date (>= 0)."""
    return max(0, int((now.date() - reported_on).days))


@dataclass(slots=True)
class _Scored:
    """Unrounded candidate used for ranking; converted to MandiCandidate on output."""

    mandi: MandiLike
    price: MandiPriceOut | None
    straight_km: float
    distance_km: float
    travel_hours: float
    feasible: bool
    feasible_pessimistic: bool
    price_is_stale: bool
    price_age_days: int | None
    consumed_now: float
    consumed_at_arrival: float
    gross_value_inr: float
    transport_cost_inr: float
    expected_value_inr: float
    reasons: list[str] = field(default_factory=list)
    reason: str | None = None

    def rank_key(self) -> tuple[bool, bool, float]:
        """Sort key (ascending): pessimistically safe first, fresh prices first, then value."""
        return (not self.feasible_pessimistic, self.price_is_stale, -self.expected_value_inr)

    def to_candidate(self, ctx: _Context) -> MandiCandidate:
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
            feasible_pessimistic=self.feasible_pessimistic,
            modal_price_per_quintal=None if price is None else price.modal_price,
            price_reported_on=None if price is None else price.reported_on,
            price_fetched_at=None if price is None else price.fetched_at,
            price_age_days=self.price_age_days,
            price_is_stale=self.price_is_stale,
            price_source=PriceSource.UNKNOWN if price is None else PriceSource(price.source),
            qty_kg=ctx.qty_kg,
            transit_temp_c=ctx.transit_temp_c,
            transit_rate=round_half_up(ctx.transit_rate, 4),
            reference_shelf_life_hours=ctx.reference_shelf_life_hours,
            trip_consumed_fraction=round_half_up(
                max(0.0, self.consumed_at_arrival - self.consumed_now), 4
            ),
            consumed_at_arrival=round_half_up(self.consumed_at_arrival, 4),
            spoilage_at_arrival=round_half_up(self.consumed_at_arrival, 4),
            gross_value_inr=round_half_up(self.gross_value_inr, 2),
            transport_cost_inr=round_half_up(self.transport_cost_inr, 2),
            expected_value_inr=round_half_up(self.expected_value_inr, 2),
            reasons=list(self.reasons),
            reason=self.reason,
        )


@dataclass(frozen=True, slots=True)
class _Context:
    """Batch-level inputs shared by every candidate (also echoed on each for reproducibility)."""

    origin: Origin
    qty_kg: float
    transit_temp_c: float
    transit_rate: float
    reference_shelf_life_hours: float
    consumed_now: float
    time_limit_hours: float  # remaining at transit temp, mid scenario, x SAFETY_FACTOR
    time_limit_pessimistic_hours: float  # same with the low scenario
    now: datetime


def _score(
    mandi: MandiLike,
    price: MandiPriceOut | None,
    *,
    ctx: _Context,
    estimate: ShelfLifeEstimate,
    protocol: dict[str, Any],
    settings: Settings,
) -> _Scored:
    straight = haversine_km(ctx.origin.lat, ctx.origin.lon, mandi.lat, mandi.lon)
    distance = straight * settings.ROAD_FACTOR
    travel_hours = distance / settings.AVG_SPEED_KMH
    transport_cost = distance * settings.TRANSPORT_COST_PER_KM_INR
    reasons: list[str] = []
    if ctx.origin.assumed:
        reasons.append(REASON_ORIGIN_ASSUMED)
    time_ok = travel_hours < ctx.time_limit_hours
    time_ok_pessimistic = travel_hours < ctx.time_limit_pessimistic_hours

    if price is None:
        reasons.append(REASON_NO_PRICE)
        return _Scored(
            mandi=mandi, price=None, straight_km=straight, distance_km=distance,
            travel_hours=travel_hours, feasible=False, feasible_pessimistic=time_ok_pessimistic,
            price_is_stale=True, price_age_days=None, consumed_now=ctx.consumed_now,
            consumed_at_arrival=ctx.consumed_now, gross_value_inr=0.0,
            transport_cost_inr=transport_cost, expected_value_inr=-transport_cost,
            reasons=reasons, reason=REJECT_NO_PRICE,
        )

    consumed_at_arrival = consumed_after(
        protocol, estimate, travel_hours, ctx.transit_temp_c, consumed_now=ctx.consumed_now
    )
    gross = price.modal_price / 100.0 * ctx.qty_kg * (1.0 - consumed_at_arrival)
    expected = gross - transport_cost
    stale_after = ctx.now - to_utc(price.fetched_at)
    age_days = price_age_days(price.reported_on, ctx.now)
    price_is_stale = (
        stale_after.total_seconds() > settings.PRICE_STALE_HOURS * 3600.0
        or age_days > settings.PRICE_STALE_HOURS / 24.0
    )
    if price_is_stale:
        reasons.append(REASON_PRICE_STALE)
    # Gates in precedence order: time rejection wins over a negative value.
    reason: str | None = None
    if not time_ok:
        reasons.append(REASON_INFEASIBLE)
        reason = REJECT_TOO_FAR
    elif expected <= 0.0:
        reasons.append(REASON_NOT_WORTH_TRIP)
        reason = REJECT_NEGATIVE_VALUE
    elif not time_ok_pessimistic:
        reasons.append(REASON_RISKY_PESSIMISTIC)
    return _Scored(
        mandi=mandi, price=price, straight_km=straight, distance_km=distance,
        travel_hours=travel_hours, feasible=time_ok and expected > 0.0,
        feasible_pessimistic=time_ok_pessimistic, price_is_stale=price_is_stale,
        price_age_days=age_days, consumed_now=ctx.consumed_now,
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
    consumed_now: float | None = None,
) -> Recommendation:
    """Rank mandis for the batch (contract section 3). Never raises for missing prices.

    `consumed_now` is the unrounded mid consumed fraction (`Evaluation.consumed_mid`); it
    defaults to the estimate's 4-dp wire value when the caller only has the estimate.
    """
    now = to_utc(now)
    transit_temp_c = transit_temperature(estimate, protocol)
    consumed = estimate.consumed_fraction if consumed_now is None else consumed_now
    ctx = _Context(
        origin=resolve_origin(batch, settings),
        qty_kg=float(batch.qty_kg),
        transit_temp_c=transit_temp_c,
        transit_rate=rate_multiplier(protocol, transit_temp_c),
        reference_shelf_life_hours=float(protocol["reference_shelf_life_hours"]),
        consumed_now=consumed,
        time_limit_hours=(
            remaining_hours_at(protocol, estimate, transit_temp_c, consumed_now=consumed)
            * settings.SAFETY_FACTOR
        ),
        time_limit_pessimistic_hours=(
            remaining_hours_at(
                protocol, estimate, transit_temp_c, scenario="low", consumed_now=consumed
            )
            * settings.SAFETY_FACTOR
        ),
        now=now,
    )
    commodity = str(protocol.get("commodity") or "")
    price_by_mandi = {p.mandi_id: p for p in prices if p.commodity == commodity}

    scored = [
        _score(
            mandi, price_by_mandi.get(mandi.id), ctx=ctx, estimate=estimate, protocol=protocol,
            settings=settings,
        )
        for mandi in mandis
    ]
    spoiled = estimate.status == "spoiled"
    if spoiled:
        for item in scored:
            if item.price is not None:
                item.feasible = False
                item.feasible_pessimistic = False
                # The cause is the batch, not the trip: drop the per-trip gate codes.
                item.reasons = [r for r in item.reasons if r not in _TRIP_GATE_REASONS]
                item.reasons.append(REASON_BATCH_SPOILED)
                item.reason = REJECT_BATCH_SPOILED

    feasible = sorted((s for s in scored if s.feasible), key=_Scored.rank_key)
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
    elif top is None and any(s.price is not None for s in scored):
        reason = REASON_NO_PROFITABLE

    ranked = [s.to_candidate(ctx) for s in feasible]
    return Recommendation(
        batch_id=batch.id,
        computed_at=now,
        model_version=MODEL_VERSION,
        shelf_life=estimate,
        top=ranked[0] if ranked else None,
        alternatives=ranked[1 : 1 + MAX_ALTERNATIVES],
        nearest=None if nearest is None else nearest.to_candidate(ctx),
        rejected=[s.to_candidate(ctx) for s in rejected],
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
