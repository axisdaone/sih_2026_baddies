"""End-to-end smoke test through `TestClient`, mirroring the pitch flow (docs/DEMO-SCRIPT):

seed the demo dataset -> list the farmer's batches -> recommendation for the hero batch ->
public Quality Pass (privacy, chain, verify, QR) -> a fresh device syncing offline work with a
skewed clock -> cross-farmer isolation.

Each step asserts the numbers the demo narrator relies on, so a regression anywhere in the
pipeline (seed, kinetics, prices, routing, hash chain, sync) shows up as one failing story.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.demo.seed import DEMO_DEVICE_ID
from app.main import app
from app.schemas import iso_z, parse_iso_z
from tests.conftest import DEMO_ADMIN_HEADERS

API = "/api/v1"
HERO_BATCH_ID = "6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01"  # tomato 500 kg, cool_morning, 4 h ago
SEEDED_BATCHES = 6
SEEDED_READINGS = 44
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
FRESH_DEVICE_ID = "0f3c1a2b-5d6e-4f70-8a9b-0c1d2e3f4a03"


def _wait_for_price_bootstrap() -> None:
    """The startup price poll runs on a thread; join it so prices are settled before routing."""
    thread = getattr(app.state, "price_bootstrap_thread", None)
    if thread is not None:
        thread.join(timeout=15)


@pytest.fixture(scope="module")
def seed(client: TestClient) -> dict[str, Any]:
    """`POST /demo/seed?reset=true` (operator header): a clean, freshly anchored demo dataset."""
    response = client.post(
        f"{API}/demo/seed", params={"reset": "true"}, headers=DEMO_ADMIN_HEADERS
    )
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


@pytest.fixture(scope="module")
def demo_headers(seed: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {seed['token']}"}


def _op(kind: str, payload: dict[str, Any], client_seq: int, at: datetime) -> dict[str, Any]:
    return {
        "op_id": str(uuid.uuid4()),
        "client_seq": client_seq,
        "kind": kind,
        "payload": payload,
        "client_time": iso_z(at),
    }


def test_seed_is_the_scripted_dataset_and_replays_idempotently(
    client: TestClient, seed: dict[str, Any]
) -> None:
    assert seed["device_id"] == DEMO_DEVICE_ID
    assert seed["batches_created"] == SEEDED_BATCHES and seed["batches_existing"] == 0
    assert seed["readings_created"] == SEEDED_READINGS
    assert seed["created"] is True and seed["simulated"] is True
    assert seed["batch_ids"][0] == HERO_BATCH_ID and len(seed["batch_ids"]) == SEEDED_BATCHES
    assert seed["loss_comparison"]  # inputs for the 18 % vs 7 % slide

    replay = client.post(f"{API}/demo/seed")
    assert replay.status_code == 200, replay.text
    data = replay.json()
    assert data["farmer_id"] == seed["farmer_id"]
    assert data["batches_created"] == 0 and data["batches_existing"] == SEEDED_BATCHES
    assert data["readings_created"] == 0 and data["created"] is False
    assert data["batch_ids"] == seed["batch_ids"]


def test_farmer_sees_six_batches_with_shelf_life_ranges(
    client: TestClient, seed: dict[str, Any], demo_headers: dict[str, str]
) -> None:
    listing = client.get(f"{API}/batches", headers=demo_headers)
    assert listing.status_code == 200, listing.text
    batches = listing.json()
    assert len(batches) == SEEDED_BATCHES
    assert {b["id"] for b in batches} == set(seed["batch_ids"])
    for batch in batches:
        assert batch["farmer_id"] == seed["farmer_id"]
        assert batch["status"] == "open"
        shelf = batch["shelf_life"]
        assert shelf is not None
        hours = shelf["remaining_hours"]
        assert hours["low"] <= hours["mid"] <= hours["high"]
        assert shelf["status"] in {"fresh", "warning", "critical", "spoiled"}
    hero = next(b for b in batches if b["id"] == HERO_BATCH_ID)
    assert hero["shelf_life"]["status"] == "fresh"
    assert hero["shelf_life"]["confidence"] == "high"


def test_hero_batch_recommendation_is_hosur(
    client: TestClient, demo_headers: dict[str, str]
) -> None:
    _wait_for_price_bootstrap()
    response = client.get(f"{API}/batches/{HERO_BATCH_ID}/recommendation", headers=demo_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["batch_id"] == HERO_BATCH_ID
    assert body["model_version"] == "routing-1.0"
    assert body["simulated"] is True  # seeded readings are source=sim -> SIMULATED chip
    assert body["shelf_life"]["status"] == "fresh"
    assert body["top"] is not None
    assert body["top"]["mandi_id"] == "hosur"
    assert body["top"]["feasible"] is True
    assert body["nearest"] is not None
    assert body["uplift_vs_nearest_pct"] is not None
    assert body["uplift_vs_nearest_pct"] >= 20
    assert body["top"]["expected_value_inr"] > body["nearest"]["expected_value_inr"]
    assert body["top"]["price_source"] in {
        "bundled_snapshot",
        "agmarknet_cache",
        "agmarknet_live",
    }


def test_public_quality_pass_privacy_chain_verify_and_qr(
    client: TestClient, seed: dict[str, Any]
) -> None:
    response = client.get(f"{API}/quality-pass/{HERO_BATCH_ID}")  # no Authorization header
    assert response.status_code == 200, response.text
    text = response.text
    for forbidden in ("farmer_id", "device_id", DEMO_DEVICE_ID, seed["farmer_id"], "notes"):
        assert forbidden not in text, forbidden
    payload = response.json()
    assert payload["batch_id"] == HERO_BATCH_ID
    assert payload["chain_valid"] is True
    assert payload["chain_length"] == 5
    assert payload["simulated"] is True
    assert payload["display_name"] == seed["display_name"]  # opted-in name only
    assert len(payload["origin_geohash"]) == 4  # ~20 km cell, never the exact origin
    head = payload["chain_head"]
    assert head and len(head) == 64
    assert payload["pass_url"].endswith(f"/pass/{HERO_BATCH_ID}?h={head[:16]}")

    verify = client.get(f"{API}/quality-pass/{HERO_BATCH_ID}/verify", params={"head": head[:16]})
    assert verify.status_code == 200, verify.text
    assert verify.json() == {
        "valid": True,
        "chain_head": head,
        "length": 5,
        "first_bad_seq": None,
        "head_matches": True,
    }

    qr = client.get(f"{API}/quality-pass/{HERO_BATCH_ID}/qr.png")
    assert qr.status_code == 200
    assert qr.headers["content-type"] == "image/png"
    assert qr.content.startswith(PNG_MAGIC)


def test_fresh_device_syncs_with_a_fast_clock_then_replays(client: TestClient) -> None:
    login = client.post(
        f"{API}/auth/device", json={"device_id": FRESH_DEVICE_ID, "display_name": "Smoke"}
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['token']}"}

    client_now = datetime.now(UTC) + timedelta(minutes=10)  # device clock runs 10 min ahead
    harvested = client_now - timedelta(hours=3)
    batch = {
        "id": str(uuid.uuid4()),
        "crop": "tomato",
        "protocol_id": "tomato",
        "qty_kg": 250,
        "harvested_at": iso_z(harvested),
        "origin_lat": 12.3,
        "origin_lon": 78.07,
        "notes": "logged in airplane mode",
        "client_seq": 1,
        "client_created_at": iso_z(harvested),
    }
    reading = {
        "id": str(uuid.uuid4()),
        "batch_id": batch["id"],
        "temp_c": 29.4,
        "taken_at": iso_z(client_now - timedelta(minutes=5)),
        "source": "manual",
        "geohash": None,
        "client_seq": 2,
    }
    ops = [_op("batch.create", batch, 1, client_now), _op("reading.append", reading, 2, client_now)]
    body = {"device_id": FRESH_DEVICE_ID, "client_now": iso_z(client_now), "ops": ops}

    first = client.post(f"{API}/sync", json=body, headers=headers)
    assert first.status_code == 200, first.text
    data = first.json()
    assert abs(data["clock_skew_seconds"] - 600) < 5
    assert [r["status"] for r in data["results"]] == ["applied", "applied"]
    assert all(r["clock_adjusted"] is True for r in data["results"])
    assert all(r["error"] is None for r in data["results"])
    server_now = parse_iso_z(data["server_now"])
    created, appended = (r["entity"] for r in data["results"])
    assert created["id"] == batch["id"]
    harvested_server = parse_iso_z(created["harvested_at"])
    assert abs((harvested_server - (server_now - timedelta(hours=3))).total_seconds()) < 5
    assert appended["id"] == reading["id"] and appended["seq"] == 1
    assert appended["temp_c"] == 29.4 and len(appended["hash"]) == 64
    synced = next(b for b in data["batches"] if b["id"] == batch["id"])
    assert synced["chain_head"] == appended["hash"]
    assert 0 <= synced["shelf_life"]["hours_since_last_reading"] < 0.2  # not "in the future"
    assert synced["shelf_life"]["current_temp_c"] == 29.4

    replay = client.post(f"{API}/sync", json=body, headers=headers)
    assert replay.status_code == 200, replay.text
    assert [r["status"] for r in replay.json()["results"]] == ["duplicate", "duplicate"]
    assert replay.json()["results"][1]["entity"]["hash"] == appended["hash"]
    assert len([b for b in replay.json()["batches"] if b["id"] == batch["id"]]) == 1

    # Cross-farmer: the fresh device cannot see the demo farmer's hero batch (404, no leak).
    assert client.get(f"{API}/batches/{HERO_BATCH_ID}", headers=headers).status_code == 404
    assert (
        client.get(f"{API}/batches/{HERO_BATCH_ID}/recommendation", headers=headers).status_code
        == 404
    )
    mine = client.get(f"{API}/batches", headers=headers).json()
    assert {b["id"] for b in mine} == {batch["id"]}
