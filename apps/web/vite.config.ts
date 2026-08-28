import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { RUNTIME_CACHING } from './src/pwa/runtimeCaching';

// Runtime caching lives in src/pwa/runtimeCaching.ts so src/pwa.test.ts can pin it without esbuild.

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
        runtimeCaching: RUNTIME_CACHING,
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
        // Contract §9: Leaflet and QR only load with their pages (Fpo / QualityPass). Everything else
        // from node_modules (react, react-dom, react-router, dexie, i18next, workbox-window…) plus
        // Rollup's commonjs helpers go to one 'vendor' chunk, so the leaflet/qrcode chunks depend on
        // vendor and never the other way round — the entry chunk must not statically import Leaflet.
        manualChunks(id) {
          const p = id.replace(/\\/g, '/');
          if (/\/node_modules\/(leaflet|react-leaflet|@react-leaflet)\//.test(p)) return 'leaflet';
          if (/\/node_modules\/(qrcode|dijkstrajs|encode-utf8|pngjs)\//.test(p)) return 'qrcode';
          if (p.includes('/node_modules/') || p.includes('commonjsHelpers')) return 'vendor';
          return undefined;
        },
      },
    },
  },
});
