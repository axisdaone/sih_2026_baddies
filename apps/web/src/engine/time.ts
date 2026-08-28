/**
 * Date/number helpers shared by the kinetics evaluator and the hash chain. Kept dependency-free so
 * the engine stays pure and worker-safe.
 *
 * Wire timestamps are ISO-8601; we parse with Date.parse (accepts 'Z', offsets and milliseconds)
 * and always emit UTC at whole-second precision with a trailing 'Z' (milliseconds truncated, which
 * matches Python's strftime('%Y-%m-%dT%H:%M:%SZ')).
 */

export const MS_PER_HOUR = 3.6e6;

/** Parse an ISO timestamp to epoch milliseconds; throws on garbage so bugs surface instead of NaN. */
export function parseIso(value: string, field: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`invalid ${field} timestamp: ${JSON.stringify(value)}`);
  return ms;
}

/** Epoch ms -> "YYYY-MM-DDTHH:MM:SSZ" (sub-second part truncated). */
export function toIsoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Normalise any parseable ISO string to the canonical seconds-precision UTC form. */
export function normalizeIso(value: string, field: string): string {
  return toIsoSeconds(parseIso(value, field));
}

export function hoursBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / MS_PER_HOUR;
}

/** Round half away from zero-ish (JS Math.round) to `dp` decimals; normalises -0 to 0. */
export function roundTo(x: number, dp: number): number {
  const f = 10 ** dp;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}
