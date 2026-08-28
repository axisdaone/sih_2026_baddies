"""Shared string enums used by both the ORM models and the wire schemas.

Values are the exact strings that travel on the wire (see ENGINEERING-CONTRACT §6.1).
"""

from __future__ import annotations

from enum import StrEnum


class Crop(StrEnum):
    TOMATO = "tomato"
    GUAVA = "guava"


class ProtocolKind(StrEnum):
    CROP = "crop"
    PHARMA = "pharma"


class BatchStatus(StrEnum):
    OPEN = "open"
    SOLD = "sold"
    SPOILED = "spoiled"
    DISCARDED = "discarded"


class ReadingSource(StrEnum):
    MANUAL = "manual"
    SIM = "sim"
    BLE = "ble"


class SyncOpKind(StrEnum):
    BATCH_CREATE = "batch.create"
    BATCH_UPDATE = "batch.update"
    READING_APPEND = "reading.append"


class SyncOpStatus(StrEnum):
    APPLIED = "applied"
    DUPLICATE = "duplicate"
    REJECTED = "rejected"


class PassEvent(StrEnum):
    VIEW = "view"
    VERIFY = "verify"


class ShelfLifeStatus(StrEnum):
    FRESH = "fresh"
    WARNING = "warning"
    CRITICAL = "critical"
    SPOILED = "spoiled"


class Confidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class PriceSource(StrEnum):
    AGMARKNET_LIVE = "agmarknet_live"
    AGMARKNET_CACHE = "agmarknet_cache"
    BUNDLED_SNAPSHOT = "bundled_snapshot"
    UNKNOWN = "unknown"  # reported by /health before the price poller has run (PHASE2)


def values(enum_cls: type[StrEnum]) -> tuple[str, ...]:
    """Tuple of raw values, handy for SQL CHECK constraints."""
    return tuple(member.value for member in enum_cls)
