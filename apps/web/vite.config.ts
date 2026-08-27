import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

const DAY = 24 * 60 * 60;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      // main.tsx registers the SW itself via `virtual:pwa-register` (so it can show an update toast).
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png', 'audio/manifest.json'],
      manifest: {
        id: '/',
        name: 'FarmSignal',
        short_name: 'FarmSignal',
        description: 'Offline-first shelf-life countdown and mandi routing for the first-mile cold chain.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#166534',
        background_color: '#ffffff',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // API calls and the SW itself must never be answered with the app shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/sw\.js$/],
        globPatterns: ['**/*.{js,css,html,ico,json,png,svg,mp3,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // Reference data + prices: prefer fresh, fall back to last-known-good.
            urlPattern: /\/api\/v1\/(protocols|mandis|prices)(\/|\?|$)/,
            handler: 'NetworkFirst',
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
            handler: 'NetworkFirst',
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
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Contract §7: Workbox Background Sync retries the outbox POST itself if the tab dies mid-flight.
            urlPattern: /\/api\/v1\/sync$/,
            method: 'POST',
            handler: 'NetworkOnly',
            options: {
              backgroundSync: { name: 'farmsignal-sync', options: { maxRetentionTime: 24 * 60 } },
            },
          },
        ],
      },
      // Lets `npm run dev` demo the service worker (dev-dist/ is gitignored).
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Contract §9: Leaflet and QR only load with their pages. Keep them in named chunks.
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          if (/\/node_modules\/(leaflet|react-leaflet|@react-leaflet)\//.test(p)) return 'leaflet';
          if (/\/node_modules\/(qrcode|dijkstrajs|encode-utf8|pngjs)\//.test(p)) return 'qrcode';
          return undefined;
        },
      },
    },
  },
});
