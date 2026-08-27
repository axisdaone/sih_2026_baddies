# FarmSignal — Engineering Contract (v1)

This document is the single source of truth that the backend (`services/api`) and the PWA (`apps/web`)
implement against. It refines the PRD (`docs/FarmSignal-PRD.md`); where the two disagree, this
document wins for implementation details, and the PRD wins for product intent.

All timestamps are ISO-8601 UTC strings on the wire (`2026-08-27T06:30:00Z`); UI renders in IST.
All IDs are UUID v4 strings. Client generates batch IDs and reading IDs (idempotent sync).

---

## 1. Repo layout

```
farmsignal/
├── apps/web/                 # React 18 + TS + Vite PWA (Tailwind, Dexie, Workbox via vite-plugin-pwa, i18next, Leaflet)
│   └── src/
│       ├── engine/           # PURE kinetics mirror (no DOM, no React) — must match Python output
│       ├── worker/           # Web Worker wrapping engine/
│       ├── db/               # Dexie schema + outbox
│       ├── sync/             # outbox drain, clock skew, background sync
│       ├── api/              # typed fetch client
│       ├── i18n/             # i18next setup + locales/{en,hi,ta}/*.json
│       ├── voice/            # pre-recorded clip player (+ labelled Web Speech fallback)
│       ├── alerts/           # threshold alerts (75/50/25)
│       ├── pages/            # Home, NewBatch, BatchDetail, Why, QualityPass, Fpo, Settings
│       ├── components/
│       └── data/             # bundled protocols + mandis (copied from /data at build)
├── services/api/             # FastAPI (Python 3.12+, Pydantic v2, SQLAlchemy 2, Alembic, APScheduler, httpx)
│   ├── app/
│   │   ├── main.py, config.py, db.py, deps.py, security.py
│   │   ├── models/           # SQLAlchemy ORM
│   │   ├── schemas/          # Pydantic
│   │   ├── routers/          # auth, protocols, batches, readings, sync, prices, mandis, recommendations, quality_pass, demo, health
│   │   ├── kinetics/         # engine.py, protocols/{tomato,guava,pharma_2_8}.json, registry.py
│   │   ├── routing/          # geo.py, engine.py
│   │   ├── prices/           # agmarknet client, cache, poller, snapshot loader
│   │   ├── quality_pass/     # hash chain, QR
│   │   ├── alerts/           # thresholds + sms_ivr_stub.py
│   │   └── demo/             # seed + telemetry simulator
│   ├── alembic/, alembic.ini
│   ├── tests/
│   ├── pyproject.toml, requirements.txt, Dockerfile, .env.example
├── infra/                    # docker-compose.yml, nginx.conf, DEPLOY.md
├── data/                     # agmarknet_snapshot.json, mandis.json, demo_scenarios/*.json
├── docs/                     # PRD, this contract, DEMO-SCRIPT.md, MODEL-NOTES.md
└── .github/workflows/ci.yml
```

---

## 2. Decay protocols (F3 / F11)

Protocols are **data**. The same evaluator code path handles crop and pharma protocols.
Files live in `services/api/app/kinetics/protocols/*.json` and are copied verbatim to
`apps/web/src/data/protocols/*.json` (the web build must not diverge — a test compares them).

### 2.1 Schema

```jsonc
{
  "id": "tomato",                       // protocol_id used on batches
  "kind": "crop",                       // "crop" | "pharma"
  "name": "Tomato",
  "commodity": "Tomato",                // Agmarknet commodity name (crop only)
  "version": "1.0",
  "model": "q10",                       // "q10" (crop) | "excursion" (pharma)
  "reference_temp_c": 10,               // T_ref for the Q10 law
  "reference_shelf_life_hours": 288,    // L_ref at T_ref (nominal)
  "reference_shelf_life_range_hours": [240, 336],   // [pessimistic, optimistic]
  "q10": 2.0,                           // nominal
  "q10_range": [1.8, 2.4],              // [optimistic, pessimistic]  (lower Q10 = slower decay above T_ref)
  "min_effective_temp_c": 10,           // clamp: below this, rate does not decrease further (chilling-injury floor)
  "max_effective_temp_c": 45,           // clamp for the rate law
  "default_ambient_c": 30,              // assumed temperature when no readings exist
  "hard_thresholds": [                  // any single reading breaching one of these => status "spoiled"
    { "type": "max_temp", "value_c": 45, "label": "heat_damage" }
  ],
  "band_c": null,                       // pharma only: [low, high]
  "excursion_budget_minutes": null,     // pharma only
  "sources": ["..."]                    // literature citations (free text)
}
```

Pharma example (`pharma_2_8.json`): `kind: "pharma"`, `model: "excursion"`, `band_c: [2, 8]`,
`excursion_budget_minutes: 720`, `reference_shelf_life_hours: 12` (= budget in hours; keeps the same
integral), hard thresholds `min_temp 0 (freeze)` and `max_temp 25`.

### 2.2 Evaluation algorithm (must be identical in Python and TypeScript)

Inputs: `protocol`, `harvested_at`, `readings[] = {temp_c, taken_at}`, `now`.

1. **Timeline** — sort readings by `taken_at`, drop readings after `now`. Build piecewise-constant
   temperature segments from `harvested_at` to `now`:
   - Before the first reading (or if no readings): `default_ambient_c`, flagged `assumed: true`.
   - Each reading holds its temperature until the next reading.
   - The last reading holds until `now`, flagged `assumed: true` if `now - last > 2 h`.
   - Readings before `harvested_at` are clamped to start at `harvested_at`.
2. **Rate multiplier** `r(T)`:
   - `q10` model: `T' = clamp(T, min_effective_temp_c, max_effective_temp_c)`;
     `r = q10 ** ((T' - reference_temp_c) / 10)`.
   - `excursion` model: `r = 0` if `band_c[0] <= T <= band_c[1]` else `1`.
3. **Consumed fraction** for a scenario `(q10, L_ref)`:
   `consumed = Σ_segments (hours_i × r(T_i)) / L_ref`, clamped to `[0, 1]`.
4. **Remaining hours** at current temperature `T_now` (temperature of the last segment):
   `remaining = (1 − consumed) × L_ref / max(r(T_now), 1e-6)`; for the excursion model with `r = 0`,
   `remaining = (1 − consumed) × L_ref` (report budget remaining, not infinity).
5. **Three scenarios**:
   - `mid`: `(q10, reference_shelf_life_hours)`
   - `high` (optimistic): `(q10_range[0], reference_shelf_life_range_hours[1])`
   - `low` (pessimistic): `(q10_range[1], reference_shelf_life_range_hours[0])`
   For `excursion`, all three use budget; the range comes from ±10 % of the budget.
6. **Hard thresholds** — if any reading breaches one, `status = "spoiled"`, all remaining = 0,
   `breach = {type, value_c, reading_id, at}`.
7. **Status** from `remaining_fraction = 1 − consumed_mid`:
   `> 0.5 → "fresh"`, `(0.25, 0.5] → "warning"`, `(0, 0.25] → "critical"`, `0 → "spoiled"`.
8. **Confidence** (deterministic):
   - `"high"`: ≥ 2 readings and last reading ≤ 2 h old
   - `"medium"`: ≥ 1 reading and last reading ≤ 8 h old
   - `"low"`: otherwise (no readings, or stale)
9. **Alerts crossed**: thresholds `[75, 50, 25]` (% shelf life remaining) where
   `remaining_fraction × 100 <= threshold`.

Output (`ShelfLifeEstimate`, identical JSON in both languages):

```jsonc
{
  "protocol_id": "tomato",
  "model_version": "kinetics-1.0",
  "computed_at": "…Z",
  "status": "fresh",
  "confidence": "medium",
  "consumed_fraction": 0.31,            // mid scenario, 4 dp
  "remaining_fraction": 0.69,
  "remaining_hours": { "low": 41.2, "mid": 58.7, "high": 79.0 },   // 1 dp
  "expected_end": { "low": "…Z", "mid": "…Z", "high": "…Z" },
  "current_temp_c": 28.0,
  "current_temp_assumed": false,
  "hours_since_last_reading": 0.5,
  "thermal_load_degree_hours": 214.0,   // Σ hours × max(0, T − reference_temp_c), 1 dp
  "alerts_crossed": [75],
  "breach": null,
  "segments": [ { "from": "…Z", "to": "…Z", "temp_c": 30, "hours": 3.0, "rate": 4.0, "assumed": true } ]
}
```

Rounding: round only at the output boundary (fractions 4 dp, hours 1 dp). Use `float64` everywhere.
Cross-language golden tests: `data/demo_scenarios/golden_kinetics.json` holds cases with expected
outputs; both the Python and TS suites must pass them (tolerance 0.05 h on hours, 1e-3 on fractions).

### 2.3 Calibration (v1, from literature; see `docs/MODEL-NOTES.md`)

| Protocol | T_ref | L_ref (h) nominal [range] | Q10 nominal [range] | Floor °C | Ambient |
|---|---|---|---|---|---|
| tomato | 10 | 288 [240, 336] (10–14 d) | 2.0 [1.8, 2.4] | 10 | 30 |
| guava  | 10 | 336 [240, 384] (10–16 d) | 2.5 [2.2, 3.0] | 8  | 30 |
| pharma_2_8 | — | budget 720 min | — | — | 25 |

Sanity anchors (tests assert these, mid scenario, single constant-temperature profile):
- Tomato: 10 °C → 288 h; 20 °C → 144 h (6 d); 30 °C → 72 h (3 d). Published: 2–4 d at 30 °C, 1–2 wk at 10–12 °C.
- Guava: 10 °C → 336 h; 20 °C → 134 h; 30 °C → 54 h (~2.2 d). Published: 2–3 d ambient, 2–3 wk at 8–10 °C.
- Pharma: 6 h at 15 °C then 6 h at 5 °C → consumed 0.5, remaining 6 h; any reading < 0 °C → spoiled.

---

## 3. Routing / recommendation (F5)

Inputs: batch (protocol, qty_kg, origin lat/lon), current `ShelfLifeEstimate`, mandi list with prices.

Constants (in `config`, overridable): `ROAD_FACTOR = 1.3`, `AVG_SPEED_KMH = 35`,
`SAFETY_FACTOR = 0.8`, `TRANSPORT_COST_PER_KM_INR = 12` (small pickup/tempo trip cost),
`TRANSIT_TEMP_C = max(last reading if ≤ 2 h old else default_ambient_c, protocol.default_ambient_c)` —
a fresh reading can only make the trip *warmer* than ambient, never cooler (no vehicle/reefer input in v1).

For each mandi that has a price for the protocol's commodity:

```
straight_km        = haversine(origin, mandi)
distance_km        = straight_km × ROAD_FACTOR
travel_hours       = distance_km / AVG_SPEED_KMH
time_ok            = travel_hours < remaining_at(TRANSIT_TEMP, mid) × SAFETY_FACTOR
                     (remaining re-projected from consumed_now at the transit temperature, so a stale
                      cold reading can never make a trip "reachable" that arrives spoiled)
consumed_at_arrival= clamp(consumed_now + travel_hours × r(TRANSIT_TEMP) / L_ref, 0, 1)   (mid scenario)
spoilage_at_arrival= consumed_at_arrival                      (v1: linear value loss, stated in explanation)
gross_value_inr    = modal_price_per_quintal / 100 × qty_kg × (1 − spoilage_at_arrival)
transport_cost_inr = distance_km × TRANSPORT_COST_PER_KM_INR
expected_value_inr = gross_value_inr − transport_cost_inr
feasible           = time_ok AND expected_value_inr > 0
feasible_pessimistic = travel_hours < remaining_at(TRANSIT_TEMP, low) × SAFETY_FACTOR   (shown as a "safe even in the worst case" flag)
```

Rank feasible mandis: pessimistically-safe first, then fresh-priced before stale, then
`expected_value_inr` desc (plain value order when all prices share one source). Output `top` + up to 2
`alternatives`, the full `ranked[]` list (so the Why screen hides nothing), plus `nearest` (closest mandi
regardless of rank) and `uplift_vs_nearest_pct` (0 when nearest is top; null when nearest has no
positive value). Infeasible mandis are returned in `rejected[]` with reason codes
(`infeasible_travel_time`, `no_price`, `negative_value`). Every candidate
carries the full explanation payload (all inputs above + `price_reported_on`, `price_fetched_at`,
`price_is_stale`, `price_source: "agmarknet_live" | "agmarknet_cache" | "bundled_snapshot"`).
Recommendation is `model_version: "routing-1.0"`. If the batch is `spoiled`, return `top: null` with
`reason: "batch_spoiled"`. If no mandi has a price, fall back to the bundled snapshot; never error.

---

## 4. Quality Pass hash chain (F7)

Each reading appended to a batch gets `seq` (1-based, per batch, assigned by the server on accept;
client sends its own `client_seq`) and:

```
payload   = canonical_json({"batch_id", "reading_id", "seq", "temp_c", "taken_at", "source", "geohash"})
            (sorted keys, no whitespace, temp_c as a float with 1 dp, taken_at ISO UTC with 'Z')
hash      = sha256_hex(prev_hash + "|" + payload)
prev_hash = previous reading's hash, or sha256_hex("farmsignal:" + batch_id) for seq 1 (genesis)
```

`chain_head` = last hash. The QR encodes `{PUBLIC_BASE_URL}/pass/{batch_id}?h={chain_head[:16]}`.
`GET /api/v1/quality-pass/{batch_id}/verify?head=…` recomputes the chain and returns
`{valid, chain_head, length, first_bad_seq, head_matches}` — `head` is optional; without it the
response still reports internal consistency with `head_matches: false`; when `valid` is false the
client must not compare heads. The client mirrors the same hash for offline display
(`apps/web/src/engine/hashchain.ts`, using `crypto.subtle`).

---

## 5. Data model (SQLAlchemy; SQLite dev, Postgres prod)

- `farmers(id UUID pk, display_name, locale, device_id unique, created_at)`
- `batches(id UUID pk client-generated, farmer_id fk, crop, protocol_id, qty_kg float, harvested_at,
  origin_lat, origin_lon, origin_geohash, status enum[open, sold, spoiled, discarded], notes,
  client_seq int, created_at, updated_at, deleted_at nullable)`
- `readings(id UUID pk client-generated, batch_id fk, temp_c, taken_at, source enum[manual, sim, ble],
  geohash, seq int, client_seq int, hash, prev_hash, received_at)` — append-only; unique(batch_id, seq)
- `mandi_prices(id pk, mandi_id, commodity, variety, modal_price, min_price, max_price, arrival_qty,
  reported_on date, fetched_at, source)` unique(mandi_id, commodity, reported_on)
- `mandis(id pk text slug, name, state, district, lat, lon, agmarknet_market, agmarknet_state, agmarknet_district)`
- `recommendations(id pk, batch_id fk, ranked_json, computed_at, model_version)`
- `protocols(id pk, kind, params_json, version)` — seeded from the JSON files at startup
- `sync_ops(op_id pk, device_id, client_seq, kind, status, received_at)` — dedupe log
- `pass_events(id pk, batch_id, event[view, verify], at, ip_hash)`

---

## 6. REST API (`/api/v1`, JSON)

Auth: `POST /auth/device {device_id, display_name?, locale?} → {token, farmer_id}`. Token is a JWT
(HS256, `sub = farmer_id`, `did = device_id`, 30 d). All routes below need `Authorization: Bearer`
except `/health`, `/protocols`, `/mandis`, `/prices`, and `/quality-pass/*` (public, rate-limited
60 req/min/IP).

| Method & path | Notes |
|---|---|
| `GET /health` | `{status, version, db, prices: {source, fetched_at, stale}}` |
| `GET /protocols` / `GET /protocols/{id}` | protocol JSON |
| `GET /mandis` | mandi list with lat/lon |
| `GET /prices?commodity=Tomato` | latest price per mandi + `{source, fetched_at, stale}` |
| `POST /prices/refresh` | trigger a poll now (demo); returns status |
| `POST /batches` | body = BatchCreate (includes client `id`); **idempotent**: same id → 200 with existing |
| `GET /batches` | farmer's batches with embedded latest `shelf_life` |
| `GET /batches/{id}` | batch + readings + shelf_life |
| `PATCH /batches/{id}` | status/notes/qty (last-writer-wins per field, by `client_seq`) |
| `POST /batches/{id}/readings` | ReadingCreate (client `id`); idempotent; returns reading with seq/hash |
| `GET /batches/{id}/readings` | ordered by seq |
| `GET /batches/{id}/shelf-life` | ShelfLifeEstimate (server-authoritative) |
| `GET /batches/{id}/recommendation` | Recommendation (computed on demand, stored) |
| `POST /batches/{id}/simulate?profile=hot_afternoon` | demo: append `source: "sim"` readings from `data/demo_scenarios/` |
| `POST /sync` | see §7 |
| `GET /quality-pass/{id}` | public payload (no farmer identity beyond opt-in display_name) |
| `GET /quality-pass/{id}/qr.png` | PNG |
| `GET /quality-pass/{id}/verify?head=` | chain verification |
| `POST /demo/seed` | seed demo farmer + batches + readings (idempotent) |

### 6.1 Wire schemas

```ts
type Crop = "tomato" | "guava";
type ReadingSource = "manual" | "sim" | "ble";
type BatchStatus = "open" | "sold" | "spoiled" | "discarded";

interface BatchCreate { id: string; crop: Crop; protocol_id: string; qty_kg: number;
  harvested_at: string; origin_lat: number | null; origin_lon: number | null;
  notes?: string | null; client_seq: number; client_created_at: string; }
interface Batch extends BatchCreate { farmer_id: string; status: BatchStatus; origin_geohash: string | null;
  created_at: string; updated_at: string; shelf_life?: ShelfLifeEstimate; readings?: Reading[];
  chain_head?: string | null; }
interface ReadingCreate { id: string; batch_id: string; temp_c: number; taken_at: string;
  source: ReadingSource; geohash?: string | null; client_seq: number; }
interface Reading extends ReadingCreate { seq: number; hash: string; prev_hash: string; received_at: string; }

interface MandiCandidate { mandi_id: string; name: string; district: string; lat: number; lon: number;
  straight_km: number; distance_km: number; travel_hours: number; feasible: boolean;
  modal_price_per_quintal: number; price_reported_on: string; price_fetched_at: string;
  price_is_stale: boolean; price_source: string; transit_temp_c: number; consumed_at_arrival: number;
  spoilage_at_arrival: number; gross_value_inr: number; transport_cost_inr: number;
  expected_value_inr: number; reasons: string[]; }
interface Recommendation { batch_id: string; computed_at: string; model_version: string;
  shelf_life: ShelfLifeEstimate; top: MandiCandidate | null; alternatives: MandiCandidate[];
  nearest: MandiCandidate | null; rejected: MandiCandidate[]; ranked: MandiCandidate[];
  uplift_vs_nearest_pct: number | null;
  reason?: string; constants: { road_factor: number; avg_speed_kmh: number; safety_factor: number;
  transport_cost_per_km_inr: number; }; simulated: boolean; }
```

---

## 7. Offline sync (F8)

Client keeps an **outbox** in Dexie: `ops(op_id, client_seq (monotonic per device), kind, payload,
created_at, status[pending|inflight|done|failed], attempts, last_error)`.

`POST /sync`:
```jsonc
{ "device_id": "…", "client_now": "…Z",
  "ops": [ { "op_id": "…", "client_seq": 12, "kind": "batch.create" | "batch.update" | "reading.append",
             "payload": { … BatchCreate | BatchPatch | ReadingCreate … }, "client_time": "…Z" } ] }
→
{ "server_now": "…Z", "clock_skew_seconds": -42.0,
  "results": [ { "op_id": "…", "status": "applied" | "duplicate" | "rejected", "error": null,
                 "entity": { …Batch | Reading… } } ],
  "batches": [ …full Batch[] for this farmer with shelf_life… ] }
```

Rules: ops applied in `client_seq` order; duplicate `op_id` → `duplicate` (no-op); readings are
append-only (a `reading.append` with an existing `id` is a duplicate, never an update); batch fields
use last-writer-wins by `client_seq`. **Clock skew**: `clock_skew_seconds = client_now − server_now`;
if `|skew| > 120 s` the server shifts every `taken_at`/`harvested_at` in that request by `−skew` and
flags `clock_adjusted: true` in the result. Client stores skew and applies it to local kinetics.

Client trigger points: `online` event, app foreground, every 60 s while online. The Dexie outbox is the
sole durable retry queue: ops left `inflight` by a dead tab are reset to `pending` at the start of the
next drain; server-rejected ops back off exponentially (2^attempts min, cap 1 h) and are parked after
5 attempts for the user to discard. Workbox Background Sync is intentionally **not** used for
`POST /sync` — a verbatim replay would carry a stale `client_now` that the skew correction would misread.

Skew bookkeeping on the client: every op records the skew it was enqueued under; drain sends one
`/sync` request per contiguous run of equal skew with `client_now = now − skew`, and stores
`skew + clock_skew_seconds` (the server's residual) so the correction accumulates instead of oscillating.
All local kinetics use `nowIso()` = device clock − stored skew.

---

## 8. Prices (F4)

Agmarknet via data.gov.in resource `9ef84268-d588-465a-a308-a864a43d0070`
(`https://api.data.gov.in/resource/{id}?api-key=…&format=json&limit=…&filters[state]=…&filters[commodity]=…`).
Config: `AGMARKNET_API_KEY` (env; default = data.gov.in public sample key), `PRICE_POLL_HOURS=6`,
`PRICE_STALE_HOURS=30`, timeout 5 s, 3 retries with exponential backoff (1, 2, 4 s).
Order of truth: live → DB cache (last-known-good) → `data/agmarknet_snapshot.json` (bundled).
Every price response carries `source` and `fetched_at`; `stale = age > PRICE_STALE_HOURS`.
The poller runs at startup (non-blocking) and every 6 h via APScheduler.

Mandi ↔ Agmarknet mapping lives in `data/mandis.json` (`agmarknet_market`, `agmarknet_state`, `agmarknet_district`).
Demo region: **Tamil Nadu + border Karnataka** (Dharmapuri/Krishnagiri tomato belt; Koyambedu, Ottanchatram,
Madurai, Coimbatore, Salem, Trichy, Hosur, Vellore, Kolar, Bengaluru).

---

## 9. Frontend conventions

- Routes: `/` Home · `/new` NewBatch · `/batch/:id` BatchDetail · `/batch/:id/why` Why · `/pass/:id`
  QualityPass (public, works from server payload or local data) · `/fpo` FPO dashboard · `/settings`.
- i18n namespaces (files per locale): `common`, `batch`, `pass`, `fpo`, `alerts`. Locales `en`, `hi`, `ta`.
  Numerals: `Intl.NumberFormat(locale)`; Hindi uses `hi-IN` with `numberingSystem: "deva"` when the
  user enables native numerals (Settings toggle; default on for hi, off for ta and en — Tamil digits
  ௦–௯ are not in contemporary use in Tamil Nadu, so Tamil UI shows Latin digits unless opted in).
- Voice: `voice/play(key)` looks for `/audio/{locale}/{key}.mp3`; if missing, falls back to
  `speechSynthesis` and shows a small "TTS fallback" label. A manifest of expected keys is in
  `public/audio/manifest.json`. Keys: `welcome`, `batch_logged`, `alert_75`, `alert_50`, `alert_25`,
  `sell_now`, `recommendation_ready`.
- Simulated data is always labelled with a `SIMULATED` chip (component `SimBadge`).
- Shelf life is always displayed as a range: "≈ 41–79 h (most likely 59 h)".
- Web Worker: `worker/kinetics.worker.ts` receives `{protocol, harvested_at, readings, now}` and posts
  `ShelfLifeEstimate`. UI recomputes every 60 s and on every reading.
- Dexie DB `farmsignal` v1 tables: `batches`, `readings`, `ops`, `prices`, `mandis`, `meta`.
- Bundle: code-split each page with `React.lazy`; Leaflet and QR only in their pages.

---

## 10. Testing & CI

- Backend: `pytest` (kinetics literature anchors, golden cases, hash chain, sync idempotency, routing,
  API smoke via `TestClient` + SQLite), `ruff`, `mypy` (strict-ish, `app/`).
- Frontend: `vitest` (engine golden cases, hash chain, outbox ordering), `tsc --noEmit`, `vite build`.
- CI: `.github/workflows/ci.yml` runs both on push/PR.
