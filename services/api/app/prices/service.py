"""Price cache service: live refresh with snapshot fallback + latest-per-mandi reads.

Order of truth (contract section 8): live -> DB cache (last-known-good) -> bundled snapshot.
The DB is the single cache; the snapshot is upserted into it so `/prices` and the routing engine
always have a price per mandi. Every row carries `source` and `fetched_at`; the response source
is the source of the newest rows and `stale = age(fetched_at) > PRICE_STALE_HOURS`.

A stored `agmarknet_live` row whose `fetched_at` is older than 1.5 poll periods is reported as
`agmarknet_cache`: the poller should have refreshed it by then, so we are serving last-known-good.

Manual refreshes (`POST /prices/refresh`) go through `try_refresh_prices`: single-flight
(`_refresh_gate`) and at most one *attempt* per PRICE_REFRESH_COOLDOWN_S regardless of outcome,
so a looped call can neither monopolise the threadpool nor burn the shared data.gov.in key.
The poller uses the raw `refresh_prices` (never starved by the endpoint cooldown) but takes
the same gate, so a poll and a manual refresh never overlap.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Coroutine, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.enums import PriceSource
from app.models import Mandi, MandiPrice
from app.prices.client import (
    COMMODITIES,
    MarketIndex,
    PriceRecord,
    fetch_agmarknet,
)
from app.prices.snapshot import load_snapshot, snapshot_exists
from app.schemas import MandiPriceOut, PriceMeta, PricesResponse

log = logging.getLogger(__name__)

# Serialises writers in this process (poller thread vs. request threads on SQLite).
_write_lock = threading.Lock()
# Single-flight for whole refresh runs (poller + manual endpoint) and the endpoint cooldown.
refresh_gate = threading.Lock()
_last_refresh_attempt: float | None = None


@dataclass(slots=True)
class RefreshResult:
    """Outcome of one refresh: which source the DB now leads with, and the row counts."""

    source: PriceSource
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    error: str | None = None
    live_attempted: bool = False


# --------------------------------------------------------------------------------------
# Upserts
# --------------------------------------------------------------------------------------


def upsert_records(
    db: Session,
    records: Sequence[PriceRecord],
    *,
    source: PriceSource,
    fetched_at: datetime,
    overwrite: bool = True,
) -> tuple[int, int]:
    """Upsert on (mandi_id, commodity, reported_on). Returns (inserted, updated).

    With `overwrite=False` existing rows are left untouched (snapshot must never clobber live).
    Duplicate keys inside `records` (several varieties per market/day): first one wins.
    """
    known = set(db.scalars(select(Mandi.id)).all())
    seen: set[tuple[str, str, date]] = set()
    inserted = updated = 0
    with _write_lock:
        for record in records:
            key = (record.mandi_id, record.commodity, record.reported_on)
            if key in seen or record.mandi_id not in known:
                continue
            seen.add(key)
            existing = db.scalars(
                select(MandiPrice).where(
                    MandiPrice.mandi_id == record.mandi_id,
                    MandiPrice.commodity == record.commodity,
                    MandiPrice.reported_on == record.reported_on,
                )
            ).first()
            if existing is None:
                db.add(
                    MandiPrice(
                        mandi_id=record.mandi_id,
                        commodity=record.commodity,
                        variety=record.variety,
                        modal_price=record.modal_price,
                        min_price=record.min_price,
                        max_price=record.max_price,
                        arrival_qty=record.arrival_qty,
                        reported_on=record.reported_on,
                        fetched_at=fetched_at,
                        source=source.value,
                    )
                )
                inserted += 1
            elif overwrite:
                existing.variety = record.variety
                existing.modal_price = record.modal_price
                existing.min_price = record.min_price
                existing.max_price = record.max_price
                existing.arrival_qty = record.arrival_qty
                existing.fetched_at = fetched_at
                existing.source = source.value
                updated += 1
        try:
            db.commit()
        except IntegrityError:
            # Concurrent writer got there first (poller vs. request): rows exist either way.
            db.rollback()
            log.info("price upsert raced another writer; rows already present")
            return 0, 0
    return inserted, updated


def ensure_snapshot_loaded(db: Session, settings: Settings | None = None) -> int:
    """Insert any bundled-snapshot rows that are missing; never overwrites. Returns inserted."""
    settings = settings or get_settings()
    if not snapshot_exists(settings):
        log.warning("no bundled snapshot at %s", settings.DATA_DIR)
        return 0
    snapshot = load_snapshot(settings.DATA_DIR / "agmarknet_snapshot.json")
    inserted, _ = upsert_records(
        db,
        snapshot.records,
        source=PriceSource.BUNDLED_SNAPSHOT,
        fetched_at=snapshot.fetched_at,
        overwrite=False,
    )
    if inserted:
        log.info("loaded %d bundled snapshot price rows", inserted)
    return inserted


# --------------------------------------------------------------------------------------
# Live refresh
# --------------------------------------------------------------------------------------


def _run_coroutine[T](coro: Coroutine[object, object, T]) -> T:
    """Run a coroutine from sync code, even when this thread already has a running loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    result: list[T] = []
    errors: list[BaseException] = []

    def runner() -> None:
        try:
            result.append(asyncio.run(coro))
        except BaseException as exc:  # noqa: BLE001 - re-raised in the caller
            errors.append(exc)

    thread = threading.Thread(target=runner, name="price-refresh", daemon=True)
    thread.start()
    thread.join()
    if errors:
        raise errors[0]
    return result[0]


async def _fetch_all_live(
    settings: Settings, index: MarketIndex
) -> tuple[list[PriceRecord], list[str]]:
    """All (commodity x state) slices concurrently; partial failures are reported, not fatal."""
    slices = [(commodity, state) for commodity in COMMODITIES for state in index.states]
    tasks = [
        fetch_agmarknet(commodity, state, settings=settings, index=index)
        for commodity, state in slices
    ]
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    records: list[PriceRecord] = []
    errors: list[str] = []
    for (commodity, state), outcome in zip(slices, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            errors.append(f"{commodity}/{state}: {outcome}")
        else:
            records.extend(outcome)
    return records, errors


def refresh_prices(
    db: Session, *, live: bool = True, settings: Settings | None = None
) -> RefreshResult:
    """Poll Agmarknet (when `live`) and upsert; always make sure the snapshot baseline exists.

    Never raises: any live failure is captured in `error` and the result falls back to the
    bundled snapshot (`source = bundled_snapshot`).
    """
    settings = settings or get_settings()
    result = RefreshResult(source=PriceSource.BUNDLED_SNAPSHOT)
    if live:
        result.live_attempted = True
        try:
            index = MarketIndex.from_data_dir(settings)
            records, errors = _run_coroutine(_fetch_all_live(settings, index))
            fetched_at = datetime.now(UTC)
            inserted, updated = upsert_records(
                db, records, source=PriceSource.AGMARKNET_LIVE, fetched_at=fetched_at
            )
            result.fetched = len(records)
            result.inserted, result.updated = inserted, updated
            if errors:
                result.error = "; ".join(errors)
            if records:
                result.source = PriceSource.AGMARKNET_LIVE
            elif result.error is None:
                result.error = "live API returned no records for our mandis"
        except Exception as exc:  # noqa: BLE001 - fallback path must never raise
            db.rollback()
            result.error = f"{type(exc).__name__}: {exc}"
            log.warning("live price refresh failed, using snapshot: %s", result.error)
    try:
        snapshot_rows = ensure_snapshot_loaded(db, settings)
        if result.source == PriceSource.BUNDLED_SNAPSHOT:
            result.inserted += snapshot_rows
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        result.error = (result.error + "; " if result.error else "") + f"snapshot: {exc}"
        log.exception("bundled snapshot could not be loaded")
    return result


def try_refresh_prices(
    db: Session, *, live: bool = True, settings: Settings | None = None
) -> RefreshResult | None:
    """`refresh_prices` behind the single-flight gate + attempt cooldown; None when skipped.

    The attempt timestamp is stamped *before* the fetch so failed / rate-limited attempts count
    against the cooldown too (otherwise a 429 from upstream would invite an immediate retry).
    """
    global _last_refresh_attempt
    settings = settings or get_settings()
    if not refresh_gate.acquire(blocking=False):
        log.info("price refresh skipped: another refresh is in flight")
        return None
    try:
        now = time.monotonic()
        last = _last_refresh_attempt
        if last is not None and now - last < settings.PRICE_REFRESH_COOLDOWN_S:
            log.info("price refresh skipped: attempted %.0f s ago", now - last)
            return None
        _last_refresh_attempt = now
        return refresh_prices(db, live=live, settings=settings)
    finally:
        refresh_gate.release()


def reset_refresh_throttle() -> None:
    """Forget the last manual attempt (tests)."""
    global _last_refresh_attempt
    _last_refresh_attempt = None


# --------------------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------------------


def effective_source(
    source: str, fetched_at: datetime, now: datetime, settings: Settings
) -> PriceSource:
    """Stored live rows older than 1.5 poll periods are being served as last-known-good cache."""
    try:
        parsed = PriceSource(source)
    except ValueError:
        return PriceSource.UNKNOWN
    if parsed == PriceSource.AGMARKNET_LIVE:
        age = now - fetched_at
        if age > timedelta(hours=settings.PRICE_POLL_HOURS * 1.5):
            return PriceSource.AGMARKNET_CACHE
    return parsed


def is_stale(fetched_at: datetime | None, now: datetime, settings: Settings) -> bool:
    if fetched_at is None:
        return True
    return (now - fetched_at) > timedelta(hours=settings.PRICE_STALE_HOURS)


def _latest_rows(db: Session, commodity: str) -> list[MandiPrice]:
    """Latest row per mandi for `commodity` (max reported_on; unique key makes it one row)."""
    latest_day = (
        select(MandiPrice.mandi_id, func.max(MandiPrice.reported_on).label("day"))
        .where(MandiPrice.commodity == commodity)
        .group_by(MandiPrice.mandi_id)
        .subquery()
    )
    stmt = (
        select(MandiPrice)
        .join(
            latest_day,
            (MandiPrice.mandi_id == latest_day.c.mandi_id)
            & (MandiPrice.reported_on == latest_day.c.day),
        )
        .where(MandiPrice.commodity == commodity)
        .order_by(MandiPrice.mandi_id)
    )
    return list(db.scalars(stmt).all())


def _meta_for(rows: Sequence[MandiPrice], now: datetime, settings: Settings) -> PriceMeta:
    if not rows:
        return PriceMeta()
    newest = max(rows, key=lambda r: (r.reported_on, r.fetched_at))
    return PriceMeta(
        source=effective_source(newest.source, newest.fetched_at, now, settings),
        fetched_at=newest.fetched_at,
        stale=is_stale(newest.fetched_at, now, settings),
    )


def get_latest_prices(
    db: Session, commodity: str, *, now: datetime | None = None, settings: Settings | None = None
) -> PricesResponse:
    """Latest price per mandi + provenance. Lazily loads the snapshot if the DB is empty."""
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    rows = _latest_rows(db, commodity)
    if not rows:
        try:
            ensure_snapshot_loaded(db, settings)
        except Exception:  # noqa: BLE001 - reads must never fail because of the fallback
            db.rollback()
            log.exception("lazy snapshot load failed")
        rows = _latest_rows(db, commodity)
    names: dict[str, str] = {
        str(row[0]): str(row[1]) for row in db.execute(select(Mandi.id, Mandi.name)).all()
    }
    prices = [
        MandiPriceOut(
            mandi_id=row.mandi_id,
            mandi_name=names.get(row.mandi_id),
            commodity=row.commodity,
            variety=row.variety,
            modal_price=row.modal_price,
            min_price=row.min_price,
            max_price=row.max_price,
            arrival_qty=row.arrival_qty,
            reported_on=row.reported_on,
            fetched_at=row.fetched_at,
            source=effective_source(row.source, row.fetched_at, now, settings),
        )
        for row in rows
    ]
    meta = _meta_for(rows, now, settings)
    return PricesResponse(
        commodity=commodity,
        source=meta.source,
        fetched_at=meta.fetched_at,
        stale=meta.stale,
        prices=prices,
    )


def newest_meta(
    db: Session, *, now: datetime | None = None, settings: Settings | None = None
) -> PriceMeta:
    """Provenance of the newest price row over all commodities (unknown when the DB is empty)."""
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    newest = db.scalars(
        select(MandiPrice)
        .order_by(MandiPrice.reported_on.desc(), MandiPrice.fetched_at.desc())
        .limit(1)
    ).first()
    return _meta_for([newest] if newest else [], now, settings)
