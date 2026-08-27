/**
 * Offline outbox + sync loop (contract §7).
 * enqueue() is real (writes the outbox row); drain()/startSyncLoop() are PHASE2 stubs.
 */
import { db, META_KEYS, type OpRow } from '../db';
import type { SyncOp, SyncResponse } from '../types';

/** Allocate the next monotonic per-device client_seq (stored in meta). */
export async function nextClientSeq(): Promise<number> {
  return db.transaction('rw', db.meta, async () => {
    const current = (await db.getMeta<number>(META_KEYS.clientSeq)) ?? 0;
    const next = current + 1;
    await db.setMeta(META_KEYS.clientSeq, next);
    return next;
  });
}

/** Append an op to the outbox (status "pending"). Idempotent on op_id. */
export async function enqueue(op: SyncOp): Promise<OpRow> {
  const row: OpRow = { ...op, status: 'pending', created_at: new Date().toISOString(), attempts: 0, last_error: null };
  await db.ops.put(row);
  return row;
}

/** Ops that still need to reach the server (for the top-bar badge via AppStatusContext). */
export async function pendingCount(): Promise<number> {
  return db.ops.where('status').anyOf('pending', 'inflight', 'failed').count();
}

/**
 * POST pending ops (in client_seq order) to /sync, apply results, store clock skew, upsert batches.
 * Returns the server response, or null when offline / nothing to send.
 * PHASE2: implemented by the sync agent.
 */
export async function drain(): Promise<SyncResponse | null> {
  return null;
}

/**
 * Trigger points: `online` event, app foreground (visibilitychange), every 60 s while online.
 * Returns a stop function.
 * PHASE2: implemented by the sync agent.
 */
export function startSyncLoop(): () => void {
  return () => undefined;
}
