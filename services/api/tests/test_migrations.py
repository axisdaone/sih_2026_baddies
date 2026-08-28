"""Startup migrations (main.run_migrations): `alembic upgrade head` in-process builds the
schema the prod (Postgres) path relies on, and leaves the app's loggers enabled afterwards."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect

from app.config import get_settings
from app.db import Base
from app.main import run_migrations


def test_run_migrations_builds_the_full_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = f"sqlite:///{(tmp_path / 'migrated.db').as_posix()}"
    monkeypatch.setattr(get_settings(), "DATABASE_URL", url)  # alembic/env.py reads it
    app_logger = logging.getLogger("app.main")
    app_logger.disabled = False

    run_migrations()
    run_migrations()  # idempotent: already at head

    engine = create_engine(url)
    try:
        names = set(inspect(engine).get_table_names())
    finally:
        engine.dispose()
    expected = set(Base.metadata.tables)
    assert expected <= names, expected - names
    assert "alembic_version" in names
    # fileConfig(..., disable_existing_loggers=False): uvicorn/app loggers survive the upgrade.
    assert app_logger.disabled is False
    assert logging.getLogger("uvicorn.error").disabled is False
