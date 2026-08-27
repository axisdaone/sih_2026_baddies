/**
 * Thin adapter over engine/hashchain (contract §4) for the Quality Pass page: builds full Reading
 * objects from local Dexie rows so the engine gets exactly the fields the canonical payload needs
 * ({batch_id, reading_id, seq, temp_c, taken_at, source, geohash}).
 */
import { computeChain, verifyChain } from '@/engine/hashchain';
import type { ReadingRow } from '@/db';
import type { ChainVerifyResponse, Reading } from '@/types';

/** Local rows ordered by seq (server-assigned) and, for unsynced rows, by taken_at after them. */
export function orderReadings(rows: ReadingRow[]): ReadingRow[] {
  return [...rows].sort((a, b) => {
    const sa = a.seq ?? Number.POSITIVE_INFINITY;
    const sb = b.seq ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return a.taken_at.localeCompare(b.taken_at);
  });
}

/** True when every row carries a server hash (only then can the chain be verified offline). */
export function allSynced(rows: ReadingRow[]): boolean {
  return rows.length > 0 && rows.every((r) => typeof r.hash === 'string' && r.hash.length > 0 && typeof r.seq === 'number');
}

/** Promote local rows to the wire Reading shape; missing seq is assigned positionally (offline copy). */
export function toWireReadings(rows: ReadingRow[]): Reading[] {
  return orderReadings(rows).map((r, i) => ({
    id: r.id,
    batch_id: r.batch_id,
    temp_c: r.temp_c,
    taken_at: r.taken_at,
    source: r.source,
    geohash: r.geohash ?? null,
    client_seq: r.client_seq,
    seq: r.seq ?? i + 1,
    hash: r.hash ?? '',
    prev_hash: r.prev_hash ?? '',
    received_at: r.received_at ?? r.taken_at,
  }));
}

/** Chain head recomputed on this device (null for an empty chain or on engine failure). */
export async function localChainHead(batchId: string, rows: ReadingRow[]): Promise<string | null> {
  if (rows.length === 0) return null;
  try {
    const { head } = await computeChain(batchId, toWireReadings(rows));
    return head;
  } catch {
    return null;
  }
}

/** Offline verification of server-hashed rows. Throws if the engine is unavailable. */
export async function localVerify(batchId: string, rows: ReadingRow[]): Promise<ChainVerifyResponse> {
  return verifyChain(batchId, toWireReadings(rows));
}

/** First 16 hex chars, as printed on the QR (contract §4). */
export function shortHead(head: string | null | undefined): string | null {
  return head ? head.slice(0, 16) : null;
}
