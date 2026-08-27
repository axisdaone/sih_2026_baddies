/**
 * Outbox primitives (contract §7): monotonic client_seq + enqueue, plus the retry policy shared by
 * the drain loop, the pending badge and the server merge. Lives under db/ (not sync/) so db/repo.ts
 * can enqueue without importing the sync loop (which imports repo — avoids a cycle).
 * sync/index.ts re-exports these for callers.
 */
import { db, META_KEYS, type OpRow } from './index';
import { getClockSkewSeconds } from '../sync/clock';
import type { SyncOp } from '../types';

type PendingListener = (count: number) => void;
const pendingListeners = new Set<PendingListener>();

/**
 * Retry policy for server-rejected ops (status `failed`): exponential backoff from the last attempt
 * (2^attempts × 1 min, capped at 1 h) and a hard cap on attempts. A `failed` op with
 * `attempts >= MAX_REJECT_ATTEMPTS` is terminal — it is never re-sent, drops off the pending badge
 * and no longer keeps its batch `synced: false`; Settings lists it so the farmer can discard it.
 * (The contract's `pending|inflight|done|failed` status set is unchanged.)
 */
export const MAX_REJECT_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Delay before a `failed` op with `attempts` attempts may be re-sent. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts) * BACKOFF_BASE_MS, BACKOFF_MAX_MS);
}

/** True while the op still counts as "needs to reach the server" (pending, inflight, or failed under the cap). */
export function isRetryable(row: Pick<OpRow, 'status' | 'attempts'>): boolean {
  if (row.status === 'done') return false;
  if (row.status === 'failed') return row.attempts < MAX_REJECT_ATTEMPTS;
  return true;
}

/** True when a retryable op may be sent now (pending ops always; failed ops once their backoff elapsed). */
export function isDue(row: Pick<OpRow, 'status' | 'attempts' | 'last_attempt_at'>, now: number = Date.now()): boolean {
  if (row.status !== 'failed') return true;
  if (!row.last_attempt_at) return true;
  const last = Date.parse(row.last_attempt_at);
  if (!Number.isFinite(last)) return true;
  return now - last >= backoffMs(row.attempts);
}

/** Terminal (exhausted) rejected op: shown in Settings, never re-sent. */
export function isExhausted(row: Pick<OpRow, 'status' | 'attempts'>): boolean {
  return row.status === 'failed' && row.attempts >= MAX_REJECT_ATTEMPTS;
}

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
  return db.ops.where('status').anyOf('pending', 'inflight', 'failed').filter(isRetryable).count();
}

/** Exhausted rejected ops (terminal), oldest first — Settings lists them with a Discard button. */
export async function listExhaustedOps(): Promise<OpRow[]> {
  const rows = await db.ops.where('status').equals('failed').filter(isExhausted).toArray();
  return rows.sort((a, b) => a.client_seq - b.client_seq);
}

/** Delete an op the farmer gave up on and refresh the badge. */
export async function discardOp(opId: string): Promise<void> {
  await db.ops.delete(opId);
  await notifyPending();
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

/**
 * Append an op to the outbox (status "pending"). Idempotent on op_id. Records the clock skew the
 * payload timestamps were produced with (repo.ts uses nowIso()) so the drain can send a matching
 * `client_now` even if the skew is re-learned before the op leaves the device.
 */
export async function enqueue(op: SyncOp): Promise<OpRow> {
  const row: OpRow = {
    ...op,
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
    last_attempt_at: null,
    skew_applied_seconds: getClockSkewSeconds(),
  };
  await db.ops.put(row);
  void notifyPending();
  return row;
}
