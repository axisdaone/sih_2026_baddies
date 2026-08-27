# FarmSignal — Product Requirements Document (PRD)

**Version:** 1.0 · **Owner:** Team Baddies · **Status:** Draft for build · **Target:** SIH 2026 prototype → pilot-ready
**PS ID:** IHSIH013 — Digital platform for cold-chain monitoring of perishable food & pharmaceuticals (Theme: Transportation & Logistics)

---

## 1. Product Summary

FarmSignal is an offline-first, regional-language decision-support platform for India's first-mile cold-chain gap — the hours between harvest and the first cold-chain touchpoint, where 6–15% of fruit and vegetable output is lost. A farmer or FPO logs a harvest in under 30 seconds; a crop-specific kinetic spoilage model converts time and temperature exposure into a live shelf-life countdown; the routing engine fuses that countdown with live Agmarknet mandi prices and travel time to issue one actionable command: *"Sell at Mandi A, 2 hrs away — batch has ~14 hrs left."* A tamper-evident Digital Quality Pass (QR) turns the batch's thermal history into negotiating leverage. The same kinetic engine is protocol-swappable: crop spoilage curves can be exchanged for pharmaceutical stability thresholds (2–8°C), extending the platform to the pharma last mile in Phase 2.

FarmSignal is a **decision layer, not a hardware product**: it works with any cold-chain access a user has — none, manual thermometer readings, or low-cost BLE tags — and is explicitly vendor-neutral.

## 2. Problem & Context (abridged)

India loses ~₹1.5 lakh crore of food annually (NABCONS 2022), concentrated at the farm-gate/first-mile node where no digital system — government or private — currently has visibility. Cold-storage capacity is nearly adequate; the 85–99% infrastructure gap is in reefer transport, pack-houses and pre-cooling (NCCD). Existing players (Ecozen, CoolCrop) solve hardware for those who can afford it; eVIN proves national-scale cold-chain digitisation works but stops at public health facilities. Nobody serves the open decision layer. Full analysis lives in the strategy report; this PRD assumes it.

## 3. Goals & Non-Goals

**Goals (v1 / hackathon MVP):**
1. A farmer can log a batch offline and receive a shelf-life estimate within 5 seconds of logging.
2. The system produces a mandi recommendation using *real* Agmarknet price data for at least one demo region.
3. Every recommendation is explainable: the UI can show *why* (price × distance × remaining shelf life).
4. A shareable Quality Pass (QR link) renders a batch's thermal history with tamper-evidence.
5. Fully usable by a low-literacy user: icon-first UI, voice prompts, ≥2 languages at MVP (Hindi + Tamil), architecture ready for 8+.

**Non-Goals (v1):**
- No hardware manufacturing or BLE firmware; sensor input is manual or simulated (clearly labelled).
- No marketplace / cold-room leasing (Direction 6 — Future Vision only).
- No pharma mode UI; only the engine's protocol abstraction is built.
- No farmer payments, credit, or mandi transaction processing.
- No ML training pipeline — the model is literature-calibrated kinetics, not learned.

## 4. Personas

| Persona | Context | Primary job-to-be-done |
|---|---|---|
| Smallholder farmer (primary) | 1–2 acres, feature-to-mid smartphone, low literacy, patchy 2G/4G | "Tell me where to sell this batch before it spoils, in my language." |
| FPO coordinator | Manages 50–500 farmers, moderate digital literacy | "See all member batches, plan shared transport/cold-room slots." |
| Trader / buyer | Mandi-side, price-setter | "Verify this batch's handling before I price it." (Quality Pass consumer) |
| Pharmacy ops lead (Phase 2) | E-pharmacy or hospital pharmacy | "Prove 2–8°C integrity from hub to patient door." |

## 5. Functional Requirements

**F1 — Harvest batch logging.** Create a batch with crop type (picker with images), quantity, harvest timestamp (default now), GPS location (auto). Must complete in ≤30 s and work fully offline. Client generates the batch UUID (idempotent sync).

**F2 — Temperature readings.** Attach readings to a batch at handoff events: manual entry, simulated feed (demo mode), or BLE tag (Phase 2 interface stub). Each reading = {batch_id, °C, timestamp, source, geohash}.

**F3 — Spoilage engine.** Compute remaining shelf life as a *range with confidence band*, never a false-precision scalar. Model: Arrhenius-based degree-hour kinetics per crop (v1 crops: tomato, guava). Recompute on every new reading; heat spikes accelerate decay. Runs on-device (Web Worker) so the countdown updates offline; server recomputes authoritatively on sync.

**F4 — Price integration.** Poll Agmarknet (data.gov.in API) for configured mandis every 6 h; cache and serve last-known-good with a staleness timestamp. Never block a recommendation on a live API call.

**F5 — Routing recommendation.** Score candidate mandis: `expected_realised_value = modal_price × (1 − predicted_spoilage_at_arrival) − transport_cost_estimate`, constrained by `travel_time < remaining_shelf_life × safety_factor`. Output the top recommendation + 2 alternatives, each with the explanation payload. v1 travel time = haversine × road factor; Phase 2 = OSRM.

**F6 — Alerts.** Local push/in-app alerts at decay thresholds (75%, 50%, 25% shelf life remaining) with voice playback in the user's language. SMS/IVR fallback is a Phase 2 interface, stubbed now.

**F7 — Digital Quality Pass.** Generate a public, read-only page per batch: crop, harvest time, thermal timeline, computed freshness band, and a hash-chain verification badge. Each reading's hash = SHA-256(prev_hash ‖ reading payload); the chain head is printed on the QR. Explicitly *not* blockchain.

**F8 — Offline-first sync.** All writes queue in IndexedDB and sync when connectivity returns; server resolves by client UUID + monotonic sequence. Conflicts: last-writer-wins per field, thermal readings append-only (never overwritten).

**F9 — Localisation & accessibility.** All strings via i18n catalogue; icon-first navigation; voice prompts as pre-recorded audio clips (not TTS-dependent); numerals rendered per locale.

**F10 — FPO dashboard (Should-have).** List member batches by urgency; map view (Leaflet) of batches vs candidate mandis.

**F11 — Protocol abstraction (engine only).** The kinetics module accepts a `DecayProtocol` (activation energy / Q10, reference shelf life, hard threshold breaches). Crop protocols and a sample pharma protocol (2–8°C excursion budget) ship as data, proving swappability without a pharma UI.

## 6. Non-Functional Requirements

- **Offline:** every farmer-facing flow functional with zero connectivity; sync is background, not a user task.
- **Performance:** cold PWA load ≤3 s on a ₹8k Android over 3G (code-split, <300 KB critical path); recommendation computation ≤2 s server-side.
- **Reliability:** Agmarknet outage must degrade to cached prices, never to an error screen.
- **Privacy:** farmer-level data private by default; only aggregated/anonymised data leaves the tenant scope. No Aadhaar, no financial data collected. Quality Pass pages expose batch data only, never farmer identity beyond a display name the farmer opts into.
- **Security:** JWT-based device auth (phone-OTP optional, off in demo); rate-limited public Quality Pass endpoint; parameterised queries only.
- **Honesty constraint (product principle):** simulated data is always labelled in the UI; shelf life always displays as a range.

## 7. Success Metrics

| Metric | Definition | MVP target |
|---|---|---|
| Time-to-decision | Harvest logged → recommendation shown | ≤5 s (offline estimate), ≤30 s incl. sync |
| Value delta (demo) | Recommended vs nearest-mandi realised value in simulation | ≥20% uplift, honestly labelled as simulated |
| Model sanity | Shelf-life estimate vs literature benchmark for tomato/guava | Within published range at 3 test temperature profiles |
| Offline integrity | Batches logged offline that sync losslessly | 100% |
| Onboarding cost | Marginal cost per farmer (software-only) | ~₹0 (PWA, no hardware required) |

Vanity metrics (raw user counts) are explicitly excluded.

## 8. Release Plan

1. **M1 — Engine (days 1–2):** kinetics module + protocol data files + unit tests against literature curves.
2. **M2 — Core loop (days 2–4):** batch logging PWA, offline queue, sync API, recommendation endpoint with live Agmarknet pull.
3. **M3 — Demo polish (days 4–5):** journey UI, voice/icon layer (2 languages), Quality Pass QR, simulated telemetry player, FPO map view.
4. **M4 — Pitch build:** scripted demo scenario (the 18 %→13 % same-weather comparison), seeded data, failure-mode rehearsal (airplane-mode demo).

## 9. Risks (delta from pitch deck)

Engineering-specific additions: Agmarknet API instability (mitigate: cache + bundled snapshot for demo); device clock skew corrupting kinetics (mitigate: server-side timestamp reconciliation on sync, monotonic client sequence); iOS PWA limitations for push/background sync (mitigate: demo on Android, document constraint).

---

# Tech Stack

| Layer | Choice | Why | Open-source alternative if constrained |
|---|---|---|---|
| Frontend | **React 18 + TypeScript + Vite (PWA)** | Fast dev, no-install distribution, team familiarity | Preact (smaller bundle) |
| Styling | **Tailwind CSS** | Rapid, consistent, small when purged | Vanilla CSS modules |
| Maps | **Leaflet + OpenStreetMap tiles** | Free, offline-tile-cacheable | MapLibre GL |
| Offline store | **IndexedDB via Dexie.js** | Structured queue + queries, battle-tested | localForage |
| Service worker | **Workbox** | Precache + background sync recipes | Hand-rolled SW |
| On-device compute | **Web Worker** (plain) | Kinetics off the main thread, offline countdown | — |
| i18n | **i18next** | Mature, lazy-loadable locales | FormatJS |
| Voice prompts | **Pre-recorded audio clips** | Works offline; TTS quality in Indic languages is unreliable | Web Speech API (online fallback) |
| Backend | **Python 3.12 + FastAPI + Pydantic v2** | Async, typed, OpenAPI for free; matches team stack | Litestar |
| ORM/migrations | **SQLAlchemy 2 + Alembic** | Standard, portable across SQLite→Postgres | SQLModel |
| Database | **PostgreSQL 16** (SQLite in dev/demo) | Relational fits the model; PostGIS optional later | — |
| Cache | **Redis** (or in-process TTL cache for demo) | Agmarknet response cache, rate-limit state | fastapi-cache2 in-memory |
| Jobs | **APScheduler** | 6-hourly price polling without Celery overhead | Celery + Redis (if scale demands) |
| HTTP client | **httpx** | Async Agmarknet calls with timeouts/retries | aiohttp |
| QR / hashing | **qrcode + hashlib (stdlib)** | Quality Pass generation, SHA-256 hash chain | segno |
| Routing (Phase 2) | **OSRM (self-hosted)** | Real road travel times, open-source | Valhalla |
| Packaging/deploy | **Docker Compose; single VPS or free-tier PaaS (Render/Fly/Railway); Nginx** | Reproducible, cheap, demo-safe | Bare uvicorn behind Caddy |
| CI | **GitHub Actions** | Lint (ruff), type-check (mypy), tests (pytest), build | GitLab CI |
| Error tracking | **Sentry SDK → GlitchTip (self-hosted)** | Crash visibility during pilot | Log files + Loki |

Deliberate exclusions: no Kubernetes (one VPS is honest at MVP scale), no Kafka (a 6-hour poller is not streaming), no blockchain (hash chain suffices for tamper-evidence), no trained ML (no data exists; kinetics are defensible).

---

# Architecture

## System overview

```mermaid
flowchart TB
    subgraph Device["Farmer's phone — React PWA (offline-first)"]
        UI[Icon/voice UI · i18next]
        WW[Web Worker\nkinetics engine (mirror)]
        IDB[(IndexedDB\nDexie queue)]
        SW[Service Worker\nWorkbox precache + bg sync]
        UI --> WW
        UI --> IDB
        IDB <--> SW
    end

    SW -- "HTTPS JSON (batched, idempotent)" --> API

    subgraph Server["FastAPI backend (Docker, single VPS)"]
        API[REST API\n/batches /readings /recommendations /quality-pass]
        KE[Kinetics service\nDecayProtocol registry:\ncrop curves ↔ pharma 2–8°C]
        RE[Routing engine\nprice × decay × travel time]
        PP[Price poller\nAPScheduler, 6h]
        QP[Quality Pass service\nSHA-256 hash chain + QR]
        API --> KE
        API --> RE
        API --> QP
        RE --> KE
    end

    PP -- httpx --> AGM[(Agmarknet API\ndata.gov.in)]
    PP --> REDIS[(Redis cache\nlast-known-good prices)]
    RE --> REDIS
    API --> PG[(PostgreSQL\nfarmers · batches · readings ·\nmandi_prices · recommendations · pass_events)]
    QP --> PUB[Public read-only\nQuality Pass page + QR]
    TRADER[Trader / buyer] --> PUB
    BLE[["Phase 2: BLE tag ingestion\n(same /readings contract)"]] -.-> API
```

## Data model (core tables)

`farmers(id, display_name, locale, device_id, created_at)` · `batches(id UUID client-generated, farmer_id, crop, protocol_id, qty_kg, harvested_at, origin_geohash, status)` · `readings(id, batch_id, temp_c, taken_at, source[manual|sim|ble], seq, hash, prev_hash)` — append-only · `mandi_prices(mandi_id, commodity, modal_price, arrival_qty, reported_on, fetched_at)` · `recommendations(id, batch_id, ranked_json, computed_at, model_version)` · `protocols(id, kind[crop|pharma], params_json)`.

## The kinetics core (the defensible bit)

Decay rate follows Arrhenius: `k(T) = A · exp(−Ea / (R·T))`. Practical form: maintain a **degree-hours integral** over the reading timeline and map cumulative thermal load to fraction of shelf life consumed, using per-crop `Q10` (rate multiplier per +10°C) and reference shelf life at 10°C from published food-science literature. Output = remaining-hours **range** (±band from parameter uncertainty). The identical code path evaluates a pharma protocol as an *excursion budget* (cumulative minutes outside 2–8°C) — this is requirement F11 and the pitch's "protocol-swappable" claim, made real.

## Key flows

1. **Offline log → sync:** UI writes batch+reading to Dexie → Web Worker shows instant local estimate → Workbox background-sync drains the queue when online → server recomputes authoritatively → deltas pushed back.
2. **Recommendation:** on new reading or price refresh, routing engine pulls cached mandi prices, filters mandis reachable within remaining shelf life × 0.8 safety factor, ranks by expected realised value, stores explanation payload (all inputs) for the "why" screen.
3. **Quality Pass:** each synced reading extends the hash chain; `/quality-pass/{batch_id}` renders the public page; QR encodes URL + chain head so any tampering with history breaks verification.

## Best practices & pitfalls to respect

Idempotency everywhere (client UUIDs; retries must be safe). Treat Agmarknet as unreliable: timeouts of 5 s, exponential backoff, and a bundled JSON snapshot so the demo cannot be killed by a government API outage. Store timestamps in UTC, render in IST; reconcile device clock skew at sync using server receive-time deltas. Keep the kinetics module pure and unit-tested against literature values — it is the demo's credibility anchor. Ship the airplane-mode demo path deliberately: judges should *see* offline work, not hear about it.

## Repo layout

```
farmsignal/
├── apps/web/            # React PWA (Vite, TS, Tailwind, Workbox, Dexie, worker/)
├── services/api/        # FastAPI app: routers/, models/, kinetics/, routing/, pass/
│   └── kinetics/protocols/  # tomato.json, guava.json, pharma_2_8.json
├── infra/               # docker-compose.yml, nginx.conf, deploy notes
├── data/                # agmarknet_snapshot.json, demo_scenarios/
└── docs/                # this PRD, strategy report, pitch deck
```
