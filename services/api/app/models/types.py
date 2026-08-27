"""Custom column types."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator


class TZDateTime(TypeDecorator[datetime]):
    """Timezone-aware UTC datetime that round-trips through SQLite.

    * bind: naive values are assumed UTC; aware values are converted to UTC.
    * result: SQLite returns naive values -> tzinfo=UTC is attached; Postgres (timestamptz)
      returns aware values -> normalised to UTC.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if not isinstance(value, datetime):  # pragma: no cover - defensive
            raise TypeError(f"TZDateTime expected datetime, got {type(value).__name__}")
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


def utcnow() -> datetime:
    """Aware UTC now (module-level so models/tests can monkeypatch)."""
    return datetime.now(UTC)
