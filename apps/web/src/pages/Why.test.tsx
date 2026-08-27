import { describe, expect, it } from 'vitest';
import { candidateRows } from './Why';
import type { MandiCandidate, Recommendation, ShelfLifeEstimate } from '../types';

const shelf: ShelfLifeEstimate = {
  protocol_id: 'tomato',
  model_version: 'kinetics-1.0',
  computed_at: '2026-08-27T06:30:00Z',
  status: 'fresh',
  confidence: 'high',
  consumed_fraction: 0.2,
  remaining_fraction: 0.8,
  remaining_hours: { low: 47, mid: 80, high: 114 },
  expected_end: { low: '2026-08-29T05:00:00Z', mid: '2026-08-30T14:00:00Z', high: '2026-09-01T00:00:00Z' },
  current_temp_c: 28,
  current_temp_assumed: false,
  hours_since_last_reading: 0.2,
  thermal_load_degree_hours: 40,
  alerts_crossed: [],
  breach: null,
  segments: [],
};

/** The hero batch's ranked list (DEMO-SCRIPT 2:15): Koyambedu is rank 8 with the highest price. */
const RANKED = ['hosur', 'bengaluru', 'kolar', 'salem', 'krishnagiri', 'dharmapuri', 'palacode', 'koyambedu', 'vellore', 'coimbatore', 'trichy', 'ottanchatram', 'madurai'];

function candidate(id: string, i: number, overrides: Partial<MandiCandidate> = {}): MandiCandidate {
  return {
    mandi_id: id,
    name: id[0].toUpperCase() + id.slice(1),
    district: id,
    lat: 12,
    lon: 78,
    straight_km: 50 + i * 20,
    distance_km: 70 + i * 25,
    travel_hours: 2 + i * 0.7,
    feasible: true,
    modal_price_per_quintal: 1600 - i * 50,
    price_reported_on: '2026-08-25',
    price_fetched_at: '2026-08-27T05:00:00Z',
    price_is_stale: false,
    price_source: 'bundled_snapshot',
    transit_temp_c: 28,
    consumed_at_arrival: 0.3,
    spoilage_at_arrival: 0.06,
    gross_value_inr: 8000 - i * 200,
    transport_cost_inr: 870 + i * 300,
    expected_value_inr: 6638 - i * 400,
    reasons: ['feasible'],
    ...overrides,
  };
}

function hero(withRanked = true): Recommendation {
  const ranked = RANKED.map((id, i) => candidate(id, i, id === 'koyambedu' ? { modal_price_per_quintal: 1800, distance_km: 320, transport_cost_inr: 3835 } : {}));
  return {
    batch_id: '6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01',
    computed_at: '2026-08-27T06:30:00Z',
    model_version: 'routing-1.0',
    shelf_life: shelf,
    top: ranked[0],
    alternatives: [ranked[1], ranked[2]],
    nearest: ranked[6],
    rejected: [],
    ...(withRanked ? { ranked } : {}),
    uplift_vs_nearest_pct: 63,
    constants: { road_factor: 1.3, avg_speed_kmh: 35, safety_factor: 0.8, transport_cost_per_km_inr: 12 },
    simulated: true,
  };
}

describe('Why / candidateRows', () => {
  it('lists every ranked mandi once with its full payload (Koyambedu is no longer hidden)', () => {
    const rec = hero();
    const rows = candidateRows(rec);
    expect(rows).toHaveLength(rec.ranked!.length + rec.rejected.length);
    const ids = rows.map((r) => r.candidate.mandi_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of RANKED) expect(ids).toContain(id);
    // rank order preserved: top, alternatives, then the rest of the ranked list
    expect(ids).toEqual(RANKED);

    const koyambedu = rows.find((r) => r.candidate.mandi_id === 'koyambedu')!;
    expect(koyambedu.candidate.modal_price_per_quintal).toBe(1800);
    expect(koyambedu.candidate.distance_km).toBe(320);
    expect(koyambedu.candidate.transport_cost_inr).toBe(3835);
    expect(koyambedu.roles).toEqual(['reachable']);

    expect(rows.find((r) => r.candidate.mandi_id === 'hosur')!.roles).toEqual(['top']);
    expect(rows.find((r) => r.candidate.mandi_id === 'bengaluru')!.roles).toEqual(['alternative']);
    expect(rows.find((r) => r.candidate.mandi_id === 'palacode')!.roles).toEqual(['reachable', 'nearest']);
  });

  it('degrades to top / alternatives / nearest / rejected rows for a cached payload without `ranked`', () => {
    const rec = hero(false);
    rec.rejected = [candidate('madurai', 12, { feasible: false, reasons: ['too_far_for_shelf_life'] })];
    const rows = candidateRows(rec);
    expect(rows.map((r) => r.candidate.mandi_id)).toEqual(['hosur', 'bengaluru', 'kolar', 'palacode', 'madurai']);
    expect(rows.map((r) => r.roles)).toEqual([['top'], ['alternative'], ['alternative'], ['nearest'], ['rejected']]);
  });

  it('tags a mandi that is both recommended and nearest with both chips, never a duplicate row', () => {
    const rec = hero();
    rec.nearest = rec.top;
    const rows = candidateRows(rec);
    expect(rows.filter((r) => r.candidate.mandi_id === 'hosur')).toHaveLength(1);
    expect(rows[0].roles).toEqual(['top', 'nearest']);
  });
});
