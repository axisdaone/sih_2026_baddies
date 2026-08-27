/**
 * Outbox primitives (contract §7): monotonic client_seq + enqueue. Lives under db/ (not sync/) so
 * db/repo.ts can enqueue without importing the sync loop (which imports repo — avoids a cycle).
 * sync/index.ts re-exports these for callers.
 */
import { db, META_KEYS, type OpRow } from './index';
import type { SyncOp } from '../types';

type PendingListener = (count: number) => void;
const pendingListeners = new Set<PendingListener>();

/** Allocate the next monotonic per-device client_seq (stored in meta). */
export async function nextClientSeq(): Promise<number> {
  return db.transaction('rw', db.meta, async () => {
    const current = (await db.getMeta<number>(META_KEYS.clientSeq)) ?? 0;
    const next = current + 1;
    await db.setMeta(META_KEYS.clientSeq, next);
    return next;
  });
}

/** Ops that still need to reach the server (for the top-bar badge via AppStatusContext). */
export async function pendingCount(): Promise<number> {
  return db.ops.where('status').anyOf('pending', 'inflight', 'failed').count();
}

/**
 * Subscribe to pending-count changes (fired after every enqueue and drain). The callback is invoked
 * immediately with the current count. Returns an unsubscribe function.
 */
export function subscribePending(cb: PendingListener): () => void {
  pendingListeners.add(cb);
  void pendingCount().then((n) => {
    if (pendingListeners.has(cb)) cb(n);
  });
  return () => {
    pendingListeners.delete(cb);
  };
}

/** Recount and notify subscribers. Never throws. */
export async function notifyPending(): Promise<number> {
  let n = 0;
  try {
    n = await pendingCount();
  } catch {
    return 0;
  }
  pendingListeners.forEach((cb) => {
    try {
      cb(n);
    } catch {
      /* listener errors must not break the outbox */
    }
  });
  return n;
}

/** Append an op to the outbox (status "pending"). Idempotent on op_id. */
export async function enqueue(op: SyncOp): Promise<OpRow> {
  const row: OpRow = { ...op, status: 'pending', created_at: new Date().toISOString(), attempts: 0, last_error: null };
  await db.ops.put(row);
  void notifyPending();
  return row;
}
