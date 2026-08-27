/** Pure time helpers. IST is a fixed UTC+05:30 (no DST), so arithmetic can use a constant offset. */

export const HOUR_MS = 3_600_000;
export const IST_OFFSET_MINUTES = 330;

export function hoursBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / HOUR_MS;
}

export function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * HOUR_MS).toISOString();
}

/** ISO string `hours` before `base`. */
export function hoursAgo(base: Date, hours: number): string {
  return new Date(base.getTime() - hours * HOUR_MS).toISOString();
}

/**
 * 06:00 IST on the current IST calendar day; if that is still in the future (before 06:00 IST) the
 * previous day's morning is returned. Used by the "this morning" harvest-time quick pick.
 */
export function thisMorningIST(base: Date, hourIST = 6): string {
  const shifted = new Date(base.getTime() + IST_OFFSET_MINUTES * 60_000);
  let morning = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hourIST, 0, 0) - IST_OFFSET_MINUTES * 60_000;
  if (morning > base.getTime()) morning -= 24 * HOUR_MS;
  return new Date(morning).toISOString();
}

/** Value for an <input type="datetime-local"> in IST ("2026-08-27T11:30"). */
export function toDatetimeLocalIST(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MINUTES * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Inverse of toDatetimeLocalIST; returns null for unparsable input. */
export function fromDatetimeLocalIST(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - IST_OFFSET_MINUTES * 60_000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

/** Round to 1 decimal place (readings are stored and hashed with 1 dp, contract §4). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
