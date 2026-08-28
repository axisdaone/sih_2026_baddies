/**
 * On-device shelf-life estimate (contract §9): runs the kinetics worker with the bundled protocol and
 * now = nowIso() (clock-skew corrected), recomputes every 60 s and whenever readings change, and
 * hands each result to alerts/checkAlerts. Falls back to the server's embedded `shelf_life` while
 * the local engine is unavailable so the UI always has a range to show.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { checkAlerts } from '../alerts';
import { PROTOCOLS } from '../data';
import type { BatchRow, ReadingRow } from '../db';
import { nowIso } from '../sync/clock';
import type { ReadingInput, ShelfLifeEstimate } from '../types';
import { estimateShelfLife } from '../worker/client';

export const RECOMPUTE_INTERVAL_MS = 60_000;

export type EstimateSource = 'local' | 'server' | null;

export interface ShelfLifeResult {
  estimate: ShelfLifeEstimate | null;
  /** 'local' = computed on-device just now; 'server' = last authoritative value from sync. */
  source: EstimateSource;
  loading: boolean;
  error: string | null;
}

type BatchInput = Pick<BatchRow, 'id' | 'protocol_id' | 'harvested_at' | 'shelf_life'>;

function toInputs(readings: ReadingRow[]): ReadingInput[] {
  return readings.map((r) => ({ id: r.id, temp_c: r.temp_c, taken_at: r.taken_at }));
}

/** Stable key so the effect re-runs only when a reading is added/changed, not on every render. */
export function readingsKey(readings: ReadingRow[]): string {
  return readings.map((r) => `${r.id}:${r.temp_c}:${r.taken_at}`).join('|');
}

/** Single evaluation; rejects when the engine is unavailable or the protocol is unknown. */
export async function estimateFor(batch: BatchInput, readings: ReadingRow[], now: string = nowIso()): Promise<ShelfLifeEstimate> {
  const protocol = PROTOCOLS[batch.protocol_id];
  if (!protocol) throw new Error(`unknown protocol ${batch.protocol_id}`);
  return estimateShelfLife({ protocol, harvested_at: batch.harvested_at, readings: toInputs(readings), now });
}

export function useShelfLife(batch: BatchInput | undefined, readings: ReadingRow[]): ShelfLifeResult {
  const [estimate, setEstimate] = useState<ShelfLifeEstimate | null>(null);
  const [source, setSource] = useState<EstimateSource>(null);
  const [loading, setLoading] = useState<boolean>(!!batch);
  const [error, setError] = useState<string | null>(null);
  const key = readingsKey(readings);
  const latest = useRef(readings);
  latest.current = readings;
  const serverEstimate = batch?.shelf_life;

  const id = batch?.id;
  const protocolId = batch?.protocol_id;
  const harvestedAt = batch?.harvested_at;

  useEffect(() => {
    if (!id || !protocolId || !harvestedAt) {
      setEstimate(null);
      setSource(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const compute = async () => {
      try {
        const est = await estimateFor({ id, protocol_id: protocolId, harvested_at: harvestedAt }, latest.current);
        if (cancelled) return;
        setEstimate(est);
        setSource('local');
        setError(null);
        void checkAlerts(id, est).catch(() => undefined);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        if (serverEstimate) {
          setEstimate(serverEstimate);
          setSource('server');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void compute();
    const timer = setInterval(() => void compute(), RECOMPUTE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `key` stands in for `readings` (array identity changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, protocolId, harvestedAt, key, serverEstimate]);

  return useMemo(() => ({ estimate, source, loading, error }), [estimate, source, loading, error]);
}

export interface ShelfLifeMapResult {
  estimates: Record<string, ShelfLifeEstimate>;
  sources: Record<string, EstimateSource>;
  loading: boolean;
}

/** Estimates for many batches at once (Home list). Same cadence rules as useShelfLife. */
export function useShelfLifeMap(batches: BatchRow[], readingsByBatch: Record<string, ReadingRow[]>): ShelfLifeMapResult {
  const [estimates, setEstimates] = useState<Record<string, ShelfLifeEstimate>>({});
  const [sources, setSources] = useState<Record<string, EstimateSource>>({});
  const [loading, setLoading] = useState<boolean>(batches.length > 0);
  const key = batches.map((b) => `${b.id}:${b.protocol_id}:${b.harvested_at}:${readingsKey(readingsByBatch[b.id] ?? [])}`).join('||');
  const latest = useRef({ batches, readingsByBatch });
  latest.current = { batches, readingsByBatch };

  useEffect(() => {
    let cancelled = false;
    const compute = async () => {
      const { batches: bs, readingsByBatch: rb } = latest.current;
      const nextEst: Record<string, ShelfLifeEstimate> = {};
      const nextSrc: Record<string, EstimateSource> = {};
      await Promise.all(
        bs.map(async (b) => {
          try {
            const est = await estimateFor(b, rb[b.id] ?? []);
            nextEst[b.id] = est;
            nextSrc[b.id] = 'local';
            void checkAlerts(b.id, est).catch(() => undefined);
          } catch {
            if (b.shelf_life) {
              nextEst[b.id] = b.shelf_life;
              nextSrc[b.id] = 'server';
            }
          }
        }),
      );
      if (cancelled) return;
      setEstimates(nextEst);
      setSources(nextSrc);
      setLoading(false);
    };
    if (latest.current.batches.length === 0) {
      setEstimates({});
      setSources({});
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    void compute();
    const timer = setInterval(() => void compute(), RECOMPUTE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useMemo(() => ({ estimates, sources, loading }), [estimates, sources, loading]);
}
