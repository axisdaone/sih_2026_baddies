/**
 * Tiny pure geohash encoder (Niemeyer base32). Precision 7 ≈ 150 m cells — enough to tag where a
 * reading was taken without storing a raw GPS fix (contract §5 `readings.geohash`).
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export const DEFAULT_GEOHASH_PRECISION = 7;

export function encodeGeohash(lat: number, lon: number, precision: number = DEFAULT_GEOHASH_PRECISION): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new RangeError('geohash: lat/lon must be finite');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new RangeError('geohash: lat/lon out of range');
  const length = Math.max(1, Math.min(12, Math.floor(precision)));

  let latLo = -90;
  let latHi = 90;
  let lonLo = -180;
  let lonHi = 180;
  let hash = '';
  let bits = 0;
  let bitCount = 0;
  let evenBit = true; // alternate longitude (even) / latitude (odd) bits

  while (hash.length < length) {
    if (evenBit) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) {
        bits = bits * 2 + 1;
        lonLo = mid;
      } else {
        bits *= 2;
        lonHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        bits = bits * 2 + 1;
        latLo = mid;
      } else {
        bits *= 2;
        latHi = mid;
      }
    }
    evenBit = !evenBit;
    bitCount += 1;
    if (bitCount === 5) {
      hash += BASE32[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

/** Decode to the cell centre (used only for tests / display). */
export function decodeGeohash(hash: string): { lat: number; lon: number } {
  let latLo = -90;
  let latHi = 90;
  let lonLo = -180;
  let lonHi = 180;
  let evenBit = true;
  for (const ch of hash.toLowerCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new RangeError(`geohash: invalid character "${ch}"`);
    for (let n = 4; n >= 0; n -= 1) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lonLo + lonHi) / 2;
        if (bit) lonLo = mid;
        else lonHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (bit) latLo = mid;
        else latHi = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latLo + latHi) / 2, lon: (lonLo + lonHi) / 2 };
}
