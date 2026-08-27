"""Shared Pydantic base + the UTC datetime type used on every wire schema.

Wire format: ISO-8601 UTC with a trailing 'Z' (`2026-08-27T06:30:00Z`). Sub-second precision is
kept as milliseconds when present. Inputs may carry any offset (or none = assumed UTC); they are
normalised to aware UTC on validation.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, PlainSerializer, StringConstraints

UUID_RE = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_UUID_PATTERN = re.compile(UUID_RE)


def to_utc(value: datetime) -> datetime:
    """Aware UTC datetime; naive inputs are assumed to already be UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def iso_z(value: datetime) -> str:
    """Serialise as ISO-8601 UTC with 'Z' (milliseconds only when non-zero)."""
    value = to_utc(value)
    spec = "milliseconds" if value.microsecond else "seconds"
    return value.isoformat(timespec=spec).replace("+00:00", "Z")


def parse_iso_z(text: str) -> datetime:
    """Parse an ISO-8601 string ('Z' or offset) into aware UTC."""
    return to_utc(datetime.fromisoformat(text.replace("Z", "+00:00")))


def is_uuid(value: str) -> bool:
    return bool(_UUID_PATTERN.match(value))


UtcDatetime = Annotated[
    datetime,
    AfterValidator(to_utc),
    PlainSerializer(iso_z, return_type=str, when_used="json"),
]

UuidStr = Annotated[str, StringConstraints(pattern=UUID_RE)]


class ApiModel(BaseModel):
    """Base for all wire schemas: ORM-friendly, alias-aware (`from` in Segment)."""

    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        serialize_by_alias=True,
        use_enum_values=True,
    )
