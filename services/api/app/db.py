"""SQLAlchemy 2 engine, session factory and declarative base.

SQLite (dev/test) gets `check_same_thread=False` plus WAL + foreign_keys pragmas on every
connection. Postgres (prod) uses the plain engine; schema is managed by Alembic there.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    """Declarative base shared by all ORM models (`app.models`)."""


def _make_engine(url: str) -> Engine:
    connect_args: dict[str, Any] = {}
    if url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    return create_engine(url, connect_args=connect_args, future=True)


settings = get_settings()
engine: Engine = _make_engine(settings.DATABASE_URL)


if settings.is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, class_=Session)


def session_scope() -> Iterator[Session]:
    """Plain generator (no FastAPI) — used by `app.deps.get_db` and startup seeding."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
