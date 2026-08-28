# 4. FarmSignal — Competitive Advantage & USPs

> How to argue, with evidence from the code, that FarmSignal is the right answer to PS IHSIH013 — and why our stack and approach beat the obvious alternatives.

---

## 4.1 Positioning: the Open Decision Layer

| Solution class | Examples | What they solve | What they leave open | FarmSignal's answer |
|---|---|---|---|---|
| **Cold-chain hardware** | Ecozen, CoolCrop, reefer-van vendors | Keeping produce cold *if you have the asset* | The 85–99 % of farmers with no reefer/pack-house; no decision support | Software-only, hardware-optional, vendor-neutral; a BLE tag is a `source:"ble"` reading, not a dependency |
| **Government vaccine cold chain** | eVIN | Proves national-scale digital cold chain works | Stops at public-health facilities; not for produce or the private last mile | Same engine, protocol-swappable to pharma 2–8 °C via `pharma_2_8.json` |
| **Price portals** | Agmarknet, eNAM | Daily mandi prices | No shelf-life, no routing, no offline, no explanation | Fuses Agmarknet prices with kinetics + travel time + transport cost into one ranked, explainable command |
| **Generic IoT dashboards** | Temperature-logger clouds | Graphs of past temperature | Require sensors; online-only; tell you *what happened*, not *what to do* | Works with zero sensors (assumed-ambient with honest `assumed` flags); prescribes an action |
| **Blockchain traceability** | Various "farm-to-fork" chains | Immutable provenance | Heavy infra, tokens, gas, no offline; overkill for tamper-evidence | SHA-256 hash chain with the head on the QR — same tamper guarantee, zero infra, verifiable offline |

**Nobody else sits in the first-mile decision seat.** That is the whole pitch.

---

## 4.2 Distinct Advantages of the Current Implementation

### 1. Genuinely offline-first (not "works offline sometimes")

| Claim | Proof in code |
|---|---|
| Every farmer-facing flow works with zero connectivity | `db/repo.ts` is the *only* write path and never awaits the network; kinetics run in a Web Worker from bundled protocols (`src/data/protocols/`) |
| The countdown keeps ticking offline | `useShelfLife()` recomputes every 60 s from Dexie; `nowIso()` is skew-corrected server time |
| Sync is a background concern, not a user task | `startSyncLoop()` on `online`, foreground, and a 60 s timer; single-flight `drain()`; ≤ 200 ops/request |
| Offline is *lossless* | Client UUIDs + monotonic `client_seq` + server `sync_ops` dedupe → replays are `duplicate`, never double-inserts; PRD target "100 % offline integrity" |
| Even the public Quality Pass has an offline path | `QualityPass.tsx` falls back to the local Dexie copy, recomputes the chain with `crypto.subtle`, labels it "Offline copy" |
| App shell + audio precached | Workbox `globPatterns` include `mp3`; runtime caches for reference data, pass pages and OSM tiles |

### 2. A defensible, *explainable* model — no black box

| Claim | Proof in code |
|---|---|
| Physics, not ML | `kinetics/engine.py`: Q10/Arrhenius degree-hour integral; calibration from USDA Handbook 66, Kader (UC Davis), Tijskens & Polderdijk 1996, ICAR-CIPHET 2015 — listed in each protocol's `sources[]` |
| Literature anchors are asserted by tests | Tomato 10/20/30 °C → 288/144/72 h; guava → 336/134/54 h (`test_kinetics.py`) |
| Uncertainty is first-class | Three parameter scenarios (mid/high/low) → always a range; `registry.validate_scenario_ordering()` proves low ≤ mid ≤ high at every temperature *at import time* |
| Confidence is deterministic and about data recency | `high` = ≥ 2 readings & last ≤ 2 h; `medium` = ≥ 1 & ≤ 8 h; `low` otherwise — identical on phone and server |
| Limitations are written down | `docs/MODEL-NOTES.md §8` lists 10 known limitations (no humidity, no ethylene, constant Q10, linear value loss…) |
| Conservative by design | With no readings the model assumes 30 °C, not a best case — "the app should never look better than reality because the farmer stopped logging" |

### 3. Phone and server can never disagree (cross-language parity)

| Claim | Proof in code |
|---|---|
| Same algorithm in Python and TypeScript | `services/api/app/kinetics/engine.py` ↔ `apps/web/src/engine/index.ts`; rounding pinned to `floor(x·10ⁿ+0.5)/10ⁿ` = JS `Math.round`; hour arithmetic in whole milliseconds to mirror JS `Date` |
| 26 golden cases both suites must pass | `data/demo_scenarios/golden_kinetics.json` (tolerance 0.05 h / 1e-3) → `test_kinetics_golden.py` + `engine.test.ts` |
| Byte-for-byte parity | `golden_estimates_py.json` dumped by `scripts/dump_golden_estimates.py`; `engine/parity.test.ts` compares JSON exactly |
| Protocol files cannot drift | `npm run sync-data` copies them; `data.test.ts` asserts byte-identical copies |
| Hash chain canonical form pinned in both languages | `-0.0` normalisation, 1-dp `temp_c`, whole-second `taken_at` — `chain.py` ↔ `hashchain.ts`, `test_readings_chain.py` ↔ `hashchain.test.ts` |

### 4. Routing that refuses to lie

| Claim | Proof in code |
|---|---|
| Considers spoilage *during* the trip, not just at departure | `consumed_at_arrival = consumed_now + travel_hours × r(transit_temp)/L_ref` |
| A stale cold reading can't fake feasibility | Transit temp = `max(last reading if ≤ 2 h old, default_ambient)` — a fresh reading can only make the trip *warmer* |
| Worst-case safety is surfaced, not hidden | `feasible_pessimistic` computed with the low scenario; pessimistically-safe mandis rank first |
| Price provenance travels with every candidate | `price_source`, `price_reported_on`, `price_fetched_at`, `price_is_stale`, `price_age_days` on each `MandiCandidate` |
| Rejected mandis are returned with reasons | `rejected[]` with `too_far_for_shelf_life` / `negative_expected_value` / `no_price` / `batch_spoiled`; the Why screen hides nothing |
| Gives unflattering answers | Seed batch #2 → "Palacode ₹302, sell now", 3 mandis too far; uplift 0 % |

### 5. Resilience against the one thing we don't control: government APIs

| Claim | Proof in code |
|---|---|
| Never blocks on Agmarknet | Poller runs in a daemon thread; recommendations read the DB cache |
| Three-tier truth | `live → agmarknet_cache → bundled_snapshot`; snapshot never overwrites live (`overwrite=False`) |
| Bounded retries | 5 s timeout, 3 attempts, 1/2/4 s backoff, retry only on 429/5xx |
| Protects the shared data.gov.in key | Manual refresh single-flight + 300 s cooldown; attempt stamped *before* the fetch so 429s count |
| Health is observable | `/health` reports `prices.source`, `fetched_at`, `stale` |

### 6. Built for the real user: low literacy, regional language, cheap phone

| Claim | Proof in code |
|---|---|
| Three languages today, architecture for 8+ | i18next namespaces per locale under `src/i18n/locales/{en,hi,ta}/` |
| Native numerals | `Intl.NumberFormat('hi-IN', {numberingSystem:'deva'})`; Tamil defaults to Latin digits (documented reasoning in contract §9) |
| Voice that works offline | Pre-recorded clips per locale with a manifest; TTS only as a labelled fallback |
| Icon-first UI | `CropPicker` tiles, `NumericPad`, `Stepper`, big `btn-primary` targets |
| Cheap-phone performance | Code-split pages, Leaflet and QR in their own chunks, `check-bundle-size.mjs` gates the critical path (< 300 KB target), ES2020 build |

### 7. Tamper-evidence without a blockchain

| Claim | Proof in code |
|---|---|
| Each reading's hash covers the previous | `hash = sha256(prev_hash ‖ canonical_payload)`; genesis = `sha256("farmsignal:" + batch_id)` |
| The QR carries the head | `/pass/{id}?h={chain_head[:16]}`; verify compares the *recomputed* head, so edits break both `valid` and `head_matches` |
| Live tamper demo | Edit `readings.temp_c` for `seq=4` → `first_bad_seq: 4` (rehearsed in `docs/DEMO-SCRIPT.md`) |
| Append-only enforced in the DB | `unique(batch_id, seq)`; `append_reading()` never updates an existing id |
| Privacy-preserving public page | No farmer/device ids, geohash-4 only, IPs stored as HMAC |

### 8. Production hygiene that most hackathon prototypes skip

| Area | What exists |
|---|---|
| CI | GitHub Actions: `ruff` + `mypy` + `pytest` (~185 tests) and `tsc` + `vitest` (~170 tests) + `vite build` on every push |
| Security | Strict CSP, `X-Frame-Options: DENY`, dual-layer rate limits, JWT secret validation in prod, body-size cap, proxy-trust gating, demo-mode gating with admin token |
| Migrations | Alembic with an initial revision; `alembic upgrade head` on prod boot; SQLite ↔ Postgres portability tested (`test_migrations.py`, `test_db_types.py`) |
| Ops docs | `infra/DEPLOY.md` covers compose, env table, Postgres switch, Render/Fly, backups, iOS limits, rate-limit sanity checks |
| Honesty about gaps | Sentry not wired (documented), `requirements.txt` unpinned (documented as pre-pitch to-do), Redis deliberately absent with the single-process caveat explained |

---

## 4.3 Why Our Stack Beats the Alternatives

| Decision | Alternative we rejected | Why ours is better for this problem |
|---|---|---|
| **PWA** (React + Vite + Workbox) | Native Android app / Flutter | No app-store friction, ~₹0 onboarding, one codebase, installable to home screen, works on ₹8k phones; iOS limits are documented rather than hidden |
| **Dexie/IndexedDB outbox + custom drain** | Workbox Background Sync for everything | Background Sync would replay a stale `client_now` and corrupt kinetics via skew correction; our outbox gives ordering, backoff, dedupe and a user-visible failed-ops list |
| **Web Worker kinetics mirror** | Server-only computation | Offline countdown is the core promise; a worker keeps the UI smooth and the golden tests guarantee it matches the server |
| **Literature-calibrated kinetics** | Trained ML model | No field data exists yet; a physical model with cited parameters is defensible in front of agronomists; the pilot's job is to *validate*, not to bootstrap a dataset |
| **FastAPI + Pydantic v2** | Django / Flask / Node | Async for the Agmarknet fetches, typed wire schemas that *are* the contract, OpenAPI at `/api/docs` for free |
| **SQLite → Postgres via SQLAlchemy 2 + Alembic** | Postgres-only or NoSQL | Zero-infra demo, one flag to production; relational fits batches/readings/prices; append-only + unique constraints enforce the chain in the DB |
| **APScheduler in-process** | Celery + Redis / Kafka | A 6-hour poll is not streaming; one process, no brokers, `max_instances=1` |
| **SHA-256 hash chain** | Blockchain | Same tamper-evidence, verifiable offline in the browser, zero gas/tokens/nodes; we say "not a blockchain" explicitly |
| **Pre-recorded voice clips** | TTS-only | Indic TTS quality is unreliable and needs network on many phones; clips are precached |
| **Haversine × road factor** (v1) | OSRM from day one | Honest v1 with tunable constants in config; OSRM is a Phase-2 swap behind the same `travel_hours` field |
| **nginx edge + Docker Compose** | Kubernetes | One VPS is honest at MVP scale; edge gives CSP, rate limits, immutable caching, TLS-ready |

---

## 4.4 Key USPs to Say Out Loud to the Judges

1. **"Software only, hardware optional."** No sensor, no reefer, no app store — a farmer with a ₹8k Android gets a shelf-life countdown today. A BLE tag plugs into the same `/readings` contract tomorrow.

2. **"It works in airplane mode — watch."** The demo logs a batch, gets a range and adds a reading with the radio off; then reconnects and syncs losslessly with clock-skew correction.

3. **"Always a range, never a fake number."** ≈ 42–104 h (most likely 72 h) with a confidence level tied to data recency; three literature-bounded parameter sets, validated by 26 golden cases in two languages.

4. **"One explainable command."** *Sell at Hosur, 2 h away — expected ₹6,608, +62 % vs the nearest mandi.* Tap **Why?** and see every price, date, distance, transit temperature, spoilage-at-arrival, transport cost — and every rejected mandi with a reason.

5. **"Same weather, one decision: 18 % → 13 %."** The status-quo vs FarmSignal comparison changes *only the decision* and is pinned to the engine by a test; we label it SIMULATED on stage.

6. **"Good handling becomes bargaining power."** Scan the Quality Pass: thermal timeline, freshness band, green Verified badge. Edit one reading in the database and it turns red at *reading 4* — a hash chain, not a blockchain.

7. **"Protocol-swappable — pharma is already running."** `pharma_2_8.json`: 2–8 °C band, 720-minute excursion budget, freeze = hard breach. Same integral, same tests. That is the pharma half of PS IHSIH013.

8. **"Resilient to the government API."** Live → cache → bundled snapshot, with the source printed on every price. A data.gov.in outage cannot produce a blank screen.

9. **"Built like a product, not a slide."** CI with lint/type/test gates on both halves, strict CSP, dual rate limits, Alembic migrations, privacy by default, and a written list of what we do *not* model.

10. **"Regional-language, low-literacy first."** Tamil/Hindi/English, native numerals, icon tiles, pre-recorded voice prompts — designed for the persona, not the demo.
