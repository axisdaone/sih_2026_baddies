from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.enums import ProtocolKind, values


class Protocol(Base):
    """Decay protocol seeded from app/kinetics/protocols/*.json (contract section 2)."""

    __tablename__ = "protocols"
    __table_args__ = (
        CheckConstraint(f"kind IN {values(ProtocolKind)!r}", name="ck_protocols_kind"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    params_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    version: Mapped[str] = mapped_column(String(16), nullable=False)
