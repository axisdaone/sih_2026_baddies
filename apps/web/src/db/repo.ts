/**
 * Local repository: every farmer-facing write goes through here — it updates Dexie *and* enqueues
 * the matching outbox op in one place, so the UI never awaits the network (PRD F1/F8).
 */
import { db, META_KEYS, type BatchRow, type OpRow, type ReadingRow } from './index';
import { enqueue, nextClientSeq } from './outbox';
import { encodeGeohash } from '../lib/geohash';
import { newId } from '../lib/ids';
import { round1 } from '../lib/time';
import { nowIso } from '../sync/clock';
import type { Batch, BatchCreate, BatchPatch, BatchStatus, Crop, Reading, ReadingCreate, ReadingSource } from '../types';

export interface CreateBatchInput {
  crop: Crop;
  qty_kg: number;
  harvested_at: string;
  origin_lat: number | null;
  origin_lon: number | null;
  notes?: string | null;
}

export interface BatchPatchInput {
  status?: BatchStatus;
  notes?: string | null;
  qty_kg?: number;
}

export interface BatchWithReadings {
  batch: BatchRow;
  readings: ReadingRow[];
}

async function localFarmerId(): Promise<string> {
  const id = await db.getMeta<string>(META_KEYS.farmerId);
  return typeof id === 'string' ? id : '';
}

/** Create a batch locally (status "open", unsynced) and enqueue `batch.create`. */
export async function createBatchLocal(input: CreateBatchInput): Promise<BatchRow> {
  const now = nowIso();
  const clientSeq = await nextClientSeq();
  const hasOrigin = input.origin_lat != null && input.origin_lon != null;
  const payload: BatchCreate = {
    id: newId(),
    crop: input.crop,
    protocol_id: input.crop,
    qty_kg: input.qty_kg,
    harvested_at: input.harvested_at,
    origin_lat: hasOrigin ? input.origin_lat : null,
    origin_lon: hasOrigin ? input.origin_lon : null,
    notes: input.notes ?? null,
    client_seq: clientSeq,
    client_created_at: now,
  };
  const row: BatchRow = {
    ...payload,
    farmer_id: await localFarmerId(),
    status: 'open',
    origin_geohash: hasOrigin ? encodeGeohash(input.origin_lat as number, input.origin_lon as number) : null,
    created_at: now,
    updated_at: now,
    synced: false,
  };
  await db.batches.put(row);
  await enqueue({ op_id: newId(), client_seq: clientSeq, client_time: now, kind: 'batch.create', payload });
  return row;
}

/**
 * Append a reading (temp rounded to 1 dp, contract §4) and enqueue `reading.append`.
 * `takenAt` defaults to now; the SIMULATED player passes harvested_at + offset.
 */
export async function addReadingLocal(
  batchId: string,
  tempC: number,
  source: ReadingSource,
  geohash?: string | null,
  takenAt?: string,
): Promise<ReadingRow> {
  if (!Number.isFinite(tempC)) throw new RangeError('temp_c must be a finite number');
  const now = nowIso();
  const clientSeq = await nextClientSeq();
  const payload: ReadingCreate = {
    id: newId(),
    batch_id: batchId,
    temp_c: round1(tempC),
    taken_at: takenAt ?? now,
    source,
    geohash: geohash ?? null,
    client_seq: clientSeq,
  };
  const row: ReadingRow = { ...payload, synced: false };
  await db.transaction('rw', db.readings, db.batches, async () => {
    await db.readings.put(row);
    const batch = await db.batches.get(batchId);
    if (batch) await db.batches.update(batchId, { updated_at: now });
  });
  await enqueue({ op_id: newId(), client_seq: clientSeq, client_time: now, kind: 'reading.append', payload });
  return row;
}

/** Patch status / notes / qty locally (marks the batch unsynced) and enqueue `batch.update`. */
export async function patchBatchLocal(batchId: string, patch: BatchPatchInput): Promise<BatchRow | undefined> {
  const now = nowIso();
  const clientSeq = await nextClientSeq();
  const payload: BatchPatch = { id: batchId, client_seq: clientSeq };
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.notes !== undefined) payload.notes = patch.notes;
  if (patch.qty_kg !== undefined) payload.qty_kg = patch.qty_kg;
  const updated = await db.transaction('rw', db.batches, async () => {
    const existing = await db.batches.get(batchId);
    if (!existing) return undefined;
    const next: BatchRow = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.qty_kg !== undefined ? { qty_kg: patch.qty_kg } : {}),
      updated_at: now,
      synced: false,
    };
    await db.batches.put(next);
    return next;
  });
  if (!updated) return undefined;
  await enqueue({ op_id: newId(), client_seq: clientSeq, client_time: now, kind: 'batch.update', payload });
  return updated;
}

export async function getBatch(batchId: string): Promise<BatchRow | undefined> {
  return db.batches.get(batchId);
}

/** Readings for a batch ordered by taken_at (the engine sorts again; this is for display). */
export async function listReadings(batchId: string): Promise<ReadingRow[]> {
  return db.readings.where('batch_id').equals(batchId).sortBy('taken_at');
}

export async function getBatchWithReadings(batchId: string): Promise<BatchWithReadings | undefined> {
  const batch = await db.batches.get(batchId);
  if (!batch) return undefined;
  return { batch, readings: await listReadings(batchId) };
}

/** All local batches, newest harvest first (Home re-sorts by urgency once estimates exist). */
export async function listBatches(): Promise<BatchRow[]> {
  return db.batches.orderBy('harvested_at').reverse().toArray();
}

/** Readings for many batches, grouped by batch_id (Home computes every open batch's estimate). */
export async function listReadingsByBatch(batchIds: string[]): Promise<Record<string, ReadingRow[]>> {
  const grouped: Record<string, ReadingRow[]> = {};
  if (batchIds.length === 0) return grouped;
  const rows = await db.readings.where('batch_id').anyOf(batchIds).toArray();
  rows.sort((a, b) => a.taken_at.localeCompare(b.taken_at));
  for (const r of rows) (grouped[r.batch_id] ??= []).push(r);
  return grouped;
}

/** Fields of a batch that a still-pending local patch will overwrite on the server later. */
function pendingPatchFields(ops: OpRow[], batchId: string): Partial<Pick<Batch, 'status' | 'notes' | 'qty_kg'>> {
  const fields: Partial<Pick<Batch, 'status' | 'notes' | 'qty_kg'>> = {};
  for (const op of ops) {
    if (op.kind !== 'batch.update' || op.payload.id !== batchId) continue;
    if (op.payload.status !== undefined) fields.status = op.payload.status;
    if (op.payload.notes !== undefined) fields.notes = op.payload.notes;
    if (op.payload.qty_kg !== undefined) fields.qty_kg = op.payload.qty_kg;
  }
  return fields;
}

/** Copy the server's chain fields onto a local reading row (or insert a server-only reading). */
export async function applyServerReading(reading: Reading): Promise<void> {
  const local = await db.readings.get(reading.id);
  const row: ReadingRow = {
    ...(local ?? {}),
    ...reading,
    geohash: reading.geohash ?? local?.geohash ?? null,
    synced: true,
  };
  await db.readings.put(row);
}

/**
 * Merge server truth (from /sync or GET /batches) into Dexie:
 * - batches are upserted with `synced: true` unless a local op for that batch is still pending, in
 *   which case the locally patched fields win and the row stays unsynced;
 * - readings: server seq / hash / prev_hash / received_at are written onto local rows by id, and
 *   server-only readings are inserted.
 * Batches that exist only locally are left untouched.
 */
export async function applyServerBatches(batches: Batch[]): Promise<void> {
  if (batches.length === 0) return;
  const pendingOps = await db.ops.where('status').anyOf('pending', 'inflight', 'failed').toArray();
  const pendingBatchIds = new Set<string>();
  for (const op of pendingOps) {
    if (op.kind === 'batch.create' || op.kind === 'batch.update') pendingBatchIds.add(op.payload.id);
  }
  await db.transaction('rw', db.batches, db.readings, async () => {
    for (const server of batches) {
      const { readings, ...rest } = server;
      const local = await db.batches.get(server.id);
      const hasPending = pendingBatchIds.has(server.id);
      const row: BatchRow = {
        ...(local ?? {}),
        ...rest,
        ...(hasPending ? pendingPatchFields(pendingOps, server.id) : {}),
        synced: !hasPending,
      };
      await db.batches.put(row);
      for (const r of readings ?? []) await applyServerReading(r);
    }
  });
}

/** True when any reading of the batch is simulated (drives the SIMULATED chip). */
export function hasSimReadings(readings: Pick<ReadingRow, 'source'>[]): boolean {
  return readings.some((r) => r.source === 'sim');
}
