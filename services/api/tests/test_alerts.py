"""F6 server side: threshold -> message-key mapping, batch filtering, and the SMS/IVR stub."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.alerts.sms_ivr_stub import (
    LoggingStubGateway,
    SmsIvrGateway,
    dispatch_alerts,
    get_gateway,
    mask_phone,
)
from app.alerts.thresholds import (
    MESSAGE_KEYS,
    SELL_NOW_KEY,
    THRESHOLDS,
    batch_alerts,
    compute_alerts,
)
from app.kinetics.engine import evaluate
from app.kinetics.registry import get_protocol
from app.schemas import BatchOut, ShelfLifeEstimate
from app.schemas.sync import BatchAlert

NOW = datetime(2026, 8, 27, 6, 0, tzinfo=UTC)
OPEN_1, OPEN_2, SOLD_1, NONE_1 = (
    str(uuid.uuid5(uuid.NAMESPACE_URL, f"farmsignal:test:{name}"))
    for name in ("open-1", "open-2", "sold-1", "none-1")
)


def _estimate(status: str, crossed: list[int]) -> ShelfLifeEstimate:
    return ShelfLifeEstimate(
        protocol_id="tomato",
        computed_at=NOW,
        status=status,
        confidence="low",
        consumed_fraction=0.5,
        remaining_fraction=0.5,
        remaining_hours={"low": 10.0, "mid": 20.0, "high": 30.0},
        expected_end={"low": NOW, "mid": NOW, "high": NOW},
        current_temp_c=30.0,
        current_temp_assumed=True,
        thermal_load_degree_hours=100.0,
        alerts_crossed=crossed,
    )


def _batch(batch_id: str, status: str, estimate: ShelfLifeEstimate | None) -> BatchOut:
    fields: dict[str, Any] = {
        "id": batch_id,
        "crop": "tomato",
        "protocol_id": "tomato",
        "qty_kg": 100.0,
        "harvested_at": NOW - timedelta(hours=10),
        "client_seq": 1,
        "client_created_at": NOW - timedelta(hours=10),
        "farmer_id": "farmer-1",
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
        "shelf_life": estimate,
    }
    return BatchOut(**fields)


def test_thresholds_map_to_message_keys() -> None:
    assert THRESHOLDS == (75, 50, 25)
    assert MESSAGE_KEYS == {75: "alert_75", 50: "alert_50", 25: "alert_25"}


def test_crossed_thresholds_become_events_highest_first() -> None:
    events = compute_alerts(_estimate("warning", [50, 75]))
    assert [(e.threshold, e.message_key, e.status) for e in events] == [
        (75, "alert_75", "warning"),
        (50, "alert_50", "warning"),
    ]


def test_critical_adds_sell_now() -> None:
    events = compute_alerts(_estimate("critical", [75, 50, 25]))
    assert [e.message_key for e in events] == ["alert_75", "alert_50", "alert_25", SELL_NOW_KEY]
    assert events[-1].threshold is None


def test_spoiled_and_fresh_never_say_sell_now() -> None:
    assert compute_alerts(_estimate("fresh", [])) == []
    spoiled = compute_alerts(_estimate("spoiled", [75, 50, 25]))
    assert [e.message_key for e in spoiled] == ["alert_75", "alert_50", "alert_25"]


def test_unknown_and_repeated_thresholds_are_ignored() -> None:
    events = compute_alerts(_estimate("warning", [90, 75, 75, 10]))
    assert [e.threshold for e in events] == [75]


def test_mapping_agrees_with_the_engine() -> None:
    # Tomato at the 30 C default ambient lasts 72 h; 60 h with no readings -> critical.
    estimate = evaluate(get_protocol("tomato"), NOW - timedelta(hours=60), [], NOW)
    assert estimate.status == "critical"
    assert [e.message_key for e in compute_alerts(estimate)] == [
        "alert_75",
        "alert_50",
        "alert_25",
        SELL_NOW_KEY,
    ]


def test_batch_alerts_only_for_open_batches_with_an_estimate() -> None:
    critical = _estimate("critical", [75, 50, 25])
    alerts = batch_alerts(
        [
            _batch(OPEN_1, "open", _estimate("warning", [75])),
            _batch(SOLD_1, "sold", critical),
            _batch(NONE_1, "open", None),
            _batch(OPEN_2, "open", critical),
        ]
    )
    assert [(a.batch_id, a.message_key) for a in alerts] == [
        (OPEN_1, "alert_75"),
        (OPEN_2, "alert_75"),
        (OPEN_2, "alert_50"),
        (OPEN_2, "alert_25"),
        (OPEN_2, SELL_NOW_KEY),
    ]
    assert alerts[0].model_dump() == {
        "batch_id": OPEN_1,
        "threshold": 75,
        "status": "warning",
        "message_key": "alert_75",
    }


def test_mask_phone_keeps_last_four_digits() -> None:
    assert mask_phone("+91 98765 43210") == "+********3210"
    assert mask_phone("1234") == "****"


def test_logging_stub_gateway_logs_and_records(caplog: pytest.LogCaptureFixture) -> None:
    gateway = LoggingStubGateway()
    assert isinstance(get_gateway(), LoggingStubGateway)
    with caplog.at_level(logging.INFO, logger="app.alerts.sms_ivr_stub"):
        sms = gateway.send_sms("+919876543210", "alert_50", {"batch_id": "b1"})
        ivr = gateway.trigger_ivr("+919876543210", "sell_now")
    assert sms.channel == "sms" and sms.accepted and sms.provider == "stub"
    assert sms.recipient == "+********3210" and "9876543210" not in caplog.text
    assert sms.key == "alert_50" and sms.params == {"batch_id": "b1"}
    assert ivr.channel == "ivr" and ivr.key == "sell_now"
    assert gateway.sent == [sms, ivr]
    assert "key=alert_50" in caplog.text and "clip=sell_now" in caplog.text


def test_dispatch_alerts_sends_sms_per_alert_and_ivr_for_sell_now() -> None:
    gateway: SmsIvrGateway = LoggingStubGateway()
    alerts = [
        BatchAlert(batch_id="b1", threshold=75, status="warning", message_key="alert_75"),
        BatchAlert(batch_id="b2", threshold=None, status="critical", message_key=SELL_NOW_KEY),
    ]
    receipts = dispatch_alerts(gateway, "+919876543210", alerts)
    assert [(r.channel, r.key) for r in receipts] == [
        ("sms", "alert_75"),
        ("sms", SELL_NOW_KEY),
        ("ivr", SELL_NOW_KEY),
    ]
    assert receipts[0].params["batch_id"] == "b1"
