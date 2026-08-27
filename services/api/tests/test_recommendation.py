"""GET /batches/{id}/recommendation end-to-end (TestClient + SQLite).

Batches/readings are created through the public API when the core routes are live, and fall
back to direct ORM rows while POST /batches still answers 501 (integration phase unskips
nothing here — both paths exercise the same recommendation endpoint).
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import Batch, Reading
from app.models import Recommendation as RecommendationRow
from app.schemas.common import iso_z

COOL_MORNING_FIRST_5 = [(0, 22.0), (1, 23.0), (2, 24.5), (3, 26.0), (4, 28.0)]


def _wait_for_bootstrap() -> None:
    thread = getattr(app.state, "price_bootstrap_thread", None)
    if thread is not None:
        thread.join(timeout=15)


@pytest.fixture(autouse=True)
def _app_ready(client: TestClient) -> None:
    _wait_for_bootstrap()


def _farmer_id(client: TestClient, headers: dict[str, str]) -> str:
    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    return str(me.json()["id"])


def _fixture_hash(prev: str, payload: dict[str, Any]) -> str:
    """Test-only chain (same shape as contract section 4; verified by the quality_pass suite)."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"{prev}|{canonical}".encode()).hexdigest()


def _create_batch(
    client: TestClient,
    headers: dict[str, str],
    *,
    farmer_id: str,
    protocol_id: str,
    qty_kg: float,
    harvested_at: datetime,
    origin: tuple[float, float] | None,
    readings: list[tuple[float, float]],
) -> str:
    """POST /batches (+ readings) when available; otherwise insert ORM rows directly."""
    batch_id = str(uuid4())
    body = {
        "id": batch_id,
        "crop": protocol_id,
        "protocol_id": protocol_id,
        "qty_kg": qty_kg,
        "harvested_at": iso_z(harvested_at),
        "origin_lat": None if origin is None else origin[0],
        "origin_lon": None if origin is None else origin[1],
        "notes": "recommendation test",
        "client_seq": 1,
        "client_created_at": iso_z(harvested_at),
    }
    created = client.post("/api/v1/batches", json=body, headers=headers)
    api_batches = created.status_code in (200, 201)
    if not api_batches:
        assert created.status_code == 501, created.text  # core-api agent still on PHASE2
        with SessionLocal() as db:
            db.add(
                Batch(
                    id=batch_id,
                    farmer_id=farmer_id,
                    crop=protocol_id,
                    protocol_id=protocol_id,
                    qty_kg=qty_kg,
                    harvested_at=harvested_at,
                    origin_lat=None if origin is None else origin[0],
                    origin_lon=None if origin is None else origin[1],
                    status="open",
                    client_seq=1,
                    client_created_at=harvested_at,
                )
            )
            db.commit()

    prev = hashlib.sha256(f"farmsignal:{batch_id}".encode()).hexdigest()
    for seq, (offset_h, temp_c) in enumerate(readings, start=1):
        reading_id = str(uuid4())
        taken_at = harvested_at + timedelta(hours=offset_h)
        payload = {
            "id": reading_id,
            "batch_id": batch_id,
            "temp_c": temp_c,
            "taken_at": iso_z(taken_at),
            "source": "sim",
            "geohash": None,
            "client_seq": seq,
        }
        posted = None
        if api_batches:
            posted = client.post(
                f"/api/v1/batches/{batch_id}/readings", json=payload, headers=headers
            )
        if posted is not None and posted.status_code in (200, 201):
            continue
        digest = _fixture_hash(
            prev,
            {
                "batch_id": batch_id, "reading_id": reading_id, "seq": seq,
                "temp_c": round(temp_c, 1), "taken_at": iso_z(taken_at),
                "source": "sim", "geohash": None,
            },
        )
        with SessionLocal() as db:
            db.add(
                Reading(
                    id=reading_id,
                    batch_id=batch_id,
                    temp_c=temp_c,
                    taken_at=taken_at,
                    source="sim",
                    seq=seq,
                    client_seq=seq,
                    hash=digest,
                    prev_hash=prev,
                )
            )
            db.commit()
        prev = digest
    return batch_id


def test_hero_batch_recommendation_endpoint(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    now = datetime.now(UTC)
    batch_id = _create_batch(
        client,
        auth_headers,
        farmer_id=_farmer_id(client, auth_headers),
        protocol_id="tomato",
        qty_kg=500,
        harvested_at=now - timedelta(hours=4),
        origin=(12.30, 78.07),
        readings=COOL_MORNING_FIRST_5,
    )
    response = client.get(f"/api/v1/batches/{batch_id}/recommendation", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["batch_id"] == batch_id
    assert body["model_version"] == "routing-1.0"
    assert body["simulated"] is True  # readings are source=sim
    assert body["shelf_life"]["status"] == "fresh"
    assert body["shelf_life"]["protocol_id"] == "tomato"
    assert body["top"]["mandi_id"] == "hosur"
    assert body["top"]["price_source"] in {"bundled_snapshot", "agmarknet_live", "agmarknet_cache"}
    assert body["top"]["expected_value_inr"] == pytest.approx(6638, rel=0.03)
    assert body["nearest"]["mandi_id"] == "palacode"
    assert body["uplift_vs_nearest_pct"] >= 20
    assert [a["mandi_id"] for a in body["alternatives"]] == ["bengaluru", "kolar"]
    assert body["computed_at"].endswith("Z")
    assert body["constants"]["road_factor"] == get_settings().ROAD_FACTOR

    with SessionLocal() as db:
        rows = db.scalars(
            select(RecommendationRow).where(RecommendationRow.batch_id == batch_id)
        ).all()
    assert len(rows) == 1
    assert rows[0].model_version == "routing-1.0"
    assert rows[0].ranked_json["top"]["mandi_id"] == "hosur"
    assert rows[0].ranked_json["batch_id"] == batch_id

    # Each call recomputes and stores a fresh row.
    url = f"/api/v1/batches/{batch_id}/recommendation"
    assert client.get(url, headers=auth_headers).status_code == 200
    stmt = select(RecommendationRow).where(RecommendationRow.batch_id == batch_id)
    with SessionLocal() as db:
        count = len(db.scalars(stmt).all())
    assert count == 2


def test_batch_without_origin_uses_demo_origin(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    now = datetime.now(UTC)
    batch_id = _create_batch(
        client,
        auth_headers,
        farmer_id=_farmer_id(client, auth_headers),
        protocol_id="tomato",
        qty_kg=500,
        harvested_at=now - timedelta(hours=4),
        origin=None,
        readings=COOL_MORNING_FIRST_5,
    )
    body = client.get(f"/api/v1/batches/{batch_id}/recommendation", headers=auth_headers).json()
    assert body["top"]["mandi_id"] == "hosur"
    assert "origin_assumed" in body["top"]["reasons"]


def test_spoiled_batch_has_no_top(client: TestClient, auth_headers: dict[str, str]) -> None:
    now = datetime.now(UTC)
    batch_id = _create_batch(
        client,
        auth_headers,
        farmer_id=_farmer_id(client, auth_headers),
        protocol_id="tomato",
        qty_kg=200,
        harvested_at=now - timedelta(hours=100),
        origin=(12.30, 78.07),
        readings=[],
    )
    body = client.get(f"/api/v1/batches/{batch_id}/recommendation", headers=auth_headers).json()
    assert body["shelf_life"]["status"] == "spoiled"
    assert body["top"] is None
    assert body["reason"] == "batch_spoiled"
    assert body["simulated"] is False


def test_unknown_batch_404(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get(f"/api/v1/batches/{uuid4()}/recommendation", headers=auth_headers)
    assert response.status_code == 404


def test_other_farmers_batch_404(client: TestClient, auth_headers: dict[str, str]) -> None:
    other = client.post(
        "/api/v1/auth/device", json={"device_id": "test-device-other", "display_name": "Other"}
    )
    assert other.status_code == 200
    other_headers = {"Authorization": f"Bearer {other.json()['token']}"}
    batch_id = _create_batch(
        client,
        other_headers,
        farmer_id=str(other.json()["farmer_id"]),
        protocol_id="tomato",
        qty_kg=100,
        harvested_at=datetime.now(UTC) - timedelta(hours=1),
        origin=(12.30, 78.07),
        readings=[(0, 25.0)],
    )
    assert (
        client.get(f"/api/v1/batches/{batch_id}/recommendation", headers=other_headers).status_code
        == 200
    )
    assert (
        client.get(f"/api/v1/batches/{batch_id}/recommendation", headers=auth_headers).status_code
        == 404
    )


def test_recommendation_requires_token(client: TestClient) -> None:
    assert client.get(f"/api/v1/batches/{uuid4()}/recommendation").status_code == 401
