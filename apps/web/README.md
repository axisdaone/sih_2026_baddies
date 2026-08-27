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
  components/       Layout (top bar + bottom nav), PublicLayout, Button, Card, SimBadge, OfflineIndicator, UpdateToast
  pages/            Home, NewBatch, BatchDetail, Why, QualityPass, Fpo, Settings (stubs)
```

Routes (contract §9): `/` Home · `/new` · `/batch/:id` · `/batch/:id/why` · `/pass/:id` (public, no bottom nav) · `/fpo` · `/settings`.
Every page is `React.lazy`; Leaflet and `qrcode` are split into their own chunks and must only be imported inside `Fpo` / `QualityPass`.

## i18n

Namespaces: `common`, `batch`, `pass`, `fpo`, `alerts`, `settings`; locales `en` (fallback), `hi`, `ta`.
Add keys to `src/i18n/locales/en/<ns>.json` first, then `hi` and `ta`. Use `useTranslation('<ns>')`.
Language is detected from `localStorage['fs.lang']` then the browser; `setLanguage('hi')` switches and persists.
Numbers: use `useFormat()` (or `i18n/format.ts`) — Hindi/Tamil render native numerals by default (`localStorage['fs.numerals']`).

## Voice clips

Drop pre-recorded MP3s at `public/audio/{en,hi,ta}/{key}.mp3` for the 7 keys
`welcome, batch_logged, alert_75, alert_50, alert_25, sell_now, recommendation_ready` and set the matching
entry in `public/audio/manifest.json` to `"status": "ready"`. Missing clips fall back to `speechSynthesis` with a visible "TTS fallback" label.

## Docker

```
docker build -t farmsignal-web .
docker run -p 8080:80 farmsignal-web      # expects an `api` host on the same network (docker-compose)
```

`nginx.conf` serves the SPA (`try_files ... /index.html`) and proxies `/api/` to `http://api:8000`.
