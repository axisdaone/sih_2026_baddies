from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.enums import BatchStatus, values
from app.models.types import TZDateTime, utcnow


class Batch(Base):
    __tablename__ = "batches"
    __table_args__ = (
        CheckConstraint(f"status IN {values(BatchStatus)!r}", name="ck_batches_status"),
        Index("ix_batches_farmer_id", "farmer_id"),
    )

    # Client-generated UUID v4 (idempotent sync).
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    farmer_id: Mapped[str] = mapped_column(String(36), ForeignKey("farmers.id"), nullable=False)
    crop: Mapped[str] = mapped_column(String(32), nullable=False)
    protocol_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    qty_kg: Mapped[float] = mapped_column(Float, nullable=False)
    harvested_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    origin_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    origin_lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    origin_geohash: Mapped[str | None] = mapped_column(String(12), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=BatchStatus.OPEN.value)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    client_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    client_created_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, default=utcnow, onupdate=utcnow
    )
    deleted_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)

    farmer: Mapped[Farmer] = relationship(back_populates="batches")
    readings: Mapped[list[Reading]] = relationship(
        back_populates="batch", order_by="Reading.seq", cascade="all, delete-orphan"
    )
    recommendations: Mapped[list[Recommendation]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )


from app.models.farmer import Farmer  # noqa: E402
from app.models.reading import Reading  # noqa: E402
from app.models.recommendation import Recommendation  # noqa: E402
