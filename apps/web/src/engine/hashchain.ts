/**
 * Quality Pass hash chain (contract §4) — the offline mirror of services/api/app/quality_pass.
 * Both sides must produce byte-identical payloads, so the canonical form is pinned here:
 *
 *   genesis   = sha256_hex("farmsignal:" + batch_id)
 *   payload   = {"batch_id":"…","geohash":null|"…","reading_id":"…","seq":N,"source":"…",
 *                "taken_at":"YYYY-MM-DDTHH:MM:SSZ","temp_c":D.D}      (sorted keys, no whitespace)
 *   hash      = sha256_hex(prev_hash + "|" + payload)
 *
 * temp_c is rounded to 1 dp and always printed with exactly one decimal ("28.0"); taken_at is UTC at
 * whole seconds. Uses crypto.subtle, which browsers expose only in secure contexts (https / localhost).
 */
import type { ChainVerifyResponse, ReadingSource } from '../types';
import { normalizeIso } from './time';

/** Fields that enter the canonical payload. */
export interface ChainPayloadInput {
  batch_id: string;
  reading_id: string;
  seq: number;
  temp_c: number;
  taken_at: string;
  source: ReadingSource;
  geohash?: string | null;
}

/** Reading shape accepted by computeChain — the wire Reading / ReadingCreate satisfy it (`id` = reading_id). */
export interface ChainReading {
  id: string;
  seq: number;
  temp_c: number;
  taken_at: string;
  source: ReadingSource;
  geohash?: string | null;
}

/** A reading carrying the hashes it was stored with (server-assigned or locally computed). */
export interface HashedChainReading extends ChainReading {
  hash: string;
  prev_hash: string;
}

export interface ComputedChain {
  /** hash per reading, in seq order */
  hashes: string[];
  /** prev_hash per reading, in seq order (genesis first) */
  prev_hashes: string[];
  /** last hash, or null for an empty chain */
  head: string | null;
}

/** Minimum number of leading hex chars a QR-carried head prefix must have to count as a match. */
export const HEAD_PREFIX_MIN = 16;

/** Round a temperature to 1 dp the way the chain stores it (mirrors Python round(x, 1) for 1-dp inputs). */
export function roundTemp(tempC: number): number {
  const r = Math.round(tempC * 10) / 10;
  return r === 0 ? 0 : r;
}

/** Canonical JSON payload string (keys sorted, no whitespace). Deterministic across languages. */
export function canonicalReadingPayload(r: ChainPayloadInput): string {
  if (!Number.isInteger(r.seq)) throw new Error(`seq must be an integer, got ${String(r.seq)}`);
  if (!Number.isFinite(r.temp_c)) throw new Error(`temp_c must be finite, got ${String(r.temp_c)}`);
  const geohash = r.geohash === null || r.geohash === undefined ? 'null' : JSON.stringify(r.geohash);
  return (
    `{"batch_id":${JSON.stringify(r.batch_id)}` +
    `,"geohash":${geohash}` +
    `,"reading_id":${JSON.stringify(r.reading_id)}` +
    `,"seq":${r.seq}` +
    `,"source":${JSON.stringify(r.source)}` +
    `,"taken_at":${JSON.stringify(normalizeIso(r.taken_at, 'taken_at'))}` +
    `,"temp_c":${roundTemp(r.temp_c).toFixed(1)}}`
  );
}

async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('crypto.subtle is unavailable (hash chain needs a secure context)');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** prev_hash for seq 1. */
export function genesisHash(batchId: string): Promise<string> {
  return sha256Hex(`farmsignal:${batchId}`);
}

/** hash = sha256_hex(prev_hash + "|" + payload). */
export function hashReading(prevHash: string, payload: string): Promise<string> {
  return sha256Hex(`${prevHash}|${payload}`);
}

/**
 * Recompute the whole chain for `readings` (ordered by seq; a copy is sorted defensively).
 * Uses the readings' own seq values verbatim — validate contiguity with verifyChain.
 */
export async function computeChain(batchId: string, readings: ChainReading[]): Promise<ComputedChain> {
  const ordered = [...readings].sort((a, b) => a.seq - b.seq);
  const hashes: string[] = [];
  const prevHashes: string[] = [];
  let prev = await genesisHash(batchId);
  for (const r of ordered) {
    const payload = canonicalReadingPayload({
      batch_id: batchId,
      reading_id: r.id,
      seq: r.seq,
      temp_c: r.temp_c,
      taken_at: r.taken_at,
      source: r.source,
      geohash: r.geohash,
    });
    const hash = await hashReading(prev, payload);
    prevHashes.push(prev);
    hashes.push(hash);
    prev = hash;
  }
  return { hashes, prev_hashes: prevHashes, head: hashes.length > 0 ? hashes[hashes.length - 1] : null };
}

/** Does a recomputed head match a full head or a QR prefix (≥ HEAD_PREFIX_MIN hex chars)? */
export function headMatches(head: string, expected: string): boolean {
  const e = expected.trim().toLowerCase();
  if (e.length === 0) return false;
  return e === head || (e.length >= HEAD_PREFIX_MIN && head.startsWith(e));
}

/**
 * Verify stored (prev_hash, hash) links against a fresh recomputation (contract §4 verify semantics).
 * - seq must run 1..n without gaps; each prev_hash must equal the previous recomputed hash; each hash
 *   must equal the recomputed hash. The first offending seq is reported in `first_bad_seq`.
 * - `chain_head` is always the *recomputed* head (genesis hash for an empty chain), so callers can
 *   compare it with the head printed on a QR. When `expectedHead` is given, `valid` also requires it
 *   to match (full hash or ≥16-char prefix).
 */
export async function verifyChain(
  batchId: string,
  readings: HashedChainReading[],
  expectedHead?: string,
): Promise<ChainVerifyResponse> {
  const ordered = [...readings].sort((a, b) => a.seq - b.seq);
  const recomputed = await computeChain(batchId, ordered);
  let firstBad: number | null = null;
  for (let i = 0; i < ordered.length; i += 1) {
    const r = ordered[i];
    const linkOk = r.seq === i + 1 && r.prev_hash === recomputed.prev_hashes[i] && r.hash === recomputed.hashes[i];
    if (!linkOk) {
      firstBad = r.seq;
      break;
    }
  }
  const head = recomputed.head ?? (await genesisHash(batchId));
  const headOk = expectedHead === undefined || headMatches(head, expectedHead);
  return { valid: firstBad === null && headOk, chain_head: head, length: ordered.length, first_bad_seq: firstBad };
}
