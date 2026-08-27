import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken, TOKEN_KEY } from '../api/client';
import { clearToasts, useToasts } from '../alerts/toast';
import { db, META_KEYS } from '../db';
import { MAX_REJECT_ATTEMPTS, backoffMs, isRetryable } from '../db/outbox';
import { addReadingLocal, createBatchLocal } from '../db/repo';
import { drain, enqueue, getClockSkewSeconds, nowIso, pendingCount, subscribePending } from './index';
import { _resetClockForTests, setClockSkewSeconds } from './clock';
import type { Batch, SyncRequest, SyncResponse } from '../types';
import { renderHook } from '@testing-library/react';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

function requestBody(call: number): SyncRequest {
  const c = fetchMock.mock.calls[call];
  if (!c) throw new Error(`fetch call ${call} missing`);
  return JSON.parse(String(c[1]?.body)) as SyncRequest;
}

function lastRequestBody(): SyncRequest {
  return requestBody(fetchMock.mock.calls.length - 1);
}

/** Server whose clock is `deviceAheadS` behind the device: skew = client_now − server_now. */
function fakeServer(deviceAheadS: number, results: (req: SyncRequest) => SyncResponse['results'] = () => []) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as SyncRequest;
    const serverNow = Date.now() - deviceAheadS * 1000;
    const skew = (Date.parse(req.client_now) - serverNow) / 1000;
    return json({ server_now: new Date(serverNow).toISOString(), clock_skew_seconds: skew, results: results(req), batches: [] });
  };
}

const input = { crop: 'tomato' as const, qty_kg: 100, harvested_at: '2026-08-27T03:00:00Z', origin_lat: 12.3, origin_lon: 78.07 };

describe('sync/drain', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    await Promise.all([db.batches.clear(), db.readings.clear(), db.ops.clear(), db.meta.clear()]);
    _resetClockForTests();
    clearToasts();
    localStorage.removeItem(TOKEN_KEY);
    setOnline(true);
    await db.setMeta(META_KEYS.deviceId, 'device-test-0001');
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setOnline(true);
  });

  it('returns null when offline without touching the network', async () => {
    await createBatchLocal(input);
    setOnline(false);
    expect(await drain()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await pendingCount()).toBe(1);
  });

  it('returns null when no token can be obtained (auth fails) and keeps ops pending', async () => {
    setToken(null);
    fetchMock.mockResolvedValue(json({ detail: 'nope' }, 503));
    await createBatchLocal(input);
    expect(await drain()).toBeNull();
    // only the auth attempt went out
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/device$/);
    expect((await db.ops.toArray())[0].status).toBe('pending');
  });

  it('posts ops in client_seq order, marks applied/duplicate done and rejected failed, merges batches, stores skew', async () => {
    const batch = await createBatchLocal(input); // client_seq 1
    const reading = await addReadingLocal(batch.id, 30.04, 'manual'); // client_seq 2
    // an older op inserted later must still be sent first
    await enqueue({
      op_id: '33333333-3333-4333-8333-333333333333',
      client_seq: 0,
      client_time: '2026-08-27T03:00:00Z',
      kind: 'batch.update',
      payload: { id: batch.id, client_seq: 0, notes: 'old' },
    });
    const ops = await db.ops.orderBy('client_seq').toArray();
    const [opOld, opCreate, opReading] = ops;

    const serverBatch: Batch = {
      ...batch,
      farmer_id: 'farmer-1',
      notes: null,
      created_at: '2026-08-27T03:00:01Z',
      updated_at: '2026-08-27T03:00:01Z',
      chain_head: 'f'.repeat(64),
      shelf_life: undefined,
      readings: [{ ...reading, geohash: null, seq: 1, hash: 'f'.repeat(64), prev_hash: 'e'.repeat(64), received_at: '2026-08-27T03:10:00Z' }],
    };
    const response: SyncResponse = {
      server_now: '2026-08-27T03:10:00Z',
      clock_skew_seconds: 42,
      results: [
        { op_id: opOld.op_id, status: 'rejected', error: 'stale client_seq', entity: null },
        { op_id: opCreate.op_id, status: 'applied', error: null, entity: serverBatch },
        { op_id: opReading.op_id, status: 'duplicate', error: null, entity: null },
      ],
      batches: [serverBatch],
    };
    fetchMock.mockResolvedValue(json(response));

    const counts: number[] = [];
    const unsubscribe = subscribePending((n) => counts.push(n));
    const result = await drain();
    unsubscribe();

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/v1\/sync$/);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    const body = lastRequestBody();
    expect(body.device_id).toBe('device-test-0001');
    expect(body.ops.map((o) => o.client_seq)).toEqual([0, 1, 2]);
    expect(body.ops.map((o) => o.kind)).toEqual(['batch.update', 'batch.create', 'reading.append']);
    // outbox-only bookkeeping never goes on the wire
    expect(body.ops[0]).not.toHaveProperty('status');
    expect(body.ops[0]).not.toHaveProperty('attempts');
    expect(body.ops[0]).not.toHaveProperty('last_attempt_at');
    expect(body.ops[0]).not.toHaveProperty('skew_applied_seconds');

    const after = await db.ops.orderBy('client_seq').toArray();
    expect(after.map((o) => o.status)).toEqual(['failed', 'done', 'done']);
    expect(after[0].last_error).toBe('stale client_seq');
    expect(after[1].attempts).toBe(1);
    expect(typeof after[1].last_attempt_at).toBe('string');
    expect(await pendingCount()).toBe(1); // the failed one is retried next time
    expect(counts.at(-1)).toBe(1);

    expect(getClockSkewSeconds()).toBe(42);
    expect(await db.getMeta(META_KEYS.clockSkewSeconds)).toBe(42);
    expect(await db.getMeta(META_KEYS.lastSyncAt)).toBe('2026-08-27T03:10:00Z');
    expect(Date.now() - new Date(nowIso()).getTime()).toBeGreaterThan(41_000);

    const merged = await db.batches.get(batch.id);
    expect(merged?.chain_head).toBe('f'.repeat(64));
    expect(merged?.synced).toBe(false); // a batch.update for it is still pending (failed)
    const r = await db.readings.get(reading.id);
    expect(r).toMatchObject({ seq: 1, hash: 'f'.repeat(64), synced: true });
  });

  it('marks a batch synced once every op for it is acknowledged', async () => {
    const batch = await createBatchLocal(input);
    const op = (await db.ops.toArray())[0];
    const serverBatch: Batch = { ...batch, farmer_id: 'farmer-1', created_at: batch.created_at, updated_at: batch.updated_at };
    fetchMock.mockResolvedValue(
      json({ server_now: '2026-08-27T03:10:00Z', clock_skew_seconds: 0, results: [{ op_id: op.op_id, status: 'applied', error: null, entity: serverBatch }], batches: [serverBatch] }),
    );
    await drain();
    expect((await db.batches.get(batch.id))?.synced).toBe(true);
    expect(await pendingCount()).toBe(0);
  });

  it('keeps a batch unsynced while only a reading.append for it is still pending', async () => {
    const batch = await createBatchLocal(input);
    const createOp = (await db.ops.toArray())[0];
    const serverBatch: Batch = { ...batch, farmer_id: 'farmer-1', created_at: batch.created_at, updated_at: batch.updated_at };
    fetchMock.mockResolvedValue(
      json({ server_now: '2026-08-27T03:10:00Z', clock_skew_seconds: 0, results: [{ op_id: createOp.op_id, status: 'applied', error: null, entity: serverBatch }], batches: [serverBatch] }),
    );
    await drain();
    expect((await db.batches.get(batch.id))?.synced).toBe(true);

    // Offline reading, then the 60 s poll returns the batch again (ops: []).
    setOnline(false);
    await addReadingLocal(batch.id, 31, 'manual');
    setOnline(true);
    fetchMock.mockResolvedValue(json({ server_now: '2026-08-27T03:11:00Z', clock_skew_seconds: 0, results: [], batches: [serverBatch] }));
    // Make the pending reading op unanswered: send an empty results list for it.
    await drain();
    expect((await db.batches.get(batch.id))?.synced).toBe(false);
    expect(await pendingCount()).toBe(1);
  });

  it('puts ops back to pending on a network failure and shares one in-flight drain', async () => {
    await createBatchLocal(input);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const [a, b] = await Promise.all([drain(), drain()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const op = (await db.ops.toArray())[0];
    expect(op.status).toBe('pending');
    expect(op.attempts).toBe(1);
  });

  it('drops the token on 401 so the next drain re-authenticates', async () => {
    await createBatchLocal(input);
    fetchMock.mockResolvedValue(json({ detail: 'expired' }, 401));
    expect(await drain()).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect((await db.ops.toArray())[0].status).toBe('pending');
  });

  it('recovers ops left inflight by a page that died mid-request', async () => {
    const batch = await createBatchLocal(input);
    await db.ops.toCollection().modify({ status: 'inflight' });
    expect(await pendingCount()).toBe(1);
    const op = (await db.ops.toArray())[0];
    const serverBatch: Batch = { ...batch, farmer_id: 'farmer-1', created_at: batch.created_at, updated_at: batch.updated_at };
    fetchMock.mockResolvedValue(
      json({ server_now: '2026-08-27T03:10:00Z', clock_skew_seconds: 0, results: [{ op_id: op.op_id, status: 'applied', error: null, entity: serverBatch }], batches: [serverBatch] }),
    );
    await drain();
    expect(lastRequestBody().ops).toHaveLength(1);
    expect((await db.ops.toArray())[0].status).toBe('done');
    expect(await pendingCount()).toBe(0);
  });

  it('treats a 2xx body that is not a SyncResponse (captive portal) as a failed request', async () => {
    await createBatchLocal(input);
    fetchMock.mockResolvedValue(new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(await drain()).toBeNull();
    expect((await db.ops.toArray())[0].status).toBe('pending');
    expect(await db.getMeta(META_KEYS.lastSyncAt)).toBeUndefined();
  });

  describe('clock skew', () => {
    it('accumulates the residual instead of replacing it, so the stored skew stays at 600 across drains', async () => {
      fetchMock.mockImplementation(fakeServer(600));
      await drain();
      expect(Math.abs(getClockSkewSeconds() - 600)).toBeLessThan(1);
      await drain();
      expect(Math.abs(getClockSkewSeconds() - 600)).toBeLessThan(1);
      await drain();
      expect(Math.abs(getClockSkewSeconds() - 600)).toBeLessThan(1);
      // The second request already sent a corrected client_now (≈ 600 s behind the device clock).
      const req2 = requestBody(1);
      expect(Date.now() - Date.parse(req2.client_now)).toBeGreaterThan(590_000);
    });

    it('sends one request per contiguous skew run with a matching client_now (ops enqueued under different skews)', async () => {
      // Op A enqueued under skew 0 (raw clock); the server answers but leaves A unanswered so it stays pending.
      await createBatchLocal(input);
      const opA = (await db.ops.toArray())[0];
      fetchMock.mockImplementation(fakeServer(600));
      await drain();
      expect(Math.abs(getClockSkewSeconds() - 600)).toBeLessThan(1);
      expect((await db.ops.get(opA.op_id))?.status).toBe('pending');
      expect((await db.ops.get(opA.op_id))?.skew_applied_seconds).toBe(0);

      // Op B enqueued after the skew was learned.
      const b = await createBatchLocal({ ...input, crop: 'guava' });
      const opB = (await db.ops.toArray()).find((o) => o.kind === 'batch.create' && o.payload.id === b.id)!;
      expect(Math.abs((opB.skew_applied_seconds ?? 0) - 600)).toBeLessThan(1);

      fetchMock.mockClear();
      fetchMock.mockImplementation(fakeServer(600, (req) => req.ops.map((o) => ({ op_id: o.op_id, status: 'applied' as const, error: null, entity: null }))));
      await drain();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const run1 = requestBody(0);
      const run2 = requestBody(1);
      expect(run1.ops.map((o) => o.op_id)).toEqual([opA.op_id]);
      expect(run2.ops.map((o) => o.op_id)).toEqual([opB.op_id]);
      // Run 1 (skew 0 ops) → raw client_now; run 2 (skew 600 ops) → client_now ≈ raw − 600 s.
      expect(Math.abs(Date.now() - Date.parse(run1.client_now))).toBeLessThan(5_000);
      expect(Date.now() - Date.parse(run2.client_now)).toBeGreaterThan(595_000);
      expect(Math.abs(getClockSkewSeconds() - 600)).toBeLessThan(1);
      expect((await db.ops.toArray()).map((o) => o.status)).toEqual(['done', 'done']);
    });

    it('tells the farmer once when the server shifted timestamps (clock_adjusted)', async () => {
      await setClockSkewSeconds(0);
      await createBatchLocal(input);
      const op = (await db.ops.toArray())[0];
      fetchMock.mockResolvedValue(
        json({ server_now: '2026-08-27T03:10:00Z', clock_skew_seconds: 600, results: [{ op_id: op.op_id, status: 'applied', error: null, entity: null, clock_adjusted: true }], batches: [] }),
      );
      await drain();
      const { result } = renderHook(() => useToasts());
      expect(result.current.map((t) => t.title)).toEqual(['Times were corrected to server time (device clock is 10 min off).']);
    });
  });

  describe('rejected ops: backoff and attempt cap', () => {
    async function rejectOnce(): Promise<string> {
      await createBatchLocal(input);
      const op = (await db.ops.toArray())[0];
      fetchMock.mockImplementation(fakeServer(0, (req) => req.ops.map((o) => ({ op_id: o.op_id, status: 'rejected' as const, error: 'batch_not_found', entity: null }))));
      await drain();
      return op.op_id;
    }

    it('skips a rejected op while inside its backoff window and re-sends it after', async () => {
      const opId = await rejectOnce();
      expect((await db.ops.get(opId))?.status).toBe('failed');
      expect((await db.ops.get(opId))?.attempts).toBe(1);
      fetchMock.mockClear();
      await drain();
      expect(lastRequestBody().ops).toHaveLength(0); // inside the 2 min window: not re-sent
      expect(await pendingCount()).toBe(1); // still counts as pending
      // Backoff elapsed.
      await db.ops.update(opId, { last_attempt_at: new Date(Date.now() - backoffMs(1) - 1000).toISOString() });
      fetchMock.mockClear();
      await drain();
      expect(lastRequestBody().ops.map((o) => o.op_id)).toEqual([opId]);
      expect((await db.ops.get(opId))?.attempts).toBe(2);
    });

    it('stops re-sending after MAX_REJECT_ATTEMPTS, drops it from the badge and lets the batch sync', async () => {
      const opId = await rejectOnce();
      const batchId = (await db.batches.toArray())[0].id;
      for (let i = 1; i < MAX_REJECT_ATTEMPTS; i += 1) {
        await db.ops.update(opId, { last_attempt_at: '2020-01-01T00:00:00Z' });
        await drain();
      }
      const row = (await db.ops.get(opId))!;
      expect(row.attempts).toBe(MAX_REJECT_ATTEMPTS);
      expect(row.status).toBe('failed');
      expect(isRetryable(row)).toBe(false);
      expect(await pendingCount()).toBe(0);

      await db.ops.update(opId, { last_attempt_at: '2020-01-01T00:00:00Z' });
      fetchMock.mockClear();
      const serverBatch: Batch = { ...(await db.batches.get(batchId))!, farmer_id: 'farmer-1' };
      fetchMock.mockResolvedValue(json({ server_now: '2026-08-27T03:10:00Z', clock_skew_seconds: 0, results: [], batches: [serverBatch] }));
      await drain();
      expect(lastRequestBody().ops).toHaveLength(0);
      expect((await db.batches.get(batchId))?.synced).toBe(true);
    });
  });
});
