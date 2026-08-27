"""POST /sync (contract section 7): ordering, dedupe, append-only readings, per-op rejection,
clock-skew correction, device binding, and the full batch list in the response."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import SyncOp
from app.schemas import iso_z, parse_iso_z

API = "/api/v1"
SYNC_DEVICE = "test-device-sync-01"


@pytest.fixture(scope="module")
def sync_headers(client: TestClient) -> dict[str, str]:
    response = client.post(f"{API}/auth/device", json={"device_id": SYNC_DEVICE})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture(scope="module")
def sync_farmer_id(client: TestClient, sync_headers: dict[str, str]) -> str:
    response = client.get(f"{API}/auth/me", headers=sync_headers)
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


def _now() -> datetime:
    return datetime.now(UTC)


def _batch_payload(harvested_hours_ago: float = 6, **overrides: Any) -> dict[str, Any]:
    harvested = _now() - timedelta(hours=harvested_hours_ago)
    payload: dict[str, Any] = {
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
    payload.update(overrides)
    return payload


def _reading_payload(
    batch_id: str, hours_ago: float = 1, temp_c: float = 28.0, **overrides: Any
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "batch_id": batch_id,
        "temp_c": temp_c,
        "taken_at": iso_z(_now() - timedelta(hours=hours_ago)),
        "source": "manual",
        "geohash": None,
        "client_seq": 2,
    }
    payload.update(overrides)
    return payload


def _op(
    kind: str, payload: dict[str, Any], client_seq: int, op_id: str | None = None
) -> dict[str, Any]:
    return {
        "op_id": op_id or str(uuid.uuid4()),
        "client_seq": client_seq,
        "kind": kind,
        "payload": payload,
        "client_time": iso_z(_now()),
    }


def _sync(
    client: TestClient,
    headers: dict[str, str],
    ops: list[dict[str, Any]],
    *,
    client_now: datetime | None = None,
    device_id: str = SYNC_DEVICE,
    expect: int = 200,
) -> dict[str, Any]:
    body = {"device_id": device_id, "client_now": iso_z(client_now or _now()), "ops": ops}
    response = client.post(f"{API}/sync", json=body, headers=headers)
    assert response.status_code == expect, response.text
    data: dict[str, Any] = response.json()
    return data


def _batch_in(data: dict[str, Any], batch_id: str) -> dict[str, Any]:
    matches = [b for b in data["batches"] if b["id"] == batch_id]
    assert len(matches) == 1, f"batch {batch_id} not in response"
    return matches[0]


def _sync_op_status(op_id: str) -> str | None:
    with SessionLocal() as db:
        row = db.scalar(select(SyncOp).where(SyncOp.op_id == op_id))
        return None if row is None else row.status


def _seconds_apart(a: str, b: datetime) -> float:
    return abs((parse_iso_z(a) - b).total_seconds())


def test_applies_mixed_kinds_in_client_seq_order(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    batch = _batch_payload()
    reading = _reading_payload(batch["id"], client_seq=3)
    create = _op("batch.create", batch, 1)
    update = _op("batch.update", {"id": batch["id"], "notes": "from sync", "client_seq": 2}, 2)
    append = _op("reading.append", reading, 3)

    # Sent out of order on purpose: the server must apply create -> update -> reading.
    data = _sync(client, sync_headers, [append, update, create])

    assert [r["op_id"] for r in data["results"]] == [
        create["op_id"],
        update["op_id"],
        append["op_id"],
    ]
    assert [r["status"] for r in data["results"]] == ["applied"] * 3
    assert all(r["error"] is None for r in data["results"])
    assert all(r["clock_adjusted"] is False for r in data["results"])

    created, patched, appended = (r["entity"] for r in data["results"])
    assert created["id"] == batch["id"] and created["status"] == "open"
    assert patched["notes"] == "from sync" and patched["client_seq"] == 2
    assert appended["id"] == reading["id"] and appended["seq"] == 1
    assert len(appended["hash"]) == 64 and appended["temp_c"] == 28.0

    stored = _batch_in(data, batch["id"])
    assert stored["notes"] == "from sync"
    assert [r["id"] for r in stored["readings"]] == [reading["id"]]
    assert stored["chain_head"] == appended["hash"]
    hours = stored["shelf_life"]["remaining_hours"]
    assert hours["low"] <= hours["mid"] <= hours["high"]
    assert stored["shelf_life"]["current_temp_c"] == 28.0
    assert isinstance(data["alerts"], list)
    assert data["server_now"].endswith("Z")
    for op in (create, update, append):
        assert _sync_op_status(op["op_id"]) == "applied"


def test_duplicate_op_id_is_a_no_op(client: TestClient, sync_headers: dict[str, str]) -> None:
    batch = _batch_payload()
    create = _op("batch.create", batch, 1)
    first = _sync(client, sync_headers, [create])
    assert first["results"][0]["status"] == "applied"
    created_at = first["results"][0]["entity"]["created_at"]

    replay = _sync(client, sync_headers, [create])
    result = replay["results"][0]
    assert result["status"] == "duplicate"
    assert result["error"] is None
    assert result["entity"]["id"] == batch["id"]
    assert result["entity"]["created_at"] == created_at
    assert _sync_op_status(create["op_id"]) == "applied"

    # A *new* op that re-creates an existing batch is also a duplicate (idempotent create).
    again = _sync(client, sync_headers, [_op("batch.create", {**batch, "qty_kg": 1}, 5)])
    assert again["results"][0]["status"] == "duplicate"
    assert again["results"][0]["entity"]["qty_kg"] == 500


def test_reading_duplicate_never_overwrites(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    batch = _batch_payload()
    reading = _reading_payload(batch["id"], temp_c=28.0)
    data = _sync(
        client,
        sync_headers,
        [_op("batch.create", batch, 1), _op("reading.append", reading, 2)],
    )
    assert data["results"][1]["status"] == "applied"
    original_hash = data["results"][1]["entity"]["hash"]

    # Same reading id, different temperature, brand-new op_id: append-only means "duplicate".
    replay = _sync(client, sync_headers, [_op("reading.append", {**reading, "temp_c": 40.0}, 3)])
    result = replay["results"][0]
    assert result["status"] == "duplicate"
    assert result["entity"]["temp_c"] == 28.0
    assert result["entity"]["hash"] == original_hash

    listing = client.get(f"{API}/batches/{batch['id']}/readings", headers=sync_headers)
    assert listing.status_code == 200
    assert [(r["id"], r["temp_c"]) for r in listing.json()] == [(reading["id"], 28.0)]


def test_bad_ops_are_rejected_while_others_apply(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    orphan = _op("reading.append", _reading_payload(str(uuid.uuid4())), 1)
    negative = _op("batch.create", _batch_payload(qty_kg=-1), 2)
    unknown_protocol = _op("batch.create", _batch_payload(protocol_id="durian"), 3)
    no_id = _op("batch.update", {"notes": "x", "client_seq": 1}, 4)
    good = _op("batch.create", _batch_payload(), 5)

    data = _sync(client, sync_headers, [orphan, negative, unknown_protocol, no_id, good])
    by_id = {r["op_id"]: r for r in data["results"]}

    assert by_id[orphan["op_id"]]["status"] == "rejected"
    assert by_id[orphan["op_id"]]["error"] == "batch_not_found"
    assert by_id[negative["op_id"]]["status"] == "rejected"
    assert by_id[negative["op_id"]]["error"].startswith("invalid payload: qty_kg")
    assert by_id[unknown_protocol["op_id"]]["status"] == "rejected"
    assert "durian" in by_id[unknown_protocol["op_id"]]["error"]
    assert by_id[no_id["op_id"]]["status"] == "rejected"
    assert "id" in by_id[no_id["op_id"]]["error"]
    assert by_id[good["op_id"]]["status"] == "applied"
    assert _batch_in(data, good["payload"]["id"])["qty_kg"] == 500
    for op in (orphan, negative, unknown_protocol, no_id):
        assert by_id[op["op_id"]]["entity"] is None
        assert _sync_op_status(op["op_id"]) == "rejected"


def test_rejected_op_is_retried_not_deduped(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    batch = _batch_payload()
    append = _op("reading.append", _reading_payload(batch["id"]), 2)
    first = _sync(client, sync_headers, [append])
    assert first["results"][0]["status"] == "rejected"

    # The PWA re-sends failed ops; once the batch exists the same op_id must apply.
    second = _sync(client, sync_headers, [_op("batch.create", batch, 1), append])
    assert [r["status"] for r in second["results"]] == ["applied", "applied"]
    assert _sync_op_status(append["op_id"]) == "applied"


def test_clock_skew_shifts_timestamps(client: TestClient, sync_headers: dict[str, str]) -> None:
    client_now = _now() + timedelta(minutes=10)  # device clock runs 10 min ahead
    batch = _batch_payload(
        harvested_at=iso_z(client_now - timedelta(hours=2)),
        client_created_at=iso_z(client_now - timedelta(hours=2)),
    )
    reading = _reading_payload(batch["id"], taken_at=iso_z(client_now - timedelta(minutes=5)))

    data = _sync(
        client,
        sync_headers,
        [_op("batch.create", batch, 1), _op("reading.append", reading, 2)],
        client_now=client_now,
    )
    assert abs(data["clock_skew_seconds"] - 600) < 5
    server_now = parse_iso_z(data["server_now"])
    assert all(r["status"] == "applied" and r["clock_adjusted"] for r in data["results"])

    created, appended = (r["entity"] for r in data["results"])
    assert _seconds_apart(created["harvested_at"], server_now - timedelta(hours=2)) < 5
    assert _seconds_apart(created["client_created_at"], server_now - timedelta(hours=2)) < 5
    assert _seconds_apart(appended["taken_at"], server_now - timedelta(minutes=5)) < 5
    # Kinetics see the corrected timeline: the reading is "5 minutes old", not "in the future".
    assert 0 <= _batch_in(data, batch["id"])["shelf_life"]["hours_since_last_reading"] < 0.2

    # Once the clocks agree (or differ by <= 120 s) nothing is shifted.
    for offset in (timedelta(0), timedelta(seconds=60)):
        later = _reading_payload(batch["id"], hours_ago=0.5, client_seq=3)
        agreed = _sync(
            client, sync_headers, [_op("reading.append", later, 3)], client_now=_now() + offset
        )
        assert abs(agreed["clock_skew_seconds"] - offset.total_seconds()) < 5
        assert agreed["results"][0]["status"] == "applied"
        assert agreed["results"][0]["clock_adjusted"] is False
        assert agreed["results"][0]["entity"]["taken_at"] == later["taken_at"]


def test_device_mismatch_is_401(client: TestClient, sync_headers: dict[str, str]) -> None:
    _sync(client, sync_headers, [], device_id="some-other-device", expect=401)
    _sync(client, {}, [], expect=401)


def test_stale_patch_is_ignored_last_writer_wins(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    batch = _batch_payload()
    newer = _op("batch.update", {"id": batch["id"], "notes": "new", "client_seq": 5}, 5)
    older = _op("batch.update", {"id": batch["id"], "notes": "old", "client_seq": 3}, 6)
    data = _sync(client, sync_headers, [_op("batch.create", batch, 1), newer, older])
    assert [r["status"] for r in data["results"]] == ["applied"] * 3
    assert data["results"][2]["entity"]["notes"] == "new"
    assert _batch_in(data, batch["id"])["notes"] == "new"


def test_response_lists_only_this_farmers_batches_with_shelf_life(
    client: TestClient,
    sync_headers: dict[str, str],
    sync_farmer_id: str,
    auth_headers: dict[str, str],
) -> None:
    other = client.post(f"{API}/batches", json=_batch_payload(), headers=auth_headers)
    assert other.status_code == 201
    mine = _batch_payload()
    data = _sync(client, sync_headers, [_op("batch.create", mine, 1)])

    ids = {b["id"] for b in data["batches"]}
    assert mine["id"] in ids and other.json()["id"] not in ids
    for batch in data["batches"]:
        assert batch["farmer_id"] == sync_farmer_id
        assert batch["readings"] is not None
        hours = batch["shelf_life"]["remaining_hours"]
        assert hours["low"] <= hours["mid"] <= hours["high"]

    empty = _sync(client, sync_headers, [])
    assert empty["results"] == []
    assert {b["id"] for b in empty["batches"]} == ids


def test_alerts_follow_shelf_life_status(client: TestClient, sync_headers: dict[str, str]) -> None:
    # Tomato at the 30 C default ambient lasts 72 h: 50 h -> warning, 60 h -> critical.
    warning = _batch_payload(harvested_hours_ago=50)
    critical = _batch_payload(harvested_hours_ago=60)
    data = _sync(
        client,
        sync_headers,
        [_op("batch.create", warning, 1), _op("batch.create", critical, 2)],
    )
    assert _batch_in(data, warning["id"])["shelf_life"]["status"] == "warning"
    assert _batch_in(data, critical["id"])["shelf_life"]["status"] == "critical"

    def keys(batch_id: str) -> list[str]:
        return [a["message_key"] for a in data["alerts"] if a["batch_id"] == batch_id]

    assert keys(warning["id"]) == ["alert_75", "alert_50"]
    assert keys(critical["id"]) == ["alert_75", "alert_50", "alert_25", "sell_now"]
    sell_now = next(a for a in data["alerts"] if a["message_key"] == "sell_now")
    assert sell_now["threshold"] is None and sell_now["status"] == "critical"

    # Selling the batch silences its alerts.
    sold = _sync(
        client,
        sync_headers,
        [_op("batch.update", {"id": critical["id"], "status": "sold", "client_seq": 3}, 3)],
    )
    assert all(a["batch_id"] != critical["id"] for a in sold["alerts"])
