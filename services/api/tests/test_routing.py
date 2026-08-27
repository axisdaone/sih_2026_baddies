"""Routing engine (contract section 3): geo, ranking, feasibility, the demo hero case."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.config import get_settings
from app.enums import PriceSource
from app.kinetics import ReadingInput, evaluate
from app.kinetics.registry import get_protocol
from app.prices.snapshot import load_snapshot
from app.routing import haversine_km, recommend
from app.routing.engine import (
    REASON_BATCH_SPOILED,
    REASON_CLOSEST,
    REASON_INFEASIBLE,
    REASON_NO_PRICE,
    REASON_NO_PRICES,
    REASON_ORIGIN_ASSUMED,
    REASON_PRICE_STALE,
    REASON_TOP,
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
) -> Recommendation:
    protocol = get_protocol(protocol_id)
    harvested_at = now - timedelta(hours=hours_ago)
    readings = _scenario_readings(profile, harvested_at, hours_ago) if profile else []
    estimate = evaluate(protocol, harvested_at, readings, now)
    return recommend(
        batch or FakeBatch(),
        estimate,
        protocol,
        _mandis(),
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
    assert rec.top.expected_value_inr == pytest.approx(6638, rel=0.03)
    assert REASON_TOP in rec.top.reasons
    assert rec.top.feasible is True
    assert rec.top.transit_temp_c == 28.0  # last reading (0 h old), not the 30 C default
    assert rec.top.travel_hours == pytest.approx(2.1, abs=0.1)
    assert rec.top.distance_km == pytest.approx(72.5, rel=0.03)
    assert rec.top.modal_price_per_quintal == 1600.0
    assert rec.top.price_source == PriceSource.BUNDLED_SNAPSHOT
    assert rec.top.price_is_stale is True and REASON_PRICE_STALE in rec.top.reasons
    assert rec.top.consumed_at_arrival == pytest.approx(0.062, abs=0.003)
    assert rec.top.spoilage_at_arrival == rec.top.consumed_at_arrival

    assert [a.mandi_id for a in rec.alternatives] == ["bengaluru", "kolar"]
    assert rec.alternatives[0].expected_value_inr == pytest.approx(6196, rel=0.03)

    assert rec.nearest is not None and rec.nearest.mandi_id == "palacode"
    assert REASON_CLOSEST in rec.nearest.reasons
    assert rec.nearest.expected_value_inr == pytest.approx(4083, rel=0.03)
    assert rec.uplift_vs_nearest_pct is not None and rec.uplift_vs_nearest_pct >= 20
    assert rec.uplift_vs_nearest_pct == pytest.approx(63, abs=3)

    assert rec.rejected == []  # every mandi reachable within 0.8 x 80 h
    assert [c.mandi_id for c in rec.ranked[:3]] == ["hosur", "bengaluru", "kolar"]
    assert len(rec.ranked) == 13
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

    rejected = {c.mandi_id: c for c in rec.rejected}
    assert {"koyambedu", "madurai", "ottanchatram"} <= set(rejected)
    assert len(rec.ranked) + len(rec.rejected) == 13
    assert len(rec.ranked) == 10
    for candidate in rejected.values():
        assert candidate.feasible is False
        assert REASON_INFEASIBLE in candidate.reasons
        assert candidate.reason == REJECT_TOO_FAR
        limit = rec.shelf_life.remaining_hours.mid * get_settings().SAFETY_FACTOR
        assert candidate.travel_hours >= limit
    assert transit_temperature(rec.shelf_life, get_protocol("tomato")) == 30.0


def test_spoiled_batch_returns_no_top() -> None:
    rec = _recommend(hours_ago=100, profile=None)  # 100 h at the 30 C default -> spoiled
    assert rec.shelf_life.status == "spoiled"
    assert rec.top is None
    assert rec.reason == REASON_BATCH_SPOILED
    assert rec.alternatives == []
    assert rec.ranked == []
    assert rec.uplift_vs_nearest_pct is None
    assert len(rec.rejected) == 13
    assert all(REASON_INFEASIBLE in c.reasons for c in rec.rejected)
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
    assert rec.top.expected_value_inr == pytest.approx(14190, rel=0.03)
    assert {a.mandi_id for a in rec.alternatives} == {"koyambedu", "hosur"}


def test_uplift_is_none_when_nearest_value_not_positive() -> None:
    rec = _recommend(hours_ago=4, profile="cool_morning", batch=FakeBatch(qty_kg=1))
    assert rec.nearest is not None and rec.nearest.expected_value_inr <= 0
    assert rec.uplift_vs_nearest_pct is None


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
        "expected_value_inr", "reasons",
    }
    assert "from" in payload["shelf_life"]["segments"][0]
    assert Recommendation.model_validate(payload).top is not None  # round-trips
