"""Threshold alerts (PRD F6, contract section 2.2 step 9).

The engine reports `alerts_crossed` = the 75/50/25 % thresholds the batch has passed. This module
turns that into alert events with the i18n / voice-clip keys the PWA already uses
(`alert_75`, `alert_50`, `alert_25`, `sell_now`). Delivery beyond the app (SMS/IVR) is Phase 2:
see `app.alerts.sms_ivr_stub`.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from app.enums import BatchStatus, ShelfLifeStatus
from app.schemas.batch import BatchOut
from app.schemas.shelf_life import ShelfLifeEstimate
from app.schemas.sync import AlertEvent, BatchAlert

Threshold = Literal[75, 50, 25]

THRESHOLDS: tuple[Threshold, ...] = (75, 50, 25)
MESSAGE_KEYS: dict[Threshold, str] = {75: "alert_75", 50: "alert_50", 25: "alert_25"}
SELL_NOW_KEY = "sell_now"

__all__ = [
    "MESSAGE_KEYS",
    "SELL_NOW_KEY",
    "THRESHOLDS",
    "AlertEvent",
    "BatchAlert",
    "batch_alerts",
    "compute_alerts",
]


def compute_alerts(estimate: ShelfLifeEstimate) -> list[AlertEvent]:
    """Events for every crossed threshold (highest first) plus `sell_now` when critical.

    Unknown threshold values are ignored; a `spoiled` batch keeps its threshold events (they
    were crossed on the way down) but never gets `sell_now` — there is nothing left to sell.
    """
    crossed = sorted({t for t in estimate.alerts_crossed if t in MESSAGE_KEYS}, reverse=True)
    events = [
        AlertEvent(threshold=t, status=estimate.status, message_key=MESSAGE_KEYS[t])
        for t in crossed
    ]
    if estimate.status == ShelfLifeStatus.CRITICAL:
        events.append(AlertEvent(threshold=None, status=estimate.status, message_key=SELL_NOW_KEY))
    return events


def batch_alerts(batches: Iterable[BatchOut]) -> list[BatchAlert]:
    """Alerts for a farmer's batch list: only `open` batches with an embedded `shelf_life`."""
    alerts: list[BatchAlert] = []
    for batch in batches:
        if batch.shelf_life is None or batch.status != BatchStatus.OPEN:
            continue
        alerts.extend(
            BatchAlert(batch_id=batch.id, **event.model_dump())
            for event in compute_alerts(batch.shelf_life)
        )
    return alerts
