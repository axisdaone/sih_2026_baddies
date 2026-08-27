"""Shelf-life evaluator (contract section 2.2). Pure functions; no DB, no I/O.

The TypeScript mirror in apps/web/src/engine must produce identical JSON. Every numeric
decision that is not spelled out in the contract is documented inline so it can be mirrored:

* Rounding is `floor(x * 10**n + 0.5) / 10**n` (== JS `Math.round(x * 10**n) / 10**n`), applied
  once at the output boundary: fractions and segment rates 4 dp, hours / degree-hours 1 dp.
* `expected_end` = `now` + the *rounded* remaining hours, as an integer number of milliseconds,
  so the end timestamp and the displayed hours never disagree.
* Zero-duration segments are not emitted; a reading exactly at `now` is kept (only `> now` drops).
* Readings are stably sorted by `taken_at`; ties keep input order (seq order from the DB).
* `current_temp_c` is the last kept reading's temperature (or `default_ambient_c`), unclamped.
* `breach` reports the first breaching reading in time order, the first matching threshold in
  protocol order, and the threshold's `value_c` (not the reading's temperature) and `label`.
* Status / alerts use the unrounded mid remaining fraction.
* Timestamps serialise as ISO-8601 UTC 'Z' with milliseconds only when non-zero (`iso_z`).

`data/demo_scenarios/golden_estimates_py.json` (written by `scripts/dump_golden_estimates.py`)
is the byte-for-byte reference the TypeScript parity test compares against.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol

from app.schemas import Breach, ScenarioEnd, ScenarioHours, Segment, ShelfLifeEstimate, to_utc

MODEL_VERSION = "kinetics-1.0"
ALERT_THRESHOLDS_PCT: tuple[int, ...] = (75, 50, 25)

# Hours after which the last reading no longer describes the current temperature.
STALE_READING_HOURS = 2.0
# Confidence "medium" needs a reading at most this old.
MEDIUM_CONFIDENCE_MAX_AGE_HOURS = 8.0
# Guard against division by a zero rate (contract step 4).
MIN_RATE = 1e-6

_MS_PER_HOUR = 3_600_000.0


class ReadingLike(Protocol):
    """Anything with the three reading attributes (ORM Reading, Pydantic ReadingCreate, ...)."""

    @property
    def id(self) -> str: ...

    @property
    def temp_c(self) -> float: ...

    @property
    def taken_at(self) -> datetime: ...


@dataclass(frozen=True, slots=True)
class ReadingInput:
    """Minimal ReadingLike for callers without an ORM/Pydantic object (tests, simulators)."""

    id: str
    temp_c: float
    taken_at: datetime


@dataclass(frozen=True, slots=True)
class _Segment:
    start: datetime
    end: datetime
    temp_c: float
    hours: float
    assumed: bool


@dataclass(frozen=True, slots=True)
class _Scenario:
    q10: float | None
    shelf_life_hours: float


def round_half_up(value: float, ndigits: int) -> float:
    """Round half up on the scaled double, identical to JS `Math.round(x * 10**n) / 10**n`."""
    scale = 10.0**ndigits
    return math.floor(value * scale + 0.5) / scale


def _hours_between(start: datetime, end: datetime) -> float:
    """Elapsed hours computed from whole milliseconds (mirrors JS `Date` arithmetic)."""
    delta = end - start
    millis = (delta.days * 86_400 + delta.seconds) * 1000 + delta.microseconds // 1000
    return millis / _MS_PER_HOUR


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def rate_multiplier(protocol: dict[str, Any], temp_c: float, q10: float | None = None) -> float:
    """Rate multiplier r(T) relative to the reference temperature.

    q10 model: clamp T to [min_effective_temp_c, max_effective_temp_c], then
    r = q10 ** ((T - reference_temp_c) / 10). `q10` overrides the protocol nominal value
    (used for the optimistic/pessimistic scenarios).
    excursion model: r = 0 inside band_c, else 1.
    """
    if protocol.get("model") == "excursion":
        band = protocol.get("band_c")
        if band is None:
            raise ValueError("excursion protocol requires band_c")
        low, high = float(band[0]), float(band[1])
        return 0.0 if low <= temp_c <= high else 1.0

    effective_q10 = float(protocol["q10"] if q10 is None else q10)
    floor = protocol.get("min_effective_temp_c")
    ceiling = protocol.get("max_effective_temp_c")
    effective_temp = float(temp_c)
    if floor is not None:
        effective_temp = max(float(floor), effective_temp)
    if ceiling is not None:
        effective_temp = min(float(ceiling), effective_temp)
    exponent = (effective_temp - float(protocol["reference_temp_c"])) / 10.0
    return math.pow(effective_q10, exponent)


def _scenarios(protocol: dict[str, Any]) -> dict[str, _Scenario]:
    """mid / high (optimistic) / low (pessimistic) parameter sets (contract step 5)."""
    l_ref = float(protocol["reference_shelf_life_hours"])
    l_range = protocol["reference_shelf_life_range_hours"]
    if protocol.get("model") == "excursion":
        # Budget in all three; the range file already encodes +/-10 % of the budget.
        return {
            "mid": _Scenario(None, l_ref),
            "high": _Scenario(None, float(l_range[1])),
            "low": _Scenario(None, float(l_range[0])),
        }
    q10_range = protocol["q10_range"]
    return {
        "mid": _Scenario(float(protocol["q10"]), l_ref),
        "high": _Scenario(float(q10_range[0]), float(l_range[1])),
        "low": _Scenario(float(q10_range[1]), float(l_range[0])),
    }


def _build_timeline(
    protocol: dict[str, Any],
    harvested_at: datetime,
    readings: Sequence[ReadingLike],
    now: datetime,
) -> list[_Segment]:
    """Piecewise-constant temperature segments from harvested_at to now (contract step 1).

    `readings` must already be sorted, UTC-normalised and restricted to `taken_at <= now`.
    Segment bounds are clamped into [harvested_at, now]; empty segments are dropped.
    """
    segments: list[_Segment] = []

    def push(start: datetime, end: datetime, temp_c: float, assumed: bool) -> None:
        start = max(start, harvested_at)
        end = min(end, now)
        if end <= start:
            return
        segments.append(_Segment(start, end, temp_c, _hours_between(start, end), assumed))

    if not readings:
        push(harvested_at, now, float(protocol["default_ambient_c"]), True)
        return segments

    push(harvested_at, readings[0].taken_at, float(protocol["default_ambient_c"]), True)
    for index, reading in enumerate(readings):
        is_last = index == len(readings) - 1
        end = now if is_last else readings[index + 1].taken_at
        assumed = is_last and _hours_between(reading.taken_at, now) > STALE_READING_HOURS
        push(reading.taken_at, end, float(reading.temp_c), assumed)
    return segments


def _find_breach(protocol: dict[str, Any], readings: Sequence[ReadingLike]) -> Breach | None:
    """First reading (time order) breaching any hard threshold (strict comparison)."""
    thresholds = protocol.get("hard_thresholds") or []
    for reading in readings:
        temp = float(reading.temp_c)
        for threshold in thresholds:
            value_c = float(threshold["value_c"])
            kind = threshold["type"]
            hit = (kind == "max_temp" and temp > value_c) or (kind == "min_temp" and temp < value_c)
            if hit:
                label = threshold.get("label")
                return Breach(
                    type=kind,
                    value_c=value_c,
                    reading_id=str(reading.id),
                    at=reading.taken_at,
                    label=None if label is None else str(label),
                )
    return None


def _consumed(protocol: dict[str, Any], segments: Sequence[_Segment], scenario: _Scenario) -> float:
    total = 0.0
    for segment in segments:
        total += segment.hours * rate_multiplier(protocol, segment.temp_c, scenario.q10)
    return _clamp(total / scenario.shelf_life_hours, 0.0, 1.0)


def _remaining_hours(
    protocol: dict[str, Any], consumed: float, temp_now: float, scenario: _Scenario
) -> float:
    """Contract step 4; an excursion batch that is in band reports budget remaining."""
    rate = rate_multiplier(protocol, temp_now, scenario.q10)
    if protocol.get("model") == "excursion" and rate == 0.0:
        return (1.0 - consumed) * scenario.shelf_life_hours
    return (1.0 - consumed) * scenario.shelf_life_hours / max(rate, MIN_RATE)


def _status(remaining_fraction: float) -> str:
    if remaining_fraction > 0.5:
        return "fresh"
    if remaining_fraction > 0.25:
        return "warning"
    if remaining_fraction > 0.0:
        return "critical"
    return "spoiled"


def _confidence(reading_count: int, hours_since_last: float | None) -> str:
    if hours_since_last is None:
        return "low"
    if reading_count >= 2 and hours_since_last <= STALE_READING_HOURS:
        return "high"
    if reading_count >= 1 and hours_since_last <= MEDIUM_CONFIDENCE_MAX_AGE_HOURS:
        return "medium"
    return "low"


def _end_at(now: datetime, rounded_hours: float) -> datetime:
    return now + timedelta(milliseconds=round_half_up(rounded_hours * _MS_PER_HOUR, 0))


@dataclass(frozen=True, slots=True)
class Evaluation:
    """`evaluate()` output plus the unrounded mid consumed fraction for downstream integrators
    (routing continues the integral from it, so it must not start from the 4-dp wire value)."""

    estimate: ShelfLifeEstimate
    consumed_mid: float


def evaluate(
    protocol: dict[str, Any],
    harvested_at: datetime,
    readings: Sequence[ReadingLike],
    now: datetime,
) -> ShelfLifeEstimate:
    """Evaluate remaining shelf life for a batch.

    Builds the piecewise-constant temperature timeline from `harvested_at` to `now`, integrates
    the rate law for the mid/high/low scenarios, applies hard thresholds, and derives
    status / confidence / alerts_crossed exactly as specified in contract section 2.2.
    Naive datetimes are treated as UTC. Rounds only at the output boundary.
    """
    return evaluate_detailed(protocol, harvested_at, readings, now).estimate


def evaluate_detailed(
    protocol: dict[str, Any],
    harvested_at: datetime,
    readings: Sequence[ReadingLike],
    now: datetime,
) -> Evaluation:
    """`evaluate()` that also returns the unrounded mid consumed fraction."""
    harvested_at = to_utc(harvested_at)
    now = to_utc(now)

    # Step 1: drop future readings, normalise to UTC, stable sort by taken_at.
    kept = [
        ReadingInput(str(r.id), float(r.temp_c), to_utc(r.taken_at))
        for r in readings
        if to_utc(r.taken_at) <= now
    ]
    kept.sort(key=lambda r: r.taken_at)
    segments = _build_timeline(protocol, harvested_at, kept, now)

    hours_since_last: float | None = None
    if kept:
        last = kept[-1]
        last_age = _hours_between(last.taken_at, now)
        hours_since_last = last_age
        current_temp = last.temp_c
        current_assumed = last_age > STALE_READING_HOURS
    else:
        current_temp = float(protocol["default_ambient_c"])
        current_assumed = True

    # Steps 2-5.
    scenarios = _scenarios(protocol)
    consumed = {name: _consumed(protocol, segments, sc) for name, sc in scenarios.items()}
    remaining = {
        name: _remaining_hours(protocol, consumed[name], current_temp, sc)
        for name, sc in scenarios.items()
    }

    # Step 6: hard thresholds override everything numeric.
    breach = _find_breach(protocol, kept)
    if breach is not None:
        consumed = dict.fromkeys(consumed, 1.0)
        remaining = dict.fromkeys(remaining, 0.0)

    # Steps 7-9 use the unrounded mid scenario.
    remaining_fraction = 1.0 - consumed["mid"]
    alerts = [t for t in ALERT_THRESHOLDS_PCT if remaining_fraction * 100.0 <= t]

    reference_temp = float(protocol["reference_temp_c"])
    thermal_load = 0.0
    for segment in segments:
        thermal_load += segment.hours * max(0.0, segment.temp_c - reference_temp)

    rounded_hours = {name: round_half_up(value, 1) for name, value in remaining.items()}
    mid_q10 = scenarios["mid"].q10
    estimate = ShelfLifeEstimate(
        protocol_id=str(protocol["id"]),
        model_version=MODEL_VERSION,
        computed_at=now,
        status=_status(remaining_fraction),
        confidence=_confidence(len(kept), hours_since_last),
        consumed_fraction=round_half_up(consumed["mid"], 4),
        remaining_fraction=round_half_up(remaining_fraction, 4),
        remaining_hours=ScenarioHours(
            low=rounded_hours["low"], mid=rounded_hours["mid"], high=rounded_hours["high"]
        ),
        expected_end=ScenarioEnd(
            low=_end_at(now, rounded_hours["low"]),
            mid=_end_at(now, rounded_hours["mid"]),
            high=_end_at(now, rounded_hours["high"]),
        ),
        current_temp_c=current_temp,
        current_temp_assumed=current_assumed,
        hours_since_last_reading=(
            None if hours_since_last is None else round_half_up(hours_since_last, 1)
        ),
        thermal_load_degree_hours=round_half_up(thermal_load, 1),
        alerts_crossed=alerts,
        breach=breach,
        segments=[
            Segment(
                from_=segment.start,
                to=segment.end,
                temp_c=segment.temp_c,
                hours=round_half_up(segment.hours, 1),
                rate=round_half_up(rate_multiplier(protocol, segment.temp_c, mid_q10), 4),
                assumed=segment.assumed,
            )
            for segment in segments
        ],
    )
    return Evaluation(estimate=estimate, consumed_mid=consumed["mid"])


def consumed_after(
    protocol: dict[str, Any],
    estimate: ShelfLifeEstimate,
    hours: float,
    temp_c: float,
    *,
    consumed_now: float | None = None,
) -> float:
    """Mid-scenario consumed fraction after holding `hours` more at `temp_c` (routing, section 3).

    consumed = clamp(consumed_now + hours * r(temp_c) / L_ref, 0, 1), where `consumed_now`
    defaults to the estimate's (4-dp) `consumed_fraction`; pass `Evaluation.consumed_mid` to
    continue the integral unrounded. Not rounded here; the routing layer rounds on output.
    """
    l_ref = float(protocol["reference_shelf_life_hours"])
    start = estimate.consumed_fraction if consumed_now is None else consumed_now
    extra = hours * rate_multiplier(protocol, temp_c) / l_ref
    return _clamp(start + extra, 0.0, 1.0)


def remaining_hours_at(
    protocol: dict[str, Any],
    estimate: ShelfLifeEstimate,
    temp_c: float,
    *,
    scenario: str = "mid",
    consumed_now: float | None = None,
) -> float:
    """Remaining hours if the batch is held at `temp_c` from now on (contract step 4 re-projected
    at another temperature). Routing uses it so feasibility and spoilage-at-arrival are both
    evaluated at the transit temperature rather than at the (possibly stale) last reading.

    `scenario` picks the parameter set ("mid" | "low" | "high"). The mid case continues from
    the consumed fraction like `consumed_after` (unrounded; reuses the MIN_RATE guard and the
    excursion `r == 0 -> budget remaining` branch). The wire estimate carries only the *mid*
    consumed fraction, so low/high re-project their own `remaining_hours` by the rate ratio
    (`remaining` is proportional to `1 / r(T)` for a fixed consumed fraction).
    """
    params = _scenarios(protocol)[scenario]
    if scenario == "mid":
        start = estimate.consumed_fraction if consumed_now is None else consumed_now
        return _remaining_hours(protocol, start, temp_c, params)
    current = float(getattr(estimate.remaining_hours, scenario))
    rate_now = rate_multiplier(protocol, estimate.current_temp_c, params.q10)
    rate_at = rate_multiplier(protocol, temp_c, params.q10)
    if rate_now == 0.0 or rate_at == 0.0:  # excursion in band: budget remaining, no temperature
        return current
    return current * rate_now / rate_at
