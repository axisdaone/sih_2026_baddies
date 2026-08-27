# FarmSignal

**Offline-first, regional-language decision support for India's first-mile cold-chain gap.**
SIH 2026 - Problem Statement **IHSIH013**: Digital platform for cold-chain monitoring of perishable food
and pharmaceuticals (Theme: Transportation & Logistics). Team Baddies.

A farmer or FPO logs a harvest in under 30 seconds - offline. A crop-specific kinetic spoilage model
turns the batch's time-temperature history into a live **shelf-life range** on the phone. The routing
engine combines that range with **live Agmarknet mandi prices** and travel time into one explainable
command: *"Sell at Hosur, 2 h away - expected Rs 6,638, +63 % vs the nearest mandi."* A tamper-evident
**Quality Pass** (QR + SHA-256 hash chain) turns the thermal history into negotiating leverage. The same
engine evaluates a pharma 2-8 C excursion budget from a data file - the Phase 2 pharma path is already
running in tests.

FarmSignal is a decision layer, not hardware: it works with no sensor, a manual thermometer, or a BLE tag.

## Architecture in one paragraph

React 18 + TypeScript PWA (Vite, Tailwind, Dexie/IndexedDB outbox, Workbox background sync, i18next
`en`/`hi`/`ta`, Leaflet) with the kinetics engine mirrored in a Web Worker so the countdown runs offline.
FastAPI (Python 3.12, Pydantic v2, SQLAlchemy 2 + Alembic, APScheduler, httpx) is the authoritative
engine, price poller (Agmarknet via data.gov.in, 6-hourly, cached, with a bundled snapshot fallback),
routing engine, Quality Pass service and idempotent sync endpoint. SQLite for dev/demo, Postgres 16 for
production, nginx in front. Details:

- [`docs/FarmSignal-PRD.md`](docs/FarmSignal-PRD.md) - product requirements, personas, tech stack, risks.
- [`docs/ENGINEERING-CONTRACT.md`](docs/ENGINEERING-CONTRACT.md) - the binding spec: protocol schema,
  kinetics algorithm, routing formula, hash chain, data model, REST API, sync, prices, frontend conventions.
- [`docs/MODEL-NOTES.md`](docs/MODEL-NOTES.md) - why the kinetics are defensible, calibration sources,
  limitations, how to add a protocol.
- [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md) - the 5-minute pitch demo and failure-mode rehearsal.
- [`infra/DEPLOY.md`](infra/DEPLOY.md) - Docker Compose, env vars, SQLite -> Postgres, Render/Fly notes.

## Quickstart

Prerequisites: Python 3.12+, Node 22 / npm 11, optionally Docker.

**API** (`http://localhost:8000`, OpenAPI at `/docs`):

```bash
cd services/api
python -m venv .venv && . .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                 # defaults are fine for local use
uvicorn app.main:app --reload --port 8000
curl -X POST http://localhost:8000/api/v1/demo/seed  # load the scripted demo dataset
```

**Web** (`http://localhost:5173`, expects the API on `http://localhost:8000`):

```bash
cd apps/web
npm ci
npm run dev
```

**Everything in containers** (`http://localhost`, see `infra/DEPLOY.md`):

```bash
docker compose -f infra/docker-compose.yml up --build
```

**Checks** (what CI runs):

```bash
cd services/api && ruff check . && mypy app && pytest -q
cd apps/web && npm run typecheck && npm test && npm run build
```

## Repository layout

```
apps/web/            React PWA: engine/ (kinetics mirror), worker/, db/ (Dexie), sync/, api/, i18n/, voice/, pages/
services/api/        FastAPI: app/{routers,models,schemas,kinetics,routing,prices,quality_pass,alerts,demo}, alembic/, tests/
data/                mandis.json, agmarknet_snapshot.json, demo_scenarios/ (profiles, demo_seed.json, golden_kinetics.json)
infra/               docker-compose.yml (+ .prod.yml), nginx.conf, DEPLOY.md
docs/                PRD, engineering contract, model notes, demo script
.github/workflows/   ci.yml (api: ruff + mypy + pytest; web: typecheck + vitest + build)
```

## Honesty principles

These are product rules, enforced in code and tests, not slide-ware:

1. **Shelf life is always a range** ("~ 42-104 h, most likely 72 h") with a confidence level that
   reflects data recency; never a false-precision scalar.
2. **Simulated data is always labelled.** Every simulated reading, recommendation built on it, and the
   18 % vs 7 % comparison carry a `SIMULATED` chip. Real Agmarknet prices carry their source
   (`agmarknet_live` / `agmarknet_cache` / `bundled_snapshot`) and reported date.
3. **Every recommendation is explainable**: the "why" screen shows all inputs (price, date, distance,
   transit temperature, spoilage at arrival, transport cost) and the mandis that were rejected and why.
4. **No trained ML.** The model is literature-calibrated kinetics with stated limitations
   (`docs/MODEL-NOTES.md`); the pilot's first job is to validate it against field data.
5. **The Quality Pass is a hash chain, not a blockchain**, and we say so.
6. **Privacy by default**: no Aadhaar, no financial data; public pass pages never expose farmer identity
   beyond an opt-in display name.

## Team

Team Baddies, SIH 2026. Roles: product and model (kinetics, protocols), backend (FastAPI, sync,
routing, prices), frontend (PWA, offline, i18n/voice), infra and demo. Contact via the repository's
issue tracker.
