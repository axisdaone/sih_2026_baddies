/**
 * Kinetics engine tests (contract §2.2 / §2.3): cross-language golden cases, literature anchors,
 * heat-spike acceleration, pharma excursion semantics, timeline edge cases, purity and formatting.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOLS } from '../data';
import type { DecayProtocol, ReadingInput, ShelfLifeEstimate } from '../types';
import { clamp, consumedAfter, evaluate, isoZ, MODEL_VERSION, rateMultiplier, roundHalfUp } from './index';

// vite-node injects __dirname for test modules; src/engine -> repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

interface GoldenExpected {
  status: string;
  confidence: string;
  consumed_fraction: number;
  remaining_fraction: number;
  remaining_hours: { low: number; mid: number; high: number };
  current_temp_c: number;
  current_temp_assumed: boolean;
  hours_since_last_reading?: number;
  thermal_load_degree_hours: number;
  alerts_crossed: number[];
  breach_type: string | null;
}

interface GoldenCase {
  id: string;
  note: string;
  protocol_id: string;
  harvested_at: string;
  now: string;
  readings: ReadingInput[];
  expected: GoldenExpected;
}

interface GoldenFile {
  version: string;
  model_version: string;
  tolerances: { hours: number; fractions: number; degree_hours: number };
  cases: GoldenCase[];
}

const GOLDEN = JSON.parse(readFileSync(resolve(REPO_ROOT, 'data/demo_scenarios/golden_kinetics.json'), 'utf8')) as GoldenFile;

const TOMATO: DecayProtocol = PROTOCOLS.tomato;
const GUAVA: DecayProtocol = PROTOCOLS.guava;
const PHARMA: DecayProtocol = PROTOCOLS.pharma_2_8;

const T0 = '2026-08-27T00:30:00Z';
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** ISO timestamp `hours` after T0 (seconds precision, Z). */
function at(hours: number): string {
  return new Date(Date.parse(T0) + hours * 3.6e6).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function reading(n: number, tempC: number, hoursAfterT0: number): ReadingInput {
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, temp_c: tempC, taken_at: at(hoursAfterT0) };
}

/** Single reading at harvest, evaluated at harvest: the "constant temperature" anchor profile. */
function constantTemp(protocol: DecayProtocol, tempC: number): ShelfLifeEstimate {
  return evaluate(protocol, T0, [reading(1, tempC, 0)], T0);
}

function expectWithin(actual: number | null, expected: number, tol: number, label: string): void {
  expect(actual, label).not.toBeNull();
  expect(Math.abs((actual as number) - expected), `${label}: got ${actual}, want ${expected} ±${tol}`).toBeLessThanOrEqual(tol);
}

// ---------------------------------------------------------------------------

describe('golden_kinetics.json (cross-language)', () => {
  const { hours: tolH, fractions: tolF, degree_hours: tolD } = GOLDEN.tolerances;

  it('file is the version this engine implements', () => {
    expect(GOLDEN.model_version).toBe(MODEL_VERSION);
    expect(GOLDEN.cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(GOLDEN.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const protocol = PROTOCOLS[c.protocol_id];
    expect(protocol, `protocol ${c.protocol_id}`).toBeDefined();
    const est = evaluate(protocol, c.harvested_at, c.readings, c.now);
    const exp = c.expected;

    expect(est.protocol_id).toBe(c.protocol_id);
    expect(est.model_version).toBe(GOLDEN.model_version);
    expect(est.status).toBe(exp.status);
    expect(est.confidence).toBe(exp.confidence);
    expectWithin(est.consumed_fraction, exp.consumed_fraction, tolF, 'consumed_fraction');
    expectWithin(est.remaining_fraction, exp.remaining_fraction, tolF, 'remaining_fraction');
    expectWithin(est.remaining_hours.low, exp.remaining_hours.low, tolH, 'remaining_hours.low');
    expectWithin(est.remaining_hours.mid, exp.remaining_hours.mid, tolH, 'remaining_hours.mid');
    expectWithin(est.remaining_hours.high, exp.remaining_hours.high, tolH, 'remaining_hours.high');
    expect(est.current_temp_c).toBe(exp.current_temp_c);
    expect(est.current_temp_assumed).toBe(exp.current_temp_assumed);
    if (exp.hours_since_last_reading === undefined) expect(est.hours_since_last_reading).toBeNull();
    else expectWithin(est.hours_since_last_reading, exp.hours_since_last_reading, tolH, 'hours_since_last_reading');
    expectWithin(est.thermal_load_degree_hours, exp.thermal_load_degree_hours, tolD, 'thermal_load_degree_hours');
    expect(est.alerts_crossed).toEqual(exp.alerts_crossed);
    expect(est.breach?.label ?? null).toBe(exp.breach_type);
    if (exp.breach_type !== null) {
      expect(est.breach?.reading_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(est.breach?.at).toMatch(ISO_SECONDS);
    }
  });
});

// ---------------------------------------------------------------------------

describe('literature anchors (contract §2.3, mid scenario)', () => {
  it('tomato: 10 C -> 288 h, 20 C -> 144 h, 30 C -> 72 h', () => {
    expect(constantTemp(TOMATO, 10).remaining_hours.mid).toBe(288);
    expect(constantTemp(TOMATO, 20).remaining_hours.mid).toBe(144);
    expect(constantTemp(TOMATO, 30).remaining_hours.mid).toBe(72);
  });

  it('tomato ranges: 10 C -> [240, 336]', () => {
    const e = constantTemp(TOMATO, 10);
    expect(e.remaining_hours).toEqual({ low: 240, mid: 288, high: 336 });
    expect(e.remaining_hours.low).toBeLessThanOrEqual(e.remaining_hours.mid);
    expect(e.remaining_hours.mid).toBeLessThanOrEqual(e.remaining_hours.high);
  });

  it('guava: 10 C -> 336 h, 20 C -> ~134 h, 30 C -> ~54 h', () => {
    expect(constantTemp(GUAVA, 10).remaining_hours.mid).toBe(336);
    expect(constantTemp(GUAVA, 20).remaining_hours.mid).toBeCloseTo(134.4, 1);
    expect(constantTemp(GUAVA, 30).remaining_hours.mid).toBeCloseTo(53.8, 1);
    expect(Math.abs(constantTemp(GUAVA, 20).remaining_hours.mid - 134)).toBeLessThan(0.5);
    expect(Math.abs(constantTemp(GUAVA, 30).remaining_hours.mid - 54)).toBeLessThan(0.5);
  });

  it('pharma: 6 h at 15 C then 6 h at 5 C -> consumed 0.5, remaining 6 h', () => {
    const e = evaluate(PHARMA, T0, [reading(1, 15, 0), reading(2, 5, 6)], at(12));
    expect(e.consumed_fraction).toBe(0.5);
    expect(e.remaining_hours.mid).toBe(6);
    expect(e.status).toBe('warning');
  });

  it('pharma: any reading below 0 C -> spoiled (freeze)', () => {
    const e = evaluate(PHARMA, T0, [reading(1, 5, 0), reading(2, -0.5, 1), reading(3, 5, 2)], at(3));
    expect(e.status).toBe('spoiled');
    // value_c is the threshold that was crossed (0 C), not the reading's -0.5 C — same as the Python engine.
    expect(e.breach).toStrictEqual({ type: 'min_temp', value_c: 0, reading_id: reading(2, 0, 0).id, at: at(1), label: 'freeze' });
    expect(e.remaining_hours).toEqual({ low: 0, mid: 0, high: 0 });
    expect(e.consumed_fraction).toBe(1);
    expect(e.expected_end).toEqual({ low: at(3), mid: at(3), high: at(3) });
  });
});

// ---------------------------------------------------------------------------

describe('heat spike acceleration', () => {
  const flat = [reading(1, 30, 0), reading(2, 30, 3), reading(3, 30, 5), reading(4, 30, 8)];
  const spike = [reading(1, 30, 0), reading(2, 42, 3), reading(3, 30, 5), reading(4, 30, 8)];

  it('a 42 C spike consumes more shelf life than a flat 30 C profile without breaching', () => {
    const a = evaluate(TOMATO, T0, flat, at(8));
    const b = evaluate(TOMATO, T0, spike, at(8));
    expect(b.breach).toBeNull();
    expect(b.status).toBe('fresh');
    expect(b.consumed_fraction).toBeGreaterThan(a.consumed_fraction);
    expect(b.remaining_hours.mid).toBeLessThan(a.remaining_hours.mid);
    expect(b.thermal_load_degree_hours).toBe(a.thermal_load_degree_hours + 2 * 12);
    // 2 h at r(42) = 2^3.2 on top of 6 h at r(30) = 4.
    expect(b.consumed_fraction).toBeCloseTo((6 * 4 + 2 * 2 ** 3.2) / 288, 4);
    const spikeSeg = b.segments.find((s) => s.temp_c === 42);
    expect(spikeSeg).toMatchObject({ hours: 2, rate: Number((2 ** 3.2).toFixed(4)), assumed: false });
  });

  it('above 45 C the hard threshold spoils the batch regardless of duration', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 30, 0), reading(2, 45.1, 3), reading(3, 30, 3.1)], at(8));
    expect(e.status).toBe('spoiled');
    expect(e.breach).toStrictEqual({ type: 'max_temp', value_c: 45, reading_id: reading(2, 0, 0).id, at: at(3), label: 'heat_damage' });
    expect(e.remaining_fraction).toBe(0);
    expect(e.alerts_crossed).toEqual([75, 50, 25]);
  });

  it('exactly 45 C is not a breach (strict comparison) but is the rate ceiling', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 45, 0)], at(1));
    expect(e.breach).toBeNull();
    expect(rateMultiplier(TOMATO, 45)).toBe(rateMultiplier(TOMATO, 60));
  });
});

// ---------------------------------------------------------------------------

describe('pharma excursion semantics', () => {
  it('in-band readings consume nothing and remaining is the budget, not infinity', () => {
    const e = evaluate(PHARMA, T0, [reading(1, 5, 0)], at(3));
    expect(e.consumed_fraction).toBe(0);
    expect(e.remaining_hours).toEqual({ low: 10.8, mid: 12, high: 13.2 });
    expect(Number.isFinite(e.remaining_hours.mid)).toBe(true);
    expect(e.expected_end.mid).toBe(at(15));
  });

  it('band edges are inclusive; just outside counts fully', () => {
    expect(rateMultiplier(PHARMA, 2)).toBe(0);
    expect(rateMultiplier(PHARMA, 8)).toBe(0);
    expect(rateMultiplier(PHARMA, 1.9)).toBe(1);
    expect(rateMultiplier(PHARMA, 8.1)).toBe(1);
  });

  it('while out of band, remaining = budget − hours out so far (all scenarios)', () => {
    const e = evaluate(PHARMA, T0, [reading(1, 5, 0), reading(2, 12, 2)], at(3));
    expect(e.remaining_hours).toEqual({ low: 9.8, mid: 11, high: 12.2 });
    expect(e.consumed_fraction).toBeCloseTo(1 / 12, 4);
  });

  it('hard thresholds are strict: 25.0 and 0.0 are not breaches, 25.1 and -0.1 are', () => {
    expect(evaluate(PHARMA, T0, [reading(1, 25, 0)], at(1)).breach).toBeNull();
    expect(evaluate(PHARMA, T0, [reading(1, 0, 0)], at(1)).breach).toBeNull();
    expect(evaluate(PHARMA, T0, [reading(1, 25.1, 0)], at(1)).breach?.label).toBe('heat_excursion');
    expect(evaluate(PHARMA, T0, [reading(1, -0.1, 0)], at(1)).breach?.label).toBe('freeze');
  });

  it('status boundaries: 0.5 -> warning, 0.75 -> critical, budget exhausted -> spoiled without breach', () => {
    const half = evaluate(PHARMA, T0, [reading(1, 15, 0), reading(2, 5, 6)], at(12));
    expect(half.status).toBe('warning');
    expect(half.alerts_crossed).toEqual([75, 50]);
    const threeQ = evaluate(PHARMA, T0, [reading(1, 15, 0), reading(2, 5, 9)], at(12));
    expect(threeQ.status).toBe('critical');
    expect(threeQ.remaining_fraction).toBe(0.25);
    expect(threeQ.alerts_crossed).toEqual([75, 50, 25]);
    // 13 h out of band: mid (12 h) and low (10.8 h) budgets are exhausted; the optimistic 13.2 h budget
    // still has 0.2 h. Status follows mid only.
    const gone = evaluate(PHARMA, T0, [reading(1, 15, 0)], at(13));
    expect(gone.status).toBe('spoiled');
    expect(gone.breach).toBeNull();
    expect(gone.remaining_hours).toEqual({ low: 0, mid: 0, high: 0.2 });
    expect(gone.expected_end.mid).toBe(at(13));
    expect(gone.expected_end.low).toBe(at(13));
  });
});

// ---------------------------------------------------------------------------

describe('timeline construction', () => {
  it('no readings: one assumed ambient segment, hours_since_last_reading null, confidence low', () => {
    const e = evaluate(TOMATO, T0, [], at(6));
    expect(e.segments).toEqual([{ from: T0, to: at(6), temp_c: 30, hours: 6, rate: 4, assumed: true }]);
    expect(e.hours_since_last_reading).toBeNull();
    expect(e.confidence).toBe('low');
    expect(e.current_temp_c).toBe(30);
    expect(e.current_temp_assumed).toBe(true);
  });

  it('readings after now are dropped for timeline, confidence and breach', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 28, 1), reading(2, 60, 5)], at(3));
    expect(e.breach).toBeNull();
    expect(e.segments.map((s) => s.temp_c)).toEqual([30, 28]);
    expect(e.confidence).toBe('medium');
    expect(e.hours_since_last_reading).toBe(2);
  });

  it('readings before harvested_at are clamped to start at harvested_at (latest one wins)', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 20, -3), reading(2, 25, -1), reading(3, 30, 2)], at(4));
    expect(e.segments).toEqual([
      { from: T0, to: at(2), temp_c: 25, hours: 2, rate: Number((2 ** 1.5).toFixed(4)), assumed: false },
      { from: at(2), to: at(4), temp_c: 30, hours: 2, rate: 4, assumed: false },
    ]);
    expect(e.thermal_load_degree_hours).toBe(2 * 15 + 2 * 20);
  });

  it('segments are contiguous from harvest to now and their hours sum to the elapsed time', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 33, 1), reading(2, 35, 2.5), reading(3, 30, 6)], at(8));
    expect(e.segments[0].from).toBe(T0);
    expect(e.segments[e.segments.length - 1].to).toBe(at(8));
    for (let i = 1; i < e.segments.length; i += 1) expect(e.segments[i].from).toBe(e.segments[i - 1].to);
    expect(e.segments.reduce((acc, s) => acc + s.hours, 0)).toBeCloseTo(8, 6);
    expect(e.segments[0]).toMatchObject({ temp_c: 30, assumed: true });
  });

  it('the last reading is "assumed" only when strictly older than 2 h', () => {
    const fresh = evaluate(TOMATO, T0, [reading(1, 30, 0), reading(2, 30, 1)], at(3));
    expect(fresh.current_temp_assumed).toBe(false);
    expect(fresh.confidence).toBe('high');
    const stale = evaluate(TOMATO, T0, [reading(1, 30, 0), reading(2, 30, 1)], at(3.01));
    expect(stale.current_temp_assumed).toBe(true);
    expect(stale.confidence).toBe('medium');
    expect(stale.segments[stale.segments.length - 1].assumed).toBe(true);
  });

  it('confidence: medium up to 8 h, low beyond', () => {
    expect(evaluate(TOMATO, T0, [reading(1, 30, 0)], at(8)).confidence).toBe('medium');
    expect(evaluate(TOMATO, T0, [reading(1, 30, 0)], at(8.01)).confidence).toBe('low');
  });

  it('now before harvested_at yields an empty timeline (no zero-length segments) rather than negative hours', () => {
    const e = evaluate(TOMATO, at(2), [], T0);
    expect(e.consumed_fraction).toBe(0);
    expect(e.segments).toEqual([]);
    expect(e.current_temp_c).toBe(30);
    expect(e.current_temp_assumed).toBe(true);
    expect(e.hours_since_last_reading).toBeNull();
    expect(e.remaining_hours.mid).toBe(72);
  });

  it('now == harvested_at with no readings: no segments, ambient assumed', () => {
    const e = evaluate(TOMATO, T0, [], T0);
    expect(e.segments).toEqual([]);
    expect(e.consumed_fraction).toBe(0);
    expect(e.remaining_hours.mid).toBe(72);
    expect(e.expected_end.mid).toBe(at(72));
  });

  it('zero-duration segments are never emitted; a reading exactly at now still defines T_now', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 20, 0), reading(2, 30, 2)], at(2));
    expect(e.segments.map((s) => [s.temp_c, s.hours])).toEqual([[20, 2]]);
    expect(e.current_temp_c).toBe(30);
    expect(e.current_temp_assumed).toBe(false);
    expect(e.hours_since_last_reading).toBe(0);
    expect(e.confidence).toBe('high');
  });

  it('a whole shelf life at 30 C clamps consumed to 1 -> spoiled with no breach', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 30, 0)], at(100));
    expect(e.consumed_fraction).toBe(1);
    expect(e.status).toBe('spoiled');
    expect(e.breach).toBeNull();
    expect(e.remaining_hours.mid).toBe(0);
    expect(e.remaining_hours.low).toBe(0);
    // Optimistic scenario (q10 1.8, L 336): 100 h × 1.8² = 324 h equivalent, so 12/3.24 ≈ 3.7 h remain.
    expect(e.remaining_hours.high).toBeCloseTo((336 - 100 * 1.8 ** 2) / 1.8 ** 2, 1);
    expect(e.expected_end.mid).toBe(at(100));
    expect(e.alerts_crossed).toEqual([75, 50, 25]);
  });
});

// ---------------------------------------------------------------------------

describe('purity and output format', () => {
  const unsorted: ReadingInput[] = [
    { id: 'b', temp_c: 35, taken_at: '2026-08-27T02:30:00.250+00:00' },
    { id: 'c', temp_c: 40, taken_at: at(10) }, // after now: dropped
    { id: 'a', temp_c: 30, taken_at: '2026-08-27T06:00:00+05:30' }, // 00:30Z
  ];

  it('same input -> same output, and inputs are not mutated', () => {
    const snapshot = JSON.stringify(unsorted);
    const a = evaluate(TOMATO, T0, unsorted, at(5));
    const b = evaluate(TOMATO, T0, unsorted, at(5));
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(unsorted)).toBe(snapshot);
    expect(unsorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('computed_at is derived from `now` (not the wall clock); timestamps are UTC Z, whole seconds when possible', () => {
    const e = evaluate(TOMATO, T0, unsorted, at(5));
    expect(e.computed_at).toBe(at(5));
    const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
    for (const s of e.segments) {
      expect(s.from).toMatch(ISO_Z);
      expect(s.to).toMatch(ISO_Z);
    }
    expect(e.segments[0].from).toBe('2026-08-27T00:30:00Z');
    expect(e.segments.map((s) => s.temp_c)).toEqual([30, 35]);
    expect(e.segments[1].from).toBe('2026-08-27T02:30:00.250Z'); // ms kept only where non-zero (Python iso_z)
    expect(e.segments[1].to).toBe(at(5));
    for (const k of ['low', 'mid', 'high'] as const) expect(e.expected_end[k]).toMatch(ISO_SECONDS);
  });

  it('sub-second inputs keep their milliseconds exactly like Python iso_z (never truncated)', () => {
    // harvested_at 06:00:00.999+05:30 == 00:30:00.999Z; reading "a" (00:30:00Z) is clamped to it.
    const e = evaluate(TOMATO, '2026-08-27T06:00:00.999+05:30', unsorted, '2026-08-27T05:30:00.123Z');
    expect(e.computed_at).toBe('2026-08-27T05:30:00.123Z');
    expect(e.segments.map((s) => [s.from, s.to, s.temp_c])).toEqual([
      ['2026-08-27T00:30:00.999Z', '2026-08-27T02:30:00.250Z', 30],
      ['2026-08-27T02:30:00.250Z', '2026-08-27T05:30:00.123Z', 35],
    ]);
    // expected_end = now + whole-ms rounded hours, so it carries now's .123 fraction.
    for (const k of ['low', 'mid', 'high'] as const) expect(e.expected_end[k]).toMatch(/\.123Z$/);
    expect(isoZ(Date.parse('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05Z');
    expect(isoZ(Date.parse('2026-01-02T03:04:05.250Z'))).toBe('2026-01-02T03:04:05.250Z');
  });

  it('expected_end = now + the *rounded* remaining_hours as whole milliseconds, ordered low <= mid <= high', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 28, 0)], at(4));
    for (const k of ['low', 'mid', 'high'] as const) {
      // Python: now + timedelta(milliseconds=round_half_up(rounded_hours * 3.6e6, 0)).
      const expectedMs = Date.parse(at(4)) + Math.floor(e.remaining_hours[k] * 3.6e6 + 0.5);
      expect(Date.parse(e.expected_end[k])).toBe(expectedMs);
      expect(e.expected_end[k]).toMatch(ISO_SECONDS); // 0.1 h = 360 s, so always whole seconds here
    }
    expect(Date.parse(e.expected_end.low)).toBeLessThanOrEqual(Date.parse(e.expected_end.mid));
    expect(Date.parse(e.expected_end.mid)).toBeLessThanOrEqual(Date.parse(e.expected_end.high));
  });

  it('roundHalfUp is floor(x * 10^n + 0.5) / 10^n, bit-for-bit the Python round_half_up', () => {
    expect(roundHalfUp(2.5, 0)).toBe(3);
    expect(roundHalfUp(-2.5, 0)).toBe(-2);
    expect(roundHalfUp(1.25, 1)).toBe(1.3);
    expect(roundHalfUp(0.08333, 4)).toBe(0.0833);
    expect(roundHalfUp(66.04, 1)).toBe(66);
    expect(Object.is(roundHalfUp(-0.04, 1), 0)).toBe(true); // never -0
    // The one input class where Math.round and the shared rule disagree: 0.5 - 2^-54 + 0.5 rounds to 1.
    expect(roundHalfUp(0.49999999999999994, 0)).toBe(1);
    expect(Math.round(0.49999999999999994)).toBe(0);
  });

  it('rounds only at the boundary: fractions 4 dp, hours 1 dp, degree-hours 1 dp', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 28, 0)], at(10));
    const dp = (x: number): number => (x.toString().split('.')[1] ?? '').length;
    expect(dp(e.consumed_fraction)).toBeLessThanOrEqual(4);
    expect(dp(e.remaining_fraction)).toBeLessThanOrEqual(4);
    expect(dp(e.remaining_hours.mid)).toBeLessThanOrEqual(1);
    expect(dp(e.thermal_load_degree_hours)).toBeLessThanOrEqual(1);
    expect(dp(e.hours_since_last_reading as number)).toBeLessThanOrEqual(1);
    expect(e.consumed_fraction + e.remaining_fraction).toBeCloseTo(1, 4);
  });

  it('rejects unparseable timestamps and non-finite temperatures', () => {
    expect(() => evaluate(TOMATO, T0, [], 'yesterday')).toThrow(/now/);
    expect(() => evaluate(TOMATO, 'nope', [], T0)).toThrow(/harvested_at/);
    expect(() => evaluate(TOMATO, T0, [{ id: 'x', temp_c: 30, taken_at: '??' }], T0)).toThrow(/taken_at/);
    expect(() => evaluate(TOMATO, T0, [{ id: 'x', temp_c: Number.NaN, taken_at: T0 }], T0)).toThrow(/temp_c/);
  });
});

// ---------------------------------------------------------------------------

describe('rateMultiplier / consumedAfter', () => {
  it('q10 law with floor and ceiling clamps', () => {
    expect(rateMultiplier(TOMATO, 10)).toBe(1);
    expect(rateMultiplier(TOMATO, 20)).toBe(2);
    expect(rateMultiplier(TOMATO, 30)).toBe(4);
    expect(rateMultiplier(TOMATO, 5)).toBe(1); // chilling floor at 10
    expect(rateMultiplier(GUAVA, 4)).toBe(rateMultiplier(GUAVA, 8));
    expect(rateMultiplier(TOMATO, 30, 2.4)).toBeCloseTo(2.4 ** 2, 12);
  });

  it('consumedAfter adds hours × r(T) / L_ref and clamps to [0, 1]', () => {
    const e = evaluate(TOMATO, T0, [reading(1, 30, 0)], at(6));
    expect(consumedAfter(TOMATO, e, 3, 30)).toBeCloseTo(e.consumed_fraction + (3 * 4) / 288, 6);
    expect(consumedAfter(TOMATO, e, 1000, 30)).toBe(1);
    expect(consumedAfter(PHARMA, evaluate(PHARMA, T0, [], T0), 5, 5)).toBe(0);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
  });
});
