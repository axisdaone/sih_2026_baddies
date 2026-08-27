"""Protocol registry: loads app/kinetics/protocols/*.json and seeds the `protocols` table."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models import Protocol

PROTOCOLS_DIR = Path(__file__).resolve().parent / "protocols"
MODEL_VERSION = "kinetics-1.0"


@lru_cache(maxsize=1)
def load_protocols() -> dict[str, dict[str, Any]]:
    """All protocol JSON files keyed by `id`. Cached; treat the returned dicts as read-only."""
    protocols: dict[str, dict[str, Any]] = {}
    for path in sorted(PROTOCOLS_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as fh:
            data: dict[str, Any] = json.load(fh)
        protocol_id = data.get("id")
        if not isinstance(protocol_id, str) or not protocol_id:
            raise ValueError(f"protocol file {path.name} has no string 'id'")
        if protocol_id in protocols:
            raise ValueError(f"duplicate protocol id {protocol_id!r} in {path.name}")
        protocols[protocol_id] = data
    return protocols


def get_protocol(protocol_id: str) -> dict[str, Any]:
    """Protocol dict by id; raises KeyError when unknown."""
    return load_protocols()[protocol_id]


def list_protocols() -> list[dict[str, Any]]:
    return list(load_protocols().values())


def seed_protocols(db: Session) -> int:
    """Upsert every protocol into the `protocols` table; returns count."""
    protocols = load_protocols()
    for protocol_id, params in protocols.items():
        db.merge(
            Protocol(
                id=protocol_id,
                kind=str(params["kind"]),
                params_json=params,
                version=str(params.get("version", "1.0")),
            )
        )
    db.commit()
    return len(protocols)
