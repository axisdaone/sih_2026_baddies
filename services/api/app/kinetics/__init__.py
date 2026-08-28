"""Kinetics: data-driven decay protocols + evaluator (contract section 2).

Only the pure evaluator is re-exported here so `app.kinetics` stays importable without the ORM;
protocol loading/seeding lives in `app.kinetics.registry`.
"""

from app.kinetics.engine import (
    ALERT_THRESHOLDS_PCT,
    MODEL_VERSION,
    STALE_READING_HOURS,
    Evaluation,
    ReadingInput,
    ReadingLike,
    consumed_after,
    evaluate,
    evaluate_detailed,
    rate_multiplier,
    remaining_hours_at,
    round_half_up,
)

__all__ = [
    "ALERT_THRESHOLDS_PCT",
    "MODEL_VERSION",
    "STALE_READING_HOURS",
    "Evaluation",
    "ReadingInput",
    "ReadingLike",
    "consumed_after",
    "evaluate",
    "evaluate_detailed",
    "rate_multiplier",
    "remaining_hours_at",
    "round_half_up",
]
