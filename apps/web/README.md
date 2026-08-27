# FarmSignal — web PWA (`apps/web`)

React 18 + TypeScript + Vite 5 + Tailwind 3 + Dexie 4 + Workbox (vite-plugin-pwa) + i18next + Leaflet.
Implements the frontend half of `docs/ENGINEERING-CONTRACT.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on http://localhost:5173, `/api` proxied to `http://localhost:8000`. The service worker is **enabled in dev** (`devOptions.enabled`), so offline mode / update toast can be demoed without a build. `dev-dist/` is generated and gitignored. |
| `npm run build` | Production build to `dist/` (gitignored). Generates `sw.js` + `manifest.webmanifest`. |
| `npm run preview` | Serve `dist/` locally (no API proxy; run behind nginx or set up your own). |
| `npm run typecheck` | `tsc --noEmit` (strict). |
| `npm test` | `vitest run` (jsdom + fake-indexeddb). `npm run test:watch` for watch mode. |
| `npm run sync-data` | Re-copy `services/api/app/kinetics/protocols/*.json` and `data/mandis.json` into `src/data/`. A test fails if the copies drift. |
| `npm run make-icons` | Regenerate `public/icons/*.png` (pure-Node PNG encoder, no deps). |

All dependencies are pinned to exact versions and already installed; feature work should not need `npm install`.

## Configuration

Only `VITE_*` variables reach the bundle (build time, not runtime). See `.env.example`; copy it to `.env.local` to override.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_BASE` | `/api/v1` (same origin) | Full API prefix the PWA calls (`src/api/client.ts`). Leave unset when the app is served next to the API: `npm run dev` proxies `/api` → `http://localhost:8000`, and `nginx.conf` proxies `/api/` → `http://api:8000`. Set e.g. `https://api.example.com/api/v1` only when the PWA is hosted apart from the API — then the backend needs the PWA origin in `CORS_ORIGINS` and `PUBLIC_BASE_URL` pointing at the PWA (it is baked into Quality Pass QR links). |

Runtime preferences live in `localStorage`: `fs.token` (device bearer token), `fs.lang`, `fs.numerals`, `fs.voice` (`muted` | `on`).

## Layout

```
src/
  types.ts          every wire/domain type (contract §2, §6.1, §7, §8) — import from here
  engine/           PURE kinetics mirror of the Python engine (no DOM)   [PHASE2: evaluate()]
  worker/           kinetics.worker.ts (module worker) + client.ts estimateShelfLife()
  db/               Dexie `farmsignal` v1: batches, readings, ops, prices, mandis, meta
  sync/             outbox enqueue() (real), drain()/startSyncLoop()     [PHASE2]
  api/              typed fetch client (`/api/v1`, bearer 'fs.token', 8 s timeout, ApiError)
  i18n/             i18next init (bundled locales), format.ts (Intl, IST, native numerals), useFormat()
  i18n/locales/{en,hi,ta}/{common,batch,pass,fpo,alerts,settings}.json
  voice/            play(key) — clips at /audio/{locale}/{key}.mp3       [PHASE2]
  alerts/           checkAlerts(batchId, estimate) 75/50/25 %            [PHASE2]
  data/             bundled protocols + mandis (verbatim copies) + PROTOCOLS / MANDIS exports
  state/            AppStatusContext {online, pendingOps, setPendingOps}
  components/       Layout (top bar + bottom nav), PublicLayout, Button, Card, SimBadge, OfflineIndicator, UpdateToast,
                    StatusPill (single status chip + colour tables; `StatusChip` = soft/pass variant), pass/*, fpo/*, settings/*
  pages/            Home, NewBatch, BatchDetail, Why, QualityPass, Fpo, Settings
```

Routes (contract §9): `/` Home · `/new` · `/batch/:id` · `/batch/:id/why` · `/pass/:id` (public, no bottom nav) · `/fpo` · `/settings`.
Every page is `React.lazy`. `vite.config.ts` `manualChunks` produces three vendor chunks: `leaflet` (leaflet + react-leaflet, imported only by `Fpo`),
`qrcode` (imported only by `QualityPass`) and `vendor` (react, react-dom, react-router, dexie, i18next, workbox-window, commonjs helpers — everything else in
`node_modules`). The entry chunk statically imports only `vendor`, so Leaflet (~45 kB gz) never loads on the farmer screens. Critical path
(`index` + `vendor` + CSS, gzip) is ≈ 145 kB against the PRD's 300 kB budget; check with `npm run build` — `grep -l '"./leaflet-' dist/assets/*.js` must list only the Fpo chunk.

## i18n

Namespaces: `common`, `batch`, `pass`, `fpo`, `alerts`, `settings`; locales `en` (fallback), `hi`, `ta`.
Add keys to `src/i18n/locales/en/<ns>.json` first, then `hi` and `ta`. Use `useTranslation('<ns>')`.
Language is detected from `localStorage['fs.lang']` then the browser; `setLanguage('hi')` switches and persists.
Numbers: use `useFormat()` (or `i18n/format.ts`) — Hindi/Tamil render native numerals by default (`localStorage['fs.numerals']`).

## Demo flow

The judged demo (`docs/DEMO-SCRIPT.md`) needs no manual data entry:

1. Start the API (`services/api`, port 8000) and `npm run dev` (port 5173), open http://localhost:5173.
2. **Settings → Demo → "Use demo identity & load demo data"**: `POST /demo/seed` (anonymous) returns the demo farmer's token
   (device `demo-device-001`, display name "Muthu") and the seeded batches (tomato + guava with `source: "sim"` readings — the
   UI shows the SIMULATED chip everywhere they appear). The token is stored in `fs.token`, identity in Dexie `meta`, then `drain()` pulls
   the batches (`GET /batches` as a fallback). Seeding is idempotent; **Reset local data** wipes Dexie + token and reloads.
3. **Settings → Demo → "Use demo origin when GPS is unavailable"** writes Dexie `meta['demo_origin'] = {lat, lon, label}`; New Batch uses it
   (else the bundled `DEMO_ORIGIN` from `data/mandis.json`) whenever geolocation fails or times out, and says so in the batch note ("Location assumed: …").
4. Home shows the countdown ranges; Batch → "Why?" explains the kinetics; Batch → Quality Pass opens `/pass/:id` (public,
   no bottom nav) with the SHA-256 chain verification badge and a QR carrying `?h=<chain head>` — scanning that link is what lets the
   server compare heads (without `?h=` the badge reads VERIFIED with a "QR head not checked" note); FPO shows the district map (Leaflet loads only here).
5. Offline: DevTools → Network → Offline (or airplane mode). Logging a batch and readings keeps working; the top bar shows the offline state and "N pending changes", and
   `POST /sync` drains when the network returns. The Dexie outbox is the only retry queue (drained on open, on `online` and every 60 s;
   ops left `inflight` by a tab that died are re-sent on the next drain). Workbox Background Sync is deliberately *not* used for `/sync`:
   a verbatim replay hours later would carry a stale `client_now`, which the server's clock-skew correction would misread.

## Voice clips

Pre-recorded prompts live at `public/audio/{en,hi,ta}/{key}.mp3` (mp3, mono, 32 kbps) — served as `/audio/<locale>/<key>.mp3` — for the 7 keys
`welcome, batch_logged, alert_75, alert_50, alert_25, sell_now, recommendation_ready` (21 clips). `public/audio/manifest.json` lists every clip
with a `status`; drop a file in and flip it to `"ready"` (recording script and format in `public/audio/README.md`). Missing clips fall back to
`speechSynthesis` with a visible "TTS fallback" label; `voice/play()` never rejects. Mute lives in `localStorage['fs.voice']`.

## Docker

```
docker build -t farmsignal-web .
docker run -p 8080:80 farmsignal-web      # expects an `api` host on the same network (docker-compose)
```

`nginx.conf` serves the SPA (`try_files ... /index.html`) and proxies `/api/` to `http://api:8000`.
