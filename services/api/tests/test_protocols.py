from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.kinetics.registry import get_protocol, load_protocols
from app.models import Protocol


def test_lists_three_protocols(client: TestClient) -> None:
    response = client.get("/api/v1/protocols")
    assert response.status_code == 200
    ids = sorted(p["id"] for p in response.json())
    assert ids == ["guava", "pharma_2_8", "tomato"]


def test_tomato_fields(client: TestClient) -> None:
    response = client.get("/api/v1/protocols/tomato")
    assert response.status_code == 200
    tomato = response.json()
    assert tomato["kind"] == "crop"
    assert tomato["model"] == "q10"
    assert tomato["commodity"] == "Tomato"
    assert tomato["reference_temp_c"] == 10
    assert tomato["reference_shelf_life_hours"] == 288
    assert tomato["reference_shelf_life_range_hours"] == [240, 336]
    assert tomato["q10"] == 2.0
    assert tomato["q10_range"] == [1.8, 2.4]
    assert tomato["min_effective_temp_c"] == 10
    assert tomato["max_effective_temp_c"] == 45
    assert tomato["default_ambient_c"] == 30
    assert tomato["hard_thresholds"] == [
        {"type": "max_temp", "value_c": 45, "label": "heat_damage"}
    ]
    assert tomato["band_c"] is None
    assert tomato["excursion_budget_minutes"] is None
    assert tomato["sources"]


def test_pharma_protocol_shape(client: TestClient) -> None:
    pharma = client.get("/api/v1/protocols/pharma_2_8").json()
    assert pharma["kind"] == "pharma"
    assert pharma["model"] == "excursion"
    assert pharma["band_c"] == [2, 8]
    assert pharma["excursion_budget_minutes"] == 720
    assert {t["type"] for t in pharma["hard_thresholds"]} == {"min_temp", "max_temp"}


def test_unknown_protocol_404(client: TestClient) -> None:
    assert client.get("/api/v1/protocols/banana").status_code == 404


def test_registry_and_seeding(client: TestClient) -> None:
    assert set(load_protocols()) == {"tomato", "guava", "pharma_2_8"}
    assert get_protocol("guava")["q10"] == 2.5
    with SessionLocal() as db:
        rows = {row.id: row for row in db.query(Protocol).all()}
    assert set(rows) == {"tomato", "guava", "pharma_2_8"}
    assert rows["tomato"].params_json["reference_shelf_life_hours"] == 288
    assert rows["pharma_2_8"].kind == "pharma"


def test_every_protocol_keeps_scenarios_ordered_at_the_clamp_bounds() -> None:
    """Contract step 5 uses fixed (q10, L_ref) pairs, which is only pessimistic/optimistic when
    the L spread outweighs the inverted q10 effect below reference_temp_c (guava: floor 8 < 10).
    `validate_scenario_ordering` checks the clamp endpoints, which bound every temperature."""
    import copy
    from datetime import UTC, datetime, timedelta

    import pytest

    from app.kinetics import ReadingInput, evaluate
    from app.kinetics.registry import validate_scenario_ordering

    for protocol in load_protocols().values():
        validate_scenario_ordering(protocol)  # must not raise

    guava = get_protocol("guava")
    assert guava["min_effective_temp_c"] < guava["reference_temp_c"]  # the sub-T_ref region
    t0 = datetime(2026, 8, 27, 0, 30, tzinfo=UTC)
    at_floor = evaluate(guava, t0, [ReadingInput("r1", 8.0, t0)], t0)
    hours = at_floor.remaining_hours
    assert hours.low == pytest.approx(299.0, abs=0.05)
    assert hours.mid == pytest.approx(403.6, abs=0.05)
    assert hours.high == pytest.approx(449.6, abs=0.05)
    later = evaluate(guava, t0, [ReadingInput("r1", 8.0, t0)], t0 + timedelta(hours=100))
    assert later.remaining_hours.low <= later.remaining_hours.mid <= later.remaining_hours.high

    # Counter-example from the review: floor 0, q10_range [2, 3], L range [280, 300] at 0 C
    # would show "~839-599 h" (low > high). The registry must refuse it.
    bad = copy.deepcopy(guava)
    bad.update({"id": "bad", "min_effective_temp_c": 0, "q10_range": [2.0, 3.0],
                "reference_shelf_life_range_hours": [280, 300], "reference_shelf_life_hours": 290,
                "q10": 2.5})
    with pytest.raises(ValueError, match="invert"):
        validate_scenario_ordering(bad)
    degenerate = copy.deepcopy(guava)
    degenerate.update({"id": "degenerate", "q10": 3.5})  # nominal outside its own range
    with pytest.raises(ValueError, match="q10_range"):
        validate_scenario_ordering(degenerate)
    outside = copy.deepcopy(guava)
    outside.update({"id": "outside", "reference_shelf_life_hours": 100})
    with pytest.raises(ValueError, match="outside range"):
        validate_scenario_ordering(outside)
    excursion = get_protocol("pharma_2_8")
    validate_scenario_ordering(excursion)  # not a q10 model: nothing to check
