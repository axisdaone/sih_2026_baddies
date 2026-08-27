import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken, TOKEN_KEY } from '../api/client';
import { db, META_KEYS } from '../db';
import { addReadingLocal, createBatchLocal } from '../db/repo';
import { drain, enqueue, getClockSkewSeconds, nowIso, pendingCount, subscribePending } from './index';
import { _resetClockForTests } from './clock';
import type { Batch, SyncRequest, SyncResponse } from '../types';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

function lastRequestBody(): SyncRequest {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return JSON.parse(String(call[1]?.body)) as SyncRequest;
}

const input = { crop: 'tomato' as const, qty_kg: 100, harvested_at: '2026-08-27T03:00:00Z', origin_lat: 12.3, origin_lon: 78.07 };

describe('sync/drain', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    await Promise.all([db.batches.clear(), db.readings.clear(), db.ops.clear(), db.meta.clear()]);
    _resetClockForTests();
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

    const after = await db.ops.orderBy('client_seq').toArray();
    expect(after.map((o) => o.status)).toEqual(['failed', 'done', 'done']);
    expect(after[0].last_error).toBe('stale client_seq');
    expect(after[1].attempts).toBe(1);
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
});
