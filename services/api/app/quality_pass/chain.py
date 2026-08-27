"""SHA-256 hash chain over a batch's readings (contract section 4). Pure; no DB, no I/O.

Canonical form — pinned byte-for-byte so Python and `apps/web/src/engine/hashchain.ts` agree:

    genesis prev_hash = sha256_hex("farmsignal:" + batch_id)
    payload = {"batch_id":"<uuid>","geohash":<null|"<str>">,"reading_id":"<uuid>","seq":<int>,
               "source":"<manual|sim|ble>","taken_at":"<YYYY-MM-DDTHH:MM:SSZ>","temp_c":<1 dp>}
    hash    = sha256_hex(prev_hash + "|" + payload)

* keys in exactly that (sorted) order, no whitespace;
* `taken_at` is UTC at seconds precision (sub-seconds truncated) with a literal 'Z';
* `temp_c` is already rounded to 1 dp at input time and rendered like `28.0` / `31.5`
  (Python `f"{x:.1f}"`, TS `x.toFixed(1)`); negative zero renders as `0.0` (both the stored
  value and the canonical string are normalised with `x = round(x, 1) + 0.0`);
* `geohash` renders as the JSON literal `null` when absent, else a JSON string.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from app.schemas.common import to_utc

HASH_HEX_LEN = 64


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def genesis_hash(batch_id: str) -> str:
    """prev_hash of the first reading (seq 1) of a batch."""
    return sha256_hex(f"farmsignal:{batch_id}")


def canonical_taken_at(taken_at: datetime) -> str:
    """ISO-8601 UTC, seconds precision, 'Z' (TS: `toISOString().slice(0, 19) + "Z"`)."""
    return to_utc(taken_at).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_temp(temp_c: float) -> str:
    """Exactly one decimal; a negative zero is normalised to `0.0` like JS `toFixed`.

    Python renders `f"{-0.04:.1f}"` (and `-0.0`) as `-0.0` while TS `(-0).toFixed(1)` is
    `0.0`; `round(x, 1) + 0.0` turns the negative zero into a positive one (IEEE-754:
    `-0.0 + 0.0 == +0.0`). Inputs are already rounded half-up to 1 dp by `append_reading`,
    so the `round` here never changes a stored value; it only pins the zero's sign.
    """
    value = round(float(temp_c), 1) + 0.0
    return f"{value:.1f}"


def canonical_payload(
    *,
    batch_id: str,
    reading_id: str,
    seq: int,
    temp_c: float,
    taken_at: datetime,
    source: str,
    geohash: str | None,
) -> str:
    """The exact string that is hashed (see module docstring)."""
    geo = "null" if geohash is None else json.dumps(geohash, ensure_ascii=False)
    return (
        "{"
        f'"batch_id":{json.dumps(batch_id, ensure_ascii=False)},'
        f'"geohash":{geo},'
        f'"reading_id":{json.dumps(reading_id, ensure_ascii=False)},'
        f'"seq":{int(seq)},'
        f'"source":{json.dumps(str(source), ensure_ascii=False)},'
        f'"taken_at":"{canonical_taken_at(taken_at)}",'
        f'"temp_c":{canonical_temp(temp_c)}'
        "}"
    )


def reading_hash(prev_hash: str, payload: str) -> str:
    return sha256_hex(f"{prev_hash}|{payload}")


class ChainReading(Protocol):
    """Structural type satisfied by the ORM `Reading` (and by test fakes)."""

    @property
    def id(self) -> str: ...

    @property
    def seq(self) -> int: ...

    @property
    def temp_c(self) -> float: ...

    @property
    def taken_at(self) -> datetime: ...

    @property
    def source(self) -> str: ...

    @property
    def geohash(self) -> str | None: ...

    @property
    def hash(self) -> str: ...

    @property
    def prev_hash(self) -> str: ...


def payload_for(batch_id: str, reading: ChainReading) -> str:
    return canonical_payload(
        batch_id=batch_id,
        reading_id=reading.id,
        seq=reading.seq,
        temp_c=reading.temp_c,
        taken_at=reading.taken_at,
        source=str(reading.source),
        geohash=reading.geohash,
    )


@dataclass(frozen=True, slots=True)
class ChainVerifyResult:
    """`chain_head` is the head *recomputed from the current data*; `stored_head` is what the
    last row claims. They differ exactly when the chain has been tampered with."""

    valid: bool
    chain_head: str | None
    length: int
    first_bad_seq: int | None
    stored_head: str | None


def verify_chain(batch_id: str, readings: Sequence[ChainReading]) -> ChainVerifyResult:
    """Recompute every link from genesis over `readings` (must be ordered by seq).

    A link is bad when its seq is not the next integer, its prev_hash is not the previous
    (recomputed) hash, or its stored hash differs from the recomputed one. Recomputation
    continues past the first bad link so `chain_head` always reflects the data as it is now.
    """
    prev = genesis_hash(batch_id)
    first_bad: int | None = None
    recomputed_head: str | None = None
    for expected_seq, reading in enumerate(readings, start=1):
        recomputed = reading_hash(prev, payload_for(batch_id, reading))
        link_ok = (
            reading.seq == expected_seq and reading.prev_hash == prev and reading.hash == recomputed
        )
        if not link_ok and first_bad is None:
            first_bad = int(reading.seq)
        prev = recomputed
        recomputed_head = recomputed
    return ChainVerifyResult(
        valid=first_bad is None,
        chain_head=recomputed_head,
        length=len(readings),
        first_bad_seq=first_bad,
        stored_head=readings[-1].hash if readings else None,
    )


def stored_chain_head(readings: Sequence[ChainReading]) -> str | None:
    """Head as stored (last reading's hash) — what batches expose as `chain_head`."""
    return readings[-1].hash if readings else None
