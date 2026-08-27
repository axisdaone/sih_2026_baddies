# FarmSignal - 5-minute pitch demo script

Audience: SIH jury (PS IHSIH013, cold-chain monitoring for perishable food and pharma). Two phones
(Android, Chrome), one laptop with the stack running (`infra/docker-compose.yml` or `uvicorn` +
`vite dev`), a second person to scan the QR. Everything below uses the seeded demo dataset
(`data/demo_scenarios/demo_seed.json`) and the bundled snapshot prices; simulated data is always shown
with the `SIMULATED` chip and we say so on stage.

Numbers quoted here are what the engine produces from the seed data with the contract's constants.
If the seed, snapshot or constants change, re-run the seed and update this script.

---

## 0. Setup (T-30 min)

- [ ] Stack up: `curl -fsS http://<laptop>/api/v1/health` shows `status: ok` and a `prices.source`.
- [ ] `POST /api/v1/demo/seed` done (idempotent; safe to repeat). Home shows 6 batches: 3 green
      (fresh), 2 amber (warning), 1 red (critical).
- [ ] Demo phone A: PWA installed to home screen, locale **Tamil**, native numerals on, logged in as
      `demo-device-001` (Muthu). Open the app once *online* so the service worker precache is warm.
- [ ] Demo phone B (jury-facing "trader" phone): camera app ready, on the same network or hotspot.
- [ ] Laptop mirrors phone A (`scrcpy`) to the projector; browser tab with the FPO map open.
- [ ] Bluetooth speaker paired for the Tamil voice clips (or phone volume max).
- [ ] Airplane-mode toggle in phone A's quick settings, GPS location cached (open Maps once outdoors,
      or set origin manually to the demo origin in Settings).

## 1. Script

### 0:00 - 0:30 The problem, one sentence

"Between harvest and the first cold-chain touchpoint India loses 6-15 % of its fruit and vegetables.
The gap is not cold storage, it is the *decision* in those first hours: where to sell, and how fast.
FarmSignal is that decision layer - software only, offline-first, in the farmer's language."

### 0:30 - 1:30 Airplane mode: log a batch, get a shelf-life range in under 5 s

1. Turn **airplane mode on** (show the icon on the projector).
2. Tap **New batch** -> tomato icon -> 500 kg -> harvest time "now" -> location (cached GPS) -> Save.
   Voice: *"batch logged"* in Tamil.
3. The batch card appears immediately with a **range**: "~ 42-104 h (most likely 72 h)", status green,
   confidence **low**, and the note "assumed 30 C - add a reading".
   Say: "No sensor, no network, and it already reasons: at a 30 C yard a ripe tomato lasts about 3 days;
   the range is parameter uncertainty from the literature, not a guess."
4. Add a **manual reading**: 24 C. The range jumps ("~ 71-148 h, most likely 109 h"), confidence
   becomes medium. Say: "Every reading tightens the estimate. A BLE tag would do this automatically -
   same `/readings` contract - but we do not depend on hardware."

### 1:30 - 2:15 Reconnect and sync

1. Airplane mode **off**. Within seconds the outbox badge drains: toast "2 changes synced".
2. Open the batch: the server's estimate matches the phone's (same golden-tested engine in Python and
   TypeScript), and a **chain head** hash now shows under the readings.
   Say: "Client-generated UUIDs and a monotonic sequence make sync idempotent; the server also corrects
   phone clock skew, which otherwise silently corrupts kinetics."

### 2:15 - 3:15 The recommendation and the "why"

1. Open the seeded hero batch (**tomato 500 kg, logged 4 h ago, cool morning readings**).
   Status fresh, confidence high, "~ 47-114 h (most likely 80 h)".
2. Tap **Sell where?** -> "**Hosur**, 73 km, ~2 h - expected Rs 6,638. Nearest mandi Palacode:
   Rs 4,083. +63 %." Alternatives: Bengaluru Rs 6,196, Kolar Rs 4,996. Voice: *"sell at Hosur"*.
3. Tap **Why?** and read the payload aloud: modal price 1,600 vs 850 Rs/quintal (Agmarknet, reported
   25 Aug, `source: bundled_snapshot` or `agmarknet_live` - point at the label), 72.5 road-km at
   35 km/h, transit at 28 C, spoilage at arrival 6.2 %, transport Rs 870.
   Say: "Koyambedu pays the most, 1,800, but it is 320 km: the truck costs Rs 3,800 and the batch loses
   another 11 % on the road - the app shows that in *rejected/alternatives* instead of hiding it."
4. Optional if time: open the **critical** batch (tomato, 60 h ago, hot afternoon). The app says
   "sell now - Palacode, Rs 302" with 3 mandis marked *too far for shelf life*. Say: "It also gives
   unflattering answers. That is the product principle."

### 3:15 - 3:45 The 18 % -> 7 % comparison (simulated, and we say so)

Show the comparison card (from `demo_seed.json` -> `loss_comparison`). Explain it honestly:

- **Status quo**: the same 500 kg tomato batch sits in the open yard through the `hot_afternoon`
  profile (6 h at 33-38 C, then 30 C), the trader arrives at hour 10, and it goes to the nearest mandi.
  Shelf life consumed at sale: **18.3 %**. Realised value at Palacode: Rs 3,462.
- **With FarmSignal**: same batch, `cool_morning` readings, the app recommends leaving at hour 4 for
  Hosur; 2.1 h transit at 28 C. Consumed at sale: **6.2 %**. Realised value: Rs 6,638.
- "Both numbers come from the same kinetics and routing code with snapshot prices. This is a simulation
  of two handling paths, not a field trial - the UI labels it SIMULATED. The pilot's job is to replace
  it with measured numbers."

### 3:45 - 4:30 Quality Pass: QR scan and the tamper demo

1. Open the **reefer batch** (tomato 800 kg, 12 C chain) -> **Quality Pass** -> QR on screen.
2. Phone B scans it: the public page loads (no farmer identity), shows the thermal timeline, the
   freshness band and a green **Verified** badge (`/quality-pass/{id}/verify?head=...` recomputed the
   SHA-256 chain: 7 readings, head matches).
3. Tamper: on the laptop, edit one reading in the database (the demo command is prepared in a terminal):
   ```bash
   docker compose -f infra/docker-compose.yml exec api \
     python -c "import sqlite3; c=sqlite3.connect('/var/lib/farmsignal/farmsignal.db'); c.execute(\"update readings set temp_c=18 where batch_id='a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c04' and seq=4\"); c.commit()"
   ```
   Phone B taps **Re-verify**: badge turns red, "chain broken at reading 4".
   Say: "Not a blockchain - a hash chain. Each reading's hash covers the previous one, the head is
   printed on the QR, so history cannot be rewritten after the pass is issued."
4. Restore for the next run (`temp_c=12` on the same row, or re-run `down -v` + seed).

### 4:30 - 5:00 FPO view and close

1. Laptop: **FPO dashboard** - member batches by urgency, Leaflet map with batches vs mandis and the
   recommended arrows.
2. Close on the three claims: **offline-first** (you saw airplane mode), **explainable** (the why
   screen), **protocol-swappable** - open `pharma_2_8.json` for one second: "same engine, 2-8 C
   excursion budget, freeze = hard breach; that is the pharma last mile in Phase 2, already running in
   tests today."

---

## 2. Failure-mode rehearsal checklist

Rehearse each of these at least once with the stopwatch running.

| Failure | What the audience sees | Response |
|---|---|---|
| Venue Wi-Fi blocks the laptop | Sync never completes | Run everything on the laptop + phone hotspot; `PUBLIC_BASE_URL` set to the hotspot IP so QR links resolve. Offline part of the demo is unaffected. |
| Agmarknet / data.gov.in down or slow | `price_source: bundled_snapshot`, "prices from 25 Aug" | Say it out loud: "the government API is down right now; this is the last-known-good snapshot and the app says so." Never a blank screen (`/prices` never errors). |
| API container down | Phone still computes shelf life; sync badge stays pending | Continue the offline segment; restart with `docker compose up -d api` (health in ~20 s). Skip the tamper step if it is not back. |
| Stale service worker after a rebuild | Old UI version | Settings -> "Reload app" (or Chrome: site settings -> clear storage), then re-seed. Do this in setup, never on stage. |
| Phone clock skew (someone set the time) | Server shows `clock_adjusted: true`, shelf life still right | Mention it: skew correction is a feature. |
| GPS unavailable indoors | New batch has no location | Settings has "use demo origin"; recommendation uses the batch's stored origin. |
| QR will not scan under stage lights | Phone B cannot read it | Tap the QR to reveal the URL and open it by hand; also keep the pass URL in the laptop browser. |
| Voice clip missing for a key | "TTS fallback" label appears | Acceptable; say the manifest lists the keys and clips are recorded per language. |
| Seed already loaded / duplicate batches | Extra cards | Seeding is idempotent (fixed UUIDs). If someone created stray batches, `docker compose down -v` + seed (60 s). |
| Projector mirroring dies | Nothing on screen | Backup: a pre-recorded 90-second screen capture of the offline segment on the laptop. |
| Demo phone battery / overheating | Phone throttles or dies | Second phone has the PWA installed and seeded too; swap devices, same device_id is not required (seed is per server). |
| Rate limit hit on Quality Pass while the jury spams it | HTTP 429 after 60/min | That is the feature; say so and wait a few seconds. |

Timing guard: if at 3:15 you are behind, drop the critical-batch aside (2.15 step 4) and the FPO map,
never the airplane-mode segment or the tamper demo.
