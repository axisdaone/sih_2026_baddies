"""Startup seeding helpers (mandis from data/mandis.json). Protocols: see app.kinetics.registry."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Mandi

MANDI_FIELDS = (
    "id",
    "name",
    "state",
    "district",
    "lat",
    "lon",
    "agmarknet_market",
    "agmarknet_state",
    "agmarknet_district",
)


def mandis_path() -> Path:
    return get_settings().DATA_DIR / "mandis.json"


def load_mandis_file(path: Path | None = None) -> dict[str, Any]:
    """Whole mandis.json document (includes `demo_origin`, `region`)."""
    with open(path or mandis_path(), encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


def seed_mandis(db: Session, path: Path | None = None) -> int:
    """Upsert every mandi from the JSON file; returns the number of rows processed."""
    rows = load_mandis_file(path)["mandis"]
    for row in rows:
        db.merge(Mandi(**{field: row[field] for field in MANDI_FIELDS}))
    db.commit()
    return len(rows)
