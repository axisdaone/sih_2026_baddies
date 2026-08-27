/**
 * PURE kinetics engine (contract §2.2). No DOM, no React — runs in the Web Worker, the main thread
 * (fallback) and vitest. Output must be identical to services/api/app/kinetics/engine.py; the golden
 * cases in data/demo_scenarios/golden_kinetics.json are the cross-language test.
 *
 * Float64 throughout; rounding happens only when the output object is assembled
 * (fractions 4 dp, hours / degree-hours 1 dp, segment rate 4 dp).
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
import { hoursBetween, MS_PER_HOUR, parseIso, roundTo, toIsoSeconds } from './time';

export const MODEL_VERSION = 'kinetics-1.0';
/** A last reading older than this makes the current temperature "assumed" and caps confidence. */
export const STALE_READING_HOURS = 2;
export const MEDIUM_CONFIDENCE_MAX_HOURS = 8;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
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
 * §2.2 step 1. Zero-length pieces are omitted, except the final one (the "current" hold), which is
 * always present so the last piece defines T_now even when now == last reading == harvested_at.
 * Readings before harvested_at start at harvested_at (earlier ones collapse to zero length and drop).
 */
function buildTimeline(protocol: DecayProtocol, harvestMs: number, nowMs: number, readings: ParsedReading[]): Piece[] {
  const pieces: Piece[] = [];
  const endMs = Math.max(nowMs, harvestMs);
  const push = (fromMs: number, toMs: number, tempC: number, assumed: boolean, force = false): void => {
    if (toMs > fromMs || force) pieces.push({ fromMs, toMs: Math.max(toMs, fromMs), tempC, assumed });
  };

  if (readings.length === 0) {
    push(harvestMs, endMs, protocol.default_ambient_c, true, true);
    return pieces;
  }
  push(harvestMs, Math.max(readings[0].ms, harvestMs), protocol.default_ambient_c, true);
  for (let i = 0; i < readings.length; i += 1) {
    const r = readings[i];
    const isLast = i === readings.length - 1;
    const fromMs = Math.max(r.ms, harvestMs);
    const toMs = isLast ? endMs : Math.max(readings[i + 1].ms, harvestMs);
    const assumed = isLast && hoursBetween(r.ms, nowMs) > STALE_READING_HOURS;
    push(fromMs, toMs, r.temp_c, assumed, isLast);
  }
  return pieces;
}

/** §2.2 step 6: strict comparisons (> max, < min); first breaching reading in time order wins. */
function findBreach(protocol: DecayProtocol, readings: ParsedReading[]): ThresholdBreach | null {
  for (const r of readings) {
    for (const t of protocol.hard_thresholds) {
      const hit = t.type === 'max_temp' ? r.temp_c > t.value_c : r.temp_c < t.value_c;
      if (hit) return { type: t.type, value_c: r.temp_c, reading_id: r.id, at: toIsoSeconds(r.ms), label: t.label };
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
  const kept = prepareReadings(readings, nowMs);
  const pieces = buildTimeline(protocol, harvestMs, nowMs, kept);
  const hours = pieces.map((p) => Math.max(0, hoursBetween(p.fromMs, p.toMs)));
  const current = pieces[pieces.length - 1];
  const tNow = current.tempC;

  const last = kept.length > 0 ? kept[kept.length - 1] : null;
  const hoursSinceLast = last ? hoursBetween(last.ms, nowMs) : null;

  // Steps 3-5: integrate each scenario.
  const breach = findBreach(protocol, kept);
  const sc = scenarios(protocol);
  const consumed = {} as Scenarios<number>;
  const remaining = {} as Scenarios<number>;
  for (const key of ['low', 'mid', 'high'] as const) {
    const { q10, lRef } = sc[key];
    if (breach) {
      consumed[key] = 1;
      remaining[key] = 0;
      continue;
    }
    let equivalentHours = 0;
    for (let i = 0; i < pieces.length; i += 1) equivalentHours += hours[i] * rateMultiplier(protocol, pieces[i].tempC, q10);
    const c = clamp(equivalentHours / lRef, 0, 1);
    const rNow = rateMultiplier(protocol, tNow, q10);
    // r = 0 (pharma, in band): report budget remaining rather than infinity.
    remaining[key] = rNow === 0 ? (1 - c) * lRef : ((1 - c) * lRef) / Math.max(rNow, 1e-6);
    consumed[key] = c;
  }

  // Thermal load uses the raw (unclamped) temperature.
  let thermalLoad = 0;
  for (let i = 0; i < pieces.length; i += 1) thermalLoad += hours[i] * Math.max(0, pieces[i].tempC - protocol.reference_temp_c);

  // Steps 7-9 on the unrounded mid scenario.
  const remainingFraction = 1 - consumed.mid;
  const status = breach ? 'spoiled' : statusFor(remainingFraction);
  const alertsCrossed: AlertThreshold[] = ALERT_THRESHOLDS.filter((t) => remainingFraction * 100 <= t);

  const segments: TemperatureSegment[] = pieces.map((p, i) => ({
    from: toIsoSeconds(p.fromMs),
    to: toIsoSeconds(p.toMs),
    temp_c: p.tempC,
    hours: roundTo(hours[i], 1),
    rate: roundTo(rateMultiplier(protocol, p.tempC, sc.mid.q10), 4),
    assumed: p.assumed,
  }));

  const expectedEnd = (h: number): string => toIsoSeconds(nowMs + h * MS_PER_HOUR);

  return {
    protocol_id: protocol.id,
    model_version: MODEL_VERSION,
    computed_at: toIsoSeconds(nowMs),
    status,
    confidence: confidenceFor(kept.length, hoursSinceLast),
    consumed_fraction: roundTo(consumed.mid, 4),
    remaining_fraction: roundTo(remainingFraction, 4),
    remaining_hours: { low: roundTo(remaining.low, 1), mid: roundTo(remaining.mid, 1), high: roundTo(remaining.high, 1) },
    expected_end: { low: expectedEnd(remaining.low), mid: expectedEnd(remaining.mid), high: expectedEnd(remaining.high) },
    current_temp_c: tNow,
    current_temp_assumed: current.assumed,
    hours_since_last_reading: hoursSinceLast === null ? null : roundTo(hoursSinceLast, 1),
    thermal_load_degree_hours: roundTo(thermalLoad, 1),
    alerts_crossed: alertsCrossed,
    breach,
    segments,
  };
}
