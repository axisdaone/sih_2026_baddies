/**
 * Device identity (contract §6 auth). A device_id UUID lives in Dexie meta; when online and without a
 * token we exchange it for a JWT via POST /auth/device. Everything here is best-effort and never
 * throws — the app is fully usable offline without a token.
 */
import { api, getToken, setToken } from './client';
import { db, META_KEYS } from '../db';
import { currentLocale } from '../i18n';
import { newId } from '../lib/ids';
import type { DeviceAuthRequest, DeviceAuthResponse } from '../types';

export interface DeviceIdentity {
  deviceId: string;
  farmerId: string | null;
  token: string | null;
}

let inflight: Promise<DeviceIdentity> | null = null;

function isOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine;
}

/** Read the stored device id, creating one on first run. */
export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await db.getMeta<string>(META_KEYS.deviceId);
  if (typeof existing === 'string' && existing.length >= 8) return existing;
  const id = newId();
  await db.setMeta(META_KEYS.deviceId, id);
  return id;
}

/** Read the stored device id without creating one (null on a fresh install). */
export async function getDeviceId(): Promise<string | null> {
  try {
    const id = await db.getMeta<string>(META_KEYS.deviceId);
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

export async function getFarmerId(): Promise<string | null> {
  try {
    const id = await db.getMeta<string>(META_KEYS.farmerId);
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** Forget the token (e.g. after a 401) so the next ensureDevice() re-authenticates. */
export function clearSession(): void {
  setToken(null);
}

async function doEnsure(opts: { force?: boolean }): Promise<DeviceIdentity> {
  let deviceId: string;
  try {
    deviceId = await getOrCreateDeviceId();
  } catch {
    // IndexedDB unavailable: fall back to an ephemeral id so callers still get a usable shape.
    return { deviceId: newId(), farmerId: null, token: getToken() };
  }
  const token = getToken();
  const farmerId = await getFarmerId();
  if ((token && !opts.force) || !isOnline()) return { deviceId, farmerId, token };

  let displayName: string | undefined;
  try {
    const stored = await db.getMeta<string>(META_KEYS.displayName);
    if (typeof stored === 'string' && stored.trim()) displayName = stored.trim();
  } catch {
    /* ignore */
  }
  const body: DeviceAuthRequest = { device_id: deviceId, locale: currentLocale() };
  if (displayName) body.display_name = displayName;
  try {
    const res = await api.post<DeviceAuthResponse>('/auth/device', body, { anonymous: true });
    if (res && typeof res.token === 'string' && res.token) {
      setToken(res.token);
      await db.setMeta(META_KEYS.farmerId, res.farmer_id);
      return { deviceId, farmerId: res.farmer_id, token: res.token };
    }
  } catch {
    /* offline, server down, or CORS — keep working locally */
  }
  return { deviceId, farmerId, token: getToken() };
}

/**
 * Ensure a device id exists and, when online and token-less (or `force`), obtain a token.
 * Concurrent callers share one in-flight request. Never rejects.
 */
export async function ensureDevice(opts: { force?: boolean } = {}): Promise<DeviceIdentity> {
  if (inflight) return inflight;
  inflight = doEnsure(opts)
    .catch(() => ({ deviceId: '', farmerId: null, token: getToken() }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
