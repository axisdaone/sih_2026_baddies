"""Demo telemetry: replay a `data/demo_scenarios/<profile>.json` onto a batch as `sim` readings.

Reading ids are `uuid5(SIM_NAMESPACE, "<farmer_id>:<batch_id>:<profile>:<offset>")`, so
replaying the same profile (or continuing it with a larger `up_to_hours`) appends only what is
new. The owner's id is part of the name because batch ids are public (they are on the QR):
without it a stranger could pre-register the ids and make the owner's replay 409. The farmer id
is server-generated and never leaves the private API, so the ids cannot be precomputed from a
pass page. Simulated readings must always be labelled (`source: "sim"`).

The router defaults `up_to_hours` to `hours_since_harvest(batch)` so a freshly harvested batch
never gets readings from the future appended to its chain; `?all=true` replays the whole profile.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.enums import ReadingSource
from app.models import Batch, Reading, utcnow
from app.schemas import ReadingCreate
from app.services import NotFoundError
from app.services.readings import append_reading

SIM_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://farmsignal.app/sim")


@dataclass(frozen=True, slots=True)
class ProfileReading:
    offset_hours: float
    temp_c: float


@dataclass(frozen=True, slots=True)
class Profile:
    id: str
    name: str
    description: str
    suitable_protocols: tuple[str, ...]
    readings: tuple[ProfileReading, ...]
    expected_story: str = ""  # what the engine should show, in words (for the demo narrator)


def scenarios_dir() -> Path:
    return get_settings().DATA_DIR / "demo_scenarios"


def _parse_profile(path: Path) -> Profile | None:
    """A profile file has `id` == file stem and a `readings` list of {offset_hours, temp_c}.
    Other JSON files in the directory (demo_seed, golden_kinetics) are skipped."""
    with open(path, encoding="utf-8") as fh:
        data: Any = json.load(fh)
    if not isinstance(data, dict) or data.get("id") != path.stem:
        return None
    raw = data.get("readings")
    if not isinstance(raw, list) or not raw:
        return None
    readings: list[ProfileReading] = []
    for item in raw:
        if not isinstance(item, dict) or "offset_hours" not in item or "temp_c" not in item:
            return None
        readings.append(ProfileReading(float(item["offset_hours"]), float(item["temp_c"])))
    readings.sort(key=lambda r: r.offset_hours)
    return Profile(
        id=path.stem,
        name=str(data.get("name", path.stem)),
        description=str(data.get("description", "")),
        suitable_protocols=tuple(str(p) for p in data.get("suitable_protocols", [])),
        readings=tuple(readings),
        expected_story=str(data.get("expected_story", "")),
    )


@lru_cache(maxsize=4)
def _load_profiles(directory: Path) -> dict[str, Profile]:
    profiles: dict[str, Profile] = {}
    for path in sorted(directory.glob("*.json")):
        profile = _parse_profile(path)
        if profile is not None:
            profiles[profile.id] = profile
    return profiles


def load_profiles() -> dict[str, Profile]:
    """All simulation profiles keyed by id (cached; the directory is read once)."""
    return _load_profiles(scenarios_dir())


def get_profile(profile_id: str) -> Profile:
    """Profile by id; 404 when there is no such file (ids are validated against the directory)."""
    try:
        return load_profiles()[profile_id]
    except KeyError:
        raise NotFoundError(f"unknown profile {profile_id!r}") from None


def sim_reading_id(batch: Batch, profile_id: str, offset_hours: float) -> str:
    """Deterministic per (owner, batch, profile, offset) — see the module docstring."""
    name = f"{batch.farmer_id}:{batch.id}:{profile_id}:{float(offset_hours):.4f}"
    return str(uuid.uuid5(SIM_NAMESPACE, name))


def hours_since_harvest(batch: Batch, now: datetime | None = None) -> float:
    """Hours elapsed since `batch.harvested_at` (never negative) — the telemetry player's
    "current hour", and the default `up_to_hours` of the simulate route."""
    at = utcnow() if now is None else now
    return max(0.0, (at - batch.harvested_at).total_seconds() / 3600.0)


def simulate_batch(
    db: Session, batch: Batch, profile_id: str, up_to_hours: float | None = None
) -> tuple[list[Reading], int]:
    """Append the profile's readings (offset <= `up_to_hours`, all when None) to `batch`.

    `taken_at = harvested_at + offset_hours`, `source = "sim"`, `geohash` = the batch origin.
    Returns `(touched readings in profile order, number newly appended)`.
    """
    profile = get_profile(profile_id)
    touched: list[Reading] = []
    appended = 0
    for index, item in enumerate(profile.readings, start=1):
        if up_to_hours is not None and item.offset_hours > up_to_hours + 1e-9:
            continue
        body = ReadingCreate(
            id=sim_reading_id(batch, profile.id, item.offset_hours),
            batch_id=batch.id,
            temp_c=item.temp_c,
            taken_at=batch.harvested_at + timedelta(hours=item.offset_hours),
            source=ReadingSource.SIM,
            geohash=batch.origin_geohash,
            client_seq=index,
        )
        reading, created = append_reading(db, batch, body)
        touched.append(reading)
        appended += int(created)
    return touched, appended
