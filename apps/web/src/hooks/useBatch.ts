/** Live Dexie queries for batches and readings (re-render on every local write or sync merge). */
import { useLiveQuery } from 'dexie-react-hooks';
import { type BatchRow, type ReadingRow } from '../db';
import { getBatchWithReadings, listBatches, listReadingsByBatch } from '../db/repo';

export interface LiveBatch {
  batch: BatchRow | undefined;
  readings: ReadingRow[];
  /** true until the first query result arrives. */
  loading: boolean;
}

export function useBatch(batchId: string | undefined): LiveBatch {
  const result = useLiveQuery(async () => {
    if (!batchId) return { batch: undefined, readings: [] as ReadingRow[] };
    const found = await getBatchWithReadings(batchId);
    return found ?? { batch: undefined, readings: [] as ReadingRow[] };
  }, [batchId]);
  return { batch: result?.batch, readings: result?.readings ?? [], loading: result === undefined };
}

export interface LiveBatches {
  batches: BatchRow[];
  readingsByBatch: Record<string, ReadingRow[]>;
  loading: boolean;
}

export function useBatches(): LiveBatches {
  const result = useLiveQuery(async () => {
    const batches = await listBatches();
    const readingsByBatch = await listReadingsByBatch(batches.map((b) => b.id));
    return { batches, readingsByBatch };
  }, []);
  return { batches: result?.batches ?? [], readingsByBatch: result?.readingsByBatch ?? {}, loading: result === undefined };
}
