"""Public Quality Pass: payload privacy, QR PNG, verify, audit events."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import SessionLocal
from app.models import PassEvent
from app.quality_pass.qr import pass_page_url
from app.schemas import iso_z
from tests.conftest import DEVICE_ID

API = "/api/v1"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _create_batch(client: TestClient, headers: dict[str, str], **overrides: Any) -> dict[str, Any]:
    harvested = datetime.now(UTC) - timedelta(hours=12)
    body: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "crop": "tomato",
        "protocol_id": "tomato",
        "qty_kg": 800,
        "harvested_at": iso_z(harvested),
        "origin_lat": 12.3,
        "origin_lon": 78.07,
        "notes": "private note: called the trader twice",
        "client_seq": 1,
        "client_created_at": iso_z(harvested),
    }
    body.update(overrides)
    response = client.post(f"{API}/batches", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return body


def test_public_payload_exposes_no_identity(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    body = _create_batch(client, auth_headers)
    batch_id = body["id"]
    sim = client.post(
        f"{API}/batches/{batch_id}/simulate", params={"profile": "reefer_van"}, headers=auth_headers
    )
    assert sim.status_code == 200, sim.text
    head = sim.json()["chain_head"]

    response = client.get(f"{API}/quality-pass/{batch_id}")  # no Authorization header
    assert response.status_code == 200, response.text
    text = response.text
    for forbidden in ("farmer_id", "device_id", DEVICE_ID, "private note", "origin_lat", "notes"):
        assert forbidden not in text, forbidden
    me = client.get(f"{API}/auth/me", headers=auth_headers).json()
    assert me["id"] not in text

    payload = response.json()
    assert payload["batch_id"] == batch_id
    assert payload["crop"] == "tomato"
    assert payload["protocol_id"] == "tomato"
    assert payload["protocol_name"] == "Tomato"
    assert payload["qty_kg"] == 800
    assert payload["status"] == "open"
    assert payload["display_name"] == "Test Farmer"  # opted in via POST /auth/device
    assert payload["region"] == "Dharmapuri belt"
    assert len(payload["origin_geohash"]) == 4
    assert sim.json()["origin_geohash"].startswith(payload["origin_geohash"])
    assert payload["simulated"] is True
    assert payload["chain_valid"] is True
    assert payload["chain_length"] == 7
    assert payload["chain_head"] == head
    assert payload["generated_at"].endswith("Z")
    assert [r["seq"] for r in payload["readings"]] == list(range(1, 8))
    assert all(len(r["hash"]) == 12 for r in payload["readings"])
    assert all(r["source"] == "sim" for r in payload["readings"])
    hours = payload["shelf_life"]["remaining_hours"]
    assert hours["low"] <= hours["mid"] <= hours["high"]
    base = get_settings().PUBLIC_BASE_URL
    assert payload["pass_url"] == f"{base}/pass/{batch_id}?h={head[:16]}"
    assert payload["verify_url"] == f"{base}/api/v1/quality-pass/{batch_id}/verify?head={head[:16]}"


def test_payload_without_readings_or_region(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    chennai = _create_batch(client, auth_headers, origin_lat=13.08, origin_lon=80.27)
    payload = client.get(f"{API}/quality-pass/{chennai['id']}").json()
    assert payload["region"] is None
    assert payload["origin_geohash"] is not None
    assert payload["readings"] == []
    assert payload["chain_head"] is None
    assert payload["chain_length"] == 0
    assert payload["chain_valid"] is True
    assert payload["simulated"] is False
    assert payload["pass_url"].endswith(f"/pass/{chennai['id']}")  # no ?h without a chain
    assert "?head" not in payload["verify_url"]

    nowhere = _create_batch(client, auth_headers, origin_lat=None, origin_lon=None)
    payload = client.get(f"{API}/quality-pass/{nowhere['id']}").json()
    assert payload["origin_geohash"] is None
    assert payload["region"] is None


def test_display_name_only_when_opted_in(client: TestClient) -> None:
    login = client.post(f"{API}/auth/device", json={"device_id": "test-device-anon-01"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    body = _create_batch(client, headers)
    payload = client.get(f"{API}/quality-pass/{body['id']}").json()
    assert payload["display_name"] is None


def test_qr_png(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _create_batch(client, auth_headers)
    response = client.get(f"{API}/quality-pass/{body['id']}/qr.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(PNG_MAGIC)
    assert len(response.content) > 200
    assert pass_page_url("http://x/", "b", "a" * 64) == "http://x/pass/b?h=" + "a" * 16
    assert pass_page_url("http://x", "b", None) == "http://x/pass/b"


def test_verify_and_audit_events(client: TestClient, auth_headers: dict[str, str]) -> None:
    body = _create_batch(client, auth_headers)
    batch_id = body["id"]
    reading = {
        "id": str(uuid.uuid4()),
        "batch_id": batch_id,
        "temp_c": 27.0,
        "taken_at": iso_z(datetime.now(UTC) - timedelta(hours=1)),
        "source": "manual",
        "client_seq": 2,
    }
    appended = client.post(f"{API}/batches/{batch_id}/readings", json=reading, headers=auth_headers)
    assert appended.status_code == 201
    head = appended.json()["hash"]

    verify_url = f"{API}/quality-pass/{batch_id}/verify"
    full = client.get(verify_url, params={"head": head}).json()
    assert full["valid"] is True and full["head_matches"] is True and full["length"] == 1
    upper = client.get(verify_url, params={"head": head[:16].upper()}).json()
    assert upper["head_matches"] is True
    assert client.get(verify_url, params={"head": "abc"}).status_code == 422
    assert client.get(verify_url, params={"head": "zz" * 8}).status_code == 422
    assert client.get(verify_url).status_code == 422

    assert client.get(f"{API}/quality-pass/{batch_id}").status_code == 200
    with SessionLocal() as db:
        events = db.query(PassEvent).filter_by(batch_id=batch_id).all()
    kinds = sorted(e.event for e in events)
    assert kinds.count("verify") == 2
    assert kinds.count("view") == 1
    assert all(len(e.ip_hash) == 64 and e.ip_hash != "testclient" for e in events)
    assert all(e.at.tzinfo is not None for e in events)


def test_unknown_batch_404(client: TestClient) -> None:
    ghost = uuid.uuid4()
    assert client.get(f"{API}/quality-pass/{ghost}").status_code == 404
    assert client.get(f"{API}/quality-pass/{ghost}/qr.png").status_code == 404
    verify = client.get(f"{API}/quality-pass/{ghost}/verify", params={"head": "0" * 16})
    assert verify.status_code == 404
