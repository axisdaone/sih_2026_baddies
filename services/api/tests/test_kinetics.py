"""Unit tests for the pure kinetics evaluator (contract sections 2.2 / 2.3)."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest

from app.kinetics import (
    ALERT_THRESHOLDS_PCT,
    MODEL_VERSION,
    ReadingInput,
    consumed_after,
    evaluate,
    rate_multiplier,
    registry,
    round_half_up,
)
from app.schemas import ShelfLifeEstimate

T0 = datetime(2026, 8, 27, 0, 30, tzinfo=UTC)


def _proto(protocol_id: str) -> dict[str, Any]:
    return registry.get_protocol(protocol_id)


def _reading(temp_c: float, hours_after_t0: float, rid: str | None = None) -> ReadingInput:
    """Reading `hours_after_t0` hours after T0 (may be negative)."""
    return ReadingInput(
        id=rid or f"00000000-0000-4000-8000-{int(hours_after_t0 * 100) % 10**12:012d}",
        temp_c=temp_c,
        taken_at=T0 + timedelta(hours=hours_after_t0),
    )


def _constant(protocol_id: str, temp_c: float, hours: float) -> ShelfLifeEstimate:
    """A single reading at harvest held for `hours` (contract 2.3 anchor profile)."""
    return evaluate(_proto(protocol_id), T0, [_reading(temp_c, 0)], T0 + timedelta(hours=hours))


# --- contract 2.3 sanity anchors -----------------------------------------------------------


@pytest.mark.parametrize(
    ("protocol_id", "temp_c", "expected_mid_hours"),
    [
        ("tomato", 10, 288),
        ("tomato", 20, 144),
        ("tomato", 30, 72),
        ("guava", 10, 336),
        ("guava", 20, 134),
        ("guava", 30, 54),
    ],
)
def test_literature_anchors(protocol_id: str, temp_c: float, expected_mid_hours: int) -> None:
    estimate = _constant(protocol_id, temp_c, 0)
    assert estimate.consumed_fraction == 0.0
    assert round(estimate.remaining_hours.mid) == expected_mid_hours
    assert (
        estimate.remaining_hours.low < estimate.remaining_hours.mid < estimate.remaining_hours.high
    )


def test_anchor_ranges_at_reference_temperature() -> None:
    tomato = _constant("tomato", 10, 0)
    assert (tomato.remaining_hours.low, tomato.remaining_hours.high) == (240.0, 336.0)
    guava = _constant("guava", 10, 0)
    assert (guava.remaining_hours.low, guava.remaining_hours.high) == (240.0, 384.0)


def test_pharma_anchor_half_budget() -> None:
    estimate = evaluate(
        _proto("pharma_2_8"),
        T0,
        [_reading(15.0, 0), _reading(5.0, 6)],
        T0 + timedelta(hours=12),
    )
    assert estimate.consumed_fraction == 0.5
    assert estimate.remaining_hours.mid == 6.0
    # Each scenario integrates against its own budget: low = (1 - 6/10.8) * 10.8, high likewise.
    assert estimate.remaining_hours.low == pytest.approx(4.8)
    assert estimate.remaining_hours.high == pytest.approx(7.2)
    assert estimate.status == "warning"
    assert estimate.alerts_crossed == [75, 50]


# --- rate multiplier ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("temp_c", "expected"),
    [(10, 1.0), (5, 1.0), (-20, 1.0), (20, 2.0), (30, 4.0), (45, 2**3.5), (60, 2**3.5)],
)
def test_rate_multiplier_tomato_with_clamps(temp_c: float, expected: float) -> None:
    assert rate_multiplier(_proto("tomato"), temp_c) == pytest.approx(expected)


def test_rate_multiplier_guava_floor_is_eight() -> None:
    guava = _proto("guava")
    floor_rate = 2.5 ** ((8 - 10) / 10)
    assert rate_multiplier(guava, 8) == pytest.approx(floor_rate)
    assert rate_multiplier(guava, 4) == pytest.approx(floor_rate)
    assert rate_multiplier(guava, 10) == pytest.approx(1.0)


def test_rate_multiplier_q10_override() -> None:
    tomato = _proto("tomato")
    assert rate_multiplier(tomato, 20, q10=1.8) == pytest.approx(1.8)
    assert rate_multiplier(tomato, 20, q10=2.4) == pytest.approx(2.4)


@pytest.mark.parametrize(
    ("temp_c", "expected"),
    [(2.0, 0.0), (8.0, 0.0), (5.0, 0.0), (1.99, 1.0), (8.01, 1.0), (-1.0, 1.0), (30.0, 1.0)],
)
def test_rate_multiplier_excursion_band_inclusive(temp_c: float, expected: float) -> None:
    assert rate_multiplier(_proto("pharma_2_8"), temp_c) == expected


# --- monotonicity / heat spike -------------------------------------------------------------


def test_more_heat_consumes_more() -> None:
    consumed = [_constant("tomato", t, 12).consumed_fraction for t in (10, 15, 20, 25, 30, 35, 40)]
    assert all(b > a for a, b in zip(consumed, consumed[1:], strict=False))
    # Below the chilling floor the rate stops decreasing.
    at_floor = _constant("tomato", 10, 12).consumed_fraction
    assert _constant("tomato", 5, 12).consumed_fraction == at_floor


def test_heat_spike_accelerates_decay_versus_baseline() -> None:
    now = T0 + timedelta(hours=8)
    baseline = evaluate(
        _proto("tomato"), T0, [_reading(30, 0), _reading(30, 3), _reading(30, 5)], now
    )
    spiked = evaluate(
        _proto("tomato"), T0, [_reading(30, 0), _reading(40, 3), _reading(30, 5)], now
    )
    assert spiked.consumed_fraction > baseline.consumed_fraction
    assert spiked.remaining_hours.mid < baseline.remaining_hours.mid
    assert spiked.thermal_load_degree_hours > baseline.thermal_load_degree_hours
    # Same current temperature -> the gap is exactly the extra load of the 2 h spike.
    extra = (
        2 * (rate_multiplier(_proto("tomato"), 40) - rate_multiplier(_proto("tomato"), 30)) / 288
    )
    assert spiked.consumed_fraction - baseline.consumed_fraction == pytest.approx(extra, abs=1e-4)


# --- pharma excursion budget ---------------------------------------------------------------


def test_pharma_in_band_consumes_nothing() -> None:
    estimate = evaluate(
        _proto("pharma_2_8"), T0, [_reading(5.0, 0), _reading(7.9, 6)], T0 + timedelta(hours=12)
    )
    assert estimate.consumed_fraction == 0.0
    assert estimate.remaining_hours.mid == 12.0  # budget remaining, not infinity
    assert estimate.remaining_hours.low == pytest.approx(10.8)
    assert estimate.remaining_hours.high == pytest.approx(13.2)
    assert estimate.status == "fresh"
    assert estimate.alerts_crossed == []
    assert [s.rate for s in estimate.segments] == [0.0, 0.0]


def test_pharma_out_of_band_consumes_one_to_one() -> None:
    estimate = evaluate(
        _proto("pharma_2_8"), T0, [_reading(5.0, 0), _reading(12.0, 9)], T0 + timedelta(hours=12)
    )
    assert estimate.consumed_fraction == 0.25
    assert estimate.remaining_hours.mid == 9.0
    assert estimate.current_temp_c == 12.0
    assert estimate.segments[-1].rate == 1.0


def test_pharma_budget_exhausted_is_spoiled_without_breach() -> None:
    estimate = evaluate(_proto("pharma_2_8"), T0, [_reading(20.0, 0)], T0 + timedelta(hours=13))
    assert estimate.status == "spoiled"
    assert estimate.breach is None
    assert estimate.consumed_fraction == 1.0
    assert estimate.remaining_hours.mid == 0.0
    assert estimate.remaining_hours.high == pytest.approx(0.2)  # optimistic budget 13.2 h


def test_pharma_freeze_breach() -> None:
    readings = [_reading(5.0, 0, "r1"), _reading(-0.5, 1, "r2"), _reading(5.0, 2, "r3")]
    estimate = evaluate(_proto("pharma_2_8"), T0, readings, T0 + timedelta(hours=3))
    assert estimate.status == "spoiled"
    assert estimate.breach is not None
    assert estimate.breach.type == "min_temp"
    assert estimate.breach.value_c == 0.0
    assert estimate.breach.reading_id == "r2"
    assert estimate.breach.at == T0 + timedelta(hours=1)
    assert estimate.breach.label == "freeze"
    assert set(estimate.breach.model_dump(mode="json")) == {
        "type",
        "value_c",
        "reading_id",
        "at",
        "label",
    }
    assert estimate.remaining_hours.model_dump() == {"low": 0.0, "mid": 0.0, "high": 0.0}
    assert estimate.consumed_fraction == 1.0
    assert estimate.alerts_crossed == list(ALERT_THRESHOLDS_PCT)


def test_pharma_ambient_25_is_not_a_breach_but_25_01_is() -> None:
    ok = evaluate(_proto("pharma_2_8"), T0, [_reading(25.0, 0)], T0 + timedelta(hours=1))
    assert ok.breach is None and ok.status == "fresh"
    bad = evaluate(_proto("pharma_2_8"), T0, [_reading(25.01, 0)], T0 + timedelta(hours=1))
    assert bad.breach is not None and bad.breach.type == "max_temp"


# --- hard thresholds / status bands -------------------------------------------------------


def test_hard_threshold_is_strict() -> None:
    assert _constant("tomato", 45.0, 1).breach is None
    hot = _constant("tomato", 45.01, 1)
    assert hot.breach is not None
    assert hot.status == "spoiled"
    assert hot.remaining_fraction == 0.0


def test_breach_reports_first_breaching_reading() -> None:
    readings = [_reading(30, 0, "a"), _reading(46, 1, "b"), _reading(47, 2, "c")]
    estimate = evaluate(_proto("tomato"), T0, readings, T0 + timedelta(hours=3))
    assert estimate.breach is not None
    assert estimate.breach.reading_id == "b"
    assert estimate.breach.value_c == 45.0
    assert estimate.breach.label == "heat_damage"
    # Thermal load and segments are still reported for the "why" screen.
    assert estimate.thermal_load_degree_hours == pytest.approx(20 + 36 + 37)
    assert len(estimate.segments) == 3


@pytest.mark.parametrize(
    ("hours", "status", "alerts"),
    [
        (0, "fresh", []),
        (18, "fresh", [75]),
        (36, "warning", [75, 50]),
        (54, "critical", [75, 50, 25]),
        (72, "spoiled", [75, 50, 25]),
        (80, "spoiled", [75, 50, 25]),
    ],
)
def test_status_bands_and_alerts_tomato_30c(hours: float, status: str, alerts: list[int]) -> None:
    estimate = _constant("tomato", 30, hours)
    assert estimate.status == status
    assert estimate.alerts_crossed == alerts


def test_spoiled_by_consumption_keeps_optimistic_scenario() -> None:
    estimate = _constant("tomato", 30, 80)
    assert estimate.status == "spoiled"
    assert estimate.breach is None
    assert estimate.consumed_fraction == 1.0
    assert estimate.remaining_hours.mid == 0.0
    assert estimate.remaining_hours.high > 0.0  # (q10 1.8, L 336) has budget left


# --- timeline edge cases -------------------------------------------------------------------


def test_no_readings_uses_ambient_and_low_confidence() -> None:
    estimate = evaluate(_proto("tomato"), T0, [], T0 + timedelta(hours=6))
    assert estimate.hours_since_last_reading is None
    assert estimate.confidence == "low"
    assert estimate.current_temp_c == 30.0
    assert estimate.current_temp_assumed is True
    assert len(estimate.segments) == 1
    assert estimate.segments[0].assumed is True
    assert estimate.segments[0].hours == 6.0
    assert estimate.segments[0].rate == 4.0
    assert estimate.consumed_fraction == pytest.approx(24 / 288, abs=1e-4)


def test_now_equals_harvest_no_readings() -> None:
    estimate = evaluate(_proto("tomato"), T0, [], T0)
    assert estimate.segments == []
    assert estimate.consumed_fraction == 0.0
    assert estimate.remaining_hours.mid == 72.0
    assert estimate.expected_end.mid == T0 + timedelta(hours=72)


def test_now_before_harvest_does_not_crash() -> None:
    estimate = evaluate(_proto("tomato"), T0, [_reading(30, 0)], T0 - timedelta(hours=1))
    assert estimate.segments == []
    assert estimate.consumed_fraction == 0.0
    assert estimate.hours_since_last_reading is None  # the reading is after now -> dropped


def test_readings_after_now_dropped_everywhere() -> None:
    readings = [_reading(28, 1), _reading(50, 5)]  # 50 C would breach if counted
    estimate = evaluate(_proto("tomato"), T0, readings, T0 + timedelta(hours=3))
    assert estimate.breach is None
    assert estimate.confidence == "medium"
    assert estimate.hours_since_last_reading == 2.0
    assert [s.temp_c for s in estimate.segments] == [30.0, 28.0]


def test_reading_before_harvest_is_clamped() -> None:
    readings = [_reading(25, -1), _reading(30, 2)]
    estimate = evaluate(_proto("tomato"), T0, readings, T0 + timedelta(hours=4))
    assert estimate.segments[0].from_ == T0
    assert [(s.temp_c, s.hours, s.assumed) for s in estimate.segments] == [
        (25.0, 2.0, False),
        (30.0, 2.0, False),
    ]
    assert estimate.thermal_load_degree_hours == 70.0


def test_readings_are_sorted_and_ties_keep_input_order() -> None:
    readings = [_reading(30, 2, "later"), _reading(20, 1, "first"), _reading(35, 2, "tie-winner")]
    estimate = evaluate(_proto("tomato"), T0, readings, T0 + timedelta(hours=3))
    assert [s.temp_c for s in estimate.segments] == [30.0, 20.0, 35.0]
    assert estimate.current_temp_c == 35.0


def test_stale_last_reading_flags_assumed_and_confidence() -> None:
    fresh = evaluate(
        _proto("tomato"), T0, [_reading(28, 0), _reading(28, 1)], T0 + timedelta(hours=3)
    )
    assert (fresh.confidence, fresh.current_temp_assumed) == ("high", False)
    exactly_two = evaluate(
        _proto("tomato"), T0, [_reading(28, 0), _reading(28, 1)], T0 + timedelta(hours=3, seconds=0)
    )
    assert exactly_two.hours_since_last_reading == 2.0
    stale_medium = evaluate(
        _proto("tomato"), T0, [_reading(28, 0), _reading(28, 1)], T0 + timedelta(hours=5)
    )
    assert (stale_medium.confidence, stale_medium.current_temp_assumed) == ("medium", True)
    assert stale_medium.segments[-1].assumed is True
    stale_low = evaluate(
        _proto("tomato"), T0, [_reading(28, 0), _reading(28, 1)], T0 + timedelta(hours=10)
    )
    assert stale_low.confidence == "low"
    single_recent = evaluate(_proto("tomato"), T0, [_reading(28, 0)], T0 + timedelta(minutes=30))
    assert single_recent.confidence == "medium"  # one reading can never be "high"


def test_zero_duration_segments_are_not_emitted() -> None:
    estimate = evaluate(
        _proto("tomato"), T0, [_reading(20, 0), _reading(30, 2)], T0 + timedelta(hours=2)
    )
    assert [(s.temp_c, s.hours) for s in estimate.segments] == [(20.0, 2.0)]
    assert estimate.current_temp_c == 30.0
    assert estimate.hours_since_last_reading == 0.0


# --- datetimes / output boundary ----------------------------------------------------------


def test_naive_and_offset_datetimes_match_utc() -> None:
    ist = timezone(timedelta(hours=5, minutes=30))
    aware = evaluate(_proto("tomato"), T0, [_reading(28, 1)], T0 + timedelta(hours=3))
    naive = evaluate(
        _proto("tomato"),
        T0.replace(tzinfo=None),
        [ReadingInput("n", 28.0, (T0 + timedelta(hours=1)).replace(tzinfo=None))],
        (T0 + timedelta(hours=3)).replace(tzinfo=None),
    )
    offset = evaluate(
        _proto("tomato"),
        T0.astimezone(ist),
        [ReadingInput("n", 28.0, (T0 + timedelta(hours=1)).astimezone(ist))],
        (T0 + timedelta(hours=3)).astimezone(ist),
    )
    aware_json = aware.model_dump_json()
    assert naive.model_dump_json() == aware_json
    assert offset.model_dump_json() == aware_json
    assert '"computed_at":"2026-08-27T03:30:00Z"' in aware_json


def test_expected_end_matches_rounded_hours_and_json_shape() -> None:
    now = T0 + timedelta(hours=5, minutes=17, seconds=3)
    estimate = evaluate(_proto("guava"), T0, [_reading(27.3, 0.4), _reading(31.1, 4.9)], now)
    payload = json.loads(estimate.model_dump_json())
    for scenario in ("low", "mid", "high"):
        hours = payload["remaining_hours"][scenario]
        assert hours == round(hours, 1)
        end = datetime.fromisoformat(payload["expected_end"][scenario].replace("Z", "+00:00"))
        assert end == now + timedelta(hours=hours)
    assert payload["consumed_fraction"] == round(payload["consumed_fraction"], 4)
    assert payload["segments"][0]["from"] == "2026-08-27T00:30:00Z"
    assert set(payload) == {
        "protocol_id",
        "model_version",
        "computed_at",
        "status",
        "confidence",
        "consumed_fraction",
        "remaining_fraction",
        "remaining_hours",
        "expected_end",
        "current_temp_c",
        "current_temp_assumed",
        "hours_since_last_reading",
        "thermal_load_degree_hours",
        "alerts_crossed",
        "breach",
        "segments",
    }


def test_round_half_up_matches_js_math_round() -> None:
    assert round_half_up(0.03125, 4) == 0.0313  # Python's round() would give 0.0312
    assert round_half_up(0.25, 1) == 0.3
    assert round_half_up(0.08333333, 4) == 0.0833
    assert round_half_up(66.04, 1) == 66.0
    assert round_half_up(0.0, 4) == 0.0
    assert round_half_up(2.5, 0) == 3.0


def test_model_version_matches_registry() -> None:
    assert MODEL_VERSION == registry.MODEL_VERSION == "kinetics-1.0"
    assert _constant("tomato", 30, 1).model_version == MODEL_VERSION


def test_evaluate_is_deterministic_and_fast() -> None:
    readings = [_reading(26 + (i % 5) * 2.5, i) for i in range(8)]
    now = T0 + timedelta(hours=9)
    protocol = _proto("tomato")
    first = evaluate(protocol, T0, readings, now).model_dump_json()
    started = time.perf_counter()
    for _ in range(200):
        assert evaluate(protocol, T0, readings, now).model_dump_json() == first
    per_call_ms = (time.perf_counter() - started) / 200 * 1000
    assert per_call_ms < 5.0, f"evaluate() too slow: {per_call_ms:.2f} ms/call"


# --- consumed_after (routing hook) --------------------------------------------------------


def test_consumed_after_adds_mid_scenario_load() -> None:
    tomato = _proto("tomato")
    estimate = _constant("tomato", 30, 6)  # consumed 24/288
    assert consumed_after(tomato, estimate, 0, 30) == estimate.consumed_fraction
    assert consumed_after(tomato, estimate, 6, 30) == pytest.approx(
        estimate.consumed_fraction + 24 / 288
    )
    assert consumed_after(tomato, estimate, 6, 10) == pytest.approx(
        estimate.consumed_fraction + 6 / 288
    )
    assert consumed_after(tomato, estimate, 1000, 30) == 1.0


def test_consumed_after_pharma_uses_budget() -> None:
    pharma = _proto("pharma_2_8")
    estimate = evaluate(pharma, T0, [_reading(5.0, 0)], T0 + timedelta(hours=1))
    assert consumed_after(pharma, estimate, 3, 5.0) == 0.0
    assert consumed_after(pharma, estimate, 3, 12.0) == pytest.approx(0.25)


def test_remaining_hours_at_reprojects_at_another_temperature() -> None:
    """Routing feasibility: remaining hours at the transit temperature, from the same consumed
    fraction, with the low/high scenarios available and the excursion `r == 0` branch intact."""
    from app.kinetics import evaluate_detailed, remaining_hours_at

    tomato = _proto("tomato")
    detailed = evaluate_detailed(
        tomato, T0, [_reading(30.0, 0), _reading(12.0, 3)], T0 + timedelta(hours=6)
    )
    estimate = detailed.estimate
    assert detailed.estimate == evaluate(
        tomato, T0, [_reading(30.0, 0), _reading(12.0, 3)], T0 + timedelta(hours=6)
    )
    assert round_half_up(detailed.consumed_mid, 4) == estimate.consumed_fraction
    # At the last reading's temperature the helper reproduces the wire figure (1 dp).
    assert round_half_up(remaining_hours_at(tomato, estimate, 12.0), 1) == pytest.approx(
        estimate.remaining_hours.mid, abs=0.1
    )
    at_30 = remaining_hours_at(tomato, estimate, 30.0)
    assert at_30 == pytest.approx((1 - estimate.consumed_fraction) * 288 / 4.0, rel=1e-6)
    assert at_30 < remaining_hours_at(tomato, estimate, 12.0)
    low = remaining_hours_at(tomato, estimate, 30.0, scenario="low")
    high = remaining_hours_at(tomato, estimate, 30.0, scenario="high")
    assert low < at_30 < high
    # The unrounded start continues the integral exactly; the rounded one is within 5e-5.
    exact = remaining_hours_at(tomato, estimate, 30.0, consumed_now=detailed.consumed_mid)
    assert exact == pytest.approx(at_30, abs=288 / 4.0 * 5e-5)

    pharma = _proto("pharma_2_8")
    in_band = evaluate(pharma, T0, [_reading(15.0, 0), _reading(5.0, 6)], T0 + timedelta(hours=12))
    assert remaining_hours_at(pharma, in_band, 5.0) == pytest.approx(6.0)  # budget remaining
    assert remaining_hours_at(pharma, in_band, 30.0) == pytest.approx(6.0)  # r = 1 -> 6 h
    with pytest.raises(KeyError):
        remaining_hours_at(tomato, estimate, 30.0, scenario="worst")
