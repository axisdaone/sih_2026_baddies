import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './index';
import { enqueue, nextClientSeq, pendingCount } from '../sync';
import type { BatchCreate, SyncOp } from '../types';

const batch: BatchCreate = {
  id: '11111111-1111-4111-8111-111111111111',
  crop: 'tomato',
  protocol_id: 'tomato',
  qty_kg: 120,
  harvested_at: '2026-08-27T03:00:00Z',
  origin_lat: 12.3,
  origin_lon: 78.07,
  client_seq: 1,
  client_created_at: '2026-08-27T03:00:05Z',
};

describe('Dexie schema + outbox', () => {
  beforeEach(async () => {
    await Promise.all([db.batches.clear(), db.readings.clear(), db.ops.clear(), db.meta.clear()]);
  });

  it('opens with the six contract tables', async () => {
    await db.open();
    expect(db.tables.map((t) => t.name).sort()).toEqual(['batches', 'mandis', 'meta', 'ops', 'prices', 'readings']);
    expect(db.verno).toBe(1);
  });

  it('allocates monotonic client_seq values', async () => {
    expect(await nextClientSeq()).toBe(1);
    expect(await nextClientSeq()).toBe(2);
    expect(await nextClientSeq()).toBe(3);
  });

  it('enqueue() writes pending ops that count towards pendingCount()', async () => {
    const op: SyncOp = {
      op_id: 'op-1',
      client_seq: 1,
      client_time: '2026-08-27T03:00:05Z',
      kind: 'batch.create',
      payload: batch,
    };
    await enqueue(op);
    await enqueue(op); // idempotent on op_id
    expect(await db.ops.count()).toBe(1);
    expect(await pendingCount()).toBe(1);
    const row = await db.ops.get('op-1');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
  });

  it('indexes readings by [batch_id+seq]', async () => {
    await db.readings.bulkPut([
      { id: 'r2', batch_id: batch.id, temp_c: 31, taken_at: '2026-08-27T05:00:00Z', source: 'manual', client_seq: 3, seq: 2, synced: true },
      { id: 'r1', batch_id: batch.id, temp_c: 28, taken_at: '2026-08-27T04:00:00Z', source: 'manual', client_seq: 2, seq: 1, synced: true },
      { id: 'r3', batch_id: batch.id, temp_c: 33, taken_at: '2026-08-27T06:00:00Z', source: 'sim', client_seq: 4, synced: false },
    ]);
    const ordered = await db.readings.where('[batch_id+seq]').between([batch.id, 0], [batch.id, Infinity]).toArray();
    expect(ordered.map((r) => r.id)).toEqual(['r1', 'r2']); // unsynced rows (no seq) are not in the compound index
    expect(await db.readings.where('batch_id').equals(batch.id).count()).toBe(3);
  });
});
