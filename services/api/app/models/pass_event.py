from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.enums import PassEvent as PassEventKind
from app.enums import values
from app.models.types import TZDateTime, utcnow


class PassEvent(Base):
    """Audit row for public Quality Pass views/verifications (IP stored hashed only)."""

    __tablename__ = "pass_events"
    __table_args__ = (
        CheckConstraint(f"event IN {values(PassEventKind)!r}", name="ck_pass_events_event"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("batches.id"), nullable=False, index=True
    )
    event: Mapped[str] = mapped_column(String(8), nullable=False)
    at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, default=utcnow)
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False)
