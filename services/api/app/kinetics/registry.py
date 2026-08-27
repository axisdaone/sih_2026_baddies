"""Protocol registry: loads app/kinetics/protocols/*.json and seeds the `protocols` table."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models import Protocol

PROTOCOLS_DIR = Path(__file__).resolve().parent / "protocols"
MODEL_VERSION = "kinetics-1.0"


@lru_cache(maxsize=1)
def load_protocols() -> dict[str, dict[str, Any]]:
    """All protocol JSON files keyed by `id`. Cached; treat the returned dicts as read-only."""
    protocols: dict[str, dict[str, Any]] = {}
    for path in sorted(PROTOCOLS_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as fh:
            data: dict[str, Any] = json.load(fh)
        protocol_id = data.get("id")
        if not isinstance(protocol_id, str) or not protocol_id:
            raise ValueError(f"protocol file {path.name} has no string 'id'")
        if protocol_id in protocols:
            raise ValueError(f"duplicate protocol id {protocol_id!r} in {path.name}")
        validate_scenario_ordering(data)
        protocols[protocol_id] = data
    return protocols


def validate_scenario_ordering(protocol: dict[str, Any]) -> None:
    """Load-time invariant for q10 protocols: the fixed (q10, L_ref) scenario pairs of contract
    step 5 must give low <= mid <= high remaining hours at *every* effective temperature.

    With x = (T' - T_ref) / 10 the remaining hours at t0 are L / q10**x, so the ordering needs
        L_lo / q_hi**x  <=  L_ref / q10**x  <=  L_hi / q_lo**x.
    For x >= 0 it follows from q_lo <= q10 <= q_hi and L_lo <= L_ref <= L_hi; for x < 0 (a
    floor below the reference temperature, e.g. guava: floor 8, T_ref 10) the pessimistic q10
    gives the *slower* rate and the L spread must outweigh it. (q_a / q_b)**x is monotone in x,
    so checking both clamp endpoints covers every temperature and hence any mixed timeline
    (consumed fractions r/L order the same way). Raises ValueError so a bad protocol file fails
    at import, not at the first estimate.
    """
    if protocol.get("model") != "q10":
        return
    pid = protocol.get("id")
    q10 = float(protocol["q10"])
    q_lo, q_hi = (float(v) for v in protocol["q10_range"])
    l_ref = float(protocol["reference_shelf_life_hours"])
    l_lo, l_hi = (float(v) for v in protocol["reference_shelf_life_range_hours"])
    if not q_lo <= q10 <= q_hi:
        raise ValueError(f"protocol {pid!r}: q10 {q10} outside q10_range [{q_lo}, {q_hi}]")
    if not l_lo <= l_ref <= l_hi:
        raise ValueError(
            f"protocol {pid!r}: reference_shelf_life_hours {l_ref} outside range [{l_lo}, {l_hi}]"
        )
    t_ref = float(protocol["reference_temp_c"])
    for temp in (protocol.get("min_effective_temp_c"), protocol.get("max_effective_temp_c")):
        if temp is None:
            continue
        x = (float(temp) - t_ref) / 10.0
        low = l_lo / q_hi**x
        mid = l_ref / q10**x
        high = l_hi / q_lo**x
        if not low <= mid <= high:
            raise ValueError(
                f"protocol {pid!r}: scenarios invert at {temp} C "
                f"(remaining low/mid/high = {low:.1f}/{mid:.1f}/{high:.1f} h); widen "
                "reference_shelf_life_range_hours or narrow q10_range"
            )


def get_protocol(protocol_id: str) -> dict[str, Any]:
    """Protocol dict by id; raises KeyError when unknown."""
    return load_protocols()[protocol_id]


def list_protocols() -> list[dict[str, Any]]:
    return list(load_protocols().values())


def seed_protocols(db: Session) -> int:
    """Upsert every protocol into the `protocols` table; returns count."""
    protocols = load_protocols()
    for protocol_id, params in protocols.items():
        db.merge(
            Protocol(
                id=protocol_id,
                kind=str(params["kind"]),
                params_json=params,
                version=str(params.get("version", "1.0")),
            )
        )
    db.commit()
    return len(protocols)
