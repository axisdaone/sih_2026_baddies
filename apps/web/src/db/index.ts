/**
 * Dexie database `farmsignal` v1 (contract §9): batches, readings, ops (outbox), prices, mandis, meta.
 * Row types extend the wire types with local-only bookkeeping (synced flags, outbox status).
 */
import Dexie, { type Table } from 'dexie';
import type { Batch, Mandi, PriceQuote, ReadingCreate, SyncOp, SyncOpStatus } from '../types';

export const DB_NAME = 'farmsignal';
export const DB_VERSION = 1;

/** Batch as stored locally. `synced` = server has acknowledged the latest local change. */
export type BatchRow = Batch & { synced: boolean };

/** Reading as stored locally; seq/hash/prev_hash/received_at are filled in once the server accepts it. */
export interface ReadingRow extends ReadingCreate {
  seq?: number;
  hash?: string;
  prev_hash?: string;
  received_at?: string;
  synced: boolean;
}

/** Outbox row (contract §7). */
export type OpRow = SyncOp & {
  status: SyncOpStatus;
  created_at: string;
  attempts: number;
  last_error: string | null;
};

/** Cached price; auto-incremented local id. */
export type PriceRow = PriceQuote & { id?: number };

export type MandiRow = Mandi;

/** Key/value scratch: device id, token, clock skew, last sync time, client_seq counter, prefs. */
export interface MetaRow {
  key: string;
  value: unknown;
  updated_at?: string;
}

/** Well-known meta keys. */
export const META_KEYS = {
  deviceId: 'device_id',
  farmerId: 'farmer_id',
  displayName: 'display_name',
  clockSkewSeconds: 'clock_skew_seconds',
  lastSyncAt: 'last_sync_at',
  clientSeq: 'client_seq',
  pricesFetchedAt: 'prices_fetched_at',
} as const;

export class FarmSignalDB extends Dexie {
  batches!: Table<BatchRow, string>;
  readings!: Table<ReadingRow, string>;
  ops!: Table<OpRow, string>;
  prices!: Table<PriceRow, number>;
  mandis!: Table<MandiRow, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super(DB_NAME);
    this.version(DB_VERSION).stores({
      batches: 'id, farmer_id, status, harvested_at, updated_at',
      readings: 'id, batch_id, taken_at, [batch_id+seq]',
      ops: 'op_id, client_seq, status, created_at',
      prices: '++id, commodity, mandi_id',
      mandis: 'id',
      meta: 'key',
    });
  }

  /** Typed meta getter. */
  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.meta.get(key);
    return row?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value, updated_at: new Date().toISOString() });
  }
}

/** Singleton. Import this everywhere; do not construct FarmSignalDB elsewhere. */
export const db = new FarmSignalDB();

export default db;
