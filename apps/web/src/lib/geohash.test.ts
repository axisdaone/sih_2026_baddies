import { describe, expect, it } from 'vitest';
import { decodeGeohash, encodeGeohash } from './geohash';

describe('geohash', () => {
  it('matches the reference value from the geohash spec', () => {
    // Wikipedia example: 42.605, -5.603 -> "ezs42"
    expect(encodeGeohash(42.605, -5.603, 5)).toBe('ezs42');
  });

  it('encodes precision 7 by default and round-trips within the cell', () => {
    const hash = encodeGeohash(12.3, 78.07);
    expect(hash).toHaveLength(7);
    const back = decodeGeohash(hash);
    // 7 chars ≈ 153 m × 153 m cell -> < 0.002° error
    expect(Math.abs(back.lat - 12.3)).toBeLessThan(0.002);
    expect(Math.abs(back.lon - 78.07)).toBeLessThan(0.002);
  });

  it('rejects invalid coordinates', () => {
    expect(() => encodeGeohash(Number.NaN, 0)).toThrow(RangeError);
    expect(() => encodeGeohash(91, 0)).toThrow(RangeError);
  });
});
