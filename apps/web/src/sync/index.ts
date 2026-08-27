/**
 * Offline outbox + sync loop (contract §7).
 * - enqueue()/nextClientSeq()/pendingCount()/subscribePending() live in db/outbox.ts (re-exported).
 * - drain(): POST pending ops (and failed ops whose backoff elapsed) in client_seq order, apply
 *   results, learn clock skew, merge the server's batches. Single in-flight drain; never throws.
 * - startSyncLoop(): `online`, foreground and a 60 s timer trigger drain(); returns stop().
 *
 * The Dexie outbox is the only durable retry queue (drained on open / `online` / every 60 s).
 * Workbox Background Sync is deliberately not used for /sync: a verbatim replay hours later would
 * carry a stale `client_now`, which the server's skew correction would misread and use to shift
 * every timestamp in the request.
 *
 * Clock skew: payload timestamps are produced with nowIso() (skew-corrected at enqueue time), so the
 * outbox records `skew_applied_seconds` per op and a drain sends one request per contiguous run of
 * equal skew with `client_now = Date.now() − skew`. The server then answers with the *residual*
 * skew, so the stored value becomes `run.skew + residual` (never the residual alone).
 */
import { api, ApiError, getToken, setToken } from '../api/client';
import { ensureDevice, getDeviceId } from '../api/auth';
import { notify } from '../alerts/toast';
import { db, META_KEYS, type OpRow } from '../db';
import { isDue, isRetryable, notifyPending } from '../db/outbox';
import { applyServerBatches, applyServerReading } from '../db/repo';
import i18n from '../i18n';
import { getClockSkewSeconds, setClockSkewSeconds } from './clock';
import type { Reading, SyncOp, SyncRequest, SyncResponse } from '../types';

export {
  enqueue,
  nextClientSeq,
  pendingCount,
  subscribePending,
  listExhaustedOps,
  discardOp,
  isRetryable,
  isExhausted,
  MAX_REJECT_ATTEMPTS,
} from '../db/outbox';
export { getClockSkewSeconds, loadClockSkew, nowIso, nowDate } from './clock';

export const SYNC_INTERVAL_MS = 60_000;
/** Ops acknowledged more than this long ago are pruned from the outbox. */
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Upper bound per drain so a huge backlog syncs in a few rounds instead of one giant POST. */
const MAX_OPS_PER_REQUEST = 200;
/** Server flags `clock_adjusted` above this (contract §7); the toast reports the skew in minutes. */
const CLOCK_ADJUST_THRESHOLD_S = 120;

let inflight: Promise<SyncResponse | null> | null = null;
let lastResult: SyncResponse | null = null;

function isOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine;
}

function isReading(entity: unknown): entity is Reading {
  return !!entity && typeof entity === 'object' && 'batch_id' in entity && 'seq' in entity && 'hash' in entity;
}

/** A 2xx body that is not a SyncResponse (captive-portal HTML, proxy error page) must not count as a sync. */
function isSyncResponse(value: unknown): value is SyncResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SyncResponse>;
  return Array.isArray(v.results) && typeof v.server_now === 'string';
}

function toWireOp(row: OpRow): SyncOp {
  const { status: _s, created_at: _c, attempts: _a, last_error: _l, last_attempt_at: _t, skew_applied_seconds: _k, ...op } = row;
  return op;
}

async function setOpStatus(ids: string[], patch: Partial<Pick<OpRow, 'status' | 'last_error'>>): Promise<void> {
  if (ids.length === 0) return;
  await db.ops.where('op_id').anyOf(ids).modify((row) => {
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.last_error !== undefined) row.last_error = patch.last_error;
  });
}

interface Run {
  /** Clock skew (whole seconds) the ops' timestamps were corrected with. */
  skew: number;
  ops: OpRow[];
}

/** Skew an op was enqueued under; rows from older builds lack the field and get the current skew. */
function opSkew(row: OpRow): number {
  const s = row.skew_applied_seconds;
  return Math.round(typeof s === 'number' && Number.isFinite(s) ? s : getClockSkewSeconds());
}

/**
 * Split client_seq-ordered ops into CONTIGUOUS runs of equal skew (skew only changes at sync time,
 * so runs are contiguous; grouping by value would reorder ops across requests and could deliver a
 * reading.append before its batch.create). An empty backlog is one empty run (the 60 s pull).
 */
export function splitRuns(rows: OpRow[]): Run[] {
  if (rows.length === 0) return [{ skew: Math.round(getClockSkewSeconds()), ops: [] }];
  const runs: Run[] = [];
  for (const row of rows) {
    const skew = opSkew(row);
    const last = runs[runs.length - 1];
    if (last && last.skew === skew) last.ops.push(row);
    else runs.push({ skew, ops: [row] });
  }
  return runs;
}

/** POST one run. Returns the response, or null when the request failed (ops already re-queued). */
async function sendRun(deviceId: string, run: Run, state: { toasted: boolean }): Promise<SyncResponse | null> {
  const ids = run.ops.map((r) => r.op_id);
  const attemptAt = new Date().toISOString();
  await db.ops.where('op_id').anyOf(ids).modify((row) => {
    row.status = 'inflight';
    row.attempts += 1;
    row.last_attempt_at = attemptAt;
  });
  void notifyPending();

  const request: SyncRequest = {
    device_id: deviceId,
    client_now: new Date(Date.now() - run.skew * 1000).toISOString(),
    ops: run.ops.map(toWireOp),
  };
  let raw: unknown;
  try {
    raw = await api.post<unknown>('/sync', request, { timeoutMs: 20_000 });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // Token expired / server reset: forget it and re-authenticate on the next drain.
      setToken(null);
      await setOpStatus(ids, { status: 'pending', last_error: 'unauthorized' });
    } else if (err instanceof ApiError && err.status > 0 && err.status < 500 && err.status !== 429) {
      // Whole request rejected (validation) — keep the ops but surface the error (backoff applies).
      await setOpStatus(ids, { status: 'failed', last_error: err.message });
    } else {
      await setOpStatus(ids, { status: 'pending' });
    }
    void notifyPending();
    return null;
  }
  if (!isSyncResponse(raw)) {
    // 200 with a non-JSON / wrong-shape body: treat like a network failure — nothing was synced.
    await setOpStatus(ids, { status: 'pending' });
    void notifyPending();
    return null;
  }
  const response = raw;

  const seen = new Set<string>();
  const done: string[] = [];
  let clockAdjusted = false;
  for (const r of response.results) {
    seen.add(r.op_id);
    if (r.clock_adjusted) clockAdjusted = true;
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

  if (typeof response.clock_skew_seconds === 'number' && Number.isFinite(response.clock_skew_seconds)) {
    // The server measured the residual against our already-corrected client_now: accumulate.
    const total = run.skew + response.clock_skew_seconds;
    await setClockSkewSeconds(total);
    if (clockAdjusted && !state.toasted) {
      state.toasted = true;
      const minutes = Math.max(1, Math.round(Math.max(Math.abs(total), CLOCK_ADJUST_THRESHOLD_S) / 60));
      notify.info(i18n.t('clock_adjusted', { ns: 'common', minutes }));
    }
  }
  await db.setMeta(META_KEYS.lastSyncAt, response.server_now);
  try {
    await applyServerBatches(Array.isArray(response.batches) ? response.batches : []);
  } catch (err) {
    console.warn('[sync] failed to merge server batches', err);
  }
  return response;
}

async function doDrain(): Promise<SyncResponse | null> {
  if (!isOnline()) return null;
  if (!getToken() || (await displayNameDirty())) await ensureDevice();
  const token = getToken();
  if (!token) return null;
  const deviceId = (await getDeviceId()) ?? (await ensureDevice()).deviceId;
  if (!deviceId) return null;

  // Ops left `inflight` by a page that died mid-request (tab closed, SW reload) are ours to retry:
  // the drain is single-flight, so nothing else can own them now.
  await db.ops.where('status').equals('inflight').modify({ status: 'pending' });

  const now = Date.now();
  const rows = await db.ops
    .where('status')
    .anyOf('pending', 'failed')
    .filter((row) => isRetryable(row) && isDue(row, now))
    .sortBy('client_seq');
  const runs = splitRuns(rows.slice(0, MAX_OPS_PER_REQUEST));

  const state = { toasted: false };
  let last: SyncResponse | null = null;
  for (const run of runs) {
    const response = await sendRun(deviceId, run, state);
    // A failed run leaves the later runs untouched (still pending) and ends this drain.
    if (!response) break;
    last = response;
  }
  if (!last) {
    await notifyPending();
    return null;
  }

  // Housekeeping: prune old acknowledged ops.
  const cutoff = new Date(Date.now() - DONE_RETENTION_MS).toISOString();
  await db.ops.where('status').equals('done').and((row) => row.created_at < cutoff).delete();

  await notifyPending();
  lastResult = last;
  return last;
}

async function displayNameDirty(): Promise<boolean> {
  try {
    return (await db.getMeta<boolean>(META_KEYS.displayNameDirty)) === true;
  } catch {
    return false;
  }
}

/**
 * POST pending ops (in client_seq order) to /sync, apply results, store clock skew, upsert batches.
 * Returns the last successful server response, or null when offline / not authenticated / the
 * request failed. Concurrent callers share the in-flight drain.
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
