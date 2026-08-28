# 3. FarmSignal — End-to-End Flow

> Step-by-step user journeys and the full data lifecycle, traced through the actual code paths. Use this to answer "what exactly happens when…" questions.

---

## 3.1 Journey 0 — First Launch & "Login" (device identity, no OTP)

There is **no username/password**. The device *is* the credential (PRD NFR: phone-OTP optional, off in demo).

| Step | What happens | Code |
|---|---|---|
| 1 | User opens the PWA URL (or the home-screen icon). Workbox serves the precached app shell — works even if offline on a second visit. | `vite.config.ts` (`generateSW`, `navigateFallback: /index.html`) |
| 2 | `<AppBootstrap/>` runs `bootstrap()`: opens Dexie DB `farmsignal` v1. If IndexedDB is blocked (private mode), a persistent toast explains it. | `src/state/bootstrap.ts` |
| 3 | Persisted clock skew is loaded into memory (`loadClockSkew()`), so `nowIso()` is server-time from the first render. | `src/sync/clock.ts` |
| 4 | `ensureDevice()`: reads `meta.device_id`; on first run generates a UUID v4 and stores it. **This works offline.** | `src/api/auth.ts` → `getOrCreateDeviceId()` |
| 5 | If online and no token: `POST /auth/device {device_id, locale, display_name?}` (anonymous). Server find-or-creates a `farmers` row and mints an HS256 JWT (`sub=farmer_id`, `did=device_id`, 30 d). Token stored in `localStorage 'fs.token'`, `farmer_id` in Dexie meta. | `services/api/app/routers/auth.py` → `create_token()` |
| 6 | `startSyncLoop()` registers `online` / `visibilitychange` listeners + a 60 s timer and runs one immediate `drain()`. | `src/sync/index.ts` |
| 7 | Home renders from Dexie live queries. Empty state points at "+ Log harvest" and Settings → demo data. | `src/pages/Home.tsx` |

**Demo identity path (Settings → "Use demo identity & load demo data"):** drain under the current identity → `POST /demo/seed` → server returns the demo farmer's token + 6 batch ids + `loss_comparison` → PWA stores identity in meta, drops the previous farmer's synced batches, drains again to pull the seeded batches. (`src/components/settings/DemoSection.tsx`)

---

## 3.2 Journey 1 — Log a Harvest Offline and Get a Shelf-Life Range (< 5 s)

This is the airplane-mode segment of the demo.

| Step | User action / system behaviour | Code |
|---|---|---|
| 1 | Tap **New batch** → crop tile (tomato/guava with images) → quantity via stepper/numeric pad (e.g. 500 kg) → harvest time quick-pick ("now") → GPS requested **non-blocking**; if unavailable, falls back to `meta.demo_origin` or the bundled `DEMO_ORIGIN` from `mandis.json` with a visible note. Optional first temperature reading. | `src/pages/NewBatch.tsx`, `src/hooks/useGeolocation.ts` |
| 2 | **Save** → `repo.createBatch()`: generates batch UUID v4 client-side, computes `origin_geohash` (precision 7), writes `BatchRow{synced:false}` to Dexie **and** enqueues outbox op `{op_id, client_seq: nextClientSeq(), kind:"batch.create", payload: BatchCreate, client_time}` with `skew_applied_seconds` recorded. Nothing awaits the network. | `src/db/repo.ts`, `src/db/outbox.ts` |
| 3 | Voice: `play('batch_logged')` → looks up `/audio/ta/batch_logged.mp3` in the manifest; falls back to `speechSynthesis` (`ta-IN`) with a "TTS fallback" label. | `src/voice/index.ts` |
| 4 | Navigate to `/batch/:id`. `useShelfLife()` posts `{protocol: PROTOCOLS['tomato'], harvested_at, readings: [], now: nowIso()}` to the **kinetics Web Worker**. | `src/hooks/useShelfLife.ts`, `src/worker/client.ts` |
| 5 | Worker runs `evaluate()` (TS mirror of contract §2.2): no readings → one segment at `default_ambient_c = 30 °C` flagged `assumed`; `r(30) = 2.0^((30−10)/10) = 4`; three scenarios (mid Q10 2.0/L 288 h; high 1.8/336 h; low 2.4/240 h) → remaining ≈ **42–104 h, most likely 72 h**; `confidence: "low"` (no readings); `status: "fresh"`. | `src/engine/index.ts` ≡ `services/api/app/kinetics/engine.py` |
| 6 | `CountdownRange` renders the range with the note "assumed 30 °C — add a reading". Recomputes every 60 s. | `src/components/CountdownRange.tsx` |
| 7 | User taps **Add reading** → 24 °C → `repo.addReading()`: reading UUID v4 client-side, `taken_at = nowIso()`, `source: "manual"`, geohash; Dexie write + outbox op `reading.append`. | `src/components/AddReadingSheet.tsx`, `src/db/repo.ts` |
| 8 | Worker recomputes: segment 1 (harvest → reading) assumed 30 °C, segment 2 at 24 °C held to `now`; `r(24) = 2^1.4 = 2.64`; range jumps to ≈ **71–148 h (109 h)**; `confidence: "medium"` (1 reading ≤ 8 h old). Every reading tightens the estimate. | same |
| 9 | `checkAlerts()` compares `alerts_crossed` with the per-batch fired-set in Dexie meta; nothing crossed yet. | `src/alerts/index.ts` |

**Time budget:** steps 1–6 are the "≤ 30 s to log, ≤ 5 s to estimate" PRD targets; the worker round-trip is milliseconds.

---

## 3.3 Journey 2 — Reconnect & Sync (idempotent, clock-skew-corrected)

| Step | What happens | Code |
|---|---|---|
| 1 | Airplane mode off → browser fires `online` → `drain()` (single in-flight promise; concurrent callers share it). | `src/sync/index.ts` |
| 2 | Any ops left `inflight` by a dead tab are reset to `pending`. Rows with status `pending`/`failed` that are retryable and *due* (backoff elapsed) are loaded, sorted by `client_seq`, capped at 200. | `doDrain()` |
| 3 | Ops are split into **contiguous runs of equal skew**; each run is one `POST /sync {device_id, client_now: Date.now() − run.skew, ops[]}` with a 20 s timeout. Ops are marked `inflight`, `attempts++`. | `splitRuns()`, `sendRun()` |
| 4 | Server (`apply_sync`): verifies token; checks `body.device_id == farmer.device_id` (else 401); computes `skew = client_now − server_now`; if `|skew| > 120 s` builds a `shift = −skew`. | `services/api/app/services/sync.py` |
| 5 | Ops applied in `client_seq` order, **each in a SAVEPOINT**: <br>• `batch.create` → `upsert_batch()`; same id → `duplicate`; other farmer's id → `rejected` (409 `ID_IN_USE`).<br>• `reading.append` → `append_reading()`: `seq = max+1`, `prev_hash` = previous hash or genesis, `hash = sha256(prev ‖ canonical_payload)`; existing id → `duplicate`, never an update.<br>• `batch.update` → LWW by `client_seq`.<br>Timestamps (`harvested_at`, `client_created_at`, `taken_at`) are shifted when `shift` is set and the result carries `clock_adjusted: true`. | `_apply_batch_create`, `_apply_reading_append`, `services/readings.py` |
| 6 | Each op is recorded in `sync_ops` (dedupe log). A previously `rejected` op is re-attempted; `applied`/`duplicate` ones are answered `duplicate` on replay without touching the DB. | `_record()`, `apply_op()` |
| 7 | Response: `{server_now, clock_skew_seconds, results[], batches[] (full farmer batch list with embedded shelf_life + readings), alerts[]}`. | `SyncResponse` |
| 8 | Client: `applied`/`duplicate` → op `done`; `rejected` → `failed` with `last_error` (exponential backoff, parked after 5). Server readings (with `seq`/`hash`/`prev_hash`) are merged via `applyServerReading()`; `applyServerBatches()` upserts the authoritative batch list. Skew stored as `run.skew + residual`. Toast "N changes synced"; if `clock_adjusted`, toast "clock adjusted by N min". | `sendRun()`, `src/db/repo.ts` |
| 9 | Batch detail now shows the **chain head** under the readings and the server estimate matches the phone's (same golden-tested engine). | `src/components/ReadingsTimeline.tsx` |

**Why not Workbox Background Sync for `/sync`?** A verbatim replay hours later would carry a stale `client_now`; the server would read it as a huge skew and shift every timestamp. The Dexie outbox is the *only* durable retry queue. (`src/pwa/runtimeCaching.ts` header comment.)

---

## 3.4 Journey 3 — "Sell where?" Recommendation and the "Why?" Screen

| Step | What happens | Code |
|---|---|---|
| 1 | On `/batch/:id`, `useRecommendation()` first reads the cached recommendation from Dexie meta `rec:<id>` (offline users see the last answer instantly). | `src/hooks/useRecommendation.ts` |
| 2 | If online: `await drain()` (batch must exist server-side) → `GET /batches/{id}/recommendation` (10 s timeout). | same |
| 3 | Server router: loads batch + readings (ordered by seq), `evaluate_detailed()` → estimate + **unrounded** `consumed_mid`; loads 13 mandis; `get_latest_prices(db, "Tomato")` → latest row per mandi (lazy-loads the bundled snapshot if the DB is empty). | `services/api/app/routers/recommendations.py` |
| 4 | `recommend()` (pure): <br>• origin = batch lat/lon (or `demo_origin`, flagged `origin_assumed`)<br>• `transit_temp = max(last reading if ≤ 2 h old, default_ambient 30 °C)`<br>• `time_limit = remaining_at(transit_temp, mid) × 0.8`; `time_limit_pessimistic` with the low scenario<br>• per mandi: `straight_km` (haversine) × 1.3 → `distance_km`; `/35` → `travel_hours`; `consumed_at_arrival = clamp(consumed_now + travel_hours × r(transit)/L_ref)`; `gross = price/100 × qty × (1 − consumed_at_arrival)`; `transport = distance_km × 12`; `expected = gross − transport`<br>• gates in order: `too_far_for_shelf_life` → `negative_expected_value` → `risky_in_pessimistic_case` (flag only)<br>• rank feasible by `(not feasible_pessimistic, price_is_stale, −expected)`. | `services/api/app/routing/engine.py` |
| 5 | Result upserted into `recommendations` (one row per batch) and returned: `top`, `alternatives[≤2]`, `ranked[]`, `nearest`, `rejected[]`, `uplift_vs_nearest_pct`, `constants`, `simulated` (true if any reading is `sim`). | same |
| 6 | Client caches it, plays `recommendation_ready`, renders `RecommendationCard`: **"Hosur, 73 km, ~2 h — expected ₹6,608. Nearest Palacode ₹4,083. +62 %."** Voice `sell_now` fires only when the batch is critical. | `src/components/RecommendationCard.tsx` |
| 7 | Tap **Why?** → `/batch/:id/why`: `candidateRows()` flattens top / alternatives / reachable / nearest / rejected; each row shows modal price + `price_reported_on` + `price_source` chip + stale flag, road km, travel h, transit temp, spoilage at arrival, transport cost, expected value, and reason codes translated via `batch:reasons.*`. The constants and the formula in words (including "value loss is assumed linear") are printed at the bottom. | `src/pages/Why.tsx` |

Worked hero-batch numbers (seed batch #1, tomato 500 kg, cool morning, 4 h old): Hosur 1,600 ₹/q, 72.5 road-km at 35 km/h, transit 30 °C, spoilage at arrival 6.5 %, transport ₹870 → ₹6,608. Koyambedu pays 1,800 but is 320 road-km: truck ₹3,800 and another 11 % lost → ranks lower, shown, not hidden.

---

## 3.5 Journey 4 — Quality Pass: QR, Public Page, Verification, Tamper Detection

| Step | What happens | Code |
|---|---|---|
| 1 | Farmer opens **Quality Pass** on the batch → `/pass/:id` (PublicLayout, no nav). `PassQr` renders a QR of `{PUBLIC_BASE_URL}/pass/{batch_id}?h={chain_head[:16]}` (client-side `qrcode`; server also serves `/quality-pass/{id}/qr.png`). | `src/components/pass/PassQr.tsx`, `app/quality_pass/qr.py` |
| 2 | Trader scans → their browser loads the PWA shell → `GET /quality-pass/{id}` (anonymous, rate-limited 60 r/m). Server builds the **public payload**: crop, protocol name, qty, harvested_at, status, geohash truncated to 4 chars (~20 km), region label ("Dharmapuri belt"), opt-in `display_name`, readings (seq, temp, time, source, first 12 hex of hash), live `shelf_life`, `chain_head`, `chain_length`, `chain_valid`, `simulated`, `verify_url`. Logs a `view` pass_event with an HMAC'd IP. **No farmer_id, device_id, notes or exact GPS.** | `app/quality_pass/service.py` `build_pass_payload()` |
| 3 | Page shows `ThermalTimeline`, `FreshnessBand` (from the range) and `VerifyBadge`. Verification calls `GET /quality-pass/{id}/verify?head=<h from QR>`. Server `verify_chain()` recomputes every link from genesis: `seq` must be consecutive, `prev_hash` must equal the previous *recomputed* hash, stored `hash` must equal the recomputed one. Returns `{valid, chain_head (recomputed), length, first_bad_seq, head_matches}`. | `app/quality_pass/chain.py` |
| 4 | Badge logic (client): `valid=false` → **TAMPERED (chain broken at reading N)**; `valid=true` + QR head present + `head_matches=false` → **TAMPERED (head mismatch)**; `valid=true` + no QR head → **VERIFIED** with "QR head not checked" note; offline → verify local chain (server-hashed rows only) or **UNVERIFIED**. | `src/pages/QualityPass.tsx` |
| 5 | **Tamper demo:** operator edits one reading in SQLite (`update readings set temp_c=18 where … seq=4`). Re-verify → link 4's recomputed hash ≠ stored hash → `valid=false, first_bad_seq=4`; the recomputed head also no longer matches the QR prefix. Badge turns red. | `docs/DEMO-SCRIPT.md §3.45` |
| 6 | Offline fallback for the farmer: if the fetch fails, the page reads the local Dexie copy, recomputes the estimate in the worker and the chain head with `crypto.subtle`, labelled **"Offline copy"**. Workbox also caches pass payloads (`quality-pass-cache`, 30 d) for traders on flaky networks. | `src/engine/hashchain.ts`, `src/pwa/runtimeCaching.ts` |

---

## 3.6 Journey 5 — Threshold Alerts (75 / 50 / 25 %)

| Step | What happens | Code |
|---|---|---|
| 1 | Every estimate (60 s tick or new reading) carries `alerts_crossed` = thresholds where `remaining_fraction × 100 ≤ 75/50/25`. | engine step 9 |
| 2 | `checkAlerts(batchId, estimate)` runs a Dexie transaction on meta `alerts:<batchId>` to find *newly* crossed thresholds (never double-fires, even with concurrent ticks). | `src/alerts/index.ts` |
| 3 | For each new threshold: in-app toast (`kind: alert`, deep-link to the batch, `SIMULATED` chip if applicable); one system Notification via the service worker (`SIMULATED ·` prefix in the title because the OS shade has no chip); one voice clip for the most urgent (`alert_25` beats `alert_75`). First time the batch turns critical: `sell_now` clip + critical toast (no TTL). Last 50 events kept in meta `alertlog` for Settings/FPO. | same |
| 4 | Server side, `/sync` and `/demo/seed` responses include `alerts[]` computed by `batch_alerts()` for open batches — the Phase-2 SMS/IVR gateway consumes exactly this list (`dispatch_alerts()`). | `app/alerts/thresholds.py`, `app/alerts/sms_ivr_stub.py` |

---

## 3.7 Journey 6 — FPO Coordinator View

| Step | What happens | Code |
|---|---|---|
| 1 | `/fpo` loads every local batch; `useEstimates()` recomputes shelf life through the worker with a signature cache (readings + minute bucket) and a 60 s tick. | `src/components/fpo/useEstimates.ts` |
| 2 | `SummaryTiles` (counts by status), `BatchList` sorted by urgency (lowest `remaining_hours.mid` first, closed last), status filter. | `src/components/fpo/` |
| 3 | `FpoMap` (Leaflet, lazy chunk): batch origins vs the 13 mandis, with the cached recommendation drawn as a line from batch to top mandi. OSM tiles cached CacheFirst (500 tiles ≈ a district). | `src/components/fpo/FpoMap.tsx` |

---

## 3.8 Journey 7 — Price Poll Lifecycle (server, background)

| Step | What happens | Code |
|---|---|---|
| 1 | On startup `start_scheduler()` launches one immediate poll in a daemon thread (never blocks boot) and an interval job every `PRICE_POLL_HOURS=6` (`coalesce`, `max_instances=1`). | `app/prices/poller.py` |
| 2 | `refresh_prices(live=live_fetch_enabled())`: for each (commodity ∈ {Tomato, Guava}) × (state ∈ {Tamil Nadu, Karnataka}) fetch `api.data.gov.in` concurrently with `httpx` (5 s timeout, 3 attempts, 1/2/4 s backoff; retry only on 429/5xx/transport errors). | `app/prices/client.py` |
| 3 | `parse_records()` maps `(state, market)` → `mandi_id` via `MarketIndex` (exact, then prefix/substring within state); drops rows with unparsable price/date. | same |
| 4 | `upsert_records(source=agmarknet_live)` on `(mandi_id, commodity, reported_on)`; then `ensure_snapshot_loaded()` inserts any missing snapshot rows with `overwrite=False` (snapshot never clobbers live). Any failure → `error` captured, result source = `bundled_snapshot`; **never raises**. | `app/prices/service.py` |
| 5 | Reads (`/prices`, routing): latest row per mandi; `source` reported as `agmarknet_cache` if a live row is older than 1.5 × poll period; `stale = age > 30 h`. `/health` exposes `{source, fetched_at, stale}`. | same |

---

## 3.9 Complete Data Lifecycle of One Temperature Reading

```
[1] Farmer taps "Add reading: 24 °C"                              (BatchDetail → AddReadingSheet)
        │  id = uuid4() (client), taken_at = nowIso() (skew-corrected), source = "manual",
        │  geohash = encode(lat, lon, 7)
        ▼
[2] Dexie: readings.put({..., synced:false})  +  ops.put({kind:"reading.append", client_seq:n, ...})
        │  (db/repo.ts — one place for every write)
        ▼
[3] Web Worker re-evaluates → ShelfLifeEstimate → UI range updates; checkAlerts() may fire
        ▼
[4] Sync trigger (online / foreground / 60 s) → POST /sync with the op
        ▼
[5] Server apply_sync → SAVEPOINT → append_reading():
        │  temp_c rounded half-up to 1 dp; seq = max(seq)+1; prev_hash = last.hash or genesis(batch_id)
        │  payload = {"batch_id","geohash","reading_id","seq","source","taken_at"(s, Z),"temp_c"(1 dp)}
        │  hash = sha256(prev_hash + "|" + payload)
        │  INSERT readings (append-only, unique(batch_id, seq)); sync_ops row = applied
        ▼
[6] Response entity Reading{seq, hash, prev_hash, received_at} → client applyServerReading()
        │  Dexie row now synced:true with server hashes; chain head shown in ReadingsTimeline
        ▼
[7] Consumers of the stored reading:
        • GET /batches/{id}/shelf-life        → evaluate() over readings ordered by seq
        • GET /batches/{id}/recommendation    → evaluate_detailed() + recommend() → recommendations row
        • GET /quality-pass/{id}              → public payload (hash[:12] per reading) + verify_chain()
        • GET /quality-pass/{id}/verify       → recomputed chain vs stored; first_bad_seq on tamper
        • /sync responses                     → alerts[] via batch_alerts()
```

---

## 3.10 Complete Data Lifecycle of a Price

```
data.gov.in JSON row {state, market, commodity, modal_price:"1600", arrival_date:"25/08/2026", ...}
   → MarketIndex.resolve("Tamil Nadu", "Hosur") = "hosur"
   → PriceRecord(mandi_id="hosur", commodity="Tomato", modal_price=1600.0, reported_on=2026-08-25)
   → mandi_prices upsert (source=agmarknet_live, fetched_at=now)      [or bundled_snapshot if live failed]
   → get_latest_prices("Tomato") → MandiPriceOut{source (live|cache|snapshot), fetched_at, reported_on}
   → routing: gross = 1600/100 × 500 kg × (1 − 0.065) = ₹7,478 ; − transport ₹870 = ₹6,608
   → MandiCandidate carries price_source, price_reported_on, price_is_stale, price_age_days
   → Why screen shows "Agmarknet, reported 25 Aug, source: bundled_snapshot" chip
   → PWA also caches GET /prices via Workbox NetworkFirst (7 d) for offline display
```

---

## 3.11 Failure Modes and What the User Sees

| Failure | Behaviour (from code) |
|---|---|
| No network at all | Logging, countdown, alerts, offline pass copy all work; outbox badge shows pending count |
| API down but network up | `ApiError` status 0/5xx → ops back to `pending`; retried next trigger; UI unaffected |
| Captive portal returns HTML 200 | `isSyncResponse()` rejects it; ops back to `pending` |
| Token expired / server reset | 401 → token cleared → `ensureDevice()` re-auths on next drain |
| Phone clock wrong by > 2 min | Server shifts timestamps, flags `clock_adjusted`; client stores accumulated skew; toast explains |
| Agmarknet down | `/prices` and recommendations served from DB cache or bundled snapshot with `source` + `stale` labels; **never an error screen** |
| Op rejected by server (validation) | `failed` + exponential backoff; after 5 attempts parked and listed in Settings → Discard |
| IndexedDB blocked | Persistent toast "This browser is blocking local storage…" |
| Worker unavailable / crashes | Inline evaluation fallback; else server `shelf_life` shown with source "server" |
| Voice clip missing | `speechSynthesis` fallback with a visible "TTS fallback" chip |
| Another tab holds the DB | Dexie `blocked` → toast "close other tabs"; `versionchange` → reload |
