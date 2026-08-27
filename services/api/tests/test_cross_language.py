"""Cross-language parity reference (data/demo_scenarios/golden_estimates_py.json).

`scripts/dump_golden_estimates.py` writes the Python engine's full ShelfLifeEstimate for every case
in golden_kinetics.json; apps/web/src/engine/parity.test.ts asserts the TypeScript engine reproduces
it exactly. This test makes CI fail when the Python engine (or the golden inputs) change without
the dump being regenerated, so the two engines can never drift silently.

Regenerate with:  .venv/Scripts/python scripts/dump_golden_estimates.py
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.kinetics import MODEL_VERSION
from scripts.dump_golden_estimates import (
    GOLDEN_ESTIMATES,
    GOLDEN_INPUTS,
    build_payload,
    load_golden_inputs,
    render,
)

REGENERATE = "regenerate with `.venv/Scripts/python scripts/dump_golden_estimates.py`"


def _dumped() -> dict[str, Any]:
    assert GOLDEN_ESTIMATES.is_file(), f"{GOLDEN_ESTIMATES} missing; {REGENERATE}"
    with open(GOLDEN_ESTIMATES, encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


def test_dump_header() -> None:
    dumped = _dumped()
    assert dumped["model_version"] == MODEL_VERSION
    assert dumped["generated_from"] == GOLDEN_INPUTS.name == "golden_kinetics.json"
    golden = load_golden_inputs()
    assert [c["id"] for c in dumped["cases"]] == [c["id"] for c in golden["cases"]], REGENERATE


@pytest.mark.parametrize(
    "case_id", [c["id"] for c in load_golden_inputs()["cases"]], ids=lambda case_id: str(case_id)
)
def test_dumped_estimate_matches_engine(case_id: str) -> None:
    """Every dumped estimate equals a fresh evaluate() run, key for key and value for value."""
    fresh = next(c for c in build_payload()["cases"] if c["id"] == case_id)
    dumped = next(c for c in _dumped()["cases"] if c["id"] == case_id)
    assert dumped["estimate"] == fresh["estimate"], f"{case_id} is stale; {REGENERATE}"
    # Same keys in the same order (the TS side also compares serialised JSON).
    assert list(dumped["estimate"]) == list(fresh["estimate"])


def test_dump_file_text_is_canonical() -> None:
    """The file is byte-for-byte what the script writes (formatting drift is drift too)."""
    assert GOLDEN_ESTIMATES.read_text(encoding="utf-8") == render(build_payload()), REGENERATE


def test_dump_has_full_wire_shape() -> None:
    """The reference carries every ShelfLifeEstimate key, including `breach.label`."""
    dumped = _dumped()
    expected_keys = {
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
    labels: set[str | None] = set()
    for case in dumped["cases"]:
        estimate = case["estimate"]
        assert set(estimate) == expected_keys, case["id"]
        for segment in estimate["segments"]:
            assert set(segment) == {"from", "to", "temp_c", "hours", "rate", "assumed"}
        if estimate["breach"] is not None:
            assert set(estimate["breach"]) == {"type", "value_c", "reading_id", "at", "label"}
            labels.add(estimate["breach"]["label"])
    assert labels == {"heat_damage", "freeze"}
