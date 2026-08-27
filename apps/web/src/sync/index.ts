/**
 * Offline outbox + sync loop (contract §7).
 * - enqueue()/nextClientSeq()/pendingCount()/subscribePending() live in db/outbox.ts (re-exported).
 * - drain(): POST pending/failed ops in client_seq order, apply results, learn clock skew, merge the
 *   server's batches. Single in-flight drain; never throws.
 * - startSyncLoop(): `online`, foreground and a 60 s timer trigger drain(); returns stop().
 */
import { api, ApiError, getToken, setToken } from '../api/client';
import { ensureDevice, getDeviceId } from '../api/auth';
import { db, META_KEYS, type OpRow } from '../db';
import { notifyPending } from '../db/outbox';
import { applyServerBatches, applyServerReading } from '../db/repo';
import { nowIso, setClockSkewSeconds } from './clock';
import type { Reading, SyncOp, SyncRequest, SyncResponse } from '../types';

export { enqueue, nextClientSeq, pendingCount, subscribePending } from '../db/outbox';
export { getClockSkewSeconds, loadClockSkew, nowIso, nowDate } from './clock';

export const SYNC_INTERVAL_MS = 60_000;
/** Ops acknowledged more than this long ago are pruned from the outbox. */
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Upper bound per request so a huge backlog syncs in a few rounds instead of one giant POST. */
const MAX_OPS_PER_REQUEST = 200;

let inflight: Promise<SyncResponse | null> | null = null;
let lastResult: SyncResponse | null = null;

function isOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine;
}

function isReading(entity: unknown): entity is Reading {
  return !!entity && typeof entity === 'object' && 'batch_id' in entity && 'seq' in entity && 'hash' in entity;
}

function toWireOp(row: OpRow): SyncOp {
  const { status: _s, created_at: _c, attempts: _a, last_error: _l, ...op } = row;
  return op;
}

async function setOpStatus(ids: string[], patch: Partial<Pick<OpRow, 'status' | 'last_error'>>): Promise<void> {
  if (ids.length === 0) return;
  await db.ops.where('op_id').anyOf(ids).modify((row) => {
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.last_error !== undefined) row.last_error = patch.last_error;
  });
}

async function doDrain(): Promise<SyncResponse | null> {
  if (!isOnline()) return null;
  if (!getToken()) await ensureDevice();
  const token = getToken();
  if (!token) return null;
  const deviceId = (await getDeviceId()) ?? (await ensureDevice()).deviceId;
  if (!deviceId) return null;

  const rows = await db.ops.where('status').anyOf('pending', 'failed').sortBy('client_seq');
  const batch = rows.slice(0, MAX_OPS_PER_REQUEST);
  const ids = batch.map((r) => r.op_id);
  await db.ops.where('op_id').anyOf(ids).modify((row) => {
    row.status = 'inflight';
    row.attempts += 1;
  });
  void notifyPending();

  const request: SyncRequest = { device_id: deviceId, client_now: nowIso(), ops: batch.map(toWireOp) };
  let response: SyncResponse;
  try {
    response = await api.post<SyncResponse>('/sync', request, { timeoutMs: 20_000 });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // Token expired / server reset: forget it and re-authenticate on the next drain.
      setToken(null);
      await setOpStatus(ids, { status: 'pending', last_error: 'unauthorized' });
    } else if (err instanceof ApiError && err.status > 0 && err.status < 500 && err.status !== 429) {
      // Whole request rejected (validation) — keep the ops but surface the error.
      await setOpStatus(ids, { status: 'failed', last_error: err.message });
    } else {
      await setOpStatus(ids, { status: 'pending' });
    }
    void notifyPending();
    return null;
  }

  const seen = new Set<string>();
  const done: string[] = [];
  const results = Array.isArray(response.results) ? response.results : [];
  for (const r of results) {
    seen.add(r.op_id);
    if (r.status === 'applied' || r.status === 'duplicate') done.push(r.op_id);
    else await setOpStatus([r.op_id], { status: 'failed', last_error: r.error ?? r.status });
    if (r.status === 'applied' && isReading(r.entity)) {
      try {
        await applyServerReading(r.entity);
      } catch {
        /* the batch merge below carries the same data */
      }
    }
  }
  await setOpStatus(done, { status: 'done', last_error: null });
  // Ops the server did not answer for (should not happen) go back to pending.
  await setOpStatus(
    ids.filter((id) => !seen.has(id)),
    { status: 'pending' },
  );

  if (typeof response.clock_skew_seconds === 'number') await setClockSkewSeconds(response.clock_skew_seconds);
  await db.setMeta(META_KEYS.lastSyncAt, response.server_now ?? nowIso());
  try {
    await applyServerBatches(Array.isArray(response.batches) ? response.batches : []);
  } catch (err) {
    console.warn('[sync] failed to merge server batches', err);
  }

  // Housekeeping: prune old acknowledged ops.
  const cutoff = new Date(Date.now() - DONE_RETENTION_MS).toISOString();
  await db.ops.where('status').equals('done').and((row) => row.created_at < cutoff).delete();

  await notifyPending();
  lastResult = response;
  return response;
}

/**
 * POST pending ops (in client_seq order) to /sync, apply results, store clock skew, upsert batches.
 * Returns the server response, or null when offline / not authenticated / the request failed.
 * Concurrent callers share the in-flight drain.
 */
export function drain(): Promise<SyncResponse | null> {
  if (inflight) return inflight;
  inflight = doDrain()
    .catch((err: unknown) => {
      console.warn('[sync] drain failed', err);
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** True while a drain is running (for a "Syncing…" hint). */
export function isDraining(): boolean {
  return inflight !== null;
}

/** The most recent successful /sync response (in-memory only). */
export function getLastSyncResult(): SyncResponse | null {
  return lastResult;
}

export async function getLastSyncAt(): Promise<string | null> {
  const v = await db.getMeta<string>(META_KEYS.lastSyncAt);
  return typeof v === 'string' ? v : null;
}

/**
 * Trigger points: `online` event, app foreground (visibilitychange → visible), every 60 s while
 * online, plus one immediate drain. Returns a stop function. Safe to call in non-browser contexts.
 */
export function startSyncLoop(opts: { intervalMs?: number; immediate?: boolean } = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const intervalMs = opts.intervalMs ?? SYNC_INTERVAL_MS;
  const tick = () => {
    if (isOnline()) void drain();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') tick();
  };
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', onVisibility);
  const timer = window.setInterval(tick, intervalMs);
  if (opts.immediate ?? true) tick();
  return () => {
    window.removeEventListener('online', tick);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(timer);
  };
}
