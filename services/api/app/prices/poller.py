"""APScheduler price poller: one immediate run in a daemon thread + every PRICE_POLL_HOURS.

Startup is never blocked and nothing here raises: every run opens a fresh SessionLocal,
calls `refresh_prices` (live only when `live_fetch_enabled()`), logs the outcome and exits.
"""

from __future__ import annotations

import logging
import threading

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI

from app.config import get_settings
from app.db import SessionLocal
from app.prices.client import live_fetch_enabled
from app.prices.service import RefreshResult, refresh_prices

log = logging.getLogger(__name__)

JOB_ID = "price_poll"


def run_poll() -> RefreshResult | None:
    """One poll cycle with its own DB session. Returns the result (None if it blew up)."""
    live = live_fetch_enabled()
    try:
        with SessionLocal() as db:
            result = refresh_prices(db, live=live)
    except Exception:  # noqa: BLE001 - scheduler jobs must never raise
        log.exception("price poll crashed")
        return None
    log.info(
        "price poll (live=%s): source=%s fetched=%d inserted=%d updated=%d error=%s",
        live,
        result.source.value,
        result.fetched,
        result.inserted,
        result.updated,
        result.error,
    )
    return result


def start_scheduler(app: FastAPI) -> BackgroundScheduler:
    """Start the interval job and kick off the first poll in a background thread."""
    settings = get_settings()
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(
        run_poll,
        "interval",
        hours=max(1, settings.PRICE_POLL_HOURS),
        id=JOB_ID,
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()
    app.state.scheduler = scheduler

    bootstrap = threading.Thread(target=run_poll, name="price-poll-bootstrap", daemon=True)
    bootstrap.start()
    # Exposed so tests / ops can wait for the first cache fill without sleeping.
    app.state.price_bootstrap_thread = bootstrap
    log.info("price poller started (every %d h, live=%s)", settings.PRICE_POLL_HOURS,
             live_fetch_enabled(settings))
    return scheduler
