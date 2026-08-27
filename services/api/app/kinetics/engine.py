"""Shelf-life evaluator (contract section 2.2). Pure functions; no DB, no I/O.

STUB: signatures only. The kinetics feature agent implements the bodies and the TypeScript
mirror in apps/web/src/engine must produce byte-identical JSON (golden tests).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any, Protocol

from app.schemas import ShelfLifeEstimate

ALERT_THRESHOLDS_PCT: tuple[int, ...] = (75, 50, 25)


class ReadingLike(Protocol):
    """Anything with the three reading attributes (ORM Reading, Pydantic ReadingCreate, ...)."""

    @property
    def id(self) -> str: ...

    @property
    def temp_c(self) -> float: ...

    @property
    def taken_at(self) -> datetime: ...


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
    All datetimes must be timezone-aware UTC. Rounds only at the output boundary.
    """
    raise NotImplementedError  # PHASE2


def rate_multiplier(protocol: dict[str, Any], temp_c: float, q10: float | None = None) -> float:
    """Rate multiplier r(T) relative to the reference temperature.

    q10 model: clamp T to [min_effective_temp_c, max_effective_temp_c], then
    r = q10 ** ((T - reference_temp_c) / 10). `q10` overrides the protocol nominal value
    (used for the optimistic/pessimistic scenarios).
    excursion model: r = 0 inside band_c, else 1.
    """
    raise NotImplementedError  # PHASE2


def consumed_after(
    protocol: dict[str, Any], estimate: ShelfLifeEstimate, hours: float, temp_c: float
) -> float:
    """Mid-scenario consumed fraction after holding `hours` more at `temp_c` (routing, section 3).

    consumed = clamp(estimate.consumed_fraction + hours * r(temp_c) / L_ref, 0, 1).
    """
    raise NotImplementedError  # PHASE2
