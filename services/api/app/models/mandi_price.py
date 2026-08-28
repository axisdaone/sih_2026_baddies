from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, Float, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.types import TZDateTime, utcnow


class MandiPrice(Base):
    """One Agmarknet price row per (mandi, commodity, reported_on). Prices are INR per quintal."""

    __tablename__ = "mandi_prices"
    __table_args__ = (
        UniqueConstraint(
            "mandi_id", "commodity", "reported_on", name="uq_mandi_prices_mandi_commodity_day"
        ),
        Index("ix_mandi_prices_commodity_reported_on", "commodity", "reported_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mandi_id: Mapped[str] = mapped_column(String(64), ForeignKey("mandis.id"), nullable=False)
    commodity: Mapped[str] = mapped_column(String(64), nullable=False)
    variety: Mapped[str | None] = mapped_column(String(64), nullable=True)
    modal_price: Mapped[float] = mapped_column(Float, nullable=False)
    min_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    arrival_qty: Mapped[float | None] = mapped_column(Float, nullable=True)
    reported_on: Mapped[date] = mapped_column(Date, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, default=utcnow)
    source: Mapped[str] = mapped_column(String(32), nullable=False)

    mandi: Mapped[Mandi] = relationship(back_populates="prices")


from app.models.mandi import Mandi  # noqa: E402
