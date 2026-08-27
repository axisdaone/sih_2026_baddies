/**
 * PURE kinetics engine (contract §2.2). No DOM, no React — runs in the Web Worker, the main thread
 * (fallback) and vitest. Output must be identical to services/api/app/kinetics/engine.py (the
 * authoritative implementation); the golden cases in data/demo_scenarios/golden_kinetics.json are the
 * cross-language behavioural test and data/demo_scenarios/golden_estimates_py.json (dumped from the
 * Python engine) is the byte-for-byte parity reference (see parity.test.ts).
 *
 * Float64 throughout; rounding happens only when the output object is assembled
 * (fractions 4 dp, hours / degree-hours 1 dp, segment rate 4 dp). Every numeric decision the contract
 * leaves open follows engine.py:
 *
 * - Rounding is `floor(x * 10**n + 0.5) / 10**n` (round half up on the scaled double), never Math.round.
 * - `expected_end` = `now` + the *rounded* remaining hours as a whole number of milliseconds, so the
 *   end timestamp and the displayed hours never disagree.
 * - Zero-duration segments are never emitted (a reading exactly at `now` still defines T_now).
 * - `current_temp_c` is the last kept reading's temperature (or `default_ambient_c`), unclamped.
 * - `breach` reports the first breaching reading in time order, the first matching threshold in
 *   protocol order, and the threshold's `value_c` + `label` (not the reading's temperature).
 * - Timestamps serialise as ISO-8601 UTC 'Z' with milliseconds only when non-zero (Python `iso_z`).
 */
import {
  ALERT_THRESHOLDS,
  type AlertThreshold,
  type Confidence,
  type DecayProtocol,
  type ReadingInput,
  type Scenarios,
  type ShelfLifeEstimate,
  type ShelfLifeStatus,
  type TemperatureSegment,
  type ThresholdBreach,
} from '../types';
import { hoursBetween, MS_PER_HOUR, parseIso } from './time';

export const MODEL_VERSION = 'kinetics-1.0';
/** A last reading older than this makes the current temperature "assumed" and caps confidence. */
export const STALE_READING_HOURS = 2;
export const MEDIUM_CONFIDENCE_MAX_HOURS = 8;
/** Guard against division by a zero rate (contract step 4). */
export const MIN_RATE = 1e-6;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Round half up on the scaled double: `floor(x * 10**n + 0.5) / 10**n`. This is exactly Python's
 * `round_half_up` in engine.py (Math.round differs from it on a handful of last-ulp inputs, so it is
 * deliberately not used here). Never returns -0.
 */
export function roundHalfUp(x: number, ndigits: number): number {
  const scale = 10 ** ndigits;
  return Math.floor(x * scale + 0.5) / scale;
}

/**
 * Epoch ms -> ISO-8601 UTC with 'Z'; milliseconds kept only when non-zero, exactly like Python's
 * `iso_z` (`2026-08-27T06:30:00Z`, `2026-08-27T06:30:00.250Z`).
 */
export function isoZ(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.endsWith('.000Z') ? iso.slice(0, -5) + 'Z' : iso;
}

/**
 * Rate multiplier r(T) (§2.2 step 2).
 * q10 model:       T' = clamp(T, min_effective, max_effective); r = q10 ** ((T' - T_ref) / 10)
 * excursion model: r = 0 inside band_c, else 1
 * `q10` overrides the protocol's nominal Q10 (used for the low/high scenarios).
 */
export function rateMultiplier(protocol: DecayProtocol, tempC: number, q10?: number): number {
  if (protocol.model === 'excursion') {
    const band = protocol.band_c ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
    return tempC >= band[0] && tempC <= band[1] ? 0 : 1;
  }
  const lo = protocol.min_effective_temp_c ?? Number.NEGATIVE_INFINITY;
  const hi = protocol.max_effective_temp_c ?? Number.POSITIVE_INFINITY;
  const t = clamp(tempC, lo, hi);
  const q = q10 ?? protocol.q10 ?? 2;
  return Math.pow(q, (t - protocol.reference_temp_c) / 10);
}

/**
 * Consumed fraction (mid scenario) after holding `hours` more at `tempC`, starting from `estimate`.
 * Used by routing previews ("consumed_at_arrival", §3): clamp(consumed + hours × r(T) / L_ref, 0, 1).
 */
export function consumedAfter(protocol: DecayProtocol, estimate: ShelfLifeEstimate, hours: number, tempC: number): number {
  const lRef = protocol.reference_shelf_life_hours;
  return clamp(estimate.consumed_fraction + (hours * rateMultiplier(protocol, tempC)) / lRef, 0, 1);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ParsedReading extends ReadingInput {
  ms: number;
}

/** One piecewise-constant stretch of the timeline (unrounded). */
interface Piece {
  fromMs: number;
  toMs: number;
  tempC: number;
  hours: number;
  assumed: boolean;
}

/** (q10, L_ref) pair for one scenario; q10 undefined = protocol nominal (or n/a for excursion). */
interface Scenario {
  q10: number | undefined;
  lRef: number;
}

/**
 * §2.2 step 5. mid = (q10, L_ref); high (optimistic) = (q10_range[0], L_range[1]);
 * low (pessimistic) = (q10_range[1], L_range[0]). Excursion protocols carry ±10 % of the budget in
 * reference_shelf_life_range_hours, so the same data path serves both models.
 */
function scenarios(protocol: DecayProtocol): Scenarios<Scenario> {
  const nominalQ = protocol.q10 ?? undefined;
  const [qOptimistic, qPessimistic] = protocol.q10_range ?? [nominalQ, nominalQ];
  const [lPessimistic, lOptimistic] = protocol.reference_shelf_life_range_hours;
  return {
    low: { q10: qPessimistic, lRef: lPessimistic },
    mid: { q10: nominalQ, lRef: protocol.reference_shelf_life_hours },
    high: { q10: qOptimistic, lRef: lOptimistic },
  };
}

/** Sort by taken_at (stable), drop readings after `now`, validate temperatures. Never mutates input. */
function prepareReadings(readings: ReadingInput[], nowMs: number): ParsedReading[] {
  const parsed: ParsedReading[] = [];
  for (const r of readings) {
    if (!Number.isFinite(r.temp_c)) throw new Error(`invalid temp_c for reading ${r.id}: ${String(r.temp_c)}`);
    const ms = parseIso(r.taken_at, `reading ${r.id} taken_at`);
    if (ms <= nowMs) parsed.push({ ...r, ms });
  }
  return parsed.sort((a, b) => a.ms - b.ms);
}

/**
 * §2.2 step 1 (mirrors engine.py `_build_timeline`). Segment bounds are clamped into
 * [harvested_at, now] and empty (zero or negative length) segments are dropped — including the final
 * one, so a reading exactly at `now` (or `now <= harvested_at`) yields no segment for it.
 */
function buildTimeline(protocol: DecayProtocol, harvestMs: number, nowMs: number, readings: ParsedReading[]): Piece[] {
  const pieces: Piece[] = [];
  const push = (fromMs: number, toMs: number, tempC: number, assumed: boolean): void => {
    const start = Math.max(fromMs, harvestMs);
    const end = Math.min(toMs, nowMs);
    if (end <= start) return;
    pieces.push({ fromMs: start, toMs: end, tempC, hours: hoursBetween(start, end), assumed });
  };

  if (readings.length === 0) {
    push(harvestMs, nowMs, protocol.default_ambient_c, true);
    return pieces;
  }
  push(harvestMs, readings[0].ms, protocol.default_ambient_c, true);
  for (let i = 0; i < readings.length; i += 1) {
    const r = readings[i];
    const isLast = i === readings.length - 1;
    const toMs = isLast ? nowMs : readings[i + 1].ms;
    const assumed = isLast && hoursBetween(r.ms, nowMs) > STALE_READING_HOURS;
    push(r.ms, toMs, r.temp_c, assumed);
  }
  return pieces;
}

/**
 * §2.2 step 6: strict comparisons (> max, < min); first breaching reading in time order wins, then the
 * first matching threshold in protocol order. Reports the threshold's value_c and label.
 */
function findBreach(protocol: DecayProtocol, readings: ParsedReading[]): ThresholdBreach | null {
  const thresholds = protocol.hard_thresholds ?? [];
  for (const r of readings) {
    for (const t of thresholds) {
      const hit = t.type === 'max_temp' ? r.temp_c > t.value_c : t.type === 'min_temp' ? r.temp_c < t.value_c : false;
      if (hit) return { type: t.type, value_c: t.value_c, reading_id: r.id, at: isoZ(r.ms), label: t.label ?? null };
    }
  }
  return null;
}

function statusFor(remainingFraction: number): ShelfLifeStatus {
  if (remainingFraction > 0.5) return 'fresh';
  if (remainingFraction > 0.25) return 'warning';
  if (remainingFraction > 0) return 'critical';
  return 'spoiled';
}

function confidenceFor(readingCount: number, hoursSinceLast: number | null): Confidence {
  if (hoursSinceLast === null) return 'low';
  if (readingCount >= 2 && hoursSinceLast <= STALE_READING_HOURS) return 'high';
  if (readingCount >= 1 && hoursSinceLast <= MEDIUM_CONFIDENCE_MAX_HOURS) return 'medium';
  return 'low';
}

/** Contract step 4; an excursion batch that is in band reports budget remaining. */
function remainingHours(protocol: DecayProtocol, consumed: number, tempNow: number, sc: Scenario): number {
  const rate = rateMultiplier(protocol, tempNow, sc.q10);
  if (protocol.model === 'excursion' && rate === 0) return (1 - consumed) * sc.lRef;
  return ((1 - consumed) * sc.lRef) / Math.max(rate, MIN_RATE);
}

/** `now` + rounded hours as a whole number of milliseconds (engine.py `_end_at`). */
function endAt(nowMs: number, roundedHours: number): string {
  return isoZ(nowMs + roundHalfUp(roundedHours * MS_PER_HOUR, 0));
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Full evaluation (§2.2 steps 1-9): timeline segments -> three scenarios -> status / confidence / alerts.
 * Pure: same inputs give the same output; `computed_at` is `now`, never the wall clock.
 * Throws on unparseable timestamps or non-finite temperatures (the worker turns that into an error reply).
 */
export function evaluate(
  protocol: DecayProtocol,
  harvestedAt: string,
  readings: ReadingInput[],
  now: string,
): ShelfLifeEstimate {
  const nowMs = parseIso(now, 'now');
  const harvestMs = parseIso(harvestedAt, 'harvested_at');

  // Step 1: drop future readings, stable sort by taken_at, build the timeline.
  const kept = prepareReadings(readings, nowMs);
  const pieces = buildTimeline(protocol, harvestMs, nowMs, kept);

  let hoursSinceLast: number | null = null;
  let currentTemp: number;
  let currentAssumed: boolean;
  if (kept.length > 0) {
    const last = kept[kept.length - 1];
    hoursSinceLast = hoursBetween(last.ms, nowMs);
    currentTemp = last.temp_c;
    currentAssumed = hoursSinceLast > STALE_READING_HOURS;
  } else {
    currentTemp = protocol.default_ambient_c;
    currentAssumed = true;
  }

  // Steps 2-5: integrate each scenario (same summation order as Python).
  const sc = scenarios(protocol);
  const consumed = {} as Scenarios<number>;
  const remaining = {} as Scenarios<number>;
  for (const key of ['mid', 'high', 'low'] as const) {
    let total = 0;
    for (const p of pieces) total += p.hours * rateMultiplier(protocol, p.tempC, sc[key].q10);
    consumed[key] = clamp(total / sc[key].lRef, 0, 1);
    remaining[key] = remainingHours(protocol, consumed[key], currentTemp, sc[key]);
  }

  // Step 6: hard thresholds override everything numeric.
  const breach = findBreach(protocol, kept);
  if (breach) {
    for (const key of ['low', 'mid', 'high'] as const) {
      consumed[key] = 1;
      remaining[key] = 0;
    }
  }

  // Steps 7-9 on the unrounded mid scenario.
  const remainingFraction = 1 - consumed.mid;
  const alertsCrossed: AlertThreshold[] = ALERT_THRESHOLDS.filter((t) => remainingFraction * 100 <= t);

  // Thermal load uses the raw (unclamped) temperature.
  let thermalLoad = 0;
  for (const p of pieces) thermalLoad += p.hours * Math.max(0, p.tempC - protocol.reference_temp_c);

  const roundedHours: Scenarios<number> = {
    low: roundHalfUp(remaining.low, 1),
    mid: roundHalfUp(remaining.mid, 1),
    high: roundHalfUp(remaining.high, 1),
  };

  const segments: TemperatureSegment[] = pieces.map((p) => ({
    from: isoZ(p.fromMs),
    to: isoZ(p.toMs),
    temp_c: p.tempC,
    hours: roundHalfUp(p.hours, 1),
    rate: roundHalfUp(rateMultiplier(protocol, p.tempC, sc.mid.q10), 4),
    assumed: p.assumed,
  }));

  return {
    protocol_id: protocol.id,
    model_version: MODEL_VERSION,
    computed_at: isoZ(nowMs),
    status: statusFor(remainingFraction),
    confidence: confidenceFor(kept.length, hoursSinceLast),
    consumed_fraction: roundHalfUp(consumed.mid, 4),
    remaining_fraction: roundHalfUp(remainingFraction, 4),
    remaining_hours: roundedHours,
    expected_end: {
      low: endAt(nowMs, roundedHours.low),
      mid: endAt(nowMs, roundedHours.mid),
      high: endAt(nowMs, roundedHours.high),
    },
    current_temp_c: currentTemp,
    current_temp_assumed: currentAssumed,
    hours_since_last_reading: hoursSinceLast === null ? null : roundHalfUp(hoursSinceLast, 1),
    thermal_load_degree_hours: roundHalfUp(thermalLoad, 1),
    alerts_crossed: alertsCrossed,
    breach,
    segments,
  };
}
