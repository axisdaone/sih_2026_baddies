"""Bundled last-known-good prices: DATA_DIR/agmarknet_snapshot.json -> PriceRecords.

Records already carry `mandi_id` (see data/README.md), so no market-name matching is needed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from app.config import Settings, get_settings
from app.prices.client import PriceRecord, parse_arrival_date, parse_price
from app.schemas.common import parse_iso_z


@dataclass(frozen=True, slots=True)
class Snapshot:
    source: str  # "bundled_snapshot"
    fetched_at: datetime  # when the snapshot was taken (reported as price_fetched_at)
    records: list[PriceRecord]


def snapshot_path(settings: Settings | None = None) -> Path:
    return (settings or get_settings()).DATA_DIR / "agmarknet_snapshot.json"


def snapshot_exists(settings: Settings | None = None) -> bool:
    return snapshot_path(settings).is_file()


def load_snapshot(path: Path | None = None) -> Snapshot:
    """Parse the bundled snapshot. Raises FileNotFoundError / ValueError on a broken file."""
    path = path or snapshot_path()
    with open(path, encoding="utf-8") as fh:
        doc: dict[str, Any] = json.load(fh)
    fetched_at = parse_iso_z(str(doc["fetched_at"]))
    records: list[PriceRecord] = []
    for row in doc.get("records", []):
        modal = parse_price(row.get("modal_price"))
        reported_on = parse_arrival_date(row.get("arrival_date"))
        mandi_id = str(row.get("mandi_id") or "").strip()
        commodity = str(row.get("commodity") or "").strip()
        if modal is None or reported_on is None or not mandi_id or not commodity:
            raise ValueError(f"snapshot record is malformed: {row!r}")
        records.append(
            PriceRecord(
                mandi_id=mandi_id,
                commodity=commodity,
                variety=str(row.get("variety") or "").strip() or None,
                modal_price=modal,
                min_price=parse_price(row.get("min_price")),
                max_price=parse_price(row.get("max_price")),
                arrival_qty=parse_price(row.get("arrival_qty")),
                reported_on=reported_on,
                market=str(row.get("market") or ""),
                state=str(row.get("state") or ""),
            )
        )
    return Snapshot(source=str(doc.get("source") or "bundled_snapshot"), fetched_at=fetched_at,
                    records=records)
