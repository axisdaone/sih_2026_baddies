"""QR PNG for the public Quality Pass page (contract section 4)."""

from __future__ import annotations

from io import BytesIO

import qrcode
from qrcode.constants import ERROR_CORRECT_M

HEAD_PREFIX_LEN = 16


def pass_page_url(base_url: str, batch_id: str, chain_head: str | None) -> str:
    """`{PUBLIC_BASE_URL}/pass/{batch_id}?h={chain_head[:16]}` (no `?h` while chain is empty)."""
    url = f"{base_url.rstrip('/')}/pass/{batch_id}"
    if chain_head:
        url += f"?h={chain_head[:HEAD_PREFIX_LEN]}"
    return url


def qr_png(data: str, *, box_size: int = 6, border: int = 2) -> bytes:
    """Render `data` as a PNG QR code (error correction M, ~15 % damage tolerance)."""
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=box_size, border=border)
    qr.add_data(data)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    buffer = BytesIO()
    image.save(buffer)
    return buffer.getvalue()
