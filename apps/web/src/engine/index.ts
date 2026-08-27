/**
 * PURE kinetics engine (contract §2.2). No DOM, no React — runs in the Web Worker, the main thread
 * (fallback) and vitest. Output must be identical to services/api/app/kinetics/engine.py; the golden
 * cases in data/demo_scenarios/golden_kinetics.json are the cross-language test.
 */
import type { DecayProtocol, ReadingInput, ShelfLifeEstimate } from '../types';

export const MODEL_VERSION = 'kinetics-1.0';

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

/**
 * Full evaluation (§2.2 steps 1-9): timeline segments -> three scenarios -> status / confidence / alerts.
 * PHASE2: implemented by the engine agent (must pass golden_kinetics.json within 0.05 h / 1e-3).
 */
export function evaluate(
  protocol: DecayProtocol,
  harvestedAt: string,
  readings: ReadingInput[],
  now: string,
): ShelfLifeEstimate {
  void protocol;
  void harvestedAt;
  void readings;
  void now;
  throw new Error('PHASE2');
}
