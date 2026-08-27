import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { db } from '../db';
import type { AlertThreshold, ShelfLifeEstimate } from '../types';

vi.mock('@/voice', () => ({ play: vi.fn(async () => undefined) }));

import { play } from '@/voice';
import { ALERT_LOG_KEY, alertsMetaKey, checkAlerts, clearToasts, getAlertLog, resetAlerts, useToasts } from './index';
import { renderHook } from '@testing-library/react';

const BATCH_ID = '22222222-2222-4222-8222-222222222222';

function estimate(overrides: Partial<ShelfLifeEstimate> & { alerts_crossed: AlertThreshold[] }): ShelfLifeEstimate {
  return {
    protocol_id: 'tomato',
    model_version: 'kinetics-1.0',
    computed_at: '2026-08-27T06:30:00Z',
    status: 'fresh',
    confidence: 'medium',
    consumed_fraction: 0.3,
    remaining_fraction: 0.7,
    remaining_hours: { low: 41.2, mid: 58.7, high: 79 },
    expected_end: { low: '2026-08-28T23:00:00Z', mid: '2026-08-29T17:00:00Z', high: '2026-08-30T13:00:00Z' },
    current_temp_c: 28,
    current_temp_assumed: false,
    hours_since_last_reading: 0.5,
    thermal_load_degree_hours: 214,
    breach: null,
    segments: [],
    ...overrides,
  };
}

describe('checkAlerts', () => {
  beforeEach(async () => {
    await Promise.all([db.meta.clear(), db.batches.clear(), db.readings.clear()]);
    vi.mocked(play).mockClear();
    clearToasts();
    await db.batches.put({
      id: BATCH_ID,
      crop: 'tomato',
      protocol_id: 'tomato',
      qty_kg: 500,
      harvested_at: '2026-08-27T02:00:00Z',
      origin_lat: 12.3,
      origin_lon: 78.07,
      client_seq: 1,
      client_created_at: '2026-08-27T02:00:05Z',
      farmer_id: 'f1',
      status: 'open',
      origin_geohash: null,
      created_at: '2026-08-27T02:00:05Z',
      updated_at: '2026-08-27T02:00:05Z',
      synced: true,
    });
  });

  it('fires each threshold once and plays the matching clip', async () => {
    expect(await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75] }))).toEqual([75]);
    expect(play).toHaveBeenCalledWith('alert_75');
    expect(play).toHaveBeenCalledTimes(1);

    // Same estimate again (60 s recompute): nothing new.
    expect(await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75] }))).toEqual([]);
    expect(play).toHaveBeenCalledTimes(1);

    // Crossing 50 later fires only 50.
    expect(await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75, 50], status: 'warning' }))).toEqual([50]);
    expect(play).toHaveBeenLastCalledWith('alert_50');
    expect(play).toHaveBeenCalledTimes(2);

    const fired = await db.getMeta<{ fired: number[] }>(alertsMetaKey(BATCH_ID));
    expect(fired?.fired).toEqual([75, 50]);
  });

  it('plays only the most urgent new clip when several thresholds arrive at once, then sell_now for critical', async () => {
    const fresh = await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75, 50, 25], status: 'critical', remaining_fraction: 0.2 }));
    expect(fresh).toEqual([75, 50, 25]);
    expect(vi.mocked(play).mock.calls.map((c) => c[0])).toEqual(['alert_25', 'sell_now']);

    // Still critical on the next tick: nothing fires again.
    expect(await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75, 50, 25], status: 'critical' }))).toEqual([]);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('records events in the alert log (newest first, with batch context) and shows toasts', async () => {
    await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75] }));
    await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75, 50], status: 'warning' }));
    const log = await getAlertLog();
    expect(log.map((e) => e.threshold)).toEqual([50, 75]);
    expect(log[0].batch_id).toBe(BATCH_ID);
    expect(log[0].crop).toBe('tomato');
    expect(log[0].qty_kg).toBe(500);
    expect(await db.getMeta(ALERT_LOG_KEY)).toHaveLength(2);

    const { result } = renderHook(() => useToasts());
    expect(result.current.map((t) => t.title)).toEqual(['75 % shelf life left', 'Half the shelf life left']);
    expect(result.current[0].body).toContain('Tomato 500 kg');
    expect(result.current[0].body).toContain('≈ 41–79 h (most likely 59 h)');
    expect(result.current[0].to).toBe(`/batch/${BATCH_ID}`);
  });

  it('resetAlerts lets thresholds fire again', async () => {
    await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75] }));
    await resetAlerts(BATCH_ID);
    expect(await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [75] }))).toEqual([75]);
  });

  it('ignores estimates with nothing crossed', async () => {
    expect(await checkAlerts(BATCH_ID, estimate({ alerts_crossed: [] }))).toEqual([]);
    expect(play).not.toHaveBeenCalled();
    expect(await db.meta.get(alertsMetaKey(BATCH_ID))).toBeUndefined();
  });
});
