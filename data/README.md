# `data/` - bundled reference data

Everything in this directory is **static, versioned data** that both the API (`services/api`) and the
PWA (`apps/web`) read. The API reads it from `DATA_DIR` (defaults to this folder); the web build copies
what it needs into `apps/web/src/data/` at build time. Nothing here is generated at runtime.

| File | Consumers | Purpose |
|---|---|---|
| `mandis.json` | API (`/mandis`, routing), PWA (map, offline recommendation) | The 13 demo mandis with coordinates and their Agmarknet filter values. |
| `agmarknet_snapshot.json` | API price fallback (`source: "bundled_snapshot"`), PWA offline prices | Last-known-good Agmarknet prices so a data.gov.in outage can never kill a recommendation. |
| `demo_scenarios/*.json` | API telemetry simulator (`POST /batches/{id}/simulate`), PWA "simulated telemetry player" | Temperature profiles (offset from harvest -> temp). See `demo_scenarios/README.md`. |
| `demo_scenarios/demo_seed.json` | API `POST /demo/seed` | The scripted pitch dataset: demo farmer + 6 batches with fixed UUIDs. |
| `demo_scenarios/golden_kinetics.json` | `pytest` and `vitest` | Cross-language golden cases for the kinetics engine (contract section 2.2). |

All timestamps are ISO-8601 UTC (`...Z`), all IDs are UUID v4 strings, temperatures are degrees Celsius,
prices are INR per quintal (100 kg), as on Agmarknet.

---

## `mandis.json` (read-only reference)

```jsonc
{
  "version": "1.0",
  "region": "Tamil Nadu + border Karnataka (demo region)",
  "note": "...",
  "demo_origin": { "label": "Palacode block, Dharmapuri district (tomato belt)", "lat": 12.30, "lon": 78.07 },
  "mandis": [
    {
      "id": "hosur",                   // slug; primary key in the `mandis` table and `mandi_id` everywhere else
      "name": "Hosur",                 // display name (may include a hint, e.g. "Koyambedu (Chennai)")
      "state": "Tamil Nadu",
      "district": "Krishnagiri",
      "lat": 12.7409, "lon": 77.8253,  // approximate market-yard location (WGS84)
      "agmarknet_market": "Hosur",     // data.gov.in `filters[market]` value
      "agmarknet_state": "Tamil Nadu", // data.gov.in `filters[state]` value
      "agmarknet_district": "Krishnagiri"
    }
  ]
}
```

`demo_origin` is where the seeded demo batches are logged. Straight-line distances from it (km):
Palacode 0.6, Dharmapuri 22, Krishnagiri 29, Hosur 56, Salem 71, Bengaluru 91, Kolar 93, Vellore ~120,
Coimbatore ~185, Trichy ~180, Ottanchatram ~202, Madurai ~264, Koyambedu 246.

---

## `agmarknet_snapshot.json`

Fallback prices, used when the live API and the DB cache are both unavailable (contract section 8:
live -> DB cache -> bundled snapshot). The UI must label these `bundled_snapshot` and stale.

```jsonc
{
  "source": "bundled_snapshot",
  "fetched_at": "2026-08-25T03:30:00Z",   // when this snapshot was taken; the API reports it as price_fetched_at
  "note": "...",
  "records": [
    {
      // --- fields exactly as data.gov.in resource 9ef84268-d588-465a-a308-a864a43d0070 returns them ---
      "state": "Tamil Nadu",
      "district": "Krishnagiri",
      "market": "Hosur",                  // == mandis.json agmarknet_market
      "commodity": "Tomato",              // == protocol.commodity ("Tomato" | "Guava")
      "variety": "Hybrid",                // tomato: "Hybrid" | "Local"; guava: "Allahabad Safeda" | "Local"
      "grade": "FAQ",
      "arrival_date": "25/08/2026",       // DD/MM/YYYY, as the real API returns it -> reported_on
      "min_price": "1370",                // strings of INR per quintal, as the real API returns them
      "max_price": "1810",
      "modal_price": "1600",
      // --- FarmSignal addition ---
      "mandi_id": "hosur"                 // resolved slug so the loader does not need to fuzzy-match market names
    }
  ]
}
```

Guarantees:

- Exactly **one record per mandi x commodity** (13 x 2 = 26 records). If the live API returns several
  varieties for one mandi/day, the poller keeps one per `(mandi_id, commodity, reported_on)` (the
  `mandi_prices` unique key) - the loader for this file never has to choose.
- `min_price`/`max_price` are within 10-15 % of `modal_price`.
- Prices are realistic for late August and deliberately form a **gradient away from the demo origin**:
  tomato Palacode 850 < Dharmapuri 950 < Krishnagiri 1050 < ... < Hosur 1600 < Bengaluru 1650 < Koyambedu 1800;
  guava 2200 (Palacode) ... 3800 (Hosur), 4200 (Bengaluru), 4800 (Koyambedu). With the routing constants
  in the contract this makes Hosur the top recommendation for the hero tomato batch and Bengaluru for the
  pre-cooled guava batch, while Koyambedu (highest price, 320 road-km away) loses on transport cost and
  in-transit spoilage - which is the point of the "why" screen.

Parsing rules for consumers: `int(modal_price)`; `datetime.strptime(arrival_date, "%d/%m/%Y").date()`;
match on `mandi_id` first, fall back to `(agmarknet_state, agmarknet_market)` only for live records.

---

## `demo_scenarios/`

See [`demo_scenarios/README.md`](demo_scenarios/README.md) for the scenario schema, the expected engine
output per scenario, the seed dataset and the golden test cases.

---

## Regenerating

The files were produced by a throwaway script that implements the contract's kinetics and routing
formulas; the expected numbers quoted in the READMEs and in `docs/DEMO-SCRIPT.md` come from that run.
If protocol parameters or routing constants change, re-derive `golden_kinetics.json` from the reference
Python engine (`services/api`) and update the numbers in the docs - never hand-edit `expected` blocks.
