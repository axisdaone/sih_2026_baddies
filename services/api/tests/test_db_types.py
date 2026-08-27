"""TZDateTime must round-trip aware UTC through SQLite and serialise with a trailing Z."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Farmer
from app.schemas import FarmerOut, iso_z, parse_iso_z


def test_tzdatetime_roundtrip(client: TestClient) -> None:
    ist = timezone(timedelta(hours=5, minutes=30))
    created_ist = datetime(2026, 8, 27, 12, 0, 0, tzinfo=ist)  # == 06:30Z
    device = f"tz-device-{uuid4()}"
    with SessionLocal() as db:
        db.add(Farmer(device_id=device, created_at=created_ist))
        db.commit()
    with SessionLocal() as db:
        row = db.query(Farmer).filter_by(device_id=device).one()
        assert row.created_at.tzinfo is not None
        assert row.created_at == created_ist
        assert row.created_at.utcoffset() == timedelta(0)
        assert FarmerOut.model_validate(row).model_dump(mode="json")["created_at"] == (
            "2026-08-27T06:30:00Z"
        )


def test_iso_z_helpers() -> None:
    assert iso_z(datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)) == "2026-01-02T03:04:05Z"
    assert iso_z(datetime(2026, 1, 2, 3, 4, 5, 250_000, tzinfo=UTC)) == "2026-01-02T03:04:05.250Z"
    assert parse_iso_z("2026-01-02T03:04:05Z") == datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    assert parse_iso_z("2026-01-02T08:34:05+05:30") == datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
