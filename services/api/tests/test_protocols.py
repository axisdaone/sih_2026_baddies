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
