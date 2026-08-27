# FarmSignal - Model Notes (kinetics v1.0)

This is the "why should we believe the countdown" document. It explains the spoilage model that runs
identically in `services/api/app/kinetics/engine.py` and `apps/web/src/engine/`, where its numbers come
from, what it deliberately does not model, and how to add a protocol. The binding algorithm is
`docs/ENGINEERING-CONTRACT.md` section 2; this document is the rationale.

Short version: **there is no machine learning here**. Shelf life is computed from temperature history
with textbook reaction kinetics, calibrated to published postharvest data. That is a feature: with zero
field data, a literature-calibrated physical model is defensible; a "trained" model would not be.

---

## 1. From Arrhenius to Q10

Every process that degrades produce - respiration, softening, microbial growth, chlorophyll loss -
speeds up with temperature. Chemical kinetics describes the rate constant of such a process with the
Arrhenius equation:

```
k(T) = A * exp(-Ea / (R * T))          T in kelvin, Ea = activation energy, R = 8.314 J/(mol*K)
```

The ratio of rates 10 K apart is

```
Q10 = k(T + 10) / k(T) = exp( Ea * 10 / (R * T * (T + 10)) )
```

For biological Ea values of 50-70 kJ/mol this gives Q10 = 2-3 in the 10-35 C range, and Q10 varies only
slowly with T (for Ea = 60 kJ/mol: about 2.4 over the 10-20 C decade and 2.1 over 30-40 C). Postharvest
literature therefore reports a single Q10 per commodity, and that is what the protocol JSON carries. The
practical form we evaluate is the **rate multiplier** relative to a reference temperature:

```
r(T) = q10 ** ((T' - reference_temp_c) / 10)        T' = clamp(T, min_effective_temp_c, max_effective_temp_c)
```

`r = 1` at the reference temperature (10 C for both crops), `r = 4` at 30 C for tomato (Q10 = 2),
`r = 6.25` at 30 C for guava (Q10 = 2.5). The **clamps** encode two physical facts: below the floor,
cooling further does not buy shelf life (and for tropical fruit causes chilling injury - a separate
failure mode we flag in the UI rather than model), and above ~45 C tissue damage is no longer a rate
process but a threshold event (see hard thresholds).

## 2. The degree-hour integral

If shelf life at the reference temperature is `L_ref` hours, then at a constant temperature `T` it is
`L_ref / r(T)`. For a **varying** temperature history the fraction of shelf life used is the integral of
the rate over time:

```
consumed = ( sum over segments_i of hours_i * r(T_i) ) / L_ref        clamped to [0, 1]
```

The numerator is "equivalent hours at the reference temperature". The timeline is piecewise-constant:
each reading holds its temperature until the next reading; before the first reading (or with no
readings at all) we assume `default_ambient_c` (30 C for the crops - a hot-season default for an Indian
yard, not a worst case: the `hot_afternoon` profile runs to 38 C - and 25 C for pharma) and flag the
segment `assumed`; after the last reading we hold its value and flag it `assumed` once it is more than
2 h old. Assuming a hot default when we have no data is a deliberate, conservative choice: the app
should never look better than reality because the farmer stopped logging.

Remaining hours are projected at the **current** temperature (the last segment's):

```
remaining = (1 - consumed) * L_ref / r(T_now)
```

This is why a batch that sat through a hot afternoon (now at 30 C) can show *more* remaining hours than
one in a warming morning (now at 33 C) even though it has consumed more shelf life: remaining hours
answer "if nothing changes from now", consumed fraction is the honest cumulative comparison. The UI
shows both, and status/alerts are driven by the consumed fraction.

We also report `thermal_load_degree_hours = sum hours_i * max(0, T_i - reference_temp_c)`. It is **not**
used by the kinetics; it is a linear "degree-days"-style number that traders and farmers can compare
without understanding exponentials. In v1 it is available in the `ShelfLifeEstimate` payload only (API
response and Web Worker result); no screen renders it yet - showing it on the Quality Pass is a UI to-do,
not a model feature.

## 3. Why a range and not a scalar

The two calibration inputs are uncertain: published shelf lives for the same crop span 10-14 days
(tomato at 10-12 C) and Q10 estimates span 1.8-2.4. Presenting "58.7 h" as if it were a measurement
would be false precision, so the engine evaluates three parameter sets:

| Scenario | Q10 | L_ref | Meaning |
|---|---|---|---|
| `high` (optimistic) | `q10_range[0]` (lower: slower acceleration above T_ref) | `reference_shelf_life_range_hours[1]` (longer) | best plausible case |
| `mid` (nominal) | `q10` | `reference_shelf_life_hours` | what we call "most likely" |
| `low` (pessimistic) | `q10_range[1]` | `reference_shelf_life_range_hours[0]` | worst plausible case |

One caveat: the optimistic/pessimistic labels assume segment temperatures at or above `T_ref`. A lower
Q10 means slower acceleration *above* the reference but a *faster* rate below it, so the labels only hold
cleanly when the floor clamp is at or above `T_ref` (tomato: floor 10 C = `T_ref`). Guava's floor is 8 C,
so in the 8-10 C band the Q10 term works against its label and the band is a little narrower than
intended there - negligible for a first-mile crop that is never that cold, but worth knowing when adding
a protocol whose floor sits well below its reference temperature.

Example (`cool_morning` profile, tomato, hour 8): remaining `27-81 h, most likely 53 h`. The band is
asymmetric because the pessimistic scenario compounds two adverse assumptions; that is intended. Status,
alerts and routing all use `mid`; the UI always renders the range (PRD honesty constraint).

## 4. Status, confidence and alerts

- `remaining_fraction = 1 - consumed_mid`: `> 0.5` fresh, `(0.25, 0.5]` warning, `(0, 0.25]` critical,
  `0` spoiled. Alerts fire when `remaining_fraction * 100 <= 75 / 50 / 25`.
- **Confidence** is about *data recency*, not model uncertainty (the range covers that):
  `high` = at least 2 readings and the last one under 2 h old; `medium` = at least 1 reading under 8 h
  old; `low` = nothing recent (the estimate is running on assumed temperatures). It is deterministic so
  the PWA and the server always agree.
- **Hard thresholds** (`hard_thresholds[]` in the protocol) are single-reading events that end the
  batch regardless of the integral: tomato/guava `max_temp 45 C` (heat damage); pharma `min_temp 0 C`
  (freeze) and `max_temp 25 C`. A breach sets `status = spoiled`, remaining = 0 and records which reading
  did it. The `heat_spike` demo profile peaks at 42 C precisely to show acceleration *without* a breach.

## 5. Pharma: the same integral as an excursion budget

`pharma_2_8.json` uses `model: "excursion"`. The only change is the rate function:

```
r(T) = 0  if band_c[0] <= T <= band_c[1]   (2-8 C)
       1  otherwise
```

With `reference_shelf_life_hours = excursion_budget_minutes / 60 = 12`, the identical integral now reads
"cumulative hours outside 2-8 C divided by the allowed budget" - the time-out-of-refrigeration
budgeting that USP <1079> and WHO TRS 961 Annex 9 describe. Because `r` can be 0, remaining is reported
as budget remaining rather than infinity. The three scenarios are the budget +-10 %. Contract anchor:
6 h at 15 C then 6 h at 5 C -> consumed 0.5, 6 h left, status `warning`. Freezing (any reading below
0 C) is a hard breach: biologics do not recover from it.

Mean kinetic temperature (MKT), the other standard pharma metric, is also Arrhenius-based and can be
computed from the same segments; it is a PHASE2 addition, not needed to prove protocol swappability.

## 6. Calibration (v1)

| Protocol | T_ref | L_ref h nominal [range] | Q10 nominal [range] | Floor C | Ambient C | Hard thresholds |
|---|---|---|---|---|---|---|
| `tomato` | 10 | 288 [240, 336] (10-14 d) | 2.0 [1.8, 2.4] | 10 | 30 | max 45 (heat_damage) |
| `guava` | 10 | 336 [240, 384] (10-16 d) | 2.5 [2.2, 3.0] | 8 | 30 | max 45 (heat_damage) |
| `pharma_2_8` | (5) | 12 [10.8, 13.2] = 720 min budget | - | - | 25 | min 0 (freeze), max 25 (heat_excursion) |

Sources, as listed in each protocol's `sources[]`:

- **Tomato** - USDA Agricultural Handbook 66 (2016): 10-14 d at 10-12.5 C for firm-ripe fruit, chilling
  injury below 10 C. Kader, *Postharvest Technology of Horticultural Crops* (UC ANR 3311): Q10 of
  respiration 2-3 between 10 and 30 C. Tijskens & Polderdijk (1996), *A generic model for keeping
  quality of vegetable produce*: Arrhenius keeping-quality kinetics for tomato. ICAR-CIPHET (2015)
  field data: ripe tomato lasts 2-4 d at 28-32 C in mandi conditions.
- **Guava** - USDA Handbook 66: 2-3 weeks at 8-10 C, chilling injury below 5-8 C. Kader (UC Davis
  Postharvest) guava produce facts: 2-3 d at 20-25 C for ripe fruit, Q10 ~2.5-3 (climacteric, high
  respiration). Singh & Pal (2008): ambient (28-32 C) shelf life 2-4 d. ICAR-CISH Lucknow bulletin:
  8-10 C optimum storage.
- **Pharma 2-8 C** - WHO TRS 961 Annex 9 (2011); USP <1079>. The 12 h budget is illustrative; real
  products carry a manufacturer-specified stability budget, which is exactly why the budget is data.

## 7. Sanity anchors (asserted by tests)

Single constant-temperature profile, mid scenario, at t = 0:

| Protocol | 10 C | 20 C | 30 C | Published |
|---|---|---|---|---|
| tomato | 288 h (12 d) | 144 h (6 d) | 72 h (3 d) | 2-4 d at 30 C; 1-2 weeks at 10-12 C |
| guava | 336 h (14 d) | 134 h (5.6 d) | 54 h (2.2 d) | 2-3 d ambient; 2-3 weeks at 8-10 C |
| pharma_2_8 | 6 h at 15 C + 6 h at 5 C -> consumed 0.5, 6 h budget left; any reading < 0 C -> spoiled | | | |

The full set of 26 cross-language cases (anchors, clamps, dropped/clamped readings, breaches, the demo
profiles) is `data/demo_scenarios/golden_kinetics.json`; both test suites load it.

Worked example - the 42 C spike: `r(42) = 2 ** 3.2 = 9.19` versus `r(30) = 4`, so each spike hour costs
2.3 x a 30 C hour; the 2 h spike consumes 18.4 reference-hours (6.4 % of tomato shelf life), the same as
4.6 h at 30 C. This breakdown is a test/document number: the app shows the resulting range and status
(and `thermal_load_degree_hours` travels in the estimate payload), but no screen renders a per-segment
reference-hours table or a spike line in v1.

## 8. Known limitations (say them out loud)

1. **No humidity.** Water loss is a major quality driver for both crops; v1 has no RH input. Effect:
   we under-predict loss in dry heat and slightly over-predict in humid conditions.
2. **No ethylene / atmosphere.** Mixed loads (tomato next to ripening banana) ripen faster; not modelled.
3. **No maturity stage or cultivar.** Green-mature vs ripe tomato differ by days. `L_ref` is for
   firm-ripe fruit; the range partly absorbs this but a maturity picker is the obvious next input.
4. **Chilling injury is a flag, not a rate.** Below the floor we stop crediting cooler temperatures but
   we do not model the damage itself.
5. **Piecewise-constant timeline.** Temperature between readings is assumed equal to the last reading;
   with hourly readings the error is small, with one reading a day it is not - hence the confidence rule
   and the `assumed` flags.
6. **Q10 held constant across 10-45 C.** A single Q10 is exact only over the decade it was fitted on.
   With the Ea implied by Q10 = 2 over 10-20 C (47.8 kJ/mol), the constant-Q10 form over-predicts the
   rate relative to same-Ea Arrhenius by ~5 % at 30 C, ~9 % at 35 C, ~14 % at 40 C and ~20 % at 45 C.
   The error is on the safe side (faster predicted decay) and the equivalent Q10 stays inside the
   `q10_range` band (1.9 at 45 C vs [1.8, 2.4]), so the reported range covers it.
7. **Linear value-loss mapping in routing.** The recommendation engine treats
   `spoilage_at_arrival = consumed_at_arrival` and multiplies price by `(1 - spoilage)`. Real mandi
   pricing is step-wise (grade drops, then rejection), so the money numbers are indicative. The payload
   itself does not carry this caveat: it is stated on the "why" screen (the `formula_spoilage` string,
   "value loss is assumed linear"), and values built from simulated readings are labelled `SIMULATED`.
8. **Transit temperature is assumed**: `max(last reading if under 2 h old, protocol.default_ambient_c)`
   (30 C for the crops, 25 C for pharma) - a fresh reading can only make the trip warmer than ambient,
   never cooler, because v1 has no vehicle/reefer input. Feasibility is re-projected at that transit
   temperature (mid scenario × safety factor), and every candidate also carries `feasible_pessimistic`
   (the same test under the low scenario) so the "why" screen can show which trips survive the worst
   case; pessimistically-safe mandis rank first.
9. **Pharma uses a simple time-out-of-range budget**, not MKT or product-specific stability curves.
10. **No validation against our own field data yet.** The calibration is literature-only; the pilot's
    first job is to log real batches and compare.

## 9. Adding a new protocol

Protocols are data; the engine does not change.

1. Create `services/api/app/kinetics/protocols/<id>.json` following the schema in the contract
   (section 2.1). For a crop: `model: "q10"`, fill `reference_shelf_life_hours` and `_range_hours`,
   `q10` and `q10_range`, floor/ceiling clamps, `default_ambient_c`, `hard_thresholds`, `commodity`
   (must equal the Agmarknet commodity name) and `sources`. For a pharma product: `model: "excursion"`,
   `band_c`, `excursion_budget_minutes` and `reference_shelf_life_hours = budget / 60`.
2. Run the web build's protocol copy (`apps/web` copies `services/api/app/kinetics/protocols/*.json`
   to `src/data/protocols/`); a test asserts the copies are byte-identical.
3. Add at least three golden cases (10/20/30 C anchors) to `data/demo_scenarios/golden_kinetics.json`,
   computed with the Python engine, and a literature-anchor test in `services/api/tests`.
4. Add the commodity to `data/agmarknet_snapshot.json` (one record per mandi) so the fallback path
   works, and check the mandis actually report it on Agmarknet.
5. UI: crop picker image + i18n names in `apps/web/src/i18n/locales/*/batch.json`; a demo scenario
   in `data/demo_scenarios/` if the crop behaves differently enough to need one.
6. Bump the protocol `version`; the `model_version` of the engine stays `kinetics-1.0` unless the
   algorithm changes.
