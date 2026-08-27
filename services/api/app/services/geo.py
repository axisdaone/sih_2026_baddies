"""Tiny pure geohash encoder (no third-party dependency) + a bounding-box helper.

Batches store `origin_geohash` at precision 7 (~150 m cell); the public Quality Pass only ever
exposes the first 4 characters (~20 km cell), see `app.quality_pass.service`.
"""

from __future__ import annotations

from typing import NamedTuple

GEOHASH_PRECISION = 7
_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash_encode(lat: float, lon: float, precision: int = GEOHASH_PRECISION) -> str:
    """Standard geohash (Niemeyer) of a WGS-84 point; `precision` characters of base32."""
    if not -90.0 <= lat <= 90.0:
        raise ValueError(f"latitude out of range: {lat}")
    if not -180.0 <= lon <= 180.0:
        raise ValueError(f"longitude out of range: {lon}")
    if precision < 1 or precision > 12:
        raise ValueError(f"precision must be 1..12, got {precision}")

    lat_lo, lat_hi = -90.0, 90.0
    lon_lo, lon_hi = -180.0, 180.0
    chars: list[str] = []
    bits = 0
    bit_count = 0
    even = True  # geohash interleaves longitude (even bits) and latitude (odd bits)
    while len(chars) < precision:
        if even:
            mid = (lon_lo + lon_hi) / 2.0
            if lon >= mid:
                bits = (bits << 1) | 1
                lon_lo = mid
            else:
                bits <<= 1
                lon_hi = mid
        else:
            mid = (lat_lo + lat_hi) / 2.0
            if lat >= mid:
                bits = (bits << 1) | 1
                lat_lo = mid
            else:
                bits <<= 1
                lat_hi = mid
        even = not even
        bit_count += 1
        if bit_count == 5:
            chars.append(_BASE32[bits])
            bits = 0
            bit_count = 0
    return "".join(chars)


def origin_geohash(lat: float | None, lon: float | None) -> str | None:
    """Precision-7 geohash for a batch origin, or None when either coordinate is missing."""
    if lat is None or lon is None:
        return None
    return geohash_encode(lat, lon, GEOHASH_PRECISION)


class BBox(NamedTuple):
    lat_min: float
    lon_min: float
    lat_max: float
    lon_max: float

    def contains(self, lat: float | None, lon: float | None) -> bool:
        if lat is None or lon is None:
            return False
        return self.lat_min <= lat <= self.lat_max and self.lon_min <= lon <= self.lon_max
