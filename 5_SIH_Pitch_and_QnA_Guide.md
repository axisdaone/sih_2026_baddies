# 5. FarmSignal — SIH Pitch Script & Judge Q&A Guide

> Everything below is grounded in the repository. Numbers come from the seeded demo dataset (`data/demo_scenarios/demo_seed.json`) with the bundled snapshot prices and the contract constants — the same numbers `services/api/tests/test_routing.py` pins. If the seed or constants change, re-run the seed and update this script.

---

## 5.1 Three-Minute Elevator Pitch (≈ 420 words, spoken)

**[0:00 – 0:25] The problem**

> "Between harvest and the first cold-chain touchpoint, India loses six to fifteen percent of its fruit and vegetables — about one-and-a-half lakh crore rupees a year. And the gap is *not* cold storage; capacity is nearly adequate. The gap is the **decision** in those first hours: where to sell, and how fast. Nobody — not Agmarknet, not the hardware vendors, not eVIN — serves that decision. FarmSignal does."

**[0:25 – 1:05] What it is**

> "FarmSignal is an offline-first, regional-language decision layer. A farmer logs a harvest in under thirty seconds — with the radio off. A crop-specific kinetic spoilage model, calibrated to published postharvest science, turns the batch's time-and-temperature history into a live shelf-life **range** on the phone: *'about 42 to 104 hours, most likely 72.'* Add a thermometer reading and the range tightens. No sensor required; a BLE tag is optional and plugs into the same interface."

**[1:05 – 1:50] The recommendation**

> "When the phone reconnects, it syncs losslessly and the server's routing engine fuses that shelf-life with live Agmarknet mandi prices, road distance, transit temperature and transport cost into *one* command: **'Sell at Hosur, two hours away — expected ₹6,608. The nearest mandi pays ₹4,083. That's plus sixty-two percent.'** Tap *Why?* and every input is on screen — the price and the date it was reported, the spoilage the batch will suffer on the road, the truck cost, and the mandis we rejected and why. Koyambedu pays more, but it's 320 kilometres: the truck costs ₹3,800 and the batch loses another 11 percent. We show that instead of hiding it."

**[1:50 – 2:20] The Quality Pass**

> "Every reading is hashed onto the previous one — SHA-256, a hash chain, deliberately *not* a blockchain — and the chain head is printed on a QR. A trader scans it and sees the thermal timeline, the freshness band and a green Verified badge. Change one reading in the database and the badge turns red at reading four. Good handling becomes bargaining power."

**[2:20 – 2:45] Impact and honesty**

> "Same batch, same hot afternoon, one different decision: shelf-life consumed at sale drops from 18 to 13 percent and realised value rises 76 percent. Those numbers are produced by the engine and pinned by a test — and the app labels them *simulated*, because the pilot's job is to replace them with field data."

**[2:45 – 3:00] Pharma and close**

> "And because the model is data, not code, the *same* engine already evaluates a pharma 2-to-8-degree excursion budget — freeze is a hard breach — passing tests today. That's the second half of the problem statement. Offline-first, explainable, protocol-swappable. FarmSignal: sell before it spoils."

---

## 5.2 Demo Beats (5-minute version, from `docs/DEMO-SCRIPT.md`)

| Time | Beat | Key line |
|---|---|---|
| 0:30 – 1:30 | **Airplane mode**: New batch → tomato → 500 kg → Save → range 42–104 h, confidence low; add 24 °C → 71–148 h, medium | "No sensor, no network, and it already reasons." |
| 1:30 – 2:15 | **Reconnect**: outbox drains, chain head appears | "Client UUIDs + monotonic sequence make sync idempotent; the server also corrects phone clock skew." |
| 2:15 – 3:15 | **Hero batch** → Sell where? → Hosur ₹6,608 (+62 %) → **Why?** | "It also gives unflattering answers — open the critical batch: 'sell now, Palacode, ₹302'." |
| 3:15 – 3:45 | **18 % → 13 % slide** | "Only the decision changed. SIMULATED. Pinned by `test_routing.py`." |
| 3:45 – 4:30 | **Quality Pass** on the reefer batch → trader scans → Verified → tamper `seq=4` → red | "Not a blockchain — a hash chain." |
| 4:30 – 5:00 | **FPO map** + open `pharma_2_8.json` for one second | "Same engine, 2–8 °C, freeze = breach. Phase 2 pharma, running in tests today." |

Timing guard: if behind at 3:15, drop the critical-batch aside and the FPO map — never the airplane-mode segment or the tamper demo.

---

## 5.3 Likely Judge Questions — With Codebase-Backed Answers

### A. Model & accuracy

**Q1. How do you know your shelf-life numbers are right? Did you train a model?**
> No ML. The model is textbook reaction kinetics — Arrhenius, in its practical Q10 form: `r(T) = q10^((T − 10)/10)`, integrated over the temperature timeline as a degree-hour integral (`services/api/app/kinetics/engine.py`). Parameters come from USDA Handbook 66, Kader (UC Davis), Tijskens & Polderdijk 1996 and ICAR-CIPHET field data, cited in each protocol's `sources[]`. Tests assert the literature anchors: tomato 288 h at 10 °C, 144 h at 20 °C, 72 h at 30 °C; published range is 2–4 days at 30 °C and 1–2 weeks at 10–12 °C. With zero field data, a calibrated physical model is defensible; a "trained" model would not be. The pilot's first job is validation against logged batches.

**Q2. Why a range instead of one number?**
> Because the inputs are uncertain: tomato shelf-life at 10–12 °C is published as 10–14 days, Q10 as 1.8–2.4. We evaluate three parameter sets — mid, optimistic (low Q10, long L_ref), pessimistic (high Q10, short L_ref) — and always render the range. `registry.validate_scenario_ordering()` mathematically checks at import that low ≤ mid ≤ high at both clamp temperatures, so a bad protocol file fails at boot, not on a farmer's phone.

**Q3. What if there are no temperature readings at all?**
> We assume the protocol's `default_ambient_c` (30 °C for crops — a hot Indian yard, not a best case), flag the segment `assumed: true`, set confidence `low`, and the UI says "assumed 30 °C — add a reading". The app must never look better than reality because the farmer stopped logging.

**Q4. What does "confidence" mean?**
> Data recency, not model uncertainty (the range covers that). `high` = ≥ 2 readings and the last ≤ 2 h old; `medium` = ≥ 1 reading ≤ 8 h old; `low` otherwise. It is deterministic so phone and server always agree.

**Q5. What does the model *not* capture?**
> `docs/MODEL-NOTES.md §8` lists ten limitations: no humidity, no ethylene/mixed loads, no maturity stage or cultivar, chilling injury is a flag not a rate, piecewise-constant timeline between readings, constant Q10 across 10–45 °C (error is on the safe side, ~5 % at 30 °C, within the range), linear value-loss in routing, assumed transit temperature, simple pharma budget (no MKT), and no field validation yet. We'd rather the jury hear that from us.

**Q6. Why does a batch that sat through a hot afternoon show *more* remaining hours than one in a cool morning?**
> Remaining hours are projected at the *current* temperature ("if nothing changes from now"); consumed fraction is the honest cumulative comparison. After 8 h, `hot_afternoon` has consumed 15.5 % vs `cool_morning` 9.4 %, yet shows 61 h vs 53 h because it is now at 30 °C vs 33 °C. Status and alerts use consumed fraction; the UI shows both.

**Q7. How is the pharma case the "same engine"?**
> `pharma_2_8.json` sets `model: "excursion"` — the only change is the rate function: `r = 0` inside 2–8 °C, `1` outside. With `reference_shelf_life_hours = 720 min / 60 = 12`, the identical integral becomes "hours out of band ÷ allowed budget" — the time-out-of-refrigeration budgeting in USP <1079> and WHO TRS 961 Annex 9. Freeze (< 0 °C) and > 25 °C are hard breaches. Test anchor: 6 h at 15 °C then 6 h at 5 °C → consumed 0.5, 6 h left, status `warning`. Mean Kinetic Temperature is a Phase-2 addition from the same segments.

**Q8. How do you add a new crop?**
> One JSON file in `app/kinetics/protocols/` (Q10, L_ref + ranges, clamps, ambient, hard thresholds, Agmarknet commodity name, sources), copy to the web via `npm run sync-data` (a test enforces byte-equality), three golden cases at 10/20/30 °C, snapshot prices, a crop tile + i18n names. The engine does not change.

### B. Offline, sync & data integrity

**Q9. How does offline actually work — and how do you avoid duplicates on retry?**
> Every write goes through `db/repo.ts`, which updates Dexie/IndexedDB and enqueues an outbox op in one place. Batch and reading IDs are client-generated UUID v4; each op has an `op_id` and a monotonic per-device `client_seq`. The server's `sync_ops` table dedupes: a replayed op returns `duplicate`, and readings are append-only (`unique(batch_id, seq)`, an existing id is never updated). PRD target: 100 % of offline batches sync losslessly.

**Q10. What happens when the phone's clock is wrong? Wouldn't that corrupt kinetics?**
> Yes, silently — so we handle it. Every `/sync` carries `client_now`; the server computes `skew = client_now − server_now` and, if |skew| > 120 s, shifts every `harvested_at`/`taken_at` in the request by `−skew` and flags `clock_adjusted`. The client stores the accumulated skew (`run.skew + residual`, so it never oscillates) and all local kinetics use `nowIso() = device clock − skew`. The demo phone can have its clock changed on purpose.

**Q11. Why not use Workbox Background Sync?**
> We use Workbox for precaching and runtime caching, but deliberately *not* for `POST /sync`: a verbatim replay hours later would carry a stale `client_now`, which the skew correction would read as a huge skew and shift every timestamp. The Dexie outbox is the sole durable queue — drained on open, `online`, foreground and every 60 s, with exponential backoff (2^attempts × 60 s, cap 1 h) and parking after 5 rejections so the farmer can discard a bad op in Settings.

**Q12. How do you guarantee the phone and the server compute the same shelf-life?**
> The Python engine and the TypeScript engine implement the same contract (§2.2), with rounding pinned to JS `Math.round` semantics and hour arithmetic in whole milliseconds. 26 golden cases in `golden_kinetics.json` must pass in both `pytest` and `vitest`, and `parity.test.ts` compares the TS output byte-for-byte against `golden_estimates_py.json` dumped from Python.

**Q13. What if two devices edit the same batch?**
> Batch fields are last-writer-wins by `client_seq`; readings are append-only and can never conflict. A batch id owned by another farmer is rejected with 409 `ID_IN_USE`. The demo seeder even handles a stranger squatting a fixed seed id by deriving `uuid5(farmer.id, fixed_id)`.

### C. Prices & routing

**Q14. What if Agmarknet / data.gov.in is down during the demo?**
> Then you'll see `price_source: bundled_snapshot, reported 25 Aug` on every candidate — and we'll say so. Order of truth is live → DB cache (last-known-good) → bundled snapshot; the snapshot never overwrites live rows. Fetches have a 5 s timeout, 3 retries with 1/2/4 s backoff, and the poller runs in a daemon thread so startup never blocks. `/prices` and recommendations never error on price failure.

**Q15. Walk me through the routing formula.**
> Per mandi: `straight_km` by haversine × road factor 1.3 → `distance_km`; ÷ 35 km/h → `travel_hours`; `consumed_at_arrival = clamp(consumed_now + travel_hours × r(transit_temp)/L_ref)`; `gross = modal_price/100 × qty_kg × (1 − consumed_at_arrival)`; `transport = distance_km × ₹12`; `expected = gross − transport`. Feasible if `travel_hours < remaining_at(transit_temp) × 0.8` and `expected > 0`. Ranked: pessimistically-safe first, fresh prices before stale, then value. All constants are in config and echoed in the payload.

**Q16. Why assume 30 °C in transit when my last reading was 12 °C in a reefer?**
> Because v1 has no vehicle input. Transit temp = `max(last reading if ≤ 2 h old, protocol ambient)` — a reading can make the trip warmer, never cooler. A stale cold reading must never make a trip "reachable" that arrives spoiled. Reefer/vehicle type is a Phase-2 input and the formula has the slot for it.

**Q17. The uplift numbers look too good. Are they real?**
> They are engine outputs with snapshot prices, labelled SIMULATED wherever simulated readings feed them (`Recommendation.simulated`, the `SimBadge` chip, even the OS notification title). The headline 18 % → 13 % comparison uses the *same* weather profile and changes only the decision; the cool-morning hero batch is shown separately precisely because its weather differs. Value loss is assumed linear — real mandi pricing is step-wise — and the Why screen says so.

### D. Security & privacy

**Q18. How do you authenticate farmers without OTP?**
> Device-bound JWT: `POST /auth/device {device_id}` find-or-creates a farmer and mints an HS256 token (`sub=farmer_id`, `did=device_id`, 30 d). The device id is the credential, so that endpoint is throttled at 10 req/min per IP both in nginx and in-app, device ids are UUID-only, and `/sync` refuses a body whose `device_id` doesn't match the token. Phone-OTP is an optional add-on per the PRD, off for the demo.

**Q19. What stops someone abusing the public Quality Pass endpoint?**
> It is rate-limited to 60 req/min per IP at the nginx edge (burst 20) *and* by an in-process sliding-window limiter (bounded to 10 k keys with eviction). Proxy headers are trusted only with `TRUST_PROXY=true`, and only the *last* `X-Forwarded-For` hop. Pass events store an HMAC-SHA-256 pseudonym of the IP, keyed off the JWT secret — never the raw address.

**Q20. What personal data do you collect?**
> None beyond an opt-in display name and a locale. No Aadhaar, no phone number, no financial data. The public pass strips `farmer_id`, `device_id`, notes and exact GPS (geohash truncated to precision 4 ≈ 20 km, plus a region label). Reading geohashes are precision 7 (~150 m) and never a raw fix.

**Q21. Is the token safe in `localStorage`?**
> The mitigation is a strict CSP from the edge: `script-src 'self'`, `connect-src 'self'`, images only from self/data/OSM tiles, `frame-ancestors 'none'`, no inline scripts (the SW is registered from `main.tsx`, not an inline tag). The API client only attaches the bearer to our own API origin — a server-supplied `pass_url` on another host is sent anonymously.

**Q22. What about production secrets and demo endpoints?**
> `ENV=prod` refuses to boot with a placeholder or < 32-byte `JWT_SECRET`. `DEMO_MODE` is `false` in compose by default; when off, the demo device id is rejected at login, `/demo/*`, `/prices/refresh` and `/simulate` return 403. Destructive `?reset=true` needs an `X-Demo-Admin-Token` compared in constant time. The Docker context excludes `.env`, `*.db`, WAL/SHM files and tests.

### E. Scalability & operations

**Q23. SQLite in production? Really?**
> SQLite (WAL mode) is for dev and the demo. Production is PostgreSQL 16 behind one compose flag (`--profile prod`); `psycopg` is already in requirements, Alembic runs `upgrade head` on boot, and the models use `String(36)` UUIDs and tz-aware datetimes so both engines behave identically (`test_migrations.py`, `test_db_types.py`). Backups and the data-copy order are documented in `infra/DEPLOY.md`.

**Q24. How does this scale to a state or the country?**
> Horizontally on data: crops are protocol files, mandis are rows in `mandis.json` with Agmarknet filter values, and the poller fetches per (commodity × state). Compute is light — a recommendation is a pure function over 13 mandis. The honest constraint today is a single API process (in-process price cache and rate limiter, SQLite single-writer); moving to several replicas needs a shared cache — a Phase-2 item we've written down rather than hidden.

**Q25. Why no Redis / Kafka / Kubernetes?**
> Because a 6-hour poll is not streaming, one VPS is honest at MVP scale, and adding brokers would make the demo more fragile without making the product better. The PRD's "deliberate exclusions" list is a design decision, not an omission.

**Q26. How do you know the bundle is small enough for a ₹8k phone on 3G?**
> Every page is `React.lazy`; Leaflet and QR are separate chunks that only load on their pages; the build targets ES2020; and `scripts/check-bundle-size.mjs` runs `postbuild` and fails if the critical path exceeds the budget (PRD: < 300 KB).

**Q27. What about iOS?**
> Documented limitation: Safari lacks Background Sync and restricts push for home-screen web apps. The app still works offline (precache + IndexedDB) but the outbox drains only in the foreground and alerts appear only while open. The demo runs on Android Chrome; the constraint is stated in the PRD risk list, `infra/DEPLOY.md §5` and on the Settings page.

**Q28. Monitoring and error tracking?**
> Today: `/health` with DB status and price provenance, compose healthchecks, rotated JSON logs. Sentry → self-hosted GlitchTip is in the PRD tech table but *not wired yet* — `DEPLOY.md §6` says so explicitly and lists the two env vars to add before a pilot.

### F. Feasibility & adoption

**Q29. Will a low-literacy farmer actually use this?**
> The UI is icon-first (crop tiles, stepper, numeric pad, big buttons), fully translated into Tamil and Hindi with native-numeral support, and every key moment has a pre-recorded voice prompt (`welcome`, `batch_logged`, `alert_75/50/25`, `sell_now`, `recommendation_ready`). If a clip is missing, TTS plays with a visible label. The FPO coordinator persona is the realistic first adopter and gets a dashboard for member batches.

**Q30. How do you get temperature readings without hardware?**
> Manual entry from a ₹100 thermometer at handoff events is enough — the model only needs a few readings a day (hourly readings are the `high` confidence bar). BLE tags are Phase 2 and land on the exact same `POST /batches/{id}/readings` contract with `source: "ble"`.

**Q31. What's your business/adoption model?**
> Software-only means ~₹0 marginal cost per farmer. Distribution through FPOs (one coordinator onboards 50–500 farmers), value capture through FPO/aggregator subscriptions and, in Phase 2, pharma last-mile compliance. We explicitly exclude payments, credit and marketplace transactions from v1 (PRD non-goals).

**Q32. How is this different from Agmarknet or eNAM?**
> They publish prices; we make a *decision* from prices plus perishability plus logistics, offline, in the farmer's language, with an audit trail the buyer can verify. We consume Agmarknet rather than compete with it.

**Q33. What if the jury spams the QR verify endpoint on stage?**
> After the burst of 20 plus 60/min it returns HTTP 429 with `Retry-After`. That's the feature; we say so and wait a few seconds (rehearsed in the failure-mode checklist).

---

## 5.4 Numbers to Have at Your Fingertips

| Item | Value |
|---|---|
| Tomato protocol | T_ref 10 °C, L_ref 288 h [240, 336], Q10 2.0 [1.8, 2.4], floor 10 °C, ambient 30 °C, breach > 45 °C |
| Guava protocol | L_ref 336 h [240, 384], Q10 2.5 [2.2, 3.0], floor 8 °C |
| Pharma 2–8 | band [2, 8] °C, budget 720 min (12 h ± 10 %), breach < 0 °C or > 25 °C |
| Routing constants | road factor 1.3, 35 km/h, safety 0.8, ₹12/km |
| Alert thresholds | 75 / 50 / 25 % remaining; `sell_now` when critical |
| Status bands | fresh > 50 %, warning (25, 50], critical (0, 25], spoiled 0 |
| Hero batch (seed #1) | tomato 500 kg, 4 h, cool morning → fresh/high, ≈ 47–114 h (80 h); Hosur ₹6,608 vs Palacode ₹4,083 = +62 % |
| Critical batch (seed #2) | tomato 300 kg, 60 h, hot afternoon → critical/low, 87.7 % consumed; Palacode ₹302, 0 % uplift |
| Reefer batch (seed #4) | tomato 800 kg, 12 h, 12 °C chain, 7 readings → Hosur ₹11,085 (+73 %); tamper demo target `seq=4` |
| Guava batch (seed #5) | 400 kg pre-cooled → Bengaluru ₹13,339 (+61 %) |
| 18 % → 13 % | baseline ₹3,462 @ hour 10 Palacode; FarmSignal ₹6,082 @ hour 4 Hosur = +76 % |
| Golden cases | 26, tolerance 0.05 h / 1e-3 |
| Tests | ~185 pytest functions, ~170 vitest cases |
| Mandis | 13 (TN + border KA); snapshot 26 records dated 2026-08-25 |
| Rate limits | 60 r/m quality-pass, 10 r/m auth (edge + app) |
| Token | HS256, 30 days |
| Sync | ≤ 200 ops/request, 60 s loop, skew threshold 120 s, 5 retries max |

---

## 5.5 Future Scope & Roadmap

### Already stubbed or designed for in the code (say "the interface exists today")

| Feature | Evidence |
|---|---|
| **BLE temperature tags** | `ReadingSource.BLE` enum; same `/readings` contract; Dexie readings already carry `source` |
| **SMS / IVR alerts** | `app/alerts/sms_ivr_stub.py`: `SmsIvrGateway` protocol, `LoggingStubGateway`, `dispatch_alerts()`; `/sync` already returns `alerts[]` |
| **Pharma 2–8 °C mode** | Engine + protocol + tests done; needs a UI (no crop picker, budget display, MKT) |
| **PostgreSQL production** | `--profile prod`, Alembic, psycopg in requirements |
| **More languages** | i18next namespace layout; add `locales/<lang>/*.json` |
| **More crops** | Protocol JSON + golden cases (`MODEL-NOTES.md §9`) |
| **Demo origin / GPS fallback** | Settings toggle already exists for indoor demos |

### Phase 2 (pilot)

1. **Field validation** of the kinetics against real logged batches in the Dharmapuri belt; tune `q10_range` / `L_ref` per cultivar and maturity stage (add a maturity picker).
2. **OSRM self-hosted routing** for real road times, replacing haversine × 1.3 behind the same `travel_hours` field.
3. **Vehicle/reefer input** so transit temperature can be lower than ambient when justified.
4. **Humidity and ethylene inputs** (the two biggest stated model gaps).
5. **Pharma UI** with excursion budget, MKT, and manufacturer-specified budgets per product.
6. **SMS/IVR provider** behind the existing gateway, playing the same recorded clips for feature-phone users.
7. **Phone-OTP** as an optional credential upgrade on top of device JWT.
8. **Sentry/GlitchTip** error tracking (two env vars, documented).
9. **Shared cache + multi-replica API** (Redis) once a single process is no longer honest.
10. **Pin dependencies** (`requirements.lock`) before pilot.

### Phase 3 (scale / "Direction 6" from the PRD)

- **FPO logistics planning**: shared transport and cold-room slot booking from the dashboard's urgency list.
- **Aggregated, anonymised insights** for state agriculture departments (first-mile loss heatmaps by district/crop), respecting the tenant-scope privacy rule.
- **Buyer-side Quality Pass integration** (trader/eNAM lot pages linking to verified thermal history).
- **Step-wise price-grade model** replacing linear value loss once mandi grading data is collected.
- **Marketplace / cold-room leasing** — explicitly a future vision, not v1.

---

## 5.6 If Something Breaks on Stage (from the rehearsal checklist)

| Failure | Say | Do |
|---|---|---|
| Venue Wi-Fi blocks laptop | "Offline part is unaffected." | Hotspot; `PUBLIC_BASE_URL` = hotspot IP |
| Agmarknet down | "Government API is down; this is the last-known-good snapshot and the app says so." | Point at the `bundled_snapshot` chip |
| API container down | Continue offline segment | `docker compose up -d api`; skip tamper if not back |
| Clock skew toast appears | "Skew correction is a feature." | Nothing |
| QR won't scan | — | Tap QR to reveal URL; open by hand |
| Voice clip missing | "Clips are recorded per language; that's the labelled TTS fallback." | Nothing |
| 429 on verify | "That's the rate limit." | Wait a few seconds |
| Projector dies | — | Pre-recorded 90 s capture of the offline segment |
