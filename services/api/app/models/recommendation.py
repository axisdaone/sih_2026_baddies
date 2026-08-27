from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import JSON, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.types import TZDateTime, utcnow


class Recommendation(Base):
    """Stored routing result (full Recommendation payload in ranked_json, contract section 3)."""

    __tablename__ = "recommendations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    batch_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("batches.id"), nullable=False, index=True
    )
    ranked_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    computed_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, default=utcnow)
    model_version: Mapped[str] = mapped_column(String(32), nullable=False)

    batch: Mapped[Batch] = relationship(back_populates="recommendations")


from app.models.batch import Batch  # noqa: E402
