/**
 * Clock skew (contract §7): `clock_skew_seconds = client_now − server_now`, learned on every sync and
 * persisted in meta. The client applies it so all local kinetics "now" values and new timestamps are
 * in server time; because `client_now` is also sent corrected, the server sees ≈0 skew afterwards and
 * never double-shifts.
 */
import { db, META_KEYS } from '../db';

let skewSeconds = 0;
let loaded = false;

/** Cached skew (seconds). 0 until loadClockSkew()/setClockSkewSeconds() has run. */
export function getClockSkewSeconds(): number {
  return skewSeconds;
}

/** Load the persisted skew into the cache (idempotent; never throws). */
export async function loadClockSkew(): Promise<number> {
  if (loaded) return skewSeconds;
  try {
    const stored = await db.getMeta<number>(META_KEYS.clockSkewSeconds);
    if (typeof stored === 'number' && Number.isFinite(stored)) skewSeconds = stored;
  } catch {
    /* IndexedDB unavailable — keep 0 */
  }
  loaded = true;
  return skewSeconds;
}

/** Persist a new skew (seconds) and update the cache. */
export async function setClockSkewSeconds(seconds: number): Promise<void> {
  skewSeconds = Number.isFinite(seconds) ? seconds : 0;
  loaded = true;
  try {
    await db.setMeta(META_KEYS.clockSkewSeconds, skewSeconds);
  } catch {
    /* ignore */
  }
}

/** Current time in server terms, as an ISO UTC string. Use for kinetics `now` and new timestamps. */
export function nowIso(): string {
  return new Date(Date.now() - skewSeconds * 1000).toISOString();
}

/** Same as nowIso() but as a Date. */
export function nowDate(): Date {
  return new Date(Date.now() - skewSeconds * 1000);
}

/** Test hook: reset the in-memory cache. */
export function _resetClockForTests(): void {
  skewSeconds = 0;
  loaded = false;
}
