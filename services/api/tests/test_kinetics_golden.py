"""Cross-language golden cases (data/demo_scenarios/golden_kinetics.json, contract section 2.2).

The TypeScript engine runs the same file; only keys present under `expected` are asserted.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from app.kinetics import MODEL_VERSION, ReadingInput, evaluate
from app.kinetics.registry import get_protocol
from app.schemas import iso_z, parse_iso_z

GOLDEN_PATH = (
    Path(__file__).resolve().parents[3] / "data" / "demo_scenarios" / "golden_kinetics.json"
)


def _load() -> dict[str, Any]:
    with open(GOLDEN_PATH, encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


GOLDEN = _load()
TOL_HOURS = float(GOLDEN["tolerances"]["hours"])
TOL_FRACTION = float(GOLDEN["tolerances"]["fractions"])
TOL_DEGREE_HOURS = float(GOLDEN["tolerances"]["degree_hours"])
CASES: list[dict[str, Any]] = GOLDEN["cases"]


def _readings(case: dict[str, Any]) -> list[ReadingInput]:
    return [
        ReadingInput(id=r["id"], temp_c=float(r["temp_c"]), taken_at=parse_iso_z(r["taken_at"]))
        for r in case["readings"]
    ]


def _run(case: dict[str, Any]) -> Any:
    return evaluate(
        get_protocol(case["protocol_id"]),
        parse_iso_z(case["harvested_at"]),
        _readings(case),
        parse_iso_z(case["now"]),
    )


def test_golden_file_shape() -> None:
    assert GOLDEN["model_version"] == MODEL_VERSION
    assert len(CASES) == 26
    assert len({c["id"] for c in CASES}) == len(CASES)


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_golden_case(case: dict[str, Any]) -> None:
    protocol = get_protocol(case["protocol_id"])
    estimate = _run(case)
    expected = case["expected"]

    assert estimate.status == expected["status"], case["note"]
    assert estimate.confidence == expected["confidence"], case["note"]
    assert estimate.consumed_fraction == pytest.approx(
        expected["consumed_fraction"], abs=TOL_FRACTION
    )
    assert estimate.remaining_fraction == pytest.approx(
        expected["remaining_fraction"], abs=TOL_FRACTION
    )
    for scenario in ("low", "mid", "high"):
        assert getattr(estimate.remaining_hours, scenario) == pytest.approx(
            expected["remaining_hours"][scenario], abs=TOL_HOURS
        ), f"{case['id']}: remaining_hours.{scenario}"
    assert estimate.current_temp_c == pytest.approx(expected["current_temp_c"], abs=1e-9)
    assert estimate.current_temp_assumed is expected["current_temp_assumed"]
    if "hours_since_last_reading" in expected:
        assert estimate.hours_since_last_reading == pytest.approx(
            expected["hours_since_last_reading"], abs=TOL_HOURS
        )
    else:
        assert not case["readings"]
        assert estimate.hours_since_last_reading is None
    assert estimate.thermal_load_degree_hours == pytest.approx(
        expected["thermal_load_degree_hours"], abs=TOL_DEGREE_HOURS
    )
    assert estimate.alerts_crossed == expected["alerts_crossed"]

    # `breach_type` in the file is the hard_threshold *label*; the wire Breach carries the
    # threshold's type/value_c plus the offending reading.
    if expected["breach_type"] is None:
        assert estimate.breach is None
    else:
        threshold = next(
            t for t in protocol["hard_thresholds"] if t["label"] == expected["breach_type"]
        )
        assert estimate.breach is not None
        assert estimate.breach.type == threshold["type"]
        assert estimate.breach.value_c == pytest.approx(threshold["value_c"])
        assert any(r["id"] == estimate.breach.reading_id for r in case["readings"])


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_golden_case_invariants(case: dict[str, Any]) -> None:
    """Fields the golden file does not assert but the contract fixes: ends, segments, JSON shape."""
    now = parse_iso_z(case["now"])
    harvested_at = parse_iso_z(case["harvested_at"])
    estimate = _run(case)
    payload = json.loads(estimate.model_dump_json())

    assert payload["computed_at"] == iso_z(now)
    assert payload["model_version"] == MODEL_VERSION
    assert payload["protocol_id"] == case["protocol_id"]
    for scenario in ("low", "mid", "high"):
        hours = payload["remaining_hours"][scenario]
        assert payload["expected_end"][scenario] == iso_z(now + timedelta(hours=hours))
    assert 0.0 <= estimate.remaining_fraction <= 1.0
    assert (
        estimate.remaining_hours.low
        <= estimate.remaining_hours.mid
        <= estimate.remaining_hours.high
    )

    total_hours = (now - harvested_at).total_seconds() / 3600.0
    assert sum(s.hours for s in estimate.segments) == pytest.approx(total_hours, abs=TOL_HOURS)
    previous_end = harvested_at
    for raw, segment in zip(payload["segments"], estimate.segments, strict=True):
        assert set(raw) == {"from", "to", "temp_c", "hours", "rate", "assumed"}
        assert raw["from"].endswith("Z") and raw["to"].endswith("Z")
        assert segment.from_ == previous_end
        assert segment.to > segment.from_
        assert segment.hours > 0
        previous_end = segment.to
    if estimate.segments:
        assert previous_end == now
        assert estimate.segments[-1].assumed is estimate.current_temp_assumed
        # A reading exactly at `now` has no segment but still defines the current temperature.
        if estimate.hours_since_last_reading != 0.0:
            assert estimate.segments[-1].temp_c == estimate.current_temp_c
