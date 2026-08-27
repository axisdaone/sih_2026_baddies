"""SMS / IVR fallback gateway (PRD F6, Phase 2 interface).

v1 ships only `LoggingStubGateway`: it records what *would* be sent and logs it. A real provider
(e.g. an SMS aggregator + an IVR platform playing the pre-recorded `/audio/{locale}/{key}.mp3`
clips) implements `SmsIvrGateway` and is plugged in via `set_gateway`. Nothing in the request
path awaits the network — delivery is fire-and-forget by design.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Protocol

from app.alerts.thresholds import SELL_NOW_KEY
from app.models.types import utcnow
from app.schemas.sync import BatchAlert

log = logging.getLogger(__name__)

Channel = Literal["sms", "ivr"]


@dataclass(frozen=True, slots=True)
class DeliveryReceipt:
    """What a gateway hands back; `accepted` only means the provider took the request."""

    channel: Channel
    recipient: str  # masked phone number — never log or store the full number
    key: str  # message_key (sms) or clip_key (ivr)
    accepted: bool
    provider: str
    sent_at: datetime
    params: Mapping[str, object] = field(default_factory=dict)
    provider_message_id: str | None = None


class SmsIvrGateway(Protocol):
    """Phase 2 contract: templated SMS by message key, IVR call playing a clip key."""

    def send_sms(
        self, phone: str, message_key: str, params: Mapping[str, object] | None = None
    ) -> DeliveryReceipt: ...

    def trigger_ivr(self, phone: str, clip_key: str) -> DeliveryReceipt: ...


def mask_phone(phone: str) -> str:
    """Keep the last 4 digits only (`+91******1234`)."""
    digits = "".join(ch for ch in phone if ch.isdigit())
    if len(digits) <= 4:
        return "*" * len(digits)
    prefix = "+" if phone.strip().startswith("+") else ""
    return f"{prefix}{'*' * (len(digits) - 4)}{digits[-4:]}"


class LoggingStubGateway:
    """Logs every call and keeps the receipts in memory (inspectable in tests / demo)."""

    provider = "stub"

    def __init__(self) -> None:
        self.sent: list[DeliveryReceipt] = []

    def send_sms(
        self, phone: str, message_key: str, params: Mapping[str, object] | None = None
    ) -> DeliveryReceipt:
        receipt = DeliveryReceipt(
            channel="sms",
            recipient=mask_phone(phone),
            key=message_key,
            accepted=True,
            provider=self.provider,
            sent_at=utcnow(),
            params=dict(params or {}),
        )
        log.info("SMS stub -> %s key=%s params=%s", receipt.recipient, message_key, receipt.params)
        self.sent.append(receipt)
        return receipt

    def trigger_ivr(self, phone: str, clip_key: str) -> DeliveryReceipt:
        receipt = DeliveryReceipt(
            channel="ivr",
            recipient=mask_phone(phone),
            key=clip_key,
            accepted=True,
            provider=self.provider,
            sent_at=utcnow(),
        )
        log.info("IVR stub -> %s clip=%s", receipt.recipient, clip_key)
        self.sent.append(receipt)
        return receipt


def dispatch_alerts(
    gateway: SmsIvrGateway, phone: str, alerts: Iterable[BatchAlert]
) -> list[DeliveryReceipt]:
    """One SMS per alert; `sell_now` additionally places an IVR call playing the same clip."""
    receipts: list[DeliveryReceipt] = []
    for alert in alerts:
        params = {"batch_id": alert.batch_id, "threshold": alert.threshold, "status": alert.status}
        receipts.append(gateway.send_sms(phone, alert.message_key, params))
        if alert.message_key == SELL_NOW_KEY:
            receipts.append(gateway.trigger_ivr(phone, alert.message_key))
    return receipts


_gateway: SmsIvrGateway = LoggingStubGateway()


def get_gateway() -> SmsIvrGateway:
    return _gateway


def set_gateway(gateway: SmsIvrGateway) -> None:
    """Swap the process-wide gateway (Phase 2 wiring / tests)."""
    global _gateway
    _gateway = gateway
