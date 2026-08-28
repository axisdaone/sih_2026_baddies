# FarmSignal API (services/api)

FastAPI backend: kinetics-based shelf-life estimates, mandi routing, Agmarknet prices and the
Quality Pass hash chain. Implements `docs/ENGINEERING-CONTRACT.md`.

## Run locally

```bash
cd services/api
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # Windows (use .venv/bin/python on Linux/macOS)
cp .env.example .env                                         # optional; defaults work for dev
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

- OpenAPI docs: http://localhost:8000/api/docs
- Health: http://localhost:8000/api/v1/health
- SQLite `farmsignal.db` is created next to this README on first start (gitignored); tables are
  created automatically and protocols/mandis are seeded from `app/kinetics/protocols/*.json`
  and `data/mandis.json`.

## Checks

```bash
.venv/Scripts/python -m ruff check app tests
.venv/Scripts/python -m mypy app
.venv/Scripts/python -m pytest -q
```

Tests use a throw-away SQLite file (see `tests/conftest.py`) and never touch `farmsignal.db`.

## Migrations (Postgres / prod)

```bash
DATABASE_URL=postgresql+psycopg://... .venv/Scripts/python -m alembic upgrade head
.venv/Scripts/python -m alembic revision --autogenerate -m "describe change"
```

## Docker

```bash
docker build -t farmsignal-api .
docker run -p 8000:8000 -v "$PWD/../../data:/data" farmsignal-api
```

## Layout

```
app/
  main.py        create_app(), lifespan (create_all + seed + price poller), routers under /api/v1
  config.py      pydantic-settings Settings, get_settings()
  db.py          engine, SessionLocal, Base (SQLite pragmas: WAL + foreign_keys)
  deps.py        get_db, get_current_farmer (Bearer JWT), rate_limited("public")
  security.py    create_token / decode_token (PyJWT HS256)
  enums.py       shared StrEnums (BatchStatus, ReadingSource, ...)
  models/        SQLAlchemy ORM (contract section 5), TZDateTime
  schemas/       Pydantic v2 wire models (contract sections 2.2, 3, 6.1, 7, 8)
  routers/       health, auth, protocols, mandis (done); batches, readings, sync, prices,
                 recommendations, quality_pass, demo (PHASE2 stubs returning 501)
  kinetics/      registry.py (protocol JSON loader + seeding), engine.py (PHASE2 stub)
  routing/ prices/ quality_pass/ alerts/ demo/   PHASE2 packages
alembic/         migrations (initial revision checked in)
tests/           pytest suite (TestClient + temp SQLite)
```
