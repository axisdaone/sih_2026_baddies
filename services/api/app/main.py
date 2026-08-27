"""FastAPI application factory. Run: `uvicorn app.main:app --reload`."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

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
API_DIR = Path(__file__).resolve().parents[1]  # services/api (alembic.ini + alembic/)
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


def run_migrations() -> None:
    """`alembic upgrade head` in-process against Settings.DATABASE_URL (alembic/env.py reads it).

    `script_location` in alembic.ini is cwd-relative, so it is pinned to the package here."""
    cfg = AlembicConfig(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    command.upgrade(cfg, "head")


def init_db(settings: Settings) -> None:
    """SQLite / non-prod: create tables directly. Prod on Postgres: run the Alembic migrations
    to head on startup (so the documented `--profile prod` stack boots with a schema)."""
    import app.models  # noqa: F401 - ensure every table is registered on Base

    if settings.is_sqlite or settings.ENV != "prod":
        Base.metadata.create_all(bind=engine)
    else:
        run_migrations()
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


class BodySizeLimitMiddleware:
    """413 for requests whose declared Content-Length exceeds MAX_REQUEST_BODY_BYTES.

    nginx enforces the same cap at the edge; deployments without it (Render, direct uvicorn)
    otherwise have no bound at all on e.g. a POST /sync body."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            max_bytes = get_settings().MAX_REQUEST_BODY_BYTES
            for name, value in scope.get("headers", []):
                if name == b"content-length":
                    try:
                        declared = int(value)
                    except ValueError:
                        declared = -1
                    if declared < 0 or declared > max_bytes:
                        await _plain_response(send, 413, b"request body too large")
                        return
                    break
        await self.app(scope, receive, send)


async def _plain_response(send: Send, status: int, body: bytes) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"text/plain; charset=utf-8"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    if settings.ENV == "prod" and settings.DEMO_MODE:
        log.warning(
            "DEMO_MODE=true with ENV=prod: anyone can mint the demo farmer's write token "
            "(POST /demo/seed) and trigger POST /prices/refresh; set DEMO_MODE=false for a pilot"
        )
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
    app.add_middleware(BodySizeLimitMiddleware)
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
