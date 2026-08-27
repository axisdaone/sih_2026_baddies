from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.enums import ReadingSource, values
from app.models.types import TZDateTime, utcnow


class Reading(Base):
    """Append-only temperature reading; seq/hash are assigned by the server (contract section 4)."""

    __tablename__ = "readings"
    __table_args__ = (
        UniqueConstraint("batch_id", "seq", name="uq_readings_batch_seq"),
        CheckConstraint(f"source IN {values(ReadingSource)!r}", name="ck_readings_source"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("batches.id"), nullable=False, index=True
    )
    temp_c: Mapped[float] = mapped_column(Float, nullable=False)
    taken_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    source: Mapped[str] = mapped_column(String(8), nullable=False)
    geohash: Mapped[str | None] = mapped_column(String(12), nullable=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    client_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    hash: Mapped[str] = mapped_column(String(64), nullable=False)
    prev_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    received_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, default=utcnow)

    batch: Mapped[Batch] = relationship(back_populates="readings")


from app.models.batch import Batch  # noqa: E402
