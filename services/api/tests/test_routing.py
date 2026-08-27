"""Routing engine (contract section 3): geo, ranking, feasibility, the demo hero case."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.config import get_settings
from app.enums import PriceSource
from app.kinetics import ReadingInput, evaluate, remaining_hours_at
from app.kinetics.registry import get_protocol
from app.prices.snapshot import load_snapshot
from app.routing import haversine_km, recommend
from app.routing.engine import (
    REASON_BATCH_SPOILED,
    REASON_CLOSEST,
    REASON_INFEASIBLE,
    REASON_NO_PRICE,
    REASON_NO_PRICES,
    REASON_NO_PROFITABLE,
    REASON_NOT_WORTH_TRIP,
    REASON_ORIGIN_ASSUMED,
    REASON_PRICE_STALE,
    REASON_RISKY_PESSIMISTIC,
    REASON_TOP,
    REJECT_BATCH_SPOILED,
    REJECT_NEGATIVE_VALUE,
    REJECT_NO_PRICE,
    REJECT_TOO_FAR,
    transit_temperature,
)
from app.schemas import MandiPriceOut, Recommendation
from app.seed import load_mandis_file

NOW = datetime(2026, 8, 27, 10, 30, tzinfo=UTC)
DEMO_ORIGIN = (12.30, 78.07)


@dataclass(frozen=True)
class FakeBatch:
    id: str = "6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01"
    qty_kg: float = 500.0
    origin_lat: float | None = DEMO_ORIGIN[0]
    origin_lon: float | None = DEMO_ORIGIN[1]


@dataclass(frozen=True)
class FakeMandi:
    id: str
    name: str
    district: str
    lat: float
    lon: float


def _mandis() -> list[FakeMandi]:
    return [
        FakeMandi(m["id"], m["name"], m["district"], m["lat"], m["lon"])
        for m in load_mandis_file()["mandis"]
    ]


def _snapshot_prices() -> list[MandiPriceOut]:
    snapshot = load_snapshot()
    return [
        MandiPriceOut(
            mandi_id=r.mandi_id,
            commodity=r.commodity,
            variety=r.variety,
            modal_price=r.modal_price,
            min_price=r.min_price,
            max_price=r.max_price,
            arrival_qty=r.arrival_qty,
            reported_on=r.reported_on,
            fetched_at=snapshot.fetched_at,
            source=PriceSource.BUNDLED_SNAPSHOT,
        )
        for r in snapshot.records
    ]


def _scenario_readings(
    profile: str, harvested_at: datetime, max_offset_hours: float
) -> list[ReadingInput]:
    path = get_settings().DATA_DIR / "demo_scenarios" / f"{profile}.json"
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    return [
        ReadingInput(
            id=f"00000000-0000-4000-8000-{i:012d}",
            temp_c=float(r["temp_c"]),
            taken_at=harvested_at + timedelta(hours=float(r["offset_hours"])),
        )
        for i, r in enumerate(doc["readings"], start=1)
        if float(r["offset_hours"]) <= max_offset_hours
    ]


def _recommend(
    *,
    protocol_id: str = "tomato",
    hours_ago: float,
    profile: str | None,
    batch: FakeBatch | None = None,
    prices: list[MandiPriceOut] | None = None,
    now: datetime = NOW,
    readings: list[ReadingInput] | None = None,
    mandis: list[FakeMandi] | None = None,
) -> Recommendation:
    protocol = get_protocol(protocol_id)
    harvested_at = now - timedelta(hours=hours_ago)
    if readings is None:
        readings = _scenario_readings(profile, harvested_at, hours_ago) if profile else []
    estimate = evaluate(protocol, harvested_at, readings, now)
    return recommend(
        batch or FakeBatch(),
        estimate,
        protocol,
        _mandis() if mandis is None else mandis,
        _snapshot_prices() if prices is None else prices,
        get_settings(),
        now,
    )


# --- geo ----------------------------------------------------------------------------------


def test_haversine_dharmapuri_to_koyambedu() -> None:
    km = haversine_km(12.1211, 78.1582, 13.0694, 80.1948)
    assert km == pytest.approx(240, rel=0.05)


def test_haversine_basics() -> None:
    assert haversine_km(12.3, 78.07, 12.3, 78.07) == 0.0
    assert haversine_km(12.3, 78.07, 12.7409, 77.8253) == pytest.approx(
        haversine_km(12.7409, 77.8253, 12.3, 78.07)
    )
    # data/README.md: Palacode 0.6 km and Hosur 56 km from the demo origin.
    assert haversine_km(*DEMO_ORIGIN, 12.3050, 78.0730) == pytest.approx(0.6, abs=0.2)
    assert haversine_km(*DEMO_ORIGIN, 12.7409, 77.8253) == pytest.approx(56, rel=0.03)


# --- hero case ----------------------------------------------------------------------------


def test_hero_case_recommends_hosur_with_uplift_over_palacode() -> None:
    rec = _recommend(hours_ago=4, profile="cool_morning")
    assert rec.shelf_life.status == "fresh"
    assert rec.shelf_life.confidence == "high"
    assert rec.shelf_life.consumed_fraction == pytest.approx(0.036, abs=0.002)

    assert rec.top is not None
    assert rec.top.mandi_id == "hosur"
    assert rec.top.expected_value_inr == pytest.approx(6608, rel=0.03)
    assert REASON_TOP in rec.top.reasons
    assert rec.top.feasible is True and rec.top.feasible_pessimistic is True
    # Last reading (28 C, 0 h old) is cooler than the 30 C ambient: the trip assumes ambient.
    assert rec.top.transit_temp_c == 30.0
    assert rec.top.travel_hours == pytest.approx(2.1, abs=0.1)
    assert rec.top.distance_km == pytest.approx(72.5, rel=0.03)
    assert rec.top.modal_price_per_quintal == 1600.0
    assert rec.top.price_source == PriceSource.BUNDLED_SNAPSHOT
    assert rec.top.price_is_stale is True and REASON_PRICE_STALE in rec.top.reasons
    assert rec.top.price_age_days == 2  # reported 2026-08-25, recommended 2026-08-27
    assert rec.top.consumed_at_arrival == pytest.approx(0.065, abs=0.003)
    assert rec.top.spoilage_at_arrival == rec.top.consumed_at_arrival
    # Reproducibility payload: trip share = travel_hours x r(transit) / L_ref.
    assert rec.top.qty_kg == 500.0
    assert rec.top.reference_shelf_life_hours == 288.0
    assert rec.top.transit_rate == pytest.approx(4.0, abs=1e-4)  # tomato q10=2 at 30 C
    assert rec.top.trip_consumed_fraction == pytest.approx(2.07 * 4.0 / 288, abs=0.001)
    assert rec.top.consumed_at_arrival == pytest.approx(
        rec.shelf_life.consumed_fraction + rec.top.trip_consumed_fraction, abs=0.0002
    )

    assert [a.mandi_id for a in rec.alternatives] == ["bengaluru", "kolar"]
    assert rec.alternatives[0].expected_value_inr == pytest.approx(6147, rel=0.03)

    assert rec.nearest is not None and rec.nearest.mandi_id == "palacode"
    assert REASON_CLOSEST in rec.nearest.reasons
    assert rec.nearest.expected_value_inr == pytest.approx(4083, rel=0.03)
    assert rec.uplift_vs_nearest_pct is not None and rec.uplift_vs_nearest_pct >= 20
    assert rec.uplift_vs_nearest_pct == pytest.approx(62, abs=3)

    assert rec.rejected == []  # every mandi reachable within 0.8 x 80 h, all profitable
    assert [c.mandi_id for c in rec.ranked[:3]] == ["hosur", "bengaluru", "kolar"]
    assert len(rec.ranked) == 13
    assert all(c.expected_value_inr > 0 for c in rec.ranked)
    assert all(c.feasible_pessimistic for c in rec.ranked)
    assert not any(REASON_RISKY_PESSIMISTIC in c.reasons for c in rec.ranked)
    assert rec.reason is None
    assert rec.model_version == "routing-1.0"
    assert rec.batch_id == FakeBatch().id
    assert rec.computed_at == NOW
    assert rec.simulated is False
    settings = get_settings()
    assert rec.constants.model_dump() == {
        "road_factor": settings.ROAD_FACTOR,
        "avg_speed_kmh": settings.AVG_SPEED_KMH,
        "safety_factor": settings.SAFETY_FACTOR,
        "transport_cost_per_km_inr": settings.TRANSPORT_COST_PER_KM_INR,
    }


def test_candidate_arithmetic_matches_contract_formulas() -> None:
    rec = _recommend(hours_ago=4, profile="cool_morning")
    settings = get_settings()
    hosur = rec.top
    assert hosur is not None
    assert hosur.distance_km == pytest.approx(hosur.straight_km * settings.ROAD_FACTOR, abs=0.1)
    assert hosur.travel_hours == pytest.approx(hosur.distance_km / settings.AVG_SPEED_KMH, abs=0.01)
    assert hosur.transport_cost_inr == pytest.approx(
        hosur.distance_km * settings.TRANSPORT_COST_PER_KM_INR, abs=1.5
    )
    assert hosur.gross_value_inr == pytest.approx(
        1600 / 100 * 500 * (1 - hosur.consumed_at_arrival), abs=1.0
    )
    assert hosur.expected_value_inr == pytest.approx(
        hosur.gross_value_inr - hosur.transport_cost_inr, abs=0.02
    )


# --- feasibility --------------------------------------------------------------------------


def test_sixty_hour_hot_afternoon_batch_rejects_far_mandis() -> None:
    rec = _recommend(hours_ago=60, profile="hot_afternoon", batch=FakeBatch(qty_kg=300))
    assert rec.shelf_life.status == "critical"
    assert rec.shelf_life.confidence == "low"
    assert rec.top is not None and rec.top.mandi_id == "palacode"
    assert rec.top.expected_value_inr == pytest.approx(302, rel=0.05)
    assert rec.top.transit_temp_c == 30.0  # last reading is 52 h old -> protocol ambient
    assert rec.uplift_vs_nearest_pct == 0.0
    # Pessimistic remaining is 0 h: the only feasible mandi is flagged risky, not rejected.
    assert rec.shelf_life.remaining_hours.low == 0.0
    assert rec.top.feasible_pessimistic is False
    assert REASON_RISKY_PESSIMISTIC in rec.top.reasons

    rejected = {c.mandi_id: c for c in rec.rejected}
    assert {"koyambedu", "madurai", "ottanchatram"} <= set(rejected)
    assert len(rec.ranked) + len(rec.rejected) == 13
    assert len(rec.ranked) == 1 and rec.alternatives == []
    assert len(rec.rejected) == 12
    protocol = get_protocol("tomato")
    limit = (
        remaining_hours_at(protocol, rec.shelf_life, rec.top.transit_temp_c)
        * get_settings().SAFETY_FACTOR
    )
    for mandi_id in ("koyambedu", "madurai", "ottanchatram"):
        candidate = rejected[mandi_id]
        assert candidate.feasible is False
        assert REASON_INFEASIBLE in candidate.reasons
        assert candidate.reason == REJECT_TOO_FAR
        assert candidate.travel_hours >= limit
    for mandi_id in rejected.keys() - {"koyambedu", "madurai", "ottanchatram"}:
        candidate = rejected[mandi_id]  # dharmapuri .. coimbatore: reachable but a loss
        assert candidate.feasible is False
        assert candidate.reason == REJECT_NEGATIVE_VALUE
        assert REASON_NOT_WORTH_TRIP in candidate.reasons
        assert REASON_INFEASIBLE not in candidate.reasons
        assert candidate.expected_value_inr <= 0
        assert candidate.travel_hours < limit
    assert transit_temperature(rec.shelf_life, protocol) == 30.0


def test_spoiled_batch_returns_no_top() -> None:
    rec = _recommend(hours_ago=100, profile=None)  # 100 h at the 30 C default -> spoiled
    assert rec.shelf_life.status == "spoiled"
    assert rec.top is None
    assert rec.reason == REASON_BATCH_SPOILED
    assert rec.alternatives == []
    assert rec.ranked == []
    assert rec.uplift_vs_nearest_pct is None
    assert len(rec.rejected) == 13
    # The cause is the batch, not the distance: 0.8 km Palacode is not "too far".
    assert all(REASON_BATCH_SPOILED in c.reasons for c in rec.rejected)
    assert all(c.reason == REJECT_BATCH_SPOILED for c in rec.rejected)
    assert not any(REASON_INFEASIBLE in c.reasons for c in rec.rejected)
    assert rec.nearest is not None and rec.nearest.mandi_id == "palacode"


# --- origin / prices edge cases -----------------------------------------------------------


def test_missing_origin_uses_demo_origin_and_flags_it() -> None:
    rec = _recommend(
        hours_ago=4, profile="cool_morning", batch=FakeBatch(origin_lat=None, origin_lon=None)
    )
    assert rec.top is not None and rec.top.mandi_id == "hosur"
    assert REASON_ORIGIN_ASSUMED in rec.top.reasons
    assert all(REASON_ORIGIN_ASSUMED in c.reasons for c in rec.ranked)


def test_no_prices_at_all_never_errors() -> None:
    rec = _recommend(hours_ago=4, profile="cool_morning", prices=[])
    assert rec.top is None
    assert rec.reason == REASON_NO_PRICES
    assert len(rec.rejected) == 13
    for candidate in rec.rejected:
        assert candidate.reason == REJECT_NO_PRICE
        assert REASON_NO_PRICE in candidate.reasons
        assert candidate.modal_price_per_quintal is None
        assert candidate.price_reported_on is None
        assert candidate.price_fetched_at is None
        assert candidate.price_source == PriceSource.UNKNOWN
        assert candidate.feasible is False
    assert rec.nearest is not None and rec.nearest.mandi_id == "palacode"
    assert rec.uplift_vs_nearest_pct is None


def test_mandi_without_price_is_rejected_not_ranked() -> None:
    prices = [p for p in _snapshot_prices() if p.mandi_id != "hosur"]
    rec = _recommend(hours_ago=4, profile="cool_morning", prices=prices)
    assert rec.top is not None and rec.top.mandi_id == "bengaluru"
    hosur = next(c for c in rec.rejected if c.mandi_id == "hosur")
    assert hosur.reason == REJECT_NO_PRICE
    assert len(rec.ranked) == 12


def test_guava_uses_guava_prices_only() -> None:
    rec = _recommend(
        protocol_id="guava", hours_ago=12, profile="pre_cooled", batch=FakeBatch(qty_kg=400)
    )
    assert rec.top is not None and rec.top.mandi_id == "bengaluru"
    assert rec.top.modal_price_per_quintal == 4200.0
    # The 12 C pre-cooled reading does not carry into the trip: transit assumes the 30 C ambient.
    assert rec.top.transit_temp_c == 30.0
    assert rec.top.expected_value_inr == pytest.approx(13338, rel=0.03)
    assert {a.mandi_id for a in rec.alternatives} == {"koyambedu", "hosur"}


def test_uplift_is_none_when_nearest_value_not_positive() -> None:
    rec = _recommend(hours_ago=4, profile="cool_morning", batch=FakeBatch(qty_kg=1))
    assert rec.nearest is not None and rec.nearest.expected_value_inr <= 0
    assert rec.uplift_vs_nearest_pct is None
    # 1 kg is not worth any trip: nothing is ranked and the card gets an honest reason.
    assert rec.top is None
    assert rec.reason == REASON_NO_PROFITABLE
    assert rec.ranked == [] and rec.alternatives == []
    assert len(rec.rejected) == 13
    assert all(c.reason == REJECT_NEGATIVE_VALUE for c in rec.rejected)
    assert all(c.feasible is False and c.expected_value_inr <= 0 for c in rec.rejected)


def test_stale_cold_reading_does_not_make_far_mandi_feasible() -> None:
    """Feasibility is projected at the transit temperature, like spoilage-at-arrival: a 3 h old
    12 C reading gives 178 h remaining *at 12 C*, but the trip is integrated at 30 C, so a
    mandi ~55 h away must be rejected as too far rather than 'feasible' and arriving spoiled."""
    protocol = get_protocol("tomato")
    harvested_at = NOW - timedelta(hours=6)
    readings = [
        ReadingInput("00000000-0000-4000-8000-000000000001", 30.0, harvested_at),
        ReadingInput("00000000-0000-4000-8000-000000000002", 12.0, NOW - timedelta(hours=3)),
    ]
    estimate = evaluate(protocol, harvested_at, readings, NOW)
    assert estimate.current_temp_assumed is True and estimate.current_temp_c == 12.0
    assert estimate.remaining_hours.mid > 150  # projected at the stale 12 C reading
    far = FakeMandi("far", "Far", "Nowhere", 12.30 + 70 * 35 / 1.3 / 111.0, 78.07)
    near = FakeMandi("palacode", "Palacode", "Dharmapuri", 12.305, 78.073)
    prices = [p for p in _snapshot_prices() if p.mandi_id == "palacode"]
    prices.append(prices[0].model_copy(update={"mandi_id": "far", "modal_price": 9000.0}))
    rec = _recommend(
        hours_ago=6, profile=None, readings=readings, mandis=[near, far], prices=prices
    )
    far_out = next(c for c in rec.rejected if c.mandi_id == "far")
    assert far_out.travel_hours > 65
    assert far_out.feasible is False and far_out.reason == REJECT_TOO_FAR
    assert far_out.transit_temp_c == 30.0
    assert far_out.spoilage_at_arrival == 1.0
    assert rec.top is not None and rec.top.mandi_id == "palacode"
    limit = remaining_hours_at(protocol, estimate, 30.0) * get_settings().SAFETY_FACTOR
    assert far_out.travel_hours >= limit > rec.top.travel_hours


def test_fresh_price_ranks_before_stale_price() -> None:
    """Mixed provenance after a partial live refresh: today's price at Palacode outranks a
    2-day-old snapshot price at Hosur even though the stale gross value is higher."""
    prices = []
    for price in _snapshot_prices():
        if price.mandi_id == "palacode":
            price = price.model_copy(
                update={
                    "reported_on": NOW.date(),
                    "fetched_at": NOW - timedelta(hours=1),
                    "source": PriceSource.AGMARKNET_LIVE,
                    "modal_price": 1000.0,
                }
            )
        prices.append(price)
    rec = _recommend(hours_ago=4, profile="cool_morning", prices=prices)
    assert rec.top is not None and rec.top.mandi_id == "palacode"
    assert rec.top.price_is_stale is False and rec.top.price_age_days == 0
    assert rec.ranked[1].mandi_id == "hosur" and rec.ranked[1].price_is_stale is True
    assert rec.ranked[1].expected_value_inr > rec.top.expected_value_inr


def test_old_reported_date_is_stale_even_when_fetched_recently() -> None:
    """A live fetch on a market holiday returns last week's records: age by reported_on."""
    prices = [
        p.model_copy(update={"fetched_at": NOW - timedelta(hours=1)}) for p in _snapshot_prices()
    ]
    rec = _recommend(hours_ago=4, profile="cool_morning", prices=prices)
    assert rec.top is not None
    assert rec.top.price_age_days == 2 and rec.top.price_is_stale is True


def test_pessimistically_safe_mandi_ranks_first() -> None:
    """A mandi reachable only in the mid case ranks after one that is safe in the low case,
    even when its expected value is higher (and it carries the risky reason code)."""
    protocol = get_protocol("tomato")
    hours_ago = 20
    harvested_at = NOW - timedelta(hours=hours_ago)
    readings = _scenario_readings("hot_afternoon", harvested_at, hours_ago)
    estimate = evaluate(protocol, harvested_at, readings, NOW)
    low_limit = remaining_hours_at(protocol, estimate, 30.0, scenario="low") * 0.8
    mid_limit = remaining_hours_at(protocol, estimate, 30.0) * 0.8
    assert 0 < low_limit < mid_limit
    risky_hours = (low_limit + mid_limit) / 2
    risky = FakeMandi("risky", "Risky", "X", 12.30 + risky_hours * 35 / 1.3 / 111.0, 78.07)
    near = FakeMandi("palacode", "Palacode", "Dharmapuri", 12.305, 78.073)
    base = next(p for p in _snapshot_prices() if p.mandi_id == "palacode")
    prices = [base, base.model_copy(update={"mandi_id": "risky", "modal_price": 20000.0})]
    rec = _recommend(
        hours_ago=hours_ago, profile="hot_afternoon", mandis=[near, risky], prices=prices,
        batch=FakeBatch(qty_kg=800),
    )
    by_id = {c.mandi_id: c for c in rec.ranked}
    assert set(by_id) == {"palacode", "risky"}
    assert by_id["risky"].expected_value_inr > by_id["palacode"].expected_value_inr
    assert by_id["risky"].feasible_pessimistic is False
    assert REASON_RISKY_PESSIMISTIC in by_id["risky"].reasons
    assert rec.top is not None and rec.top.mandi_id == "palacode"


def test_payload_json_shape_matches_contract() -> None:
    rec = _recommend(hours_ago=4, profile="cool_morning")
    payload: dict[str, Any] = rec.model_dump(mode="json")
    assert set(payload) >= {
        "batch_id", "computed_at", "model_version", "shelf_life", "top", "alternatives",
        "nearest", "rejected", "uplift_vs_nearest_pct", "reason", "constants", "simulated",
    }
    assert payload["computed_at"] == "2026-08-27T10:30:00Z"
    assert payload["top"]["price_reported_on"] == "2026-08-25"
    assert payload["top"]["price_fetched_at"] == "2026-08-25T03:30:00Z"
    assert set(payload["top"]) >= {
        "mandi_id", "name", "district", "lat", "lon", "straight_km", "distance_km",
        "travel_hours", "feasible", "modal_price_per_quintal", "price_reported_on",
        "price_fetched_at", "price_is_stale", "price_source", "transit_temp_c",
        "consumed_at_arrival", "spoilage_at_arrival", "gross_value_inr", "transport_cost_inr",
        "expected_value_inr", "reasons", "feasible_pessimistic", "price_age_days", "qty_kg",
        "transit_rate", "reference_shelf_life_hours", "trip_consumed_fraction",
    }
    assert "from" in payload["shelf_life"]["segments"][0]
    assert Recommendation.model_validate(payload).top is not None  # round-trips


# --- pitch comparison (demo_seed.json -> loss_comparison) -------------------------------------


def _loss_comparison() -> dict[str, Any]:
    path = get_settings().DATA_DIR / "demo_scenarios" / "demo_seed.json"
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["loss_comparison"]


@pytest.mark.parametrize("arm_key", ["baseline", "farmsignal", "harvest_timing_bonus"])
def test_loss_comparison_arm_reproduces_from_the_engine(arm_key: str) -> None:
    """The slide numbers are static text in demo_seed.json; pin them to what the engine computes
    so the pitch can never drift from the model (docs/DEMO-SCRIPT.md section 3:15)."""
    arm = _loss_comparison()[arm_key]
    rec = _recommend(hours_ago=float(arm["evaluate_at_offset_hours"]), profile=arm["scenario"])
    candidates = [c for c in rec.ranked + rec.rejected if c.mandi_id == arm["mandi_id"]]
    assert candidates, f"{arm['mandi_id']} missing from the recommendation"
    cand = candidates[0]
    assert cand.consumed_at_arrival * 100 == pytest.approx(arm["consumed_at_sale_pct"], abs=0.15)
    assert cand.expected_value_inr == pytest.approx(arm["expected_value_inr"], abs=5)
    if arm_key != "baseline":
        assert rec.top is not None and rec.top.mandi_id == arm["mandi_id"]
