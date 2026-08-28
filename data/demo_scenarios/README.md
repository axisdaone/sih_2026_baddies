# `data/demo_scenarios/` - temperature profiles, seed data, golden tests

## 1. Scenario files (`<id>.json`)

One file per profile. Used by:

- the server simulator: `POST /api/v1/batches/{id}/simulate?profile=<id>` appends the profile's readings
  (`source: "sim"`) relative to the batch's `harvested_at`;
- the PWA "simulated telemetry player", which replays the same readings locally (offline) and shows the
  `SIMULATED` chip.

### Schema

```jsonc
{
  "id": "heat_spike",                       // file name without .json; value of ?profile=
  "name": "Heat spike (tarpaulin / closed van)",
  "description": "...",                     // what physically happened
  "suitable_protocols": ["tomato", "guava"],// protocol ids this profile makes sense for
  "readings": [
    { "offset_hours": 0, "temp_c": 30 },    // hours after harvested_at (may be fractional), degrees C
    { "offset_hours": 3, "temp_c": 42 }
  ],
  "expected_story": "..."                   // what the engine should show, in words (for the demo narrator)
}
```

Rules: `readings` are sorted by `offset_hours`, the first is always at offset 0, each reading holds its
temperature until the next one (piecewise-constant, exactly like the engine's timeline). A player that is
"at hour h" appends only readings with `offset_hours <= h`.

### The profiles and what the engine says about them

Evaluated at the profile's last offset, with the mid/low/high scenarios from the contract. "Consumed"
is the mid-scenario fraction of shelf life used; "Remaining" is `low-high (mid)` hours at the
current temperature.

| id | Shape | Tomato: consumed / remaining h | Guava: consumed / remaining h | Story |
|---|---|---|---|---|
| `cool_morning` | 06:00 harvest, 22 -> 33 C over 8 h | 9.4 % / 27-81 (53) | 12.2 % / 15-57 (36) | Good-practice day; best case for selling far |
| `hot_afternoon` | 33-38 C for 6 h, then 30 C (8 h) | 15.5 % / 29-93 (61) | 23.3 % / 13-68 (41) | Both arms of the 18 % vs 13 % comparison (sell at hour 10 vs leave at hour 4) |
| `heat_spike` | 30 C with 2 h at 42 C at hour 3 (8 h) | 14.7 % / 30-94 (61) | 22.3 % / 13-68 (42) | Spike accelerates decay ~2.3x per hour, no hard breach (42 < 45) |
| `reefer_van` | 1 h at 30 C, then 12 C for 10 h | 5.4 % / 187-286 (237) | 5.4 % / 175-314 (265) | Unbroken cold chain; Quality Pass demo |
| `pre_cooled` | 30 -> 15 -> 12 C over 12 h | 5.9 % / 185-285 (236) | 5.9 % / 174-313 (263) | Best practice; distant premium markets feasible |
| `pharma_excursion` | 5 C, 4 h at 15 C, back to 5 C (12 h) | - | - | pharma_2_8: consumed 33.3 %, 6.8-9.2 (8.0) h of budget left, alert 75 crossed |
| `pharma_freeze` | 5 C, 30 min at -1 C, back (4 h) | - | - | pharma_2_8: hard breach `freeze` -> spoiled, remaining 0 |

Note the counter-intuitive pair: after 8 h `hot_afternoon` has consumed *more* shelf life than
`cool_morning` (15.5 % vs 9.4 %) yet shows *more* remaining hours (61 vs 53), because remaining hours are
projected at the **current** temperature (30 C vs 33 C). Consumed fraction is the honest comparison;
remaining hours answer "if nothing changes from now".

## 2. `demo_seed.json` - the scripted pitch dataset

Loaded by `POST /api/v1/demo/seed` (idempotent thanks to fixed UUIDs) and mirrored by the PWA's
"load demo" action.

```jsonc
{
  "version": "1.0",
  "note": "...",
  "farmer": { "device_id": "demo-device-001", "display_name": "Muthu (demo)", "locale": "ta",
              "origin": { "lat": 12.30, "lon": 78.07, "label": "Palacode block, Dharmapuri district (tomato belt)" } },
  "batches": [
    {
      "id": "6f1c2a3e-4b5d-4c6e-8f70-1a2b3c4d5e01",   // fixed UUID v4 -> re-seeding is a no-op
      "crop": "tomato", "protocol_id": "tomato", "qty_kg": 500,
      "harvested_hours_ago": 4,                       // harvested_at = now - 4 h (relative so the demo never goes stale)
      "scenario": "cool_morning",                     // profile to continue with in the telemetry player
      "origin_lat": 12.30, "origin_lon": 78.07,
      "notes": "...",
      "readings": [                                    // only offsets <= harvested_hours_ago; taken_at = harvested_at + offset
        { "id": "<uuid v4>", "offset_hours": 0, "temp_c": 22, "source": "sim" }
      ],
      "intended_story": "fresh / high confidence. Recommendation: Hosur ..."
    }
  ],
  "loss_comparison": { ... }                          // inputs + expected numbers for the 18 % vs 13 % slide (pinned by test_routing.py)
}
```

Seeding rules: `client_seq` for seeded ops is the batch index (1-based) and readings get `client_seq`
equal to their position; `source` is always `sim`; batch `status` is `open`. The batch's `client_created_at`
equals its `harvested_at`.

### The six batches (expected engine + routing output at seed time)

| # | Crop, qty | Harvested | Scenario | Status / confidence | Consumed | Recommendation (expected value) | Nearest (Palacode) | Uplift |
|---|---|---|---|---|---|---|---|---|
| 1 | tomato 500 kg | 4 h ago | cool_morning | fresh / high | 3.6 % | **Hosur** Rs 6,608 (Bengaluru Rs 6,146 second) | Rs 4,083 | +62 % |
| 2 | tomato 300 kg | 60 h ago | hot_afternoon | **critical** / low | 87.7 % | Palacode Rs 302 (only 10 of 13 mandis feasible) | Rs 302 | 0 % |
| 3 | tomato 200 kg | 36 h ago | heat_spike | **warning** / low | 53.6 % | Palacode Rs 778 | Rs 778 | 0 % |
| 4 | tomato 800 kg | 12 h ago | reefer_van | fresh / high | 5.8 % | Hosur Rs 11,085 | Rs 6,397 | +73 % |
| 5 | guava 400 kg | 12 h ago | pre_cooled | fresh / high | 5.9 % | **Bengaluru** Rs 13,339 (Hosur Rs 12,847, Koyambedu Rs 10,969) | Rs 8,266 | +61 % |
| 6 | guava 250 kg | 30 h ago | hot_afternoon | **warning** / low | 64.2 % | Hosur Rs 2,165 | Rs 1,956 | +11 % |

Batch 4 is the Quality Pass / tamper demo (7 readings in the hash chain). Batches 2 and 3 exist so the
Home list shows all three colours and so the app is seen giving an *unflattering* answer ("sell at the
nearest mandi, now") when that is the truth.

Values use the bundled snapshot prices and the contract constants (road factor 1.3, 35 km/h, safety 0.8,
Rs 12/km). Transit temperature is the last reading when it is under 2 h old, else the protocol's 30 C.

## 3. `golden_kinetics.json` - cross-language golden cases

26 cases that both `services/api/tests` (pytest) and `apps/web` (vitest) must pass, so the on-device
countdown and the server's authoritative estimate can never disagree.

```jsonc
{
  "version": "1.0", "model_version": "kinetics-1.0",
  "tolerances": { "hours": 0.05, "fractions": 0.001, "degree_hours": 0.05 },
  "assumptions": [ "..." ],                     // interpretation choices for the ambiguous corners of section 2.2
  "cases": [
    {
      "id": "tomato_heat_spike_42c_no_breach",
      "note": "...",
      "protocol_id": "tomato",                   // load from services/api/app/kinetics/protocols/<id>.json
      "harvested_at": "2026-08-27T00:30:00Z",
      "now": "2026-08-27T08:30:00Z",
      "readings": [ { "id": "<uuid>", "temp_c": 30.0, "taken_at": "..." } ],
      "expected": {
        "status": "fresh", "confidence": "high",
        "consumed_fraction": 0.1471, "remaining_fraction": 0.8529,
        "remaining_hours": { "low": 29.9, "mid": 61.4, "high": 93.7 },
        "current_temp_c": 30.0, "current_temp_assumed": false,
        "hours_since_last_reading": 0.0,
        "thermal_load_degree_hours": 184.0,
        "alerts_crossed": [], "breach_type": null   // hard_threshold label or null
      }
    }
  ]
}
```

Assert every key present in `expected` (and only those); `segments` and `expected_end` are not
asserted. Cases cover: the literature anchors (tomato 10/20/30 C, guava 10/20/30 C), no readings,
stale readings (assumed segment, low confidence), a reading before `harvested_at` (clamped), a reading
after `now` (dropped), the chilling floor clamp, hard breaches (46 C, -1 C), the 42 C spike that must
*not* breach, the demo profiles, and the pharma budget anchor (6 h out of band -> consumed 0.5, 6 h left).
