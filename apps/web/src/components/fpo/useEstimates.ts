/**
 * Shelf-life estimates for every local batch (FPO dashboard). Recomputes via the kinetics worker
 * with a small signature cache (readings + minute bucket) and a 60 s tick; falls back to the last
 * server estimate embedded on the batch when the engine is unavailable.
 */
import { useEffect, useRef, useState } from 'react';
import type { BatchRow, ReadingRow } from '../../db';
import { getProtocol } from '../../data';
import { estimateShelfLife } from '../../worker/client';
import type { ShelfLifeEstimate } from '../../types';
import { STATUS_RANK } from '../StatusPill';

export interface EstimateEntry {
  estimate: ShelfLifeEstimate | null;
  pending: boolean;
  simulated: boolean;
}

export interface UrgencyItem extends EstimateEntry {
  batch: BatchRow;
}

const TICK_MS = 60_000;

/** Urgency: open batches first (lowest remaining mid first, unknown last), then closed batches. */
export function sortByUrgency(items: UrgencyItem[]): UrgencyItem[] {
  return [...items].sort((a, b) => {
    const aOpen = a.batch.status === 'open' ? 0 : 1;
    const bOpen = b.batch.status === 'open' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const ea = a.estimate;
    const eb = b.estimate;
    if (ea && eb) {
      const ra = STATUS_RANK[ea.status];
      const rb = STATUS_RANK[eb.status];
      if (ra !== rb) return ra - rb;
      return ea.remaining_hours.mid - eb.remaining_hours.mid;
    }
    if (ea) return -1;
    if (eb) return 1;
    return b.batch.harvested_at.localeCompare(a.batch.harvested_at);
  });
}

function signature(batch: BatchRow, rows: ReadingRow[], bucket: number): string {
  const last = rows[rows.length - 1];
  return `${batch.harvested_at}|${batch.status}|${rows.length}|${last?.id ?? ''}|${last?.temp_c ?? ''}|${bucket}`;
}

export function useBatchEstimates(batches: BatchRow[] | undefined, readings: ReadingRow[] | undefined): Record<string, EstimateEntry> {
  const [entries, setEntries] = useState<Record<string, EstimateEntry>>({});
  const cache = useRef(new Map<string, { sig: string; estimate: ShelfLifeEstimate | null }>());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!batches) return;
    let cancelled = false;
    const byBatch = new Map<string, ReadingRow[]>();
    for (const r of readings ?? []) {
      const list = byBatch.get(r.batch_id) ?? [];
      list.push(r);
      byBatch.set(r.batch_id, list);
    }
    const bucket = Math.floor(Date.now() / TICK_MS);

    const run = async () => {
      const next: Record<string, EstimateEntry> = {};
      await Promise.all(
        batches.map(async (batch) => {
          const rows = (byBatch.get(batch.id) ?? []).sort((a, b) => a.taken_at.localeCompare(b.taken_at));
          const simulated = rows.some((r) => r.source === 'sim');
          const sig = signature(batch, rows, bucket);
          const cached = cache.current.get(batch.id);
          if (cached && cached.sig === sig) {
            next[batch.id] = { estimate: cached.estimate, pending: false, simulated };
            return;
          }
          const protocol = getProtocol(batch.protocol_id);
          let estimate: ShelfLifeEstimate | null = batch.shelf_life ?? null;
          if (protocol) {
            try {
              estimate = await estimateShelfLife({
                protocol,
                harvested_at: batch.harvested_at,
                readings: rows.map((r) => ({ id: r.id, temp_c: r.temp_c, taken_at: r.taken_at })),
              });
            } catch {
              /* engine unavailable: keep the server copy */
            }
          }
          cache.current.set(batch.id, { sig, estimate });
          next[batch.id] = { estimate, pending: false, simulated };
        }),
      );
      if (!cancelled) setEntries(next);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [batches, readings, tick]);

  return entries;
}
