/**
 * Hash chain tests (contract §4). The pinned vectors below were computed independently with
 * node:crypto createHash; the Python implementation must reproduce them byte for byte.
 */
import { createHash, webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Reading } from '../types';
import {
  canonicalReadingPayload,
  computeChain,
  genesisHash,
  hashReading,
  headMatches,
  roundTemp,
  verifyChain,
  type HashedChainReading,
} from './hashchain';

// jsdom may not expose SubtleCrypto; polyfill from Node's webcrypto for this file only.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const BATCH = '6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';

/** Pinned cross-language vectors (see report). */
const VECTORS = {
  genesis: '6b1a79d4f77f56686e4d2824ac9bff0dd3e3ab1cbf4a5fb01f2ceab1feb5f192',
  payload1:
    '{"batch_id":"6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01","geohash":null,"reading_id":"11111111-1111-4111-8111-111111111111","seq":1,"source":"manual","taken_at":"2026-08-27T06:30:00Z","temp_c":28.0}',
  hash1: 'a23ebd7d0c22a337e33a7b05f60aad7f32d7933a76c0730dcc08cd2711e6d5d7',
  payload2:
    '{"batch_id":"6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01","geohash":"tdr1y","reading_id":"22222222-2222-4222-8222-222222222222","seq":2,"source":"sim","taken_at":"2026-08-27T07:30:00Z","temp_c":31.5}',
  hash2: 'ee7fe3dc52817ec948c8a874ea9f01b749e6cd6e22b67da80a05359a84c6d144',
} as const;

const nodeSha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function wireReading(overrides: Partial<Reading> & Pick<Reading, 'id' | 'seq' | 'temp_c' | 'taken_at' | 'source'>): Reading {
  return {
    batch_id: BATCH,
    client_seq: overrides.seq,
    geohash: null,
    hash: '',
    prev_hash: '',
    received_at: overrides.taken_at,
    ...overrides,
  };
}

const READINGS: Reading[] = [
  wireReading({ id: R1, seq: 1, temp_c: 28, taken_at: '2026-08-27T06:30:00Z', source: 'manual' }),
  wireReading({ id: R2, seq: 2, temp_c: 31.5, taken_at: '2026-08-27T07:30:00Z', source: 'sim', geohash: 'tdr1y' }),
  wireReading({ id: R3, seq: 3, temp_c: 33.04, taken_at: '2026-08-27T08:30:00.400+00:00', source: 'ble' }),
];

async function signed(readings: Reading[]): Promise<HashedChainReading[]> {
  const chain = await computeChain(BATCH, readings);
  return readings.map((r, i) => ({ ...r, hash: chain.hashes[i], prev_hash: chain.prev_hashes[i] }));
}

// ---------------------------------------------------------------------------

describe('canonicalReadingPayload', () => {
  it('matches the pinned canonical form (sorted keys, no whitespace, null geohash, 1-dp temp)', () => {
    expect(
      canonicalReadingPayload({ batch_id: BATCH, reading_id: R1, seq: 1, temp_c: 28, taken_at: '2026-08-27T06:30:00Z', source: 'manual', geohash: null }),
    ).toBe(VECTORS.payload1);
    expect(
      canonicalReadingPayload({ batch_id: BATCH, reading_id: R2, seq: 2, temp_c: 31.5, taken_at: '2026-08-27T07:30:00Z', source: 'sim', geohash: 'tdr1y' }),
    ).toBe(VECTORS.payload2);
  });

  it('is valid JSON whose keys are in sorted order', () => {
    const parsed = JSON.parse(VECTORS.payload2) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['batch_id', 'geohash', 'reading_id', 'seq', 'source', 'taken_at', 'temp_c']);
    expect(parsed.temp_c).toBe(31.5);
  });

  it('formats temp_c with exactly one decimal after rounding to 1 dp', () => {
    const payload = (t: number): string =>
      canonicalReadingPayload({ batch_id: BATCH, reading_id: R1, seq: 1, temp_c: t, taken_at: '2026-08-27T06:30:00Z', source: 'manual' });
    expect(payload(28)).toContain('"temp_c":28.0}');
    expect(payload(31.54)).toContain('"temp_c":31.5}');
    expect(payload(31.55)).toContain('"temp_c":31.6}');
    expect(payload(-1)).toContain('"temp_c":-1.0}');
    expect(payload(-0.04)).toContain('"temp_c":0.0}');
    expect(roundTemp(28.04)).toBe(28);
  });

  it('normalises taken_at to seconds-precision UTC (offsets and milliseconds)', () => {
    const p = canonicalReadingPayload({
      batch_id: BATCH,
      reading_id: R1,
      seq: 1,
      temp_c: 28,
      taken_at: '2026-08-27T12:00:00.750+05:30',
      source: 'manual',
    });
    expect(p).toContain('"taken_at":"2026-08-27T06:30:00Z"');
  });

  it('treats an undefined geohash as null and escapes strings', () => {
    const p = canonicalReadingPayload({ batch_id: BATCH, reading_id: R1, seq: 1, temp_c: 28, taken_at: '2026-08-27T06:30:00Z', source: 'manual' });
    expect(p).toContain('"geohash":null');
    const q = canonicalReadingPayload({ batch_id: BATCH, reading_id: R1, seq: 1, temp_c: 28, taken_at: '2026-08-27T06:30:00Z', source: 'manual', geohash: 'a"b' });
    expect(q).toContain('"geohash":"a\\"b"');
  });

  it('rejects non-integer seq and non-finite temperatures', () => {
    expect(() => canonicalReadingPayload({ batch_id: BATCH, reading_id: R1, seq: 1.5, temp_c: 28, taken_at: '2026-08-27T06:30:00Z', source: 'manual' })).toThrow(/seq/);
    expect(() => canonicalReadingPayload({ batch_id: BATCH, reading_id: R1, seq: 1, temp_c: Number.NaN, taken_at: '2026-08-27T06:30:00Z', source: 'manual' })).toThrow(/temp_c/);
  });
});

describe('hashes (crypto.subtle) match node:crypto and the pinned vectors', () => {
  it('genesis = sha256("farmsignal:" + batch_id)', async () => {
    const g = await genesisHash(BATCH);
    expect(g).toBe(VECTORS.genesis);
    expect(g).toBe(nodeSha256(`farmsignal:${BATCH}`));
    expect(g).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash = sha256(prev_hash + "|" + payload)', async () => {
    const h1 = await hashReading(VECTORS.genesis, VECTORS.payload1);
    expect(h1).toBe(VECTORS.hash1);
    expect(h1).toBe(nodeSha256(`${VECTORS.genesis}|${VECTORS.payload1}`));
    const h2 = await hashReading(h1, VECTORS.payload2);
    expect(h2).toBe(VECTORS.hash2);
  });
});

describe('computeChain', () => {
  it('links readings in seq order from the genesis hash', async () => {
    const chain = await computeChain(BATCH, READINGS);
    expect(chain.hashes).toHaveLength(3);
    expect(chain.prev_hashes[0]).toBe(VECTORS.genesis);
    expect(chain.hashes[0]).toBe(VECTORS.hash1);
    expect(chain.prev_hashes[1]).toBe(VECTORS.hash1);
    expect(chain.hashes[1]).toBe(VECTORS.hash2);
    expect(chain.prev_hashes[2]).toBe(VECTORS.hash2);
    expect(chain.head).toBe(chain.hashes[2]);
    // Third reading: 33.04 -> 33.0, taken_at ms stripped.
    const payload3 = `{"batch_id":"${BATCH}","geohash":null,"reading_id":"${R3}","seq":3,"source":"ble","taken_at":"2026-08-27T08:30:00Z","temp_c":33.0}`;
    expect(chain.hashes[2]).toBe(nodeSha256(`${VECTORS.hash2}|${payload3}`));
  });

  it('is order-independent on input (sorts by seq) and returns null head for no readings', async () => {
    const shuffled = [READINGS[2], READINGS[0], READINGS[1]];
    expect(await computeChain(BATCH, shuffled)).toEqual(await computeChain(BATCH, READINGS));
    expect(await computeChain(BATCH, [])).toEqual({ hashes: [], prev_hashes: [], head: null });
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain', async () => {
    const stored = await signed(READINGS);
    const res = await verifyChain(BATCH, stored);
    expect(res).toEqual({ valid: true, chain_head: stored[2].hash, length: 3, first_bad_seq: null });
  });

  it('flags the first tampered reading (temperature edited after the fact)', async () => {
    const stored = await signed(READINGS);
    stored[1] = { ...stored[1], temp_c: 29.5 };
    const res = await verifyChain(BATCH, stored);
    expect(res.valid).toBe(false);
    expect(res.first_bad_seq).toBe(2);
    expect(res.length).toBe(3);
    // chain_head is the recomputed head over the (tampered) payloads, so it no longer matches the stored one.
    expect(res.chain_head).not.toBe(stored[2].hash);
  });

  it('flags a broken prev_hash link, a seq gap, and a deleted reading', async () => {
    const stored = await signed(READINGS);
    const brokenLink = stored.map((r, i) => (i === 2 ? { ...r, prev_hash: VECTORS.genesis } : r));
    expect((await verifyChain(BATCH, brokenLink)).first_bad_seq).toBe(3);

    const gap = stored.map((r, i) => (i === 2 ? { ...r, seq: 4 } : r));
    expect((await verifyChain(BATCH, gap)).first_bad_seq).toBe(4);

    const deleted = [stored[0], stored[2]];
    const res = await verifyChain(BATCH, deleted);
    expect(res.valid).toBe(false);
    expect(res.first_bad_seq).toBe(3);
    expect(res.length).toBe(2);
  });

  it('an empty chain is valid with the genesis hash as head', async () => {
    expect(await verifyChain(BATCH, [])).toEqual({ valid: true, chain_head: VECTORS.genesis, length: 0, first_bad_seq: null });
  });

  it('checks an expected head (full hash or the 16-char QR prefix)', async () => {
    const stored = await signed(READINGS);
    const head = stored[2].hash;
    expect((await verifyChain(BATCH, stored, head)).valid).toBe(true);
    expect((await verifyChain(BATCH, stored, head.slice(0, 16))).valid).toBe(true);
    expect((await verifyChain(BATCH, stored, head.slice(0, 16).toUpperCase())).valid).toBe(true);
    expect((await verifyChain(BATCH, stored, VECTORS.hash1.slice(0, 16))).valid).toBe(false);
    expect((await verifyChain(BATCH, stored, head.slice(0, 8))).valid).toBe(false);
    expect(headMatches(head, '')).toBe(false);
  });

  it('a chain for a different batch id does not verify', async () => {
    const stored = await signed(READINGS);
    const res = await verifyChain('00000000-0000-4000-8000-000000000000', stored);
    expect(res.valid).toBe(false);
    expect(res.first_bad_seq).toBe(1);
  });
});
