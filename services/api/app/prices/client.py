"""Agmarknet (data.gov.in) client: fetch + parse + market -> mandi mapping (contract section 8).

Network policy: `AGMARKNET_TIMEOUT_S` per request, `MAX_ATTEMPTS` attempts with exponential
backoff (`BACKOFF_SCHEDULE_S`), 5xx/429 and transport errors are retried, other 4xx are not.
Records whose market is not one of ours are ignored.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

import httpx

from app.config import Settings, get_settings
from app.seed import load_mandis_file

log = logging.getLogger(__name__)

AGMARKNET_BASE_URL = "https://api.data.gov.in/resource"
COMMODITIES: tuple[str, ...] = ("Tomato", "Guava")
MAX_ATTEMPTS = 3
BACKOFF_SCHEDULE_S: tuple[float, ...] = (1.0, 2.0, 4.0)
PAGE_LIMIT = 1000
_RETRY_STATUS = {429, 500, 502, 503, 504}


class AgmarknetError(RuntimeError):
    """Raised after every attempt against data.gov.in failed."""


@dataclass(frozen=True, slots=True)
class PriceRecord:
    """One parsed Agmarknet row, already resolved to a FarmSignal mandi. INR per quintal."""

    mandi_id: str
    commodity: str
    variety: str | None
    modal_price: float
    min_price: float | None
    max_price: float | None
    arrival_qty: float | None
    reported_on: date
    market: str
    state: str


def live_fetch_enabled(settings: Settings | None = None) -> bool:
    """True unless `AGMARKNET_LIVE` is 0/false/no/off or we are running under ENV=test.

    Tests never touch the network; the poller and the refresh endpoint consult this flag.
    """
    settings = settings or get_settings()
    flag = os.environ.get("AGMARKNET_LIVE", "1").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    return settings.ENV != "test"


# --------------------------------------------------------------------------------------
# Parsing helpers (shared with the snapshot loader)
# --------------------------------------------------------------------------------------


def parse_price(value: Any) -> float | None:
    """Agmarknet prices arrive as strings ('1600', '1,600', 'NA'). None when unusable."""
    if value is None:
        return None
    if isinstance(value, int | float):
        number = float(value)
    else:
        text = str(value).strip().replace(",", "")
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    return number if number > 0 else None


def parse_arrival_date(value: Any) -> date | None:
    """DD/MM/YYYY as the real API returns it; ISO YYYY-MM-DD is accepted too."""
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------------------
# Market -> mandi mapping
# --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _MarketKey:
    state: str
    market: str


class MarketIndex:
    """Resolves Agmarknet (state, market) names to our mandi ids, case-insensitively.

    Exact match first; then, within the same state, prefix / substring matches in either
    direction (handles 'Binny Mill (F&V), Bangalore' vs 'Bangalore' vs 'Binny Mill').
    """

    def __init__(self, mandis: list[dict[str, Any]]) -> None:
        self._exact: dict[_MarketKey, str] = {}
        self._by_state: dict[str, list[tuple[str, str]]] = {}
        self._state_names: dict[str, str] = {}  # lower-cased -> as written in mandis.json
        for mandi in mandis:
            state_name = str(mandi["agmarknet_state"]).strip()
            state = state_name.lower()
            market = str(mandi["agmarknet_market"]).strip().lower()
            self._exact[_MarketKey(state, market)] = str(mandi["id"])
            self._by_state.setdefault(state, []).append((market, str(mandi["id"])))
            self._state_names.setdefault(state, state_name)

    @classmethod
    def from_data_dir(cls, settings: Settings | None = None) -> MarketIndex:
        settings = settings or get_settings()
        return cls(load_mandis_file(settings.DATA_DIR / "mandis.json")["mandis"])

    @property
    def states(self) -> list[str]:
        """Distinct `agmarknet_state` filter values, as written in mandis.json (file order)."""
        return list(self._state_names.values())

    def resolve(self, state: str | None, market: str | None) -> str | None:
        if not market:
            return None
        market_l = market.strip().lower()
        state_l = (state or "").strip().lower()
        if state_l:
            exact = self._exact.get(_MarketKey(state_l, market_l))
            if exact:
                return exact
            candidates = self._by_state.get(state_l, [])
        else:
            candidates = [pair for pairs in self._by_state.values() for pair in pairs]
            for key, mandi_id in self._exact.items():
                if key.market == market_l:
                    return mandi_id
        for known, mandi_id in candidates:
            if market_l.startswith(known) or known.startswith(market_l):
                return mandi_id
        for known, mandi_id in candidates:
            if known in market_l or market_l in known:
                return mandi_id
        return None


def parse_records(
    payload: dict[str, Any], index: MarketIndex, *, default_state: str | None = None
) -> list[PriceRecord]:
    """Map a data.gov.in JSON body to PriceRecords; unmapped / malformed rows are dropped."""
    rows = payload.get("records") or []
    out: list[PriceRecord] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        state = str(row.get("state") or default_state or "").strip()
        market = str(row.get("market") or "").strip()
        mandi_id = index.resolve(state, market)
        if mandi_id is None:
            continue
        modal = parse_price(row.get("modal_price"))
        reported_on = parse_arrival_date(row.get("arrival_date"))
        commodity = str(row.get("commodity") or "").strip()
        if modal is None or reported_on is None or not commodity:
            continue
        variety = str(row.get("variety") or "").strip() or None
        out.append(
            PriceRecord(
                mandi_id=mandi_id,
                commodity=commodity,
                variety=variety,
                modal_price=modal,
                min_price=parse_price(row.get("min_price")),
                max_price=parse_price(row.get("max_price")),
                arrival_qty=parse_price(row.get("arrival_qty") or row.get("arrivals")),
                reported_on=reported_on,
                market=market,
                state=state,
            )
        )
    return out


# --------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------


def _build_params(commodity: str, state: str | None, settings: Settings) -> dict[str, str]:
    params = {
        "api-key": settings.AGMARKNET_API_KEY,
        "format": "json",
        "limit": str(PAGE_LIMIT),
        "filters[commodity]": commodity,
    }
    if state:
        params["filters[state]"] = state
    return params


async def _get_with_retries(
    client: httpx.AsyncClient, url: str, params: dict[str, str]
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = await client.get(url, params=params)
            if response.status_code in _RETRY_STATUS:
                raise AgmarknetError(f"HTTP {response.status_code}")
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict):
                raise AgmarknetError("unexpected JSON shape (not an object)")
            return body
        except httpx.HTTPStatusError as exc:  # non-retryable 4xx
            raise AgmarknetError(f"HTTP {exc.response.status_code}") from exc
        except (httpx.HTTPError, AgmarknetError, ValueError) as exc:
            last_error = exc
            log.warning(
                "agmarknet attempt %d/%d failed for %s: %s", attempt, MAX_ATTEMPTS, params, exc
            )
            if attempt < MAX_ATTEMPTS:
                delay = BACKOFF_SCHEDULE_S[min(attempt - 1, len(BACKOFF_SCHEDULE_S) - 1)]
                if delay > 0:
                    await asyncio.sleep(delay)
    raise AgmarknetError(f"agmarknet unreachable after {MAX_ATTEMPTS} attempts: {last_error}")


def make_client(settings: Settings) -> httpx.AsyncClient:
    """HTTP client factory (tests monkeypatch this to inject an `httpx.MockTransport`)."""
    return httpx.AsyncClient(timeout=settings.AGMARKNET_TIMEOUT_S)


async def fetch_agmarknet(
    commodity: str,
    state: str | None,
    *,
    settings: Settings | None = None,
    index: MarketIndex | None = None,
    client: httpx.AsyncClient | None = None,
) -> list[PriceRecord]:
    """Fetch + parse one (commodity, state) slice from data.gov.in.

    Raises `AgmarknetError` when every attempt fails; returns only records mapped to our mandis.
    """
    settings = settings or get_settings()
    index = index or MarketIndex.from_data_dir(settings)
    url = f"{AGMARKNET_BASE_URL}/{settings.AGMARKNET_RESOURCE_ID}"
    params = _build_params(commodity, state, settings)
    if client is not None:
        body = await _get_with_retries(client, url, params)
    else:
        async with make_client(settings) as own_client:
            body = await _get_with_retries(own_client, url, params)
    records = parse_records(body, index, default_state=state)
    log.info(
        "agmarknet %s/%s: %d raw rows, %d mapped",
        commodity,
        state or "*",
        len(body.get("records") or []),
        len(records),
    )
    return records
