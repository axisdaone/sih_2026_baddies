from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.enums import SyncOpKind, SyncOpStatus, values
from app.models.types import TZDateTime, utcnow


class SyncOp(Base):
    """Dedupe log for POST /sync (contract section 7): one row per accepted op_id."""

    __tablename__ = "sync_ops"
    __table_args__ = (
        Index("ix_sync_ops_device_seq", "device_id", "client_seq"),
        CheckConstraint(f"kind IN {values(SyncOpKind)!r}", name="ck_sync_ops_kind"),
        CheckConstraint(f"status IN {values(SyncOpStatus)!r}", name="ck_sync_ops_status"),
    )

    op_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128), nullable=False)
    client_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    received_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, default=utcnow)
