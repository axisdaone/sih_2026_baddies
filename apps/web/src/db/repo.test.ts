import { beforeEach, describe, expect, it } from 'vitest';
import { db, META_KEYS } from './index';
import { addReadingLocal, applyServerBatches, createBatchLocal, getBatchWithReadings, listBatches, patchBatchLocal } from './repo';
import { _resetClockForTests, setClockSkewSeconds } from '../sync/clock';
import type { Batch, Reading } from '../types';

const input = {
  crop: 'tomato' as const,
  qty_kg: 120,
  harvested_at: '2026-08-27T03:00:00Z',
  origin_lat: 12.3,
  origin_lon: 78.07,
};

describe('db/repo', () => {
  beforeEach(async () => {
    await Promise.all([db.batches.clear(), db.readings.clear(), db.ops.clear(), db.meta.clear()]);
    _resetClockForTests();
  });

  it('createBatchLocal writes the batch row and a batch.create op with monotonic client_seq', async () => {
    await db.setMeta(META_KEYS.farmerId, 'farmer-1');
    const a = await createBatchLocal(input);
    const b = await createBatchLocal({ ...input, crop: 'guava' });

    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.protocol_id).toBe('tomato');
    expect(b.protocol_id).toBe('guava');
    expect(a.status).toBe('open');
    expect(a.synced).toBe(false);
    expect(a.farmer_id).toBe('farmer-1');
    expect(a.origin_geohash).toHaveLength(7);
    expect(a.client_seq).toBe(1);
    expect(b.client_seq).toBe(2);

    const ops = await db.ops.orderBy('client_seq').toArray();
    expect(ops.map((o) => o.kind)).toEqual(['batch.create', 'batch.create']);
    expect(ops.map((o) => o.client_seq)).toEqual([1, 2]);
    expect(ops[0].status).toBe('pending');
    expect(ops[0].payload).toMatchObject({ id: a.id, crop: 'tomato', qty_kg: 120, client_seq: 1 });
    expect(await listBatches()).toHaveLength(2);
  });

  it('addReadingLocal rounds to 1 dp, defaults taken_at to now and enqueues reading.append', async () => {
    const batch = await createBatchLocal(input);
    const before = Date.now();
    const r = await addReadingLocal(batch.id, 28.46, 'manual', 'tf4m6yz');
    expect(r.temp_c).toBe(28.5);
    expect(r.source).toBe('manual');
    expect(r.synced).toBe(false);
    expect(r.geohash).toBe('tf4m6yz');
    expect(Math.abs(new Date(r.taken_at).getTime() - before)).toBeLessThan(5_000);
    expect(r.client_seq).toBe(2);

    const sim = await addReadingLocal(batch.id, 42, 'sim', null, '2026-08-27T06:00:00Z');
    expect(sim.taken_at).toBe('2026-08-27T06:00:00Z');
    expect(sim.client_seq).toBe(3);

    const ops = (await db.ops.orderBy('client_seq').toArray()).filter((o) => o.kind === 'reading.append');
    expect(ops).toHaveLength(2);
    expect(ops[0].payload).toMatchObject({ id: r.id, batch_id: batch.id, temp_c: 28.5, client_seq: 2 });
    const found = await getBatchWithReadings(batch.id);
    expect(found?.readings.map((x) => x.id)).toEqual([sim.id, r.id]); // ordered by taken_at
  });

  it('applies clock skew to new timestamps', async () => {
    await setClockSkewSeconds(600); // device clock is 10 min ahead of the server
    const batch = await createBatchLocal(input);
    const created = new Date(batch.client_created_at).getTime();
    expect(Date.now() - created).toBeGreaterThan(590_000);
    expect(Date.now() - created).toBeLessThan(610_000);
  });

  it('patchBatchLocal updates fields, marks unsynced and enqueues batch.update', async () => {
    const batch = await createBatchLocal(input);
    const updated = await patchBatchLocal(batch.id, { status: 'sold', notes: 'sold at Hosur' });
    expect(updated?.status).toBe('sold');
    expect(updated?.notes).toBe('sold at Hosur');
    expect(updated?.synced).toBe(false);
    const op = (await db.ops.toArray()).find((o) => o.kind === 'batch.update');
    expect(op).toBeDefined();
    expect(op?.payload).toEqual({ id: batch.id, client_seq: 2, status: 'sold', notes: 'sold at Hosur' });
    expect(await patchBatchLocal('missing', { status: 'sold' })).toBeUndefined();
  });

  it('applyServerBatches upserts batches, writes chain fields onto local readings and inserts server-only ones', async () => {
    const batch = await createBatchLocal(input);
    const local = await addReadingLocal(batch.id, 30, 'manual');
    await db.ops.clear(); // pretend everything was acknowledged

    const serverReading: Reading = {
      ...local,
      geohash: null,
      seq: 1,
      hash: 'a'.repeat(64),
      prev_hash: 'b'.repeat(64),
      received_at: '2026-08-27T04:00:00Z',
    };
    const serverOnly: Reading = {
      id: '22222222-2222-4222-8222-222222222222',
      batch_id: batch.id,
      temp_c: 31,
      taken_at: '2026-08-27T05:00:00Z',
      source: 'sim',
      geohash: null,
      client_seq: 9,
      seq: 2,
      hash: 'c'.repeat(64),
      prev_hash: 'a'.repeat(64),
      received_at: '2026-08-27T05:00:01Z',
    };
    const serverBatch: Batch = {
      ...batch,
      farmer_id: 'farmer-server',
      created_at: '2026-08-27T03:00:01Z',
      updated_at: '2026-08-27T05:00:01Z',
      chain_head: 'c'.repeat(64),
      readings: [serverReading, serverOnly],
    };
    await applyServerBatches([serverBatch]);

    const merged = await getBatchWithReadings(batch.id);
    expect(merged?.batch.synced).toBe(true);
    expect(merged?.batch.farmer_id).toBe('farmer-server');
    expect(merged?.batch.chain_head).toBe('c'.repeat(64));
    expect((merged?.batch as { readings?: unknown }).readings).toBeUndefined(); // not nested in the row
    expect(merged?.readings).toHaveLength(2);
    const r1 = merged?.readings.find((r) => r.id === local.id);
    expect(r1).toMatchObject({ seq: 1, hash: 'a'.repeat(64), synced: true, temp_c: 30 });
    expect(merged?.readings.find((r) => r.id === serverOnly.id)).toMatchObject({ seq: 2, source: 'sim', synced: true });
  });

  it('applyServerBatches keeps locally patched fields while their op is still pending', async () => {
    const batch = await createBatchLocal(input);
    await db.ops.clear();
    await patchBatchLocal(batch.id, { status: 'sold' }); // pending batch.update
    await applyServerBatches([{ ...batch, status: 'open', updated_at: '2026-08-27T09:00:00Z' }]);
    const row = await db.batches.get(batch.id);
    expect(row?.status).toBe('sold');
    expect(row?.synced).toBe(false);
  });
});
