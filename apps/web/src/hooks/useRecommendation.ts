/**
 * Mandi recommendation (PRD F5): GET /batches/:id/recommendation when online (after a drain so the
 * batch exists server-side), cached in Dexie meta under `rec:<id>` for offline display. Plays the
 * `recommendation_ready` clip when a newer recommendation arrives. Never blocks on the network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { db } from '../db';
import { drain } from '../sync';
import { nowIso } from '../sync/clock';
import { useAppStatus } from '../state/appStatus';
import type { Recommendation } from '../types';
import { play } from '../voice';

export interface CachedRecommendation {
  recommendation: Recommendation;
  cached_at: string;
}

export function recommendationCacheKey(batchId: string): string {
  return `rec:${batchId}`;
}

export async function readCachedRecommendation(batchId: string): Promise<CachedRecommendation | null> {
  try {
    const v = await db.getMeta<CachedRecommendation>(recommendationCacheKey(batchId));
    return v && typeof v === 'object' && 'recommendation' in v ? v : null;
  } catch {
    return null;
  }
}

export async function cacheRecommendation(batchId: string, recommendation: Recommendation): Promise<CachedRecommendation> {
  const entry: CachedRecommendation = { recommendation, cached_at: nowIso() };
  try {
    await db.setMeta(recommendationCacheKey(batchId), entry);
  } catch {
    /* cache is best-effort */
  }
  return entry;
}

export interface RecommendationState {
  recommendation: Recommendation | null;
  /** When the shown value was fetched; null when it is fresh from this session. */
  cachedAt: string | null;
  fromCache: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * @param refreshKey change it (e.g. readings count) to refetch when the inputs change.
 * @param fetchWhenOnline set false to only read the cache (the Why page).
 */
export function useRecommendation(batchId: string | undefined, refreshKey = '', fetchWhenOnline = true): RecommendationState {
  const { online } = useAppStatus();
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState<boolean>(!!batchId);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const lastComputedAt = useRef<string | null>(null);

  // 1) Cache first, so offline users see the last known answer immediately.
  useEffect(() => {
    if (!batchId) return undefined;
    let cancelled = false;
    void readCachedRecommendation(batchId).then((cached) => {
      if (cancelled || !cached) return;
      setRecommendation((current) => current ?? cached.recommendation);
      setCachedAt((current) => current ?? cached.cached_at);
      setFromCache(true);
      lastComputedAt.current ??= cached.recommendation.computed_at;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  // 2) Fresh fetch when online.
  useEffect(() => {
    if (!batchId || !fetchWhenOnline) {
      setLoading(false);
      return undefined;
    }
    if (!online) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        await drain(); // the batch and its readings must exist server-side first
        if (cancelled) return;
        const rec = await api.get<Recommendation>(`/batches/${batchId}/recommendation`, { timeoutMs: 10_000 });
        if (cancelled) return;
        const entry = await cacheRecommendation(batchId, rec);
        setRecommendation(rec);
        setCachedAt(entry.cached_at);
        setFromCache(false);
        setError(null);
        if (lastComputedAt.current !== rec.computed_at) {
          lastComputedAt.current = rec.computed_at;
          void play('recommendation_ready');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [batchId, online, refreshKey, tick, fetchWhenOnline]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return useMemo(
    () => ({ recommendation, cachedAt, fromCache, loading, error, refresh }),
    [recommendation, cachedAt, fromCache, loading, error, refresh],
  );
}
