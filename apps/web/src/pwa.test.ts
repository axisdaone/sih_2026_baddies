/**
 * Pins the service-worker runtime-caching choices (vite.config.ts) that have correctness
 * consequences: POST /api/v1/sync must NOT be replayed by Workbox Background Sync (a stale
 * `client_now` would be misread as clock skew and shift every timestamp), and API/pass GETs stay
 * network-first so the app never serves stale data when the server is reachable.
 */
import { describe, expect, it } from 'vitest';
import { RUNTIME_CACHING } from './pwa/runtimeCaching';

describe('PWA runtime caching', () => {
  it('does not route POST /sync through Background Sync (the Dexie outbox is the only retry queue)', () => {
    for (const entry of RUNTIME_CACHING) {
      const pattern = entry.urlPattern as RegExp;
      expect(pattern.test('/api/v1/sync')).toBe(false);
      expect(pattern.test('https://farmsignal.example/api/v1/sync')).toBe(false);
      expect((entry as { method?: string }).method).toBeUndefined();
      expect(JSON.stringify(entry.options)).not.toContain('backgroundSync');
    }
  });

  it('keeps reference data and quality-pass payloads network-first', () => {
    const api = RUNTIME_CACHING.find((e) => (e.urlPattern as RegExp).test('/api/v1/prices?commodity=Tomato'));
    const pass = RUNTIME_CACHING.find((e) => (e.urlPattern as RegExp).test('/api/v1/quality-pass/abc'));
    expect(api?.handler).toBe('NetworkFirst');
    expect(pass?.handler).toBe('NetworkFirst');
  });
});
