"""POST /demo/seed + GET /demo/scenarios: idempotent scripted dataset, demo identity, 403 gate."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.demo import seed as seed_mod
from app.demo.seed import DEMO_DEVICE_ID, derived_id, seed_demo
from app.models import Batch, Farmer, Reading
from tests.conftest import DEMO_ADMIN_HEADERS

API = "/api/v1"
SEED_PATH = Path(__file__).resolve().parents[3] / "data" / "demo_scenarios" / "demo_seed.json"
SCENARIO_IDS = {
    "cool_morning",
    "hot_afternoon",
    "heat_spike",
    "reefer_van",
    "pre_cooled",
    "pharma_excursion",
    "pharma_freeze",
}


def _seed_file() -> dict[str, Any]:
    with open(SEED_PATH, encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


def _expected_reading_count(seed: dict[str, Any]) -> int:
    return sum(
        1
        for batch in seed["batches"]
        for reading in batch["readings"]
        if reading["offset_hours"] <= batch["harvested_hours_ago"]
    )


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_seed_creates_six_batches_and_replay_is_idempotent(client: TestClient) -> None:
    seed = _seed_file()
    first = client.post(f"{API}/demo/seed")
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["device_id"] == DEMO_DEVICE_ID
    assert data["display_name"] == seed["farmer"]["display_name"]
    assert data["batches_created"] == 6 and data["batches_existing"] == 0
    assert data["readings_created"] == _expected_reading_count(seed)
    assert data["batch_ids"] == [b["id"] for b in seed["batches"]]
    assert data["created"] is True and data["simulated"] is True
    assert data["loss_comparison"] == seed["loss_comparison"]

    # The token adopts the demo identity.
    me = client.get(f"{API}/auth/me", headers=_bearer(data["token"]))
    assert me.status_code == 200, me.text
    assert me.json()["id"] == data["farmer_id"]
    assert me.json()["device_id"] == DEMO_DEVICE_ID

    replay = client.post(f"{API}/demo/seed").json()
    assert replay["farmer_id"] == data["farmer_id"]
    assert replay["batches_created"] == 0 and replay["batches_existing"] == 6
    assert replay["readings_created"] == 0
    assert replay["created"] is False
    assert replay["batch_ids"] == data["batch_ids"]

    listing = client.get(f"{API}/batches", headers=_bearer(data["token"]))
    assert listing.status_code == 200
    batches = {b["id"]: b for b in listing.json()}
    assert set(batches) == set(data["batch_ids"])
    for spec in seed["batches"]:
        batch = batches[spec["id"]]
        assert batch["status"] == "open"
        assert batch["client_seq"] == seed["batches"].index(spec) + 1
        assert batch["client_created_at"] == batch["harvested_at"]
        hours = batch["shelf_life"]["remaining_hours"]
        assert hours["low"] <= hours["mid"] <= hours["high"]
        detail = client.get(f"{API}/batches/{spec['id']}", headers=_bearer(data["token"])).json()
        expected = [r for r in spec["readings"] if r["offset_hours"] <= spec["harvested_hours_ago"]]
        assert [r["id"] for r in detail["readings"]] == [r["id"] for r in expected]
        assert all(r["source"] == "sim" for r in detail["readings"])
        assert [r["client_seq"] for r in detail["readings"]] == list(range(1, len(expected) + 1))


def test_seeded_batches_tell_the_scripted_story(client: TestClient) -> None:
    seed = _seed_file()
    data = client.post(f"{API}/demo/seed").json()
    listing = client.get(f"{API}/batches", headers=_bearer(data["token"])).json()
    status = {b["id"]: b["shelf_life"]["status"] for b in listing}
    hero, critical, spike, reefer, guava_cool, guava_hot = (b["id"] for b in seed["batches"])
    assert status[hero] == "fresh" and status[reefer] == "fresh" and status[guava_cool] == "fresh"
    assert status[critical] == "critical"
    assert status[spike] == "warning" and status[guava_hot] == "warning"

    def keys(batch_id: str) -> list[str]:
        return [a["message_key"] for a in data["alerts"] if a["batch_id"] == batch_id]

    assert keys(hero) == []
    assert keys(spike) == ["alert_75", "alert_50"]
    assert keys(critical) == ["alert_75", "alert_50", "alert_25", "sell_now"]


def test_seed_reset_reanchors_harvested_at() -> None:
    seed = _seed_file()
    anchor = datetime(2026, 8, 27, 6, 0, tzinfo=UTC)
    with SessionLocal() as db:
        result = seed_demo(db, now=anchor, reset=True)
        assert result.batches_created == 6 and result.batches_existing == 0
        assert result.readings_created == _expected_reading_count(seed)
        for spec in seed["batches"]:
            batch = db.get(Batch, spec["id"])
            assert batch is not None
            assert batch.harvested_at == anchor - timedelta(hours=spec["harvested_hours_ago"])
            assert batch.client_created_at == batch.harvested_at
        # Replaying against the stored anchor is still a no-op.
        replay = seed_demo(db, now=anchor + timedelta(days=3))
        assert replay.batches_created == 0 and replay.readings_created == 0


def test_scenarios_endpoint_lists_all_profiles(client: TestClient) -> None:
    response = client.get(f"{API}/demo/scenarios")
    assert response.status_code == 200, response.text
    scenarios = {s["id"]: s for s in response.json()}
    assert set(scenarios) == SCENARIO_IDS
    for scenario in scenarios.values():
        assert scenario["name"] and scenario["description"]
        assert scenario["suitable_protocols"]
        assert scenario["simulated"] is True
        assert scenario["expected_story"]  # narrator copy from the profile file
        offsets = [r["offset_hours"] for r in scenario["readings"]]
        assert offsets[0] == 0 and offsets == sorted(offsets)
    assert scenarios["pharma_freeze"]["suitable_protocols"] == ["pharma_2_8"]
    assert "18%" in scenarios["hot_afternoon"]["expected_story"]
    assert "spoiled" in scenarios["pharma_freeze"]["expected_story"].lower()


def test_demo_endpoints_are_403_when_demo_mode_is_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "DEMO_MODE", False)
    assert client.post(f"{API}/demo/seed").status_code == 403
    assert client.get(f"{API}/demo/scenarios").status_code == 403


def _counts(farmer_id: str) -> tuple[int, int]:
    with SessionLocal() as db:
        batches = db.scalars(select(Batch.id).where(Batch.farmer_id == farmer_id)).all()
        readings = db.scalars(select(Reading.id).where(Reading.batch_id.in_(batches))).all()
    return len(batches), len(readings)


def test_reset_requires_the_operator_header(client: TestClient) -> None:
    """`?reset=true` hard-deletes the demo tenant: never anonymous, even in DEMO_MODE."""
    seeded = client.post(f"{API}/demo/seed").json()
    before = _counts(seeded["farmer_id"])
    assert before[0] == 6 and before[1] > 0
    with SessionLocal() as db:
        anchor = db.get(Batch, seeded["batch_ids"][0])
        assert anchor is not None
        harvested_before = anchor.harvested_at

    no_header = client.post(f"{API}/demo/seed", params={"reset": "true"})
    assert no_header.status_code == 403, no_header.text
    wrong = client.post(
        f"{API}/demo/seed", params={"reset": "true"}, headers={"X-Demo-Admin-Token": "nope"}
    )
    assert wrong.status_code == 403
    assert _counts(seeded["farmer_id"]) == before
    with SessionLocal() as db:
        anchor = db.get(Batch, seeded["batch_ids"][0])
        assert anchor is not None and anchor.harvested_at == harvested_before

    # The right header resets (and re-anchors) the dataset.
    ok = client.post(f"{API}/demo/seed", params={"reset": "true"}, headers=DEMO_ADMIN_HEADERS)
    assert ok.status_code == 200, ok.text
    assert ok.json()["batches_created"] == 6 and ok.json()["batches_existing"] == 0


def test_reset_is_off_when_no_admin_token_is_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "DEMO_ADMIN_TOKEN", None)
    response = client.post(
        f"{API}/demo/seed", params={"reset": "true"}, headers=DEMO_ADMIN_HEADERS
    )
    assert response.status_code == 403
    assert client.post(f"{API}/demo/seed").status_code == 200  # plain replay still works


def test_seed_survives_squatted_fixed_ids(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    auth_headers: dict[str, str],
) -> None:
    """A stranger pre-registers the (public) hero batch id and a fixed reading id under their
    own farmer; `POST /demo/seed` still returns 200 with 6 batches by falling back to ids derived
    from the demo farmer's row id — and replays stay no-ops. Uses a private copy of the seed
    file (own farmer + fresh ids) so the shared demo dataset is untouched."""
    seed = _seed_file()
    seed["farmer"] = {**seed["farmer"], "device_id": str(uuid.uuid4()), "display_name": "Squat"}
    for batch in seed["batches"]:
        batch["id"] = str(uuid.uuid4())
        for reading in batch["readings"]:
            reading["id"] = str(uuid.uuid4())
    path = tmp_path / "demo_seed.json"
    path.write_text(json.dumps(seed), encoding="utf-8")
    monkeypatch.setattr(seed_mod, "seed_path", lambda: path)

    hero = seed["batches"][0]
    squatted_reading = hero["readings"][0]["id"]
    stolen = {
        "id": hero["id"], "crop": "tomato", "protocol_id": "tomato", "qty_kg": 1,
        "harvested_at": "2026-08-27T00:00:00Z", "client_seq": 1,
        "client_created_at": "2026-08-27T00:00:00Z",
    }
    assert client.post(f"{API}/batches", json=stolen, headers=auth_headers).status_code == 201
    reading = {
        "id": squatted_reading, "batch_id": hero["id"], "temp_c": 20.0,
        "taken_at": "2026-08-27T00:00:00Z", "source": "manual", "client_seq": 1,
    }
    assert client.post(
        f"{API}/batches/{hero['id']}/readings", json=reading, headers=auth_headers
    ).status_code == 201

    first = client.post(f"{API}/demo/seed")
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["batches_created"] == 6 and data["batches_existing"] == 0
    assert data["readings_created"] == _expected_reading_count(seed)
    assert len(data["batch_ids"]) == 6
    with SessionLocal() as db:
        farmer = db.get(Farmer, data["farmer_id"])
        assert farmer is not None
        assert data["batch_ids"][0] == derived_id(farmer, hero["id"])
        assert data["batch_ids"][1:] == [b["id"] for b in seed["batches"][1:]]
        # The squatter still owns the fixed id; the demo farmer got the derived one.
        assert db.get(Batch, hero["id"]).farmer_id != data["farmer_id"]  # type: ignore[union-attr]
        rows = db.scalars(
            select(Reading).where(Reading.batch_id == data["batch_ids"][0]).order_by(Reading.seq)
        ).all()
        assert rows[0].id == derived_id(farmer, f"{data['batch_ids'][0]}:{squatted_reading}")
        assert [r.id for r in rows[1:]] == [r["id"] for r in hero["readings"][1:5]]

    replay = client.post(f"{API}/demo/seed").json()
    assert replay["batches_created"] == 0 and replay["batches_existing"] == 6
    assert replay["readings_created"] == 0
    assert replay["batch_ids"] == data["batch_ids"]
