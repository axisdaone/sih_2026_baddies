"""Dump the Python engine's full ShelfLifeEstimate for every golden case.

Usage (from services/api):

    .venv/Scripts/python scripts/dump_golden_estimates.py

Reads  data/demo_scenarios/golden_kinetics.json   (inputs; the behavioural golden file)
Writes data/demo_scenarios/golden_estimates_py.json (outputs; the byte-for-byte parity reference)

The Python engine is authoritative (contract section 2.2). apps/web/src/engine/parity.test.ts
loads the written file and asserts that the TypeScript engine produces exactly the same estimate
objects; tests/test_cross_language.py asserts the file is up to date with the Python engine.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

API_ROOT = Path(__file__).resolve().parents[1]  # services/api
REPO_ROOT = API_ROOT.parents[1]  # repo root (services/api -> services -> root)
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.kinetics import MODEL_VERSION, ReadingInput, evaluate  # noqa: E402
from app.kinetics.registry import get_protocol  # noqa: E402
from app.schemas import parse_iso_z  # noqa: E402

GOLDEN_INPUTS = REPO_ROOT / "data" / "demo_scenarios" / "golden_kinetics.json"
GOLDEN_ESTIMATES = REPO_ROOT / "data" / "demo_scenarios" / "golden_estimates_py.json"


def load_golden_inputs() -> dict[str, Any]:
    with open(GOLDEN_INPUTS, encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


def estimate_for(case: dict[str, Any]) -> dict[str, Any]:
    """Full ShelfLifeEstimate JSON (wire aliases, 'Z' timestamps) for one golden case."""
    readings = [
        ReadingInput(id=r["id"], temp_c=float(r["temp_c"]), taken_at=parse_iso_z(r["taken_at"]))
        for r in case["readings"]
    ]
    estimate = evaluate(
        get_protocol(case["protocol_id"]),
        parse_iso_z(case["harvested_at"]),
        readings,
        parse_iso_z(case["now"]),
    )
    return estimate.model_dump(mode="json", by_alias=True)


def build_payload(golden: dict[str, Any] | None = None) -> dict[str, Any]:
    golden = load_golden_inputs() if golden is None else golden
    return {
        "model_version": MODEL_VERSION,
        "generated_from": GOLDEN_INPUTS.name,
        "cases": [{"id": case["id"], "estimate": estimate_for(case)} for case in golden["cases"]],
    }


def render(payload: dict[str, Any]) -> str:
    """Deterministic file text (2-space indent, trailing newline, keys in model order)."""
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    payload = build_payload()
    GOLDEN_ESTIMATES.write_text(render(payload), encoding="utf-8", newline="\n")
    print(f"wrote {len(payload['cases'])} estimates to {GOLDEN_ESTIMATES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
