"""FastAPI application factory. Run: `uvicorn app.main:app --reload`."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.db import Base, SessionLocal, engine
from app.kinetics.registry import seed_protocols
from app.routers import (
    auth,
    batches,
    demo,
    health,
    mandis,
    prices,
    protocols,
    quality_pass,
    readings,
    recommendations,
    sync,
)
from app.seed import seed_mandis

log = logging.getLogger(__name__)

API_PREFIX = "/api/v1"
ROUTERS = (
    health.router,
    auth.router,
    protocols.router,
    mandis.router,
    batches.router,
    readings.router,
    sync.router,
    prices.router,
    recommendations.router,
    quality_pass.router,
    demo.router,
)


def init_db(settings: Settings) -> None:
    """SQLite / non-prod: create tables directly. Prod (Postgres): `alembic upgrade head`."""
    import app.models  # noqa: F401 - ensure every table is registered on Base

    if settings.is_sqlite or settings.ENV != "prod":
        Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        n_protocols = seed_protocols(db)
        n_mandis = seed_mandis(db)
    log.info("seeded %d protocols, %d mandis", n_protocols, n_mandis)


def start_price_poller(app: FastAPI) -> None:
    """Non-blocking APScheduler poller (PHASE2: implemented in app.prices.poller)."""
    try:
        from app.prices.poller import start_scheduler  # PHASE2
    except ImportError:
        log.info("price poller not available yet (PHASE2); /health reports source=unknown")
        return
    start_scheduler(app)


def stop_price_poller(app: FastAPI) -> None:
    scheduler = getattr(app.state, "scheduler", None)
    if scheduler is not None:
        scheduler.shutdown(wait=False)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    init_db(settings)
    start_price_poller(app)
    yield
    stop_price_poller(app)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.VERSION,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for router in ROUTERS:
        app.include_router(router, prefix=API_PREFIX)
    return app


app = create_app()
