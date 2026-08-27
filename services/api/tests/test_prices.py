"""Prices (contract section 8): snapshot loader, live parser, fallback, staleness, endpoints.

No network: `live_fetch_enabled()` is False under ENV=test and every live path is exercised
through an `httpx.MockTransport` injected via `app.prices.client.make_client`.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.config import get_settings
from app.db import SessionLocal
from app.enums import PriceSource
from app.main import app
from app.models import MandiPrice
from app.prices import client as client_mod
from app.prices.client import (
    AgmarknetError,
    MarketIndex,
    fetch_agmarknet,
    live_fetch_enabled,
    parse_records,
)
from app.prices.poller import JOB_ID, run_poll
from app.prices.service import (
    effective_source,
    ensure_snapshot_loaded,
    get_latest_prices,
    refresh_prices,
)
from app.prices.snapshot import load_snapshot
from app.seed import load_mandis_file

os.environ.setdefault("AGMARKNET_LIVE", "0")  # belt and braces: ENV=test already disables live

SNAPSHOT_FETCHED_AT = datetime(2026, 8, 25, 3, 30, tzinfo=UTC)
SNAPSHOT_DAY = date(2026, 8, 25)

# Realistic data.gov.in body (resource 9ef84268-...) for filters[commodity]=Tomato&filters[state]=…
LIVE_FIXTURE: dict[str, Any] = {
    "index_name": "9ef84268-d588-465a-a308-a864a43d0070",
    "title": "Current Daily Price of Various Commodities from Various Markets (Mandi)",
    "status": "ok",
    "total": 7,
    "count": 7,
    "limit": "1000",
    "offset": "0",
    "field": [
        {"id": "state", "name": "State", "type": "keyword"},
        {"id": "district", "name": "District", "type": "keyword"},
        {"id": "market", "name": "Market", "type": "keyword"},
        {"id": "commodity", "name": "Commodity", "type": "keyword"},
        {"id": "variety", "name": "Variety", "type": "keyword"},
        {"id": "grade", "name": "Grade", "type": "keyword"},
        {"id": "arrival_date", "name": "Arrival_Date", "type": "date"},
        {"id": "min_price", "name": "Min_Price", "type": "double"},
        {"id": "max_price", "name": "Max_Price", "type": "double"},
        {"id": "modal_price", "name": "Modal_Price", "type": "double"},
    ],
    "records": [
        {
            "state": "Tamil Nadu", "district": "Krishnagiri", "market": "Hosur",
            "commodity": "Tomato", "variety": "Hybrid", "grade": "FAQ",
            "arrival_date": "27/08/2026", "min_price": "1500", "max_price": "1900",
            "modal_price": "1700",
        },
        {  # second variety for the same market/day -> first one wins in the upsert
            "state": "Tamil Nadu", "district": "Krishnagiri", "market": "Hosur",
            "commodity": "Tomato", "variety": "Local", "grade": "FAQ",
            "arrival_date": "27/08/2026", "min_price": "1200", "max_price": "1500",
            "modal_price": "1350",
        },
        {  # case-insensitive market name
            "state": "Tamil Nadu", "district": "Dharmapuri", "market": "palacode",
            "commodity": "Tomato", "variety": "Local", "grade": "FAQ",
            "arrival_date": "27/08/2026", "min_price": "800", "max_price": "1000",
            "modal_price": "900",
        },
        {  # prefix match on a decorated market name
            "state": "Tamil Nadu", "district": "Dharmapuri",
            "market": "Dharmapuri (Uzhavar Sandhai)", "commodity": "Tomato",
            "variety": "Hybrid", "grade": "FAQ", "arrival_date": "27/08/2026",
            "min_price": "900", "max_price": "1100", "modal_price": "1000",
        },
        {  # Karnataka F&V market, exact name as data.gov.in returns it
            "state": "Karnataka", "district": "Bangalore",
            "market": "Binny Mill (F&V), Bangalore", "commodity": "Tomato",
            "variety": "Hybrid", "grade": "FAQ", "arrival_date": "27/08/2026",
            "min_price": "1,500", "max_price": "1,800", "modal_price": "1,700",
        },
        {  # not one of our mandis -> ignored
            "state": "Karnataka", "district": "Chikkaballapur", "market": "Chintamani",
            "commodity": "Tomato", "variety": "Hybrid", "grade": "FAQ",
            "arrival_date": "27/08/2026", "min_price": "1400", "max_price": "1700",
            "modal_price": "1550",
        },
        {  # unusable price -> ignored
            "state": "Tamil Nadu", "district": "Salem", "market": "Salem",
            "commodity": "Tomato", "variety": "Hybrid", "grade": "FAQ",
            "arrival_date": "27/08/2026", "min_price": "NA", "max_price": "NA",
            "modal_price": "NA",
        },
    ],
}


# --------------------------------------------------------------------------------------
# helpers / fixtures
# --------------------------------------------------------------------------------------


def _wait_for_bootstrap() -> None:
    thread = getattr(app.state, "price_bootstrap_thread", None)
    if thread is not None:
        thread.join(timeout=15)


@pytest.fixture(autouse=True)
def _app_ready(client: TestClient) -> Iterator[None]:
    """Lifespan has run (tables + seeds) and the poller's first cache fill has finished."""
    _wait_for_bootstrap()
    yield


@pytest.fixture
def db() -> Iterator[Any]:
    with SessionLocal() as session:
        yield session


def _clear_prices(db: Any) -> None:
    db.execute(delete(MandiPrice))
    db.commit()


def _mock_client(handler: Callable[[httpx.Request], httpx.Response]) -> Callable[..., Any]:
    def factory(settings: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=1.0)

    return factory


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_mod, "BACKOFF_SCHEDULE_S", (0.0, 0.0, 0.0))


# --------------------------------------------------------------------------------------
# snapshot
# --------------------------------------------------------------------------------------


def test_snapshot_loads_26_records() -> None:
    snapshot = load_snapshot()
    assert snapshot.source == "bundled_snapshot"
    assert snapshot.fetched_at == SNAPSHOT_FETCHED_AT
    assert len(snapshot.records) == 26
    mandi_ids = {m["id"] for m in load_mandis_file()["mandis"]}
    by_commodity: dict[str, set[str]] = {}
    for record in snapshot.records:
        assert record.mandi_id in mandi_ids
        assert record.reported_on == SNAPSHOT_DAY
        assert record.modal_price > 0
        assert record.min_price is not None and record.max_price is not None
        assert record.min_price <= record.modal_price <= record.max_price
        by_commodity.setdefault(record.commodity, set()).add(record.mandi_id)
    assert by_commodity == {"Tomato": mandi_ids, "Guava": mandi_ids}
    hosur = next(r for r in snapshot.records if r.mandi_id == "hosur" and r.commodity == "Tomato")
    assert hosur.modal_price == 1600.0


# --------------------------------------------------------------------------------------
# live parser + client
# --------------------------------------------------------------------------------------


def test_live_parser_maps_markets_to_mandi_ids() -> None:
    index = MarketIndex.from_data_dir()
    records = parse_records(LIVE_FIXTURE, index)
    by_id = {(r.mandi_id, r.variety): r for r in records}
    assert {r.mandi_id for r in records} == {"hosur", "palacode", "dharmapuri", "bengaluru"}
    assert len(records) == 5  # both Hosur varieties survive parsing; the upsert dedupes
    assert by_id[("hosur", "Hybrid")].modal_price == 1700.0
    assert by_id[("hosur", "Hybrid")].reported_on == date(2026, 8, 27)
    assert by_id[("bengaluru", "Hybrid")].modal_price == 1700.0  # "1,700" parsed
    assert by_id[("bengaluru", "Hybrid")].min_price == 1500.0
    assert by_id[("dharmapuri", "Hybrid")].market == "Dharmapuri (Uzhavar Sandhai)"


def test_market_index_resolution_rules() -> None:
    index = MarketIndex.from_data_dir()
    assert index.states == ["Tamil Nadu", "Karnataka"]
    assert index.resolve("Tamil Nadu", "KOYAMBEDU") == "koyambedu"
    assert index.resolve("karnataka", "Bangalore") == "bengaluru"  # substring of our name
    assert index.resolve("Karnataka", "Binny Mill") == "bengaluru"  # prefix of our name
    assert index.resolve(None, "Hosur") == "hosur"  # no state filter -> exact market match
    assert index.resolve("Tamil Nadu", "Chintamani") is None
    assert index.resolve("Tamil Nadu", "") is None


async def test_fetch_agmarknet_builds_request_and_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=LIVE_FIXTURE)

    monkeypatch.setattr(client_mod, "make_client", _mock_client(handler))
    settings = get_settings()
    records = await fetch_agmarknet("Tomato", "Tamil Nadu", settings=settings)
    assert {r.mandi_id for r in records} >= {"hosur", "palacode"}
    assert len(seen) == 1
    request = seen[0]
    assert request.url.host == "api.data.gov.in"
    assert request.url.path == f"/resource/{settings.AGMARKNET_RESOURCE_ID}"
    params = dict(request.url.params)
    assert params["api-key"] == settings.AGMARKNET_API_KEY
    assert params["format"] == "json"
    assert params["limit"] == "1000"
    assert params["filters[commodity]"] == "Tomato"
    assert params["filters[state]"] == "Tamil Nadu"


async def test_fetch_agmarknet_retries_three_times_then_raises(
    monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ConnectTimeout("simulated timeout", request=request)

    monkeypatch.setattr(client_mod, "make_client", _mock_client(handler))
    with pytest.raises(AgmarknetError):
        await fetch_agmarknet("Tomato", "Tamil Nadu")
    assert attempts == 3


async def test_fetch_agmarknet_retries_5xx_and_recovers(
    monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    responses = iter([503, 500, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        code = next(responses)
        return httpx.Response(code, json=LIVE_FIXTURE if code == 200 else {"error": "x"})

    monkeypatch.setattr(client_mod, "make_client", _mock_client(handler))
    records = await fetch_agmarknet("Tomato", "Tamil Nadu")
    assert records


def test_live_fetch_disabled_in_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    assert live_fetch_enabled() is False  # ENV=test
    monkeypatch.setenv("AGMARKNET_LIVE", "0")
    assert live_fetch_enabled() is False


# --------------------------------------------------------------------------------------
# service: refresh + fallback + reads
# --------------------------------------------------------------------------------------


def test_refresh_falls_back_to_snapshot_when_httpx_raises(
    db: Any, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("data.gov.in unreachable", request=request)

    monkeypatch.setattr(client_mod, "make_client", _mock_client(handler))
    _clear_prices(db)
    result = refresh_prices(db, live=True)
    assert result.live_attempted is True
    assert result.source == PriceSource.BUNDLED_SNAPSHOT
    assert result.fetched == 0
    assert result.inserted == 26
    assert result.error is not None and "unreachable" in result.error

    latest = get_latest_prices(db, "Tomato")
    assert len(latest.prices) == 13
    assert latest.source == PriceSource.BUNDLED_SNAPSHOT
    assert latest.fetched_at == SNAPSHOT_FETCHED_AT
    assert latest.stale is True
    assert all(p.source == PriceSource.BUNDLED_SNAPSHOT for p in latest.prices)


def test_refresh_live_success_upserts_and_wins_over_snapshot(
    db: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.params["filters[state]"])
        if request.url.params["filters[commodity]"] != "Tomato":
            return httpx.Response(200, json={"records": []})
        return httpx.Response(200, json=LIVE_FIXTURE)

    monkeypatch.setattr(client_mod, "make_client", _mock_client(handler))
    _clear_prices(db)
    result = refresh_prices(db, live=True)
    assert sorted(calls) == ["Karnataka", "Karnataka", "Tamil Nadu", "Tamil Nadu"]
    assert result.source == PriceSource.AGMARKNET_LIVE
    assert result.error is None
    assert result.fetched == 10  # 5 mapped records x 2 state slices (fixture is not filtered)
    assert result.inserted == 4  # hosur, palacode, dharmapuri, bengaluru (dedupe on key)
    assert result.updated == 0

    latest = get_latest_prices(db, "Tomato")
    assert len(latest.prices) == 13  # snapshot fills the other mandis
    assert latest.source == PriceSource.AGMARKNET_LIVE
    assert latest.stale is False
    by_id = {p.mandi_id: p for p in latest.prices}
    assert by_id["hosur"].modal_price == 1700.0
    assert by_id["hosur"].variety == "Hybrid"  # first variety wins
    assert by_id["hosur"].reported_on == date(2026, 8, 27)
    assert by_id["hosur"].source == PriceSource.AGMARKNET_LIVE
    assert by_id["hosur"].mandi_name == "Hosur"
    assert by_id["salem"].source == PriceSource.BUNDLED_SNAPSHOT
    assert by_id["salem"].modal_price == 1250.0

    # Second poll with the same rows updates in place (unique mandi+commodity+day).
    again = refresh_prices(db, live=True)
    assert (again.inserted, again.updated) == (0, 4)
    rows = db.scalars(select(MandiPrice).where(MandiPrice.commodity == "Tomato")).all()
    assert len(rows) == 17
    _clear_prices(db)
    ensure_snapshot_loaded(db)


def test_refresh_live_disabled_only_loads_snapshot(db: Any) -> None:
    _clear_prices(db)
    result = refresh_prices(db, live=False)
    assert result.live_attempted is False
    assert result.source == PriceSource.BUNDLED_SNAPSHOT
    assert result.inserted == 26
    assert result.error is None
    assert refresh_prices(db, live=False).inserted == 0  # idempotent


def test_get_latest_prices_never_empty_when_snapshot_exists(db: Any) -> None:
    _clear_prices(db)
    assert db.scalar(select(MandiPrice.id)) is None
    latest = get_latest_prices(db, "Guava")
    assert len(latest.prices) == 13
    assert latest.source == PriceSource.BUNDLED_SNAPSHOT
    assert {p.commodity for p in latest.prices} == {"Guava"}
    assert get_latest_prices(db, "Tomato").prices


def test_unknown_commodity_returns_empty_list_with_unknown_source(db: Any) -> None:
    latest = get_latest_prices(db, "Durian")
    assert latest.prices == []
    assert latest.source == PriceSource.UNKNOWN
    assert latest.stale is True


def test_staleness_flag_uses_price_stale_hours(db: Any) -> None:
    _clear_prices(db)
    ensure_snapshot_loaded(db)
    hours = get_settings().PRICE_STALE_HOURS
    fresh = get_latest_prices(db, "Tomato", now=SNAPSHOT_FETCHED_AT + timedelta(hours=hours - 1))
    assert fresh.stale is False
    stale = get_latest_prices(db, "Tomato", now=SNAPSHOT_FETCHED_AT + timedelta(hours=hours + 1))
    assert stale.stale is True


def test_effective_source_reports_old_live_rows_as_cache() -> None:
    settings = get_settings()
    now = datetime(2026, 8, 27, 12, 0, tzinfo=UTC)
    recent = now - timedelta(hours=1)
    old = now - timedelta(hours=settings.PRICE_POLL_HOURS * 1.5 + 1)
    assert effective_source("agmarknet_live", recent, now, settings) == PriceSource.AGMARKNET_LIVE
    assert effective_source("agmarknet_live", old, now, settings) == PriceSource.AGMARKNET_CACHE
    assert effective_source("bundled_snapshot", old, now, settings) == PriceSource.BUNDLED_SNAPSHOT
    assert effective_source("garbage", old, now, settings) == PriceSource.UNKNOWN


# --------------------------------------------------------------------------------------
# poller
# --------------------------------------------------------------------------------------


def test_scheduler_registered_on_app_state() -> None:
    scheduler = app.state.scheduler
    job = scheduler.get_job(JOB_ID)
    assert job is not None
    assert job.trigger.interval == timedelta(hours=get_settings().PRICE_POLL_HOURS)


def test_run_poll_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.prices import poller

    def boom(db: Any, *, live: bool) -> Any:
        raise RuntimeError("simulated crash")

    monkeypatch.setattr(poller, "refresh_prices", boom)
    assert run_poll() is None
    monkeypatch.undo()
    result = run_poll()
    assert result is not None and result.source == PriceSource.BUNDLED_SNAPSHOT


# --------------------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------------------


def test_get_prices_endpoint_shape(client: TestClient, db: Any) -> None:
    _clear_prices(db)
    response = client.get("/api/v1/prices", params={"commodity": "Tomato"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"commodity", "source", "fetched_at", "stale", "prices"}
    assert body["commodity"] == "Tomato"
    assert body["source"] == "bundled_snapshot"
    assert body["fetched_at"] == "2026-08-25T03:30:00Z"
    assert body["stale"] is True
    assert len(body["prices"]) == 13
    hosur = next(p for p in body["prices"] if p["mandi_id"] == "hosur")
    assert set(hosur) == {
        "mandi_id", "mandi_name", "commodity", "variety", "modal_price", "min_price",
        "max_price", "arrival_qty", "reported_on", "fetched_at", "source",
    }
    assert hosur["mandi_name"] == "Hosur"
    assert hosur["modal_price"] == 1600.0
    assert hosur["reported_on"] == "2026-08-25"
    assert hosur["fetched_at"].endswith("Z")
    assert hosur["source"] == "bundled_snapshot"
    assert client.get("/api/v1/prices").json()["commodity"] == "Tomato"  # default


def test_refresh_endpoint_skips_live_under_test_env(client: TestClient) -> None:
    response = client.post("/api/v1/prices/refresh")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "skipped"
    assert body["source"] == "bundled_snapshot"
    assert body["error"] is None
    assert body["rows"] == body["inserted"] + body["updated"]


def test_refresh_endpoint_reports_failed_live_with_fallback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    from app.routers import prices as prices_router

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"status": "error"})

    monkeypatch.setattr(client_mod, "make_client", _mock_client(handler))
    monkeypatch.setattr(prices_router, "live_fetch_enabled", lambda: True)
    response = client.post("/api/v1/prices/refresh")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert body["source"] == "bundled_snapshot"
    assert "HTTP 503" in body["error"]


def test_refresh_endpoint_reports_ok_on_live_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, db: Any
) -> None:
    from app.routers import prices as prices_router

    monkeypatch.setattr(
        client_mod, "make_client", _mock_client(lambda r: httpx.Response(200, json=LIVE_FIXTURE))
    )
    monkeypatch.setattr(prices_router, "live_fetch_enabled", lambda: True)
    response = client.post("/api/v1/prices/refresh")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["source"] == "agmarknet_live"
    assert body["stale"] is False
    assert body["fetched"] == 20  # 5 mapped records x (2 commodities x 2 states), unfiltered mock
    assert body["inserted"] == 4
    _clear_prices(db)
    ensure_snapshot_loaded(db)


def test_refresh_endpoint_requires_token_outside_demo_mode(
    client: TestClient, auth_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "DEMO_MODE", False)
    assert client.post("/api/v1/prices/refresh").status_code == 401
    assert client.post("/api/v1/prices/refresh", headers=auth_headers).status_code == 200


def test_health_reports_snapshot_source(client: TestClient, db: Any) -> None:
    ensure_snapshot_loaded(db)
    body = client.get("/api/v1/health").json()
    assert body["prices"]["source"] == "bundled_snapshot"
    assert body["prices"]["fetched_at"] == "2026-08-25T03:30:00Z"
    assert body["prices"]["stale"] is True
