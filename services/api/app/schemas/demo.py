from __future__ import annotations

from typing import Any

from app.schemas.common import ApiModel
from app.schemas.sync import BatchAlert


class DemoSeedResponse(ApiModel):
    """POST /demo/seed. `token` lets the PWA adopt the demo identity (device `demo-device-001`)."""

    farmer_id: str
    device_id: str
    display_name: str | None = None
    token: str
    batch_ids: list[str] = []
    created: bool  # True when this call created at least one batch (False on an idempotent replay)
    batches_created: int
    batches_existing: int
    readings_created: int
    loss_comparison: dict[str, Any] = {}  # passed through verbatim from demo_seed.json
    alerts: list[BatchAlert] = []  # F6 view of the seeded batches (see app.alerts.thresholds)
    simulated: bool = True  # every seeded reading is `source: "sim"`; the UI must label it


class ScenarioReading(ApiModel):
    offset_hours: float  # hours after harvested_at
    temp_c: float


class DemoScenarioOut(ApiModel):
    """One `data/demo_scenarios/<id>.json` profile (online source of truth for the PWA player)."""

    id: str
    name: str
    description: str
    suitable_protocols: list[str]
    readings: list[ScenarioReading]
    simulated: bool = True
