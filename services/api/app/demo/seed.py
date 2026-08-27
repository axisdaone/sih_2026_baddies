"""Scripted demo dataset (POST /demo/seed) from `data/demo_scenarios/demo_seed.json`.

Semantics (see data/demo_scenarios/README.md section 2):

* the demo farmer is found-or-created by `device_id` (`demo-device-001`);
* `harvested_at = now - harvested_hours_ago`, `client_created_at = harvested_at`;
* readings: `taken_at = harvested_at + offset_hours`, only offsets <= `harvested_hours_ago`,
  always `source: "sim"` (simulated data must be labelled), geohash = batch origin;
* `client_seq` = 1-based batch index for batches, 1-based position for readings;
* ids are fixed in the file, so replays are no-ops (existing batches keep their original
  `harvested_at`, so their reading timestamps stay consistent). `reset=True` deletes the demo
  farmer's data first and re-anchors everything to `now` — for a pitch days after the first seed
  (chain heads change, so printed QR codes must be regenerated);
* the fixed ids are public (the seed file is in the repo), so a stranger could pre-register one
  under their own farmer and make every later seed 409. When that happens the batch / reading
  falls back to `uuid5(demo_farmer.id, fixed_id)`: derived from the demo farmer's row id (stable
  for the life of the DB, unlike JWT_SECRET) so replays are still no-ops, and unguessable
  because the farmer id never leaves the private API.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import DEMO_DEVICE_ID, get_settings
from app.enums import Crop, ReadingSource
from app.models import Batch, Farmer, PassEvent, Reading, Recommendation, SyncOp, utcnow
from app.schemas import BatchCreate, ReadingCreate
from app.services import ConflictError
from app.services.batches import upsert_batch
from app.services.readings import append_reading

__all__ = ["DEMO_DEVICE_ID", "SeedResult", "derived_id", "seed_demo"]


@dataclass(slots=True)
class SeedResult:
    farmer: Farmer
    batch_ids: list[str] = field(default_factory=list)
    batches_created: int = 0
    batches_existing: int = 0
    readings_created: int = 0
    loss_comparison: dict[str, Any] = field(default_factory=dict)


def seed_path() -> Path:
    return get_settings().DATA_DIR / "demo_scenarios" / "demo_seed.json"


def derived_id(farmer: Farmer, fixed_id: str) -> str:
    """Fallback id when `fixed_id` is already taken by another tenant (see module docstring)."""
    return str(uuid.uuid5(uuid.UUID(farmer.id), fixed_id))


def load_seed(path: Path | None = None) -> dict[str, Any]:
    with open(path or seed_path(), encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


def seed_demo(
    db: Session,
    *,
    now: datetime | None = None,
    reset: bool = False,
    path: Path | None = None,
) -> SeedResult:
    """Idempotently seed the demo farmer + batches + readings; see the module docstring."""
    data = load_seed(path)
    at = utcnow() if now is None else now
    farmer = ensure_demo_farmer(db, data["farmer"])
    if reset:
        reset_farmer_data(db, farmer)

    result = SeedResult(farmer=farmer, loss_comparison=dict(data.get("loss_comparison", {})))
    for index, spec in enumerate(data["batches"], start=1):
        hours_ago = float(spec["harvested_hours_ago"])
        harvested_at = at - timedelta(hours=hours_ago)
        body = BatchCreate(
            id=spec["id"],
            crop=Crop(spec["crop"]),
            protocol_id=spec["protocol_id"],
            qty_kg=float(spec["qty_kg"]),
            harvested_at=harvested_at,
            origin_lat=spec.get("origin_lat"),
            origin_lon=spec.get("origin_lon"),
            notes=spec.get("notes"),
            client_seq=index,
            client_created_at=harvested_at,
        )
        try:
            batch, created = upsert_batch(db, farmer, body)
        except ConflictError:  # fixed id squatted by another farmer: derive a private one
            body = body.model_copy(update={"id": derived_id(farmer, body.id)})
            batch, created = upsert_batch(db, farmer, body)
        result.batch_ids.append(batch.id)
        if created:
            result.batches_created += 1
        else:
            result.batches_existing += 1
        result.readings_created += _seed_readings(db, batch, spec.get("readings", []), hours_ago)
    return result


def ensure_demo_farmer(db: Session, spec: dict[str, Any]) -> Farmer:
    """Find-or-create by device_id. An existing farmer keeps its data; only a *missing*
    display name is filled from the spec (a bare `POST /auth/device` with the demo id before
    the first seed would otherwise leave the demo farmer nameless on every Quality Pass)."""
    device_id = str(spec.get("device_id", DEMO_DEVICE_ID))
    farmer = db.scalar(select(Farmer).where(Farmer.device_id == device_id))
    if farmer is not None and farmer.display_name is None and spec.get("display_name"):
        farmer.display_name = str(spec["display_name"])
        db.commit()
        db.refresh(farmer)
    if farmer is None:
        farmer = Farmer(
            device_id=device_id,
            display_name=spec.get("display_name"),
            locale=str(spec.get("locale", "en")),
        )
        db.add(farmer)
        db.commit()
        db.refresh(farmer)
    return farmer


def reset_farmer_data(db: Session, farmer: Farmer) -> None:
    """Hard-delete the farmer's batches (+ readings, recommendations, pass events) and sync log."""
    batch_ids = select(Batch.id).where(Batch.farmer_id == farmer.id)
    db.execute(delete(PassEvent).where(PassEvent.batch_id.in_(batch_ids)))
    db.execute(delete(Recommendation).where(Recommendation.batch_id.in_(batch_ids)))
    db.execute(delete(Reading).where(Reading.batch_id.in_(batch_ids)))
    db.execute(delete(Batch).where(Batch.farmer_id == farmer.id))
    db.execute(delete(SyncOp).where(SyncOp.device_id == farmer.device_id))
    db.commit()
    db.expire_all()


def _seed_readings(
    db: Session, batch: Batch, readings: list[dict[str, Any]], hours_ago: float
) -> int:
    """Append the readings relative to the *stored* harvested_at; returns how many were new."""
    created = 0
    for position, item in enumerate(readings, start=1):
        offset = float(item["offset_hours"])
        if offset > hours_ago + 1e-9:
            continue  # the rest of the scenario belongs to the telemetry player
        body = ReadingCreate(
            id=item["id"],
            batch_id=batch.id,
            temp_c=float(item["temp_c"]),
            taken_at=batch.harvested_at + timedelta(hours=offset),
            source=ReadingSource.SIM,
            geohash=batch.origin_geohash,
            client_seq=position,
        )
        try:
            _, was_created = append_reading(db, batch, body)
        except ConflictError:  # fixed id squatted on another batch: derive a private one
            # Derived from the (possibly remapped) batch id so replays stay no-ops.
            fallback = derived_id(batch.farmer, f"{batch.id}:{body.id}")
            _, was_created = append_reading(db, batch, body.model_copy(update={"id": fallback}))
        created += int(was_created)
    return created
