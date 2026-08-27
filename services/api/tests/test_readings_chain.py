"""Readings API + hash chain (contract section 4). The pinned vector below is the cross-language
fixture: apps/web/src/engine/hashchain.ts must produce the same hash for the same input."""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.kinetics.engine import round_half_up
from app.models import Reading
from app.quality_pass.chain import (
    canonical_payload,
    canonical_taken_at,
    canonical_temp,
    genesis_hash,
    reading_hash,
    verify_chain,
)
from app.schemas import iso_z

API = "/api/v1"

# --- pinned cross-language vector ---------------------------------------------------------
VECTOR_BATCH_ID = "6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01"
VECTOR_READING_ID = "11111111-1111-4111-8111-111111111111"
VECTOR_GENESIS = "6b1a79d4f77f56686e4d2824ac9bff0dd3e3ab1cbf4a5fb01f2ceab1feb5f192"
VECTOR_PAYLOAD = (
    '{"batch_id":"6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01","geohash":null,'
    '"reading_id":"11111111-1111-4111-8111-111111111111","seq":1,"source":"manual",'
    '"taken_at":"2026-08-27T06:30:00Z","temp_c":28.0}'
)
VECTOR_HASH = "a23ebd7d0c22a337e33a7b05f60aad7f32d7933a76c0730dcc08cd2711e6d5d7"


def test_pinned_vector() -> None:
    assert genesis_hash(VECTOR_BATCH_ID) == VECTOR_GENESIS
    payload = canonical_payload(
        batch_id=VECTOR_BATCH_ID,
        reading_id=VECTOR_READING_ID,
        seq=1,
        temp_c=28.0,
        taken_at=datetime(2026, 8, 27, 6, 30, tzinfo=UTC),
        source="manual",
        geohash=None,
    )
    assert payload == VECTOR_PAYLOAD
    assert reading_hash(VECTOR_GENESIS, payload) == VECTOR_HASH


def test_canonical_formatting() -> None:
    assert canonical_temp(31.5) == "31.5"
    assert canonical_temp(28) == "28.0"
    assert canonical_temp(-0.0) == "0.0"
    assert canonical_temp(-0.04) == "0.0"  # would be '-0.0' with a bare f"{x:.1f}"
    assert canonical_temp(-1.0) == "-1.0"
    assert canonical_temp(-0.06) == "-0.1"
    # Sub-seconds are truncated and offsets are normalised to UTC.
    ist = timezone(timedelta(hours=5, minutes=30))
    assert canonical_taken_at(datetime(2026, 8, 27, 12, 0, 0, 999_000, tzinfo=ist)) == (
        "2026-08-27T06:30:00Z"
    )
    assert canonical_taken_at(datetime(2026, 8, 27, 6, 30)) == "2026-08-27T06:30:00Z"  # naive=UTC
    payload = canonical_payload(
        batch_id="b",
        reading_id="r",
        seq=7,
        temp_c=31.5,
        taken_at=datetime(2026, 8, 27, 6, 30, tzinfo=UTC),
        source="sim",
        geohash="tf3rq2k",
    )
    assert payload == (
        '{"batch_id":"b","geohash":"tf3rq2k","reading_id":"r","seq":7,"source":"sim",'
        '"taken_at":"2026-08-27T06:30:00Z","temp_c":31.5}'
    )
    assert " " not in payload


# --- pure verify_chain ----------------------------------------------------------------------


@dataclass(frozen=True)
class FakeReading:
    id: str
    seq: int
    temp_c: float
    taken_at: datetime
    source: str
    geohash: str | None
    hash: str
    prev_hash: str


def _fake_chain(batch_id: str, temps: list[float]) -> list[FakeReading]:
    prev = genesis_hash(batch_id)
    rows: list[FakeReading] = []
    base = datetime(2026, 8, 27, 6, 30, tzinfo=UTC)
    for index, temp in enumerate(temps, start=1):
        rid = f"00000000-0000-4000-8000-{index:012d}"
        taken = base + timedelta(hours=index)
        payload = canonical_payload(
            batch_id=batch_id,
            reading_id=rid,
            seq=index,
            temp_c=temp,
            taken_at=taken,
            source="manual",
            geohash=None,
        )
        digest = reading_hash(prev, payload)
        rows.append(FakeReading(rid, index, temp, taken, "manual", None, digest, prev))
        prev = digest
    return rows


def test_verify_chain_pure() -> None:
    batch_id = str(uuid.uuid4())
    empty = verify_chain(batch_id, [])
    assert empty.valid and empty.chain_head is None and empty.length == 0
    assert empty.first_bad_seq is None

    rows = _fake_chain(batch_id, [28.0, 30.5, 33.0])
    ok = verify_chain(batch_id, rows)
    assert ok.valid and ok.length == 3 and ok.first_bad_seq is None
    assert ok.chain_head == rows[-1].hash == ok.stored_head

    tampered = [rows[0], replace(rows[1], temp_c=25.0), rows[2]]
    bad = verify_chain(batch_id, tampered)
    assert not bad.valid
    assert bad.first_bad_seq == 2
    assert bad.length == 3
    assert bad.chain_head != bad.stored_head  # recomputed head no longer matches the stored one

    reordered = [rows[1], rows[0], rows[2]]
    assert verify_chain(batch_id, reordered).first_bad_seq == 2  # seq 2 where 1 was expected


# --- API ------------------------------------------------------------------------------------


def _create_batch(client: TestClient, headers: dict[str, str], hours_ago: float = 10) -> str:
    harvested = datetime.now(UTC) - timedelta(hours=hours_ago)
    body = {
        "id": str(uuid.uuid4()),
        "crop": "tomato",
        "protocol_id": "tomato",
        "qty_kg": 300,
        "harvested_at": iso_z(harvested),
        "origin_lat": 12.3,
        "origin_lon": 78.07,
        "client_seq": 1,
        "client_created_at": iso_z(harvested),
    }
    response = client.post(f"{API}/batches", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return body["id"]


def _reading_body(
    batch_id: str, hours_ago: float, temp_c: float, **overrides: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "batch_id": batch_id,
        "temp_c": temp_c,
        "taken_at": iso_z(datetime.now(UTC) - timedelta(hours=hours_ago)),
        "source": "manual",
        "geohash": None,
        "client_seq": 1,
    }
    body.update(overrides)
    return body


def test_append_reading_assigns_seq_and_chain(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    batch_id = _create_batch(client, auth_headers)
    url = f"{API}/batches/{batch_id}/readings"

    first_body = _reading_body(batch_id, 9, 28.26, geohash="tf3rq2k")
    first = client.post(url, json=first_body, headers=auth_headers)
    assert first.status_code == 201, first.text
    r1 = first.json()
    assert r1["seq"] == 1
    assert r1["temp_c"] == 28.3  # rounded to 1 dp at input time
    assert r1["prev_hash"] == genesis_hash(batch_id)
    expected = reading_hash(
        genesis_hash(batch_id),
        canonical_payload(
            batch_id=batch_id,
            reading_id=first_body["id"],
            seq=1,
            temp_c=28.3,
            taken_at=datetime.fromisoformat(first_body["taken_at"].replace("Z", "+00:00")),
            source="manual",
            geohash="tf3rq2k",
        ),
    )
    assert r1["hash"] == expected
    assert r1["received_at"].endswith("Z")

    # Duplicate id: 200, stored row returned unchanged even if the payload drifted.
    replay = client.post(url, json={**first_body, "temp_c": 45}, headers=auth_headers)
    assert replay.status_code == 200
    assert replay.json()["hash"] == r1["hash"]
    assert replay.json()["temp_c"] == 28.3

    second = client.post(url, json=_reading_body(batch_id, 5, 31.25), headers=auth_headers)
    assert second.status_code == 201
    r2 = second.json()
    assert r2["seq"] == 2
    assert r2["prev_hash"] == r1["hash"]
    assert r2["temp_c"] == 31.3  # half-up, like JS Math.round(x * 10) / 10

    listed = client.get(url, headers=auth_headers).json()
    assert [r["seq"] for r in listed] == [1, 2]
    assert [r["hash"] for r in listed] == [r1["hash"], r2["hash"]]

    detail = client.get(f"{API}/batches/{batch_id}", headers=auth_headers).json()
    assert detail["chain_head"] == r2["hash"]
    assert detail["shelf_life"]["current_temp_c"] == 31.3
    assert detail["shelf_life"]["confidence"] == "medium"  # last reading 5 h old (<= 8 h)
    assert len(detail["readings"]) == 2


def test_negative_zero_temperature_is_normalised(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    """-0.04 rounds to a zero that must be stored and hashed as +0.0 ('0.0' like TS toFixed)."""
    rounded = round_half_up(-0.04, 1) + 0.0
    assert rounded == 0.0 and math.copysign(1.0, rounded) > 0
    assert canonical_temp(rounded) == "0.0"

    batch_id = _create_batch(client, auth_headers)
    body = _reading_body(batch_id, 1, -0.04)
    response = client.post(f"{API}/batches/{batch_id}/readings", json=body, headers=auth_headers)
    assert response.status_code == 201, response.text
    reading = response.json()
    assert reading["temp_c"] == 0.0
    assert '"temp_c":-0' not in response.text and '"temp_c": -0' not in response.text
    payload = canonical_payload(
        batch_id=batch_id,
        reading_id=body["id"],
        seq=1,
        temp_c=0.0,
        taken_at=datetime.fromisoformat(body["taken_at"].replace("Z", "+00:00")),
        source="manual",
        geohash=None,
    )
    assert payload.endswith('"temp_c":0.0}')
    assert reading["hash"] == reading_hash(genesis_hash(batch_id), payload)

    with SessionLocal() as db:
        stored = db.get(Reading, body["id"])
        assert stored is not None
        assert stored.temp_c == 0.0 and math.copysign(1.0, stored.temp_c) > 0
    verify = client.get(f"{API}/quality-pass/{batch_id}/verify", params={"head": reading["hash"]})
    assert verify.json()["valid"] is True and verify.json()["head_matches"] is True


def test_reading_validation_and_scoping(client: TestClient, auth_headers: dict[str, str]) -> None:
    batch_id = _create_batch(client, auth_headers)
    other_batch = _create_batch(client, auth_headers)
    url = f"{API}/batches/{batch_id}/readings"

    mismatch = client.post(url, json=_reading_body(other_batch, 1, 30), headers=auth_headers)
    assert mismatch.status_code == 422

    body = _reading_body(batch_id, 1, 30)
    assert client.post(url, json=body, headers=auth_headers).status_code == 201
    reused = client.post(
        f"{API}/batches/{other_batch}/readings",
        json={**body, "batch_id": other_batch},
        headers=auth_headers,
    )
    assert reused.status_code == 409
    assert reused.json()["detail"] == "id already in use"  # neutral: no ownership oracle

    stranger = client.post(
        f"{API}/auth/device", json={"device_id": "0f3c1a2b-5d6e-4f70-8a9b-0c1d2e3f4a06"}
    )
    other_headers = {"Authorization": f"Bearer {stranger.json()['token']}"}
    assert client.get(url, headers=other_headers).status_code == 404
    foreign = client.post(url, json=_reading_body(batch_id, 1, 30), headers=other_headers)
    assert foreign.status_code == 404
    assert client.get(url, headers={}).status_code == 401


def test_tamper_is_detected_by_verify(client: TestClient, auth_headers: dict[str, str]) -> None:
    batch_id = _create_batch(client, auth_headers)
    url = f"{API}/batches/{batch_id}/readings"
    hashes = []
    for hours_ago, temp in ((9, 28.0), (6, 30.0), (3, 31.5)):
        body = _reading_body(batch_id, hours_ago, temp)
        response = client.post(url, json=body, headers=auth_headers)
        assert response.status_code == 201
        hashes.append(response.json()["hash"])
    head = hashes[-1]

    verify_url = f"{API}/quality-pass/{batch_id}/verify"
    good = client.get(verify_url, params={"head": head[:16]}).json()
    assert good == {
        "valid": True,
        "chain_head": head,
        "length": 3,
        "first_bad_seq": None,
        "head_matches": True,
    }
    assert client.get(verify_url, params={"head": "0" * 16}).json()["head_matches"] is False

    # Tamper with the second reading directly in the DB (what a dishonest operator would do).
    with SessionLocal() as db:
        row = db.query(Reading).filter_by(batch_id=batch_id, seq=2).one()
        row.temp_c = 12.0
        db.commit()

    bad = client.get(verify_url, params={"head": head[:16]}).json()
    assert bad["valid"] is False
    assert bad["first_bad_seq"] == 2
    assert bad["length"] == 3
    assert bad["head_matches"] is False
    assert bad["chain_head"] != head  # recomputed from the tampered data

    public = client.get(f"{API}/quality-pass/{batch_id}").json()
    assert public["chain_valid"] is False
    assert public["chain_head"] == head  # the stored head is still what the QR printed
