from __future__ import annotations

from sqlalchemy import Float, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Mandi(Base):
    """Market yard; seeded from data/mandis.json (contract section 8)."""

    __tablename__ = "mandis"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # slug
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    state: Mapped[str] = mapped_column(String(64), nullable=False)
    district: Mapped[str] = mapped_column(String(64), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    agmarknet_market: Mapped[str] = mapped_column(String(120), nullable=False)
    agmarknet_state: Mapped[str] = mapped_column(String(64), nullable=False)
    agmarknet_district: Mapped[str] = mapped_column(String(64), nullable=False)

    prices: Mapped[list[MandiPrice]] = relationship(back_populates="mandi")


from app.models.mandi_price import MandiPrice  # noqa: E402
