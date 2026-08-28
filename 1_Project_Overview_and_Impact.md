# 1. FarmSignal — Project Overview & Impact

> **SIH 2026 · Problem Statement IHSIH013** — *Digital platform for cold-chain monitoring of perishable food and pharmaceuticals* (Theme: Transportation & Logistics) · **Team Baddies**
>
> One-liner: **Offline-first, regional-language decision support for India's first-mile cold-chain gap.** Tagline in the app: *"Sell before it spoils."*

---

## 1.1 The Problem We Are Solving

### The numbers

| Fact | Source (as cited in `docs/FarmSignal-PRD.md`) |
|---|---|
| India loses **~₹1.5 lakh crore** of food every year | NABCONS 2022 |
| **6–15 %** of fruit & vegetable output is lost between harvest and the first cold-chain touchpoint | PRD §1 |
| Cold-*storage* capacity is nearly adequate; the **85–99 % infrastructure gap** is in reefer transport, pack-houses and pre-cooling | NCCD |
| Ripe tomato lasts only **2–4 days at 28–32 °C** in mandi conditions vs **10–14 days at 10–12 °C** | ICAR-CIPHET 2015, USDA Handbook 66 |

### Where the loss actually happens: the **first mile**

The "first mile" is the window between harvest and the first cold-chain touchpoint (a pack-house, reefer, or the mandi itself). In those hours:

1. **No one has visibility.** No government or private digital system sees the batch sitting in an open yard at 38 °C waiting for a trader.
2. **The farmer has no way to reason about time.** They know produce spoils, but not *how fast today*, and *how far they can still afford to travel* to a better-paying market.
3. **Price information is disconnected from freshness.** Agmarknet publishes mandi prices, but a higher price 300 km away is worthless if the batch arrives half-spoiled and the truck costs more than the uplift.
4. **Handling history is invisible to the buyer.** A trader cannot distinguish a batch kept at 12 °C in a reefer van from one left in the sun — so the farmer gets no premium for good handling.

### Who is *not* solving it

| Existing player | What they do | Gap |
|---|---|---|
| Ecozen, CoolCrop | Solar cold rooms / hardware | Only for those who can afford the hardware |
| eVIN (Govt.) | National vaccine cold-chain digitisation | Stops at public-health facilities; proves scale works |
| Agmarknet | Daily mandi prices | Prices only — no shelf-life, no routing, no offline |

**Nobody serves the open decision layer.** That is FarmSignal's position.

---

## 1.2 Our Solution: FarmSignal

FarmSignal is a **decision layer, not a hardware product**. It works with whatever cold-chain access the user has — none, a manual thermometer, or a BLE tag — and is explicitly vendor-neutral.

### The core loop (exactly what the code does)

```
Log harvest (≤30 s, offline)
      │
      ▼
Crop-specific kinetic spoilage model  ──►  live SHELF-LIFE RANGE on the phone
(Web Worker, no network needed)             "≈ 42–104 h, most likely 72 h"
      │
      ▼
Routing engine: shelf-life × live Agmarknet prices × travel time × transport cost
      │
      ▼
ONE explainable command:
"Sell at Hosur, 73 km, ~2 h — expected ₹6,608. Nearest mandi Palacode: ₹4,083. +62 %."
      │
      ▼
Tamper-evident QUALITY PASS (QR + SHA-256 hash chain) the trader can scan and verify
```

### How each part of the solution maps to the problem

| Problem | FarmSignal feature | Where it lives in the repo |
|---|---|---|
| No visibility in the first mile | Batch logging + temperature readings (manual / simulated / BLE-ready), synced offline-first | `apps/web/src/pages/NewBatch.tsx`, `services/api/app/routers/readings.py` |
| Farmer cannot reason about spoilage speed | **Kinetics engine**: Q10/Arrhenius degree-hour integral, literature-calibrated for tomato & guava; output is always a *range* with confidence | `services/api/app/kinetics/engine.py`, mirrored in `apps/web/src/engine/` and run in a Web Worker |
| Price info disconnected from freshness | **Routing engine**: `expected_value = price × (1 − spoilage_at_arrival) − transport_cost`, constrained by `travel_time < remaining × 0.8` | `services/api/app/routing/engine.py` |
| Prices unreliable / API outages | Agmarknet poller (data.gov.in) every 6 h with **live → DB cache → bundled snapshot** fallback; never blocks a recommendation | `services/api/app/prices/` |
| Handling history invisible to buyer | **Quality Pass**: public read-only page + QR; each reading hashed `SHA-256(prev_hash ‖ payload)`; chain head printed on the QR | `services/api/app/quality_pass/`, `apps/web/src/engine/hashchain.ts` |
| Low literacy, regional languages, patchy 2G | PWA, icon-first UI, i18next `en`/`hi`/`ta`, pre-recorded voice clips, Devanagari numerals toggle | `apps/web/src/i18n/`, `apps/web/src/voice/` |
| FPOs need a fleet view | FPO dashboard: batches by urgency + Leaflet map of batches vs mandis | `apps/web/src/pages/Fpo.tsx` |
| Pharma cold chain (same PS) | The *same* engine evaluates a 2–8 °C excursion budget from a data file (`pharma_2_8.json`) — freeze = hard breach | `services/api/app/kinetics/protocols/pharma_2_8.json` |

### The "honesty principles" (product rules enforced in code and tests)

These are what make the pitch credible in front of a technical jury:

1. **Shelf life is always a range** with a confidence level that reflects *data recency* — never a false-precision scalar.
2. **Simulated data is always labelled** with a `SIMULATED` chip; real prices carry their source (`agmarknet_live` / `agmarknet_cache` / `bundled_snapshot`) and reported date.
3. **Every recommendation is explainable** — the "Why?" screen shows every input and every rejected mandi with a reason code.
4. **No trained ML.** Literature-calibrated kinetics with stated limitations (`docs/MODEL-NOTES.md`). With zero field data, a physical model is defensible; a "trained" model would not be.
5. **The Quality Pass is a hash chain, not a blockchain** — and we say so.
6. **Privacy by default**: no Aadhaar, no financial data; public pass pages expose no farmer identity beyond an opt-in display name and a ~20 km geohash cell.

---

## 1.3 Target Audience (Personas)

| Persona | Context | Job-to-be-done | What they use |
|---|---|---|---|
| **Smallholder farmer** (primary) | 1–2 acres, ₹8k Android, low literacy, patchy 2G/4G | *"Tell me where to sell this batch before it spoils, in my language."* | Home → New batch → Batch detail → "Sell where?" → Why? |
| **FPO coordinator** | Manages 50–500 farmers, moderate digital literacy | *"See all member batches, plan shared transport / cold-room slots."* | `/fpo` dashboard with urgency list + map |
| **Trader / buyer** | Mandi-side price-setter | *"Verify this batch's handling before I price it."* | Scans the Quality Pass QR → public `/pass/:id` page → Verified badge |
| **Pharmacy ops lead** (Phase 2) | E-pharmacy / hospital pharmacy | *"Prove 2–8 °C integrity from hub to patient door."* | Same engine, `pharma_2_8` protocol (engine + tests today; UI in Phase 2) |

**Demo region:** Tamil Nadu + border Karnataka — the Dharmapuri/Krishnagiri tomato belt. Origin: Palacode block (12.30 N, 78.07 E). 13 mandis in `data/mandis.json` (Palacode, Dharmapuri, Krishnagiri, Hosur, Salem, Vellore, Koyambedu, Coimbatore, Trichy, Ottanchatram, Madurai, Kolar, Bengaluru).

---

## 1.4 Projected Real-World Impact

### Economic impact — the 18 % → 13 % comparison (pinned to the engine by `test_routing.py`)

The demo seed's `loss_comparison` block runs the **same 500 kg tomato batch through the same `hot_afternoon` weather profile** (33–38 °C for 6 h, then 30 °C), and changes *only the decision*:

| Path | Decision | Shelf life consumed at sale | Realised value | Delta |
|---|---|---|---|---|
| **Status quo** | Wait for the trader until hour 10, sell at nearest mandi (Palacode, ₹850/quintal) | **18.3 %** | **₹3,462** | — |
| **With FarmSignal** | Leave at hour 4 for the recommended mandi (Hosur, ₹1,600/quintal, 2.1 h transit) | **13.1 %** | **₹6,082** | **+76 %** |
| *Reference: + cool-morning harvest* | Same as above but harvested in a cool morning (the hero demo batch) | 6.5 % | ₹6,608 | (not headline — weather differs) |

> **How to say it honestly on stage:** "The percentage is shelf life *consumed* at the moment of sale, not physical loss — both batches are still green. All numbers come from the same kinetics + routing code with snapshot prices. It is a simulation of handling paths, not a field trial; the pilot's job is to replace it with measured numbers."

### Social impact

- **Zero marginal cost per farmer.** PWA, no hardware, no app-store install, no SIM-based OTP required in demo. The PRD's onboarding-cost target is ~₹0.
- **Works for low-literacy users.** Icon-first crop tiles, numeric pad, voice prompts in Tamil/Hindi/English (`welcome`, `batch_logged`, `alert_75/50/25`, `sell_now`, `recommendation_ready`), native numerals.
- **Works with zero connectivity.** Every farmer-facing flow — logging, countdown, alerts, Quality Pass display — runs offline; sync is background, never a user task.
- **Bargaining power shifts to the farmer.** The Quality Pass makes good handling *provable*, converting an invisible practice into negotiating leverage.
- **Gives unflattering answers too.** Seeded batch #2 (critical, 60 h old) gets "sell now — Palacode, ₹302" with 3 mandis marked *too far for shelf life*. Trust comes from honesty, not from always promising an uplift.

### Scalability

| Dimension | How the design scales | Evidence in repo |
|---|---|---|
| **Crops** | Protocols are *data*. Adding a crop = one JSON file + golden tests + snapshot prices; the engine does not change. | `docs/MODEL-NOTES.md §9`, `app/kinetics/registry.py` validates each file at import |
| **Pharma** | Same evaluator, `model: "excursion"` instead of `model: "q10"`. Already passes tests (6 h out of band → 50 % budget consumed). | `pharma_2_8.json`, `test_kinetics.py` |
| **Languages** | i18next namespaces per locale (`common`, `batch`, `pass`, `fpo`, `alerts`, `settings`); architecture ready for 8+ languages. | `apps/web/src/i18n/locales/{en,hi,ta}/` |
| **Regions / mandis** | `data/mandis.json` maps each mandi to its Agmarknet `state`/`market` filter; the poller fetches per (commodity × state). | `app/prices/client.py` `MarketIndex` |
| **Sensors** | BLE tags plug into the *same* `POST /batches/{id}/readings` contract (`source: "ble"` enum already exists). | `app/enums.py` `ReadingSource` |
| **Infrastructure** | SQLite → Postgres 16 via Alembic and one compose `--profile prod` flag; nginx edge with rate limits. Single VPS is honest at MVP scale; no Kubernetes/Kafka needed. | `infra/docker-compose.prod.yml`, `infra/DEPLOY.md` |
| **Alerts beyond the app** | `SmsIvrGateway` protocol with a logging stub; a real SMS/IVR provider is a `set_gateway()` swap. | `app/alerts/sms_ivr_stub.py` |

### Success metrics we commit to (from the PRD)

| Metric | Definition | MVP target |
|---|---|---|
| Time-to-decision | Harvest logged → recommendation shown | ≤ 5 s offline estimate, ≤ 30 s incl. sync |
| Value delta (demo) | Recommended vs nearest-mandi realised value | ≥ 20 % uplift, labelled simulated (we show +62 % / +76 %) |
| Model sanity | Shelf-life vs literature at 3 temperature profiles | Within published range (tomato 10/20/30 °C → 288/144/72 h) |
| Offline integrity | Batches logged offline that sync losslessly | 100 % (idempotent client UUIDs + `sync_ops` dedupe) |
| Onboarding cost | Marginal cost per farmer | ~₹0 |

*Vanity metrics (raw user counts) are explicitly excluded.*

---

## 1.5 Elevator Summary (memorise this)

> Between harvest and the first cold-chain touchpoint India loses 6–15 % of its fruit and vegetables. The gap is not cold storage — it is the **decision** in those first hours: where to sell, and how fast. **FarmSignal is that decision layer**: software-only, offline-first, in the farmer's language. A crop-specific kinetic model turns time and temperature into a live shelf-life range; the routing engine fuses that with live Agmarknet prices and travel time into one explainable command; and a hash-chained Quality Pass turns good handling into bargaining power. The same engine already runs a pharma 2–8 °C excursion budget from a data file — that is the pharma last mile in Phase 2.
