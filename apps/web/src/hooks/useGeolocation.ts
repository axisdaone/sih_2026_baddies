/**
 * Non-blocking GPS fix (PRD F1): resolves within `timeoutMs` (default 5 s) or reports unavailable.
 * Never throws; callers fall back to DEMO_ORIGIN with a visible note.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type GeoStatus = 'idle' | 'locating' | 'ok' | 'unavailable';

export interface GeoFix {
  lat: number;
  lon: number;
  accuracy_m: number | null;
}

export interface GeolocationState {
  status: GeoStatus;
  fix: GeoFix | null;
  retry: () => void;
}

export const GEO_TIMEOUT_MS = 5_000;

export function useGeolocation(opts: { auto?: boolean; timeoutMs?: number } = {}): GeolocationState {
  const { auto = true, timeoutMs = GEO_TIMEOUT_MS } = opts;
  const [status, setStatus] = useState<GeoStatus>('idle');
  const [fix, setFix] = useState<GeoFix | null>(null);
  const attempt = useRef(0);

  const locate = useCallback(() => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo || typeof geo.getCurrentPosition !== 'function') {
      setStatus('unavailable');
      return;
    }
    attempt.current += 1;
    const mine = attempt.current;
    setStatus('locating');
    let settled = false;
    const finish = (next: GeoStatus, value: GeoFix | null) => {
      if (settled || mine !== attempt.current) return;
      settled = true;
      setFix(value);
      setStatus(next);
    };
    const timer = setTimeout(() => finish('unavailable', null), timeoutMs + 500);
    try {
      geo.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          finish('ok', { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy_m: pos.coords.accuracy ?? null });
        },
        () => {
          clearTimeout(timer);
          finish('unavailable', null);
        },
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 },
      );
    } catch {
      clearTimeout(timer);
      finish('unavailable', null);
    }
  }, [timeoutMs]);

  useEffect(() => {
    if (auto) locate();
  }, [auto, locate]);

  return { status, fix, retry: locate };
}
