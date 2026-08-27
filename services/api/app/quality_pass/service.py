"""Public Quality Pass: payload assembly, chain verification, QR, audit events.

Privacy rules (PRD "Privacy", contract section 6): the public payload never carries
`farmer_id`, `device_id`, notes, or the exact origin. Location is reduced to a precision-4
geohash cell (~20 km) plus a coarse region label; `display_name` is the name the farmer
opted into on `POST /auth/device` (it is the only identity field on the Farmer row that the
farmer sets themselves, so no extra opt-in column is needed).
"""

from __future__ import annotations

import hashlib
from datetime import datetime

from sqlalchemy.orm import Session

from app.config import get_settings
from app.enums import PassEvent as PassEventKind
from app.enums import ReadingSource
from app.kinetics.registry import get_protocol
from app.models import Batch, PassEvent, utcnow
from app.quality_pass.chain import ChainVerifyResult, stored_chain_head, verify_chain
from app.quality_pass.qr import HEAD_PREFIX_LEN, pass_page_url, qr_png
from app.schemas import PassReading, QualityPassPayload, QualityPassVerify
from app.services import NotFoundError
from app.services.batches import readings_for, shelf_life_for
from app.services.geo import BBox

# Dharmapuri + Krishnagiri tomato belt (demo region, contract section 8).
DEMO_REGION_BBOX = BBox(lat_min=11.7, lon_min=77.6, lat_max=12.9, lon_max=78.7)
DEMO_REGION_LABEL = "Dharmapuri belt"
PUBLIC_GEOHASH_PRECISION = 4
HASH_DISPLAY_LEN = 12


def get_public_batch(db: Session, batch_id: str) -> Batch:
    """Any live batch by id (the QR link is the capability); 404 otherwise."""
    batch = db.get(Batch, batch_id)
    if batch is None or batch.deleted_at is not None:
        raise NotFoundError("batch not found")
    return batch


def pass_url(batch_id: str, chain_head: str | None) -> str:
    return pass_page_url(get_settings().PUBLIC_BASE_URL, batch_id, chain_head)


def verify_url(batch_id: str, chain_head: str | None) -> str:
    base = get_settings().PUBLIC_BASE_URL.rstrip("/")
    url = f"{base}/api/v1/quality-pass/{batch_id}/verify"
    if chain_head:
        url += f"?head={chain_head[:HEAD_PREFIX_LEN]}"
    return url


def region_label(batch: Batch) -> str | None:
    if DEMO_REGION_BBOX.contains(batch.origin_lat, batch.origin_lon):
        return DEMO_REGION_LABEL
    return None


def public_geohash(batch: Batch) -> str | None:
    if not batch.origin_geohash:
        return None
    return batch.origin_geohash[:PUBLIC_GEOHASH_PRECISION]


def build_pass_payload(
    db: Session, batch: Batch, now: datetime | None = None
) -> QualityPassPayload:
    at = utcnow() if now is None else now
    readings = readings_for(db, batch.id)
    protocol = get_protocol(batch.protocol_id)
    chain = verify_chain(batch.id, readings)
    head = stored_chain_head(readings)
    return QualityPassPayload(
        batch_id=batch.id,
        crop=batch.crop,
        protocol_id=batch.protocol_id,
        protocol_name=str(protocol.get("name", batch.protocol_id)),
        qty_kg=batch.qty_kg,
        harvested_at=batch.harvested_at,
        status=batch.status,
        origin_geohash=public_geohash(batch),
        region=region_label(batch),
        display_name=batch.farmer.display_name or None,
        readings=[
            PassReading(
                seq=r.seq,
                temp_c=r.temp_c,
                taken_at=r.taken_at,
                source=r.source,
                hash=r.hash[:HASH_DISPLAY_LEN],
            )
            for r in readings
        ],
        shelf_life=shelf_life_for(batch, readings, at),
        chain_head=head,
        chain_length=len(readings),
        chain_valid=chain.valid,
        generated_at=at,
        simulated=any(r.source == ReadingSource.SIM.value for r in readings),
        pass_url=pass_url(batch.id, head),
        verify_url=verify_url(batch.id, head),
    )


def verify_batch(db: Session, batch: Batch, head: str | None = None) -> QualityPassVerify:
    """Recompute the chain; `head_matches` compares the caller's (prefix of a) head against
    the *recomputed* head, so a tampered chain fails both `valid` and `head_matches`."""
    chain: ChainVerifyResult = verify_chain(batch.id, readings_for(db, batch.id))
    matches = False
    if head and chain.chain_head is not None:
        wanted = head.strip().lower()
        matches = len(wanted) >= HEAD_PREFIX_LEN and chain.chain_head.startswith(wanted)
    return QualityPassVerify(
        valid=chain.valid,
        chain_head=chain.chain_head,
        length=chain.length,
        first_bad_seq=chain.first_bad_seq,
        head_matches=matches,
    )


def qr_png_for(db: Session, batch: Batch) -> bytes:
    head = stored_chain_head(readings_for(db, batch.id))
    return qr_png(pass_url(batch.id, head))


def hash_ip(ip: str) -> str:
    """Keyed SHA-256 of the client IP: enough for abuse analysis, never reversible in the DB."""
    return hashlib.sha256(f"{get_settings().JWT_SECRET}:{ip}".encode()).hexdigest()


def record_pass_event(db: Session, batch_id: str, event: PassEventKind, ip: str) -> None:
    db.add(PassEvent(batch_id=batch_id, event=event.value, ip_hash=hash_ip(ip)))
    db.commit()
