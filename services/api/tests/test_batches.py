"""Batches API: idempotent create, farmer scoping, LWW patch, shelf-life, simulate."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.schemas import iso_z
from app.services.geo import geohash_encode, origin_geohash

API = "/api/v1"


def _batch_body(harvested_hours_ago: float = 10, **overrides: Any) -> dict[str, Any]:
    harvested = datetime.now(UTC) - timedelta(hours=harvested_hours_ago)
    body: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "crop": "tomato",
        "protocol_id": "tomato",
        "qty_kg": 500,
        "harvested_at": iso_z(harvested),
        "origin_lat": 12.3,
        "origin_lon": 78.07,
        "notes": None,
        "client_seq": 1,
        "client_created_at": iso_z(harvested),
    }
    body.update(overrides)
    return body


def _assert_range(shelf_life: dict[str, Any]) -> None:
    hours = shelf_life["remaining_hours"]
    assert hours["low"] <= hours["mid"] <= hours["high"]
    assert set(shelf_life["expected_end"]) == {"low", "mid", "high"}
    assert shelf_life["model_version"] == "kinetics-1.0"


@pytest.fixture(scope="module")
def other_headers(client: TestClient) -> dict[str, str]:
    response = client.post(
        f"{API}/auth/device", json={"device_id": "0f3c1a2b-5d6e-4f70-8a9b-0c1d2e3f4a04"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def test_create_batch_is_idempotent(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _batch_body()
    first = client.post(f"{API}/batches", json=body, headers=auth_headers)
    assert first.status_code == 201, first.text
    data = first.json()
    assert data["id"] == body["id"]
    assert data["status"] == "open"
    assert data["origin_geohash"] == geohash_encode(12.3, 78.07, 7)
    assert len(data["origin_geohash"]) == 7
    assert data["readings"] == []
    assert data["chain_head"] is None
    assert data["harvested_at"] == body["harvested_at"]
    assert data["created_at"].endswith("Z")
    _assert_range(data["shelf_life"])

    replay = client.post(f"{API}/batches", json=body, headers=auth_headers)
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == body["id"]
    assert replay.json()["created_at"] == data["created_at"]

    # A replay with drifted fields still returns the stored row (create is not an upsert of
    # fields; PATCH is the only way to change a batch).
    drifted = client.post(f"{API}/batches", json={**body, "qty_kg": 1}, headers=auth_headers)
    assert drifted.status_code == 200
    assert drifted.json()["qty_kg"] == 500


def test_batch_without_coordinates_has_no_geohash(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    body = _batch_body(origin_lat=None, origin_lon=None)
    response = client.post(f"{API}/batches", json=body, headers=auth_headers)
    assert response.status_code == 201, response.text
    assert response.json()["origin_geohash"] is None


def test_unknown_protocol_rejected(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _batch_body(protocol_id="banana")
    response = client.post(f"{API}/batches", json=body, headers=auth_headers)
    assert response.status_code == 422
    assert "banana" in response.json()["detail"]


def test_cross_farmer_isolation(
    client: TestClient, auth_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    body = _batch_body()
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201

    # Same id from another farmer is a conflict, not a silent takeover.
    stolen = client.post(f"{API}/batches", json=body, headers=other_headers)
    assert stolen.status_code == 409
    assert stolen.json()["detail"] == "id already in use"  # same wording as the reading branch

    # Reads/patches by the other farmer look like a missing batch (no id leakage).
    assert client.get(f"{API}/batches/{body['id']}", headers=other_headers).status_code == 404
    assert (
        client.get(f"{API}/batches/{body['id']}/shelf-life", headers=other_headers).status_code
        == 404
    )
    patch = client.patch(
        f"{API}/batches/{body['id']}",
        json={"status": "sold", "client_seq": 9},
        headers=other_headers,
    )
    assert patch.status_code == 404
    ids = {b["id"] for b in client.get(f"{API}/batches", headers=other_headers).json()}
    assert body["id"] not in ids

    # Owner still sees it untouched.
    mine = client.get(f"{API}/batches/{body['id']}", headers=auth_headers)
    assert mine.status_code == 200
    assert mine.json()["status"] == "open"


def test_list_embeds_shelf_life_range(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _batch_body()
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    listing = client.get(f"{API}/batches", headers=auth_headers)
    assert listing.status_code == 200
    rows = {b["id"]: b for b in listing.json()}
    assert body["id"] in rows
    row = rows[body["id"]]
    assert row["shelf_life"] is not None
    _assert_range(row["shelf_life"])
    assert row["shelf_life"]["current_temp_assumed"] is True  # no readings yet
    assert row["readings"] is None  # list view stays light
    assert row["chain_head"] is None


def test_patch_last_writer_wins(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _batch_body(notes="first note")
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    url = f"{API}/batches/{body['id']}"

    newer = client.patch(url, json={"status": "sold", "client_seq": 5}, headers=auth_headers)
    assert newer.status_code == 200, newer.text
    assert newer.json()["status"] == "sold"
    assert newer.json()["client_seq"] == 5
    assert newer.json()["notes"] == "first note"  # absent field untouched
    assert newer.json()["shelf_life"] is not None

    stale = client.patch(url, json={"status": "open", "client_seq": 3}, headers=auth_headers)
    assert stale.status_code == 200
    assert stale.json()["status"] == "sold"  # ignored, current row returned
    assert stale.json()["client_seq"] == 5

    cleared = client.patch(
        url, json={"notes": None, "qty_kg": 420, "client_seq": 6}, headers=auth_headers
    )
    assert cleared.status_code == 200
    assert cleared.json()["notes"] is None  # explicit null clears
    assert cleared.json()["qty_kg"] == 420
    assert cleared.json()["status"] == "sold"

    # Replaying the same seq is idempotent.
    again = client.patch(
        url, json={"notes": None, "qty_kg": 420, "client_seq": 6}, headers=auth_headers
    )
    assert again.status_code == 200
    assert again.json()["qty_kg"] == 420

    bad = client.patch(url, json={"qty_kg": -1, "client_seq": 7}, headers=auth_headers)
    assert bad.status_code == 422


def test_shelf_life_endpoint(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _batch_body()
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    response = client.get(f"{API}/batches/{body['id']}/shelf-life", headers=auth_headers)
    assert response.status_code == 200
    estimate = response.json()
    assert estimate["protocol_id"] == "tomato"
    assert estimate["status"] in {"fresh", "warning", "critical", "spoiled"}
    assert estimate["confidence"] == "low"
    assert estimate["current_temp_c"] == 30  # protocol default ambient while no readings
    _assert_range(estimate)
    missing = client.get(f"{API}/batches/{uuid.uuid4()}/shelf-life", headers=auth_headers)
    assert missing.status_code == 404


def test_simulate_hot_afternoon_is_idempotent(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    body = _batch_body(harvested_hours_ago=9)  # last profile reading (offset 8 h) is 1 h old
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    url = f"{API}/batches/{body['id']}/simulate"

    # No up_to_hours: the window defaults to "hours since harvest" (9 h), so the whole 8 h
    # profile fits without dating any reading in the future.
    first = client.post(url, params={"profile": "hot_afternoon"}, headers=auth_headers)
    assert first.status_code == 200, first.text
    data = first.json()
    readings = data["readings"]
    assert len(readings) == 8
    assert [r["seq"] for r in readings] == list(range(1, 9))
    assert {r["source"] for r in readings} == {"sim"}
    assert all(r["geohash"] == data["origin_geohash"] for r in readings)
    assert readings[0]["taken_at"] == body["harvested_at"]
    assert readings[-1]["temp_c"] == 30
    assert data["chain_head"] == readings[-1]["hash"]
    assert data["shelf_life"]["current_temp_c"] == 30
    assert data["shelf_life"]["current_temp_assumed"] is False  # last reading 1 h ago
    assert data["shelf_life"]["hours_since_last_reading"] == 1.0
    assert data["shelf_life"]["confidence"] == "high"
    _assert_range(data["shelf_life"])

    replay = client.post(url, params={"profile": "hot_afternoon"}, headers=auth_headers)
    assert replay.status_code == 200
    assert [r["hash"] for r in replay.json()["readings"]] == [r["hash"] for r in readings]
    assert len(replay.json()["readings"]) == 8

    listed = client.get(f"{API}/batches/{body['id']}/readings", headers=auth_headers)
    assert listed.status_code == 200
    assert len(listed.json()) == 8


def test_simulate_up_to_hours_continues_the_profile(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    body = _batch_body(crop="guava", protocol_id="guava")
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    url = f"{API}/batches/{body['id']}/simulate"

    partial = client.post(
        url, params={"profile": "cool_morning", "up_to_hours": 3}, headers=auth_headers
    )
    assert partial.status_code == 200, partial.text
    assert len(partial.json()["readings"]) == 4  # offsets 0,1,2,3

    full = client.post(
        url, params={"profile": "cool_morning", "up_to_hours": 8}, headers=auth_headers
    )
    assert full.status_code == 200
    seqs = [r["seq"] for r in full.json()["readings"]]
    assert seqs == list(range(1, 10))  # 9 readings, chain extended in place
    assert full.json()["shelf_life"]["protocol_id"] == "guava"


def test_simulate_defaults_to_hours_since_harvest(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    """A freshly harvested batch must not get future readings appended to its chain."""
    body = _batch_body(harvested_hours_ago=2.5)
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    url = f"{API}/batches/{body['id']}/simulate"

    partial = client.post(url, params={"profile": "hot_afternoon"}, headers=auth_headers)
    assert partial.status_code == 200, partial.text
    readings = partial.json()["readings"]
    assert len(readings) == 3  # offsets 0, 1, 2 (<= 2.5 h since harvest)
    now = datetime.now(UTC)
    for reading in readings:
        taken = datetime.fromisoformat(reading["taken_at"].replace("Z", "+00:00"))
        assert taken <= now
    shelf = partial.json()["shelf_life"]
    assert shelf["current_temp_c"] == 36.5  # the offset-2 reading, not a future one
    assert shelf["confidence"] == "high"  # 3 readings, last one 0.5 h old
    _assert_range(shelf)

    # Replaying with the default window is a no-op (same ids, same hashes).
    again = client.post(url, params={"profile": "hot_afternoon"}, headers=auth_headers)
    assert [r["hash"] for r in again.json()["readings"]] == [r["hash"] for r in readings]

    # An explicit window still wins over the clock, and ?all=true appends the whole profile.
    four = client.post(
        url, params={"profile": "hot_afternoon", "up_to_hours": 4}, headers=auth_headers
    )
    assert len(four.json()["readings"]) == 5
    full = client.post(
        url, params={"profile": "hot_afternoon", "all": "true"}, headers=auth_headers
    )
    assert full.status_code == 200, full.text
    assert [r["seq"] for r in full.json()["readings"]] == list(range(1, 9))
    assert full.json()["readings"][:3] == readings  # chain extended in place
    # `all` overrides `up_to_hours` and is itself idempotent.
    both = client.post(
        url,
        params={"profile": "hot_afternoon", "up_to_hours": 1, "all": "true"},
        headers=auth_headers,
    )
    assert len(both.json()["readings"]) == 8
    listed = client.get(f"{API}/batches/{body['id']}/readings", headers=auth_headers).json()
    assert listed == full.json()["readings"]


def test_simulate_unknown_profile(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _batch_body()
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    url = f"{API}/batches/{body['id']}/simulate"
    for profile, expected in (("cool_chain", 404), ("../seed", 422), ("golden_kinetics", 404)):
        response = client.post(url, params={"profile": profile}, headers=auth_headers)
        assert response.status_code == expected, profile
    unknown = client.post(
        f"{API}/batches/{uuid.uuid4()}/simulate",
        params={"profile": "hot_afternoon"},
        headers=auth_headers,
    )
    assert unknown.status_code == 404


def test_all_scenario_profiles_load(client: TestClient) -> None:
    from app.services.simulate import load_profiles

    assert set(load_profiles()) == {
        "cool_morning",
        "hot_afternoon",
        "heat_spike",
        "reefer_van",
        "pre_cooled",
        "pharma_excursion",
        "pharma_freeze",
    }
    assert load_profiles()["pharma_freeze"].readings[0].offset_hours == 0


def test_geohash_reference_vectors() -> None:
    assert geohash_encode(42.605, -5.603, 5) == "ezs42"
    assert geohash_encode(57.64911, 10.40744, 11) == "u4pruydqqvj"
    assert geohash_encode(12.3, 78.07, 7).startswith(geohash_encode(12.3, 78.07, 4))
    assert origin_geohash(None, 78.07) is None
    with pytest.raises(ValueError):
        geohash_encode(91, 0)
    with pytest.raises(ValueError):
        geohash_encode(0, 181)


def test_simulate_is_403_when_demo_mode_is_off(
    client: TestClient, auth_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings

    body = _batch_body()
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    monkeypatch.setattr(get_settings(), "DEMO_MODE", False)
    url = f"{API}/batches/{body['id']}/simulate"
    response = client.post(url, params={"profile": "reefer_van"}, headers=auth_headers)
    assert response.status_code == 403, response.text
    # The rest of the batch API is unaffected by DEMO_MODE.
    assert client.get(f"{API}/batches/{body['id']}", headers=auth_headers).status_code == 200


def test_client_seq_is_bounded_to_32_bits(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _batch_body()
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    too_big = client.post(
        f"{API}/batches", json=_batch_body(client_seq=2**31), headers=auth_headers
    )
    assert too_big.status_code == 422
    url = f"{API}/batches/{body['id']}"
    patch = client.patch(url, json={"notes": "x", "client_seq": 2**31}, headers=auth_headers)
    assert patch.status_code == 422
    max_ok = client.patch(url, json={"notes": "x", "client_seq": 2**31 - 1}, headers=auth_headers)
    assert max_ok.status_code == 200


def test_unknown_profile_detail_does_not_list_profiles(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    body = _batch_body()
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    url = f"{API}/batches/{body['id']}/simulate"
    response = client.post(url, params={"profile": "cool_chain"}, headers=auth_headers)
    assert response.status_code == 404
    assert "known:" not in response.json()["detail"]
    assert "hot_afternoon" not in response.json()["detail"]


def test_sim_reading_ids_are_owner_scoped(
    client: TestClient, auth_headers: dict[str, str], other_headers: dict[str, str]
) -> None:
    """A stranger who knows the (public) batch id cannot precompute and squat the sim ids."""
    from app.services.simulate import sim_reading_id

    body = _batch_body(harvested_hours_ago=9)
    assert client.post(f"{API}/batches", json=body, headers=auth_headers).status_code == 201
    mine = client.get(f"{API}/auth/me", headers=auth_headers).json()["id"]
    theirs = client.get(f"{API}/auth/me", headers=other_headers).json()["id"]

    class Stub:
        def __init__(self, farmer_id: str) -> None:
            self.id = body["id"]
            self.farmer_id = farmer_id

    guess = sim_reading_id(Stub(theirs), "hot_afternoon", 0)  # type: ignore[arg-type]
    real = sim_reading_id(Stub(mine), "hot_afternoon", 0)  # type: ignore[arg-type]
    assert guess != real
    # The stranger appends the guessed id to their own batch ...
    theirs_batch = _batch_body()
    created = client.post(f"{API}/batches", json=theirs_batch, headers=other_headers)
    assert created.status_code == 201
    squat = {
        "id": guess, "batch_id": theirs_batch["id"], "temp_c": 20.0,
        "taken_at": theirs_batch["harvested_at"], "source": "manual", "client_seq": 1,
    }
    assert client.post(
        f"{API}/batches/{theirs_batch['id']}/readings", json=squat, headers=other_headers
    ).status_code == 201
    # ... and the owner's simulation still works because the real ids differ.
    url = f"{API}/batches/{body['id']}/simulate"
    sim = client.post(url, params={"profile": "hot_afternoon"}, headers=auth_headers)
    assert sim.status_code == 200, sim.text
    assert sim.json()["readings"][0]["id"] == real
