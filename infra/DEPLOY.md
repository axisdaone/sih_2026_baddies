# Deploying FarmSignal

The whole prototype is two containers (FastAPI + static PWA) behind one nginx. It runs on a single
small VPS, on Render, or on Fly.io. Nothing here needs Kubernetes, a message queue or a managed cache.

## 1. Local / single VPS with Docker Compose (recommended for the pilot)

```bash
git clone <repo> farmsignal && cd farmsignal
cp services/api/.env.example services/api/.env      # optional: local overrides for `uvicorn` runs
export JWT_SECRET="$(openssl rand -hex 32)"
export PUBLIC_BASE_URL="https://farmsignal.example.org"   # what the Quality Pass QR codes will point at
docker compose -f infra/docker-compose.yml up -d --build
curl -fsS http://localhost/api/v1/health
```

What you get:

| Service | Image | Port | Notes |
|---|---|---|---|
| `edge` | `nginx:1.27-alpine` + `infra/nginx.conf` | `EDGE_PORT` (80) | Public entry. `/` -> web, `/api` -> api, gzip, 1-year immutable cache on `/assets/*`, `no-cache` on `sw.js`/manifest, 60 req/min/IP on `/api/v1/quality-pass/*`, security headers (strict CSP: same-origin scripts and API calls, OSM tiles allowed for images, `frame-ancestors 'none'`; `X-Frame-Options: DENY`; `Permissions-Policy`). |
| `web` | built from `apps/web/Dockerfile` | `WEB_PORT` (8080) | Static bundle only; use the edge for a working app (API calls are same-origin `/api`). |
| `api` | built from `services/api/Dockerfile` | internal 8000 | SQLite on the `api_data` volume; `data/` mounted read-only at `/srv/farmsignal/data`. Health: `GET /api/v1/health`. |

TLS: put Caddy (`caddy reverse-proxy --from farmsignal.example.org --to localhost:80`) or a cloud load
balancer in front of the edge and set `PUBLIC_BASE_URL` to the https origin. The edge forwards
`X-Forwarded-Proto`, which the API uses when it builds absolute Quality Pass URLs.

Backups (SQLite): `docker compose -f infra/docker-compose.yml exec api sh -c 'sqlite3 /var/lib/farmsignal/farmsignal.db ".backup /var/lib/farmsignal/backup.db"'`
(or `cp` the file - the API writes in WAL mode, a copy while running is safe enough for the demo).

### Production profile: Postgres 16

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml --profile prod up -d --build
```

`docker-compose.prod.yml` overrides `DATABASE_URL` to `postgresql+psycopg://farmsignal:...@postgres:5432/farmsignal`.
Requirements: `psycopg[binary]>=3.2` in `services/api/requirements.txt` (PHASE2 for the API; SQLite is
enough for the demo).

There is deliberately no Redis. The price cache and the public-endpoint rate limiter
(`app/deps.py`, sliding window) are **in-process**: the API reads no `REDIS_URL`, and the PRD allows an
in-process cache for the demo. That is correct as long as a single API process runs (one `uvicorn`
worker, one replica - which SQLite requires anyway). Running several API replicas would give each its
own price cache and its own rate-limit counter; a shared cache is a Phase 2 item, not a compose flag.

## 2. Environment variables

Names match `services/api/app/config.py` (pydantic-settings, case-insensitive, `.env` supported).

| Variable | Default | Purpose |
|---|---|---|
| `ENV` | `dev` (`prod` in compose) | `dev` / `test` / `prod`; affects logging and debug behaviour. |
| `DATABASE_URL` | `sqlite:///./farmsignal.db` (compose: `sqlite:////var/lib/farmsignal/farmsignal.db`) | SQLAlchemy URL. Postgres: `postgresql+psycopg://user:pass@host:5432/db`. |
| `DATA_DIR` | `<repo>/data` (compose: `/srv/farmsignal/data`) | Where `mandis.json`, `agmarknet_snapshot.json`, `demo_scenarios/` live. |
| `JWT_SECRET` | dev default only; **no usable default in `prod`** | HS256 key for device tokens. The API refuses to start with the dev default when `ENV=prod`; compose requires it (`openssl rand -hex 32`). Flipping `DEMO_MODE` off does not revoke already-minted demo tokens (30-day TTL) - rotate this secret. |
| `TRUST_PROXY` | `false` (`true` in compose) | Trust `X-Real-IP` / the last `X-Forwarded-For` hop for rate-limit keys. Set `true` only behind nginx / Render / Fly; never on a directly exposed uvicorn. |
| `AUTH_RATE_LIMIT_PER_MIN` | `10` | Per-IP limit on `POST /auth/device` (the edge applies the same 10 r/m zone). |
| `DEMO_ADMIN_TOKEN` | unset | Required for `POST /demo/seed?reset=true` (header `X-Demo-Admin-Token`). Reset re-anchors `harvested_at`, so printed QR codes must be regenerated. |
| `PRICE_REFRESH_COOLDOWN_S` | `300` | Minimum gap between `POST /prices/refresh` calls (protects the shared data.gov.in sample key). |
| `MAX_REQUEST_BODY_BYTES` | `2097152` | Request body cap (sync batches); the edge enforces `client_max_body_size 2m` too. |
| `JWT_TTL_DAYS` | `30` | Token lifetime. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Origin encoded in Quality Pass QR codes (`{PUBLIC_BASE_URL}/pass/{batch_id}?h=...`). |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated. Behind the edge the app is same-origin, so this only matters for `vite dev`. |
| `AGMARKNET_API_KEY` | data.gov.in public sample key | Get your own at data.gov.in for anything beyond the demo (the sample key is heavily rate-limited). |
| `AGMARKNET_RESOURCE_ID` | `9ef84268-d588-465a-a308-a864a43d0070` | Agmarknet daily prices resource. |
| `AGMARKNET_TIMEOUT_S` | `5.0` | Per-request timeout; 3 retries with 1/2/4 s backoff. |
| `PRICE_POLL_HOURS` | `6` | APScheduler poll interval. |
| `PRICE_STALE_HOURS` | `30` | Prices older than this are flagged `stale: true` (still served). |
| `ROAD_FACTOR` / `AVG_SPEED_KMH` / `SAFETY_FACTOR` / `TRANSPORT_COST_PER_KM_INR` | `1.3` / `35` / `0.8` / `12` | Routing constants (contract section 3). |
| `DEMO_MODE` | `true` in `dev`, **`false` in compose** | The pitch host sets it explicitly. Enables the anonymous demo token from `POST /demo/seed` (= write access to the demo batches), `GET /demo/scenarios`, anonymous `POST /prices/refresh` and `POST /batches/{id}/simulate`. Keep `false` for a pilot. |
| `RATE_LIMIT_PER_MIN` | `60` | Application-level limit on public endpoints (the edge enforces the same limit at nginx). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `farmsignal` | Only used by the `prod` profile. |
| `EDGE_PORT` / `WEB_PORT` | `80` / `8080` | Host ports published by compose. |

The PWA has one build-time variable, `VITE_API_BASE` (default `/api/v1`), so the same image works behind
any origin.

## 3. Switching SQLite -> Postgres with Alembic

1. `psycopg[binary]` is already in `services/api/requirements.txt`; rebuild the API image if it predates that line.
2. Start Postgres (`--profile prod`, or a managed instance) and point `DATABASE_URL` at it.
3. Run the migrations against the new database (the API also runs `alembic upgrade head` on startup,
   but doing it explicitly first surfaces errors before traffic arrives):
   ```bash
   docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml --profile prod \
     run --rm api alembic upgrade head
   ```
4. Migrate data (demo data can simply be re-seeded with `POST /api/v1/demo/seed`; for a pilot use
   `pgloader` or a short SQLAlchemy script that copies table by table in FK order:
   `farmers -> batches -> readings -> mandi_prices -> recommendations -> pass_events -> sync_ops`).
5. Protocol rows (`protocols` table) are re-seeded from the JSON files at startup; no data copy needed.

Schema differences to keep in mind when writing migrations: SQLite ignores `ALTER COLUMN` (Alembic's
`batch_alter_table` handles it), stores UUIDs and datetimes as text (the models use `String(36)` and
timezone-aware `DateTime` so both engines behave identically), and has no native enum type.

## 4. Render / Fly.io notes

**Render** (free web service + free static site):

- API: "Web Service" from `services/api` (Docker). Add a 1 GB persistent disk mounted at
  `/var/lib/farmsignal` and set `DATABASE_URL=sqlite:////var/lib/farmsignal/farmsignal.db`, or attach a
  Render Postgres and set the `postgresql+psycopg://` URL. Health check path: `/api/v1/health`.
  Set `DATA_DIR=/app/data` if the Dockerfile copies `data/` into the image, otherwise mount it.
- Web: "Static Site" from `apps/web` (`npm ci && npm run build`, publish `dist`). Add a rewrite
  `/api/* -> https://<api>.onrender.com/api/*` and a catch-all `/* -> /index.html`. Set the API's
  `CORS_ORIGINS`/`PUBLIC_BASE_URL` to the static site origin.
- Free instances sleep after idle: the first request after a sleep takes ~30 s. Warm the API before a
  demo (`curl /api/v1/health`) or keep a paid instance for the pitch day.

**Fly.io** (one app per container, Fly volumes for SQLite):

```bash
cd services/api && fly launch --no-deploy --name farmsignal-api
fly volumes create api_data --size 1
fly secrets set JWT_SECRET=... PUBLIC_BASE_URL=https://farmsignal-web.fly.dev
# fly.toml: [mounts] source="api_data" destination="/var/lib/farmsignal"; [[services.http_checks]] path="/api/v1/health"
fly deploy
cd ../../apps/web && fly launch --name farmsignal-web && fly deploy
```

Use Fly's built-in TLS; keep a single API machine (SQLite is single-writer). For Postgres use `fly
postgres create` and attach it.

## 5. Known limitation: iOS PWA

Safari on iOS does not support the Background Sync API and restricts push notifications for
home-screen web apps (partial support from iOS 16.4, opt-in and not available in-browser). On iOS the
app still works offline (service worker precache + IndexedDB outbox), but the outbox only drains when
the app is in the foreground with connectivity, and threshold alerts appear only while the app is open.
The demo is run on Android (Chrome) where Workbox Background Sync and Notifications both work; the
constraint is stated in the PRD risk list and on the Settings page.

## 6. Error tracking and monitoring (what exists today)

The PRD's tech-stack table lists "Sentry SDK -> GlitchTip" for crash visibility. **That is not wired
in the prototype**: there is no `sentry-sdk` in `services/api/requirements.txt`, no `@sentry/react` in
`apps/web/package.json`, and no `SENTRY_DSN` / `VITE_SENTRY_DSN` setting. Worker errors, sync
rejections and poller exceptions are visible only in the rotated container logs (`docker compose logs
api`, json-file, 10 MB x 3). For the pitch this is acceptable; before a pilot add the two SDKs behind
optional `SENTRY_DSN` (API, initialised in `create_app()` only when set) and `VITE_SENTRY_DSN` (PWA)
variables and document them in the table above.

## 7. Operational checklist

- `GET /api/v1/health` returns `{"status": "ok", "prices": {"source": ..., "stale": ...}}`; the compose
  healthchecks and the edge healthcheck both use it.
- Logs: `docker compose -f infra/docker-compose.yml logs -f api edge` (json-file, rotated at 10 MB x 3).
- Price poller: `POST /api/v1/prices/refresh` forces a poll; `/health` shows the source and age.
- Reset demo data: `docker compose ... down -v` (drops the SQLite volume) then `POST /api/v1/demo/seed`.
- Rate limit sanity: `for i in $(seq 1 90); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/v1/quality-pass/<id>/verify?head=x; done | sort | uniq -c`
  should show a mix of 200/404 and 429 after the burst of 20 + 60/min is exhausted.
- Security headers: `curl -sI http://localhost/ | grep -i -E "content-security-policy|x-frame-options"`
  must show both. If the FPO map tiles stop loading after a change to `infra/nginx.conf`, check that
  `tile.openstreetmap.org` is still allowed in `img-src` (page policy) and `connect-src` (service-worker
  policy, `$farmsignal_sw_csp`).
- Image hygiene before pushing `farmsignal/api:*` anywhere: the API Dockerfile copies the build
  context, so the context must exclude `.env`, `*.db` (+ `-wal`/`-shm` sidecars), `.venv` and tests via
  `services/api/.dockerignore`. Verify with `docker run --rm farmsignal/api:local ls -a /srv/api` -
  nothing but `app/`, `alembic/`, `alembic.ini`, `pyproject.toml` and `requirements*.txt` should be there.
- Reproducible builds: `services/api/requirements.txt` carries lower bounds only. Pin before the pitch
  (a `requirements.lock` from `pip freeze` / `pip-compile`, installed by the Dockerfile and CI) so a
  surprise major release of fastapi/pydantic/PyJWT cannot change the reviewed image overnight.
