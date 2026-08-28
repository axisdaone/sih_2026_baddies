/**
 * Workbox runtime caching for the generated service worker (consumed by vite.config.ts; kept in a
 * plain module so src/pwa.test.ts can pin it without loading the Vite/esbuild toolchain).
 *
 * POST /api/v1/sync is intentionally NOT routed through Workbox Background Sync: a verbatim replay
 * hours later would carry a stale `client_now`, which the server's clock-skew correction would read
 * as a huge skew and use to shift every timestamp in the request. The Dexie outbox (src/sync) is the
 * sole durable retry queue — drained on open, on `online` and every 60 s.
 */
const DAY = 24 * 60 * 60;

export const RUNTIME_CACHING = [
  {
    // Reference data + prices: prefer fresh, fall back to last-known-good.
    urlPattern: /\/api\/v1\/(protocols|mandis|prices)(\/|\?|$)/,
    handler: 'NetworkFirst' as const,
    options: {
      cacheName: 'api-cache',
      networkTimeoutSeconds: 8,
      expiration: { maxEntries: 64, maxAgeSeconds: 7 * DAY },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // Public Quality Pass payloads (a trader opens a QR link on a flaky network).
    urlPattern: /\/api\/v1\/quality-pass\//,
    handler: 'NetworkFirst' as const,
    options: {
      cacheName: 'quality-pass-cache',
      networkTimeoutSeconds: 8,
      expiration: { maxEntries: 100, maxAgeSeconds: 30 * DAY },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
  {
    // OSM raster tiles for the FPO map. 500 tiles covers a district at a few zoom levels.
    urlPattern: /^https:\/\/([a-c]\.)?tile\.openstreetmap\.org\/.*/i,
    handler: 'CacheFirst' as const,
    options: {
      cacheName: 'osm-tiles',
      expiration: { maxEntries: 500, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
];
