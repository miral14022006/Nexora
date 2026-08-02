# Deploying Nexora to Render

Nexora ships as a **single Infrastructure-as-Code blueprint** (`render.yaml`) that
provisions the entire platform on [Render](https://render.com): frontend, API
gateway, 9 private backend services, managed Postgres, managed Redis, plus env
groups for secrets. Kafka and S3 are the only pieces Render doesn't host, so
they're provisioned externally and wired in with credentials.

- **Blueprint file:** [`render.yaml`](render.yaml)
- **Schema reference:** <https://render.com/docs/blueprint-spec>
- **Local equivalent:** `docker compose up` (see [README.md](README.md))

---

## 1. What deploys where

> **Current blueprint mode: FREE-TIER DEMO.** Every service is `type: web` +
> `plan: free` ($0/month) because Render's free plan doesn't allow private
> services. Free web services spin down after 15 min idle and each gets a
> public URL (JWT + `SERVICE_SECRET` still protect the data). To get
> production behavior, switch any service back to `type: pserv` + `plan: starter`.

| Render resource        | Type        | Plan   | Notes                                              |
|------------------------|-------------|--------|----------------------------------------------------|
| `nexora-frontend`      | web (docker)| free   | Vite SPA behind nginx; proxies `/api` + `/ws` to the gateway |
| `nexora-api-gateway`   | web (docker)| free   | **Primary API entry point** (`/api/*`, `/ws`)       |
| `nexora-websocket-gateway` | web  | free   | WS termination, presence, receipt fan-out           |
| `nexora-auth` … `nexora-media` | web (9×) | free | Downstream services (public URLs but token-protected) |
| `nexora-postgres`      | database    | free    | Managed Postgres 16 — internal-network only        |
| `nexora-redis`         | keyvalue    | free    | Managed Redis 7 — internal-network only            |
| `nexora-shared-secrets` | env group  | —       | `generateValue` secrets (JWT, SERVICE_SECRET)      |
| `nexora-kafka` / `nexora-minio` | env groups | — | Credentials you paste after first deploy (`sync: false`) |

> **Why are all services private (production mode)?** Only the frontend and the
> API gateway need public URLs. In the paid configuration every other service
> is a `pserv` reachable exclusively over Render's internal network. In the
> current free-tier demo mode they're public web services instead — protected
> by JWTs for user data and by `SERVICE_SECRET` trust headers for internal
> routes.

---

## 2. Prerequisites

| What | Why |
|------|-----|
| [Render account](https://render.com/register) | Free plan works to try it; see [§9](#9-scaling--production-hardening) |
| GitHub repo | Push this repo; Render deploys from Git |
| [Upstash Kafka](https://upstash.com/kafka) (or any Kafka) | Render has no managed Kafka; used by chat/delivery/notification |
| S3-compatible store *(optional)* | For `media-service` (AWS S3, Cloudflare R2, …). Without it, media routes return 503 and everything else still works |
| Docker (local only) | For local verification and CI — `npm run build:images` |

---

## 3. Provision external services (one-time)

### Kafka (Upstash)

1. [console.upstash.com](https://console.upstash.com) → **Create Kafka Cluster**,
   region near your Render region (e.g. `us-east-1` for Oregon).
2. Create the topics (or run `node scripts/create-topics.mjs` once a service is
   deployed — it creates them idempotently):

   | Topic                     | Partitions |
   |---------------------------|------------|
   | `message-events`          | 3          |
   | `chat.message.delivered`  | 1          |
   | `chat.message.read`       | 1          |
   | `message-events-dlq`      | 1          |

3. Copy the **bootstrap endpoint**, **username**, **password** — you'll paste
   them into the Dashboard.

> Services detect `KAFKA_SASL_USERNAME` at startup and enable
> SASL/SCRAM-256 + TLS automatically; unset (local dev) = plain TCP to the
> Docker Kafka container. Kafka is **lazy**: consumers/producers only connect
> when events flow, so a missing broker never blocks boot.

### S3-compatible storage (optional)

Any S3 API-compatible bucket. The `media-service` degrades gracefully: with no
`MINIO_*` config it boots, serves `/health`, and returns `503` on media routes —
safe to deploy first and configure later.

---

## 4. Deploy the blueprint

### Option A — One-click

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/miral14022006/nexora)

### Option B — Manual

1. [Dashboard](https://dashboard.render.com) → **New Blueprint Instance**.
2. Connect the repo (branch `main`); `render.yaml` is auto-detected.
3. Click **Apply** — Render provisions everything at once.

Both options render a list of **12 services, 2 databases, 3 env groups**. Render
deploys them **concurrently** — this is safe because every service retries its
DB/Redis connections at startup (`withRetry`, ~20 attempts / 3s apart) until
dependencies are live, and health checks gate traffic.

---

## 5. Fill in the `sync: false` secrets

During creation Render prompts for every `sync: false` variable. If you skipped
them, add them per service in the Dashboard and redeploy:

| Env group | Keys | Example value |
|-----------|------|---------------|
| `nexora-kafka` | `KAFKA_BROKERS`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` | `grizzly-1234-us1-kafka.upstash.io:9092` |
| `nexora-minio` | `MINIO_INTERNAL_ENDPOINT`, `MINIO_PUBLIC_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `s3.amazonaws.com`, `443`, `true`, … |

Everything else is auto-wired — see [§7](#7-environment-variables).

---

## 6. Architecture & networking on Render

```
Browser
  │  https://nexora-frontend.onrender.com
  ▼
nexora-frontend (web, nginx)
  │  /api/* and /ws  →  api-gateway internal host:port  (envsubst at boot)
  ▼
nexora-api-gateway (web) ── fromService hostport ──▶ auth, user, group,
  │  /ws upgrade proxying          chat, delivery, presence,
  ▼                                notification, media  (web, free-mode)
nexora-websocket-gateway (web, free-mode)
  │  Redis pub/sub: deliver:<userId>, presence keys, receipt channel
  ▼
nexora-postgres + nexora-redis (managed, internal-only)
```

### How internal addresses are injected

- `fromService … property: hostport` injects a bare `host:port`
  (e.g. `nexora-auth-3k2j:3001`) — **no scheme**. The api-gateway's
  `config.js` normalizes it with `withScheme()` (adds `http://` only when
  missing), so the same config works for compose (full URLs) and Render
  (bare host:port).
- The frontend receives `API_GATEWAY_UPSTREAM` (the gateway's internal
  `host:port`). The nginx template renders `set $gateway_upstream
  http://<value>` — because the upstream is a **variable**, nginx resolves DNS
  per request, so a not-yet-live gateway never blocks the container boot.
- `DATABASE_URL` / `REDIS_URL` come from `fromDatabase` / `fromService
  (keyvalue)` `connectionString` — private-network URLs, no manual entry.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SERVICE_SECRET` are
  `generateValue: true` — Render creates random 256-bit values, shared through
  the `nexora-shared-secrets` env group.

### WebSocket path

The browser connects `wss://<frontend>/ws`. nginx upgrades to the api-gateway,
which round-robins across `WS_GATEWAY_URLS` (the websocket-gateway's internal
host:port). Instances share Redis pub/sub, so scaling the websocket-gateway
horizontally keeps presence + delivery correct.

---

## 7. Environment variables

### Auto-wired by the blueprint

| Variable | Source |
|----------|--------|
| `DATABASE_URL` | `fromDatabase` → `nexora-postgres` |
| `REDIS_URL` | `fromService` → `nexora-redis` (keyvalue) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SERVICE_SECRET`, `BCRYPT_ROUNDS`, `NODE_ENV` | env group `nexora-shared-secrets` |
| `AUTH_SERVICE_URL`, `USER_SERVICE_URL`, `GROUP_SERVICE_URL`, `CHAT_SERVICE_URL`, `MEDIA_SERVICE_URL` | `fromService hostport` per pserv |
| `GATEWAY_HTTP_URL`, `WS_GATEWAY_URLS` | `fromService hostport` → websocket-gateway |
| `API_GATEWAY_UPSTREAM` (frontend nginx) | `fromService hostport` → api-gateway |
| `PORT`, `SERVICE_NAME` | set per service |

### Manual (paste in Dashboard)

| Variable | Where | Notes |
|----------|-------|-------|
| `KAFKA_BROKERS`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` | env group `nexora-kafka` | Upstash credentials |
| `MINIO_*` | env group `nexora-minio` | S3 credentials; leave unset to run without media |
| `VITE_API_BASE_URL` | `nexora-frontend` | **Optional.** Unset = the SPA calls relative `/api`+`/ws` and nginx proxies to the gateway (default, works out of the box). Set = bake the gateway's public URL into the bundle at build time (bypass nginx proxy). |

> `VITE_API_BASE_URL` is a **build-time** variable — changing it requires a
> redeploy of the frontend.

---

## 8. Verifying the deployment

Wait for every service to reach "Live" (blueprint page shows the status), then:

```bash
# 1. Public health endpoint (api-gateway)
curl https://api-gateway-xxxx.onrender.com/health
# → {"status":"ok"}

# 2. Signup through the public gateway
curl -X POST https://api-gateway-xxxx.onrender.com/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com","password":"S3cureP@ssw0rd!"}'
# → { accessToken, refreshToken, user }

# 3. The frontend loads and the SPA talks to the API
open https://nexora-frontend-xxxx.onrender.com
# login/register → chat → send a message → see it arrive on the other tab
```

Sign in with the same account in two browser tabs: real-time delivery runs over
`wss` → gateway → Redis pub/sub, and message statuses (✓/✓✓) flow back via the
delivery-service.

### Where to look if something's off

- **Blueprints page** → click any service → **Logs** tab. Look for
  `retrying database init (attempt N/20)` — that's normal during the first
  minutes while Postgres/Redis provision.
- **api-gateway health is red** → check the downstream service URLs (should be
  `host:port` values injected by `fromService`; `config.js` adds the scheme).
- **Frontend loads but API calls 502** → `API_GATEWAY_UPSTREAM` not set; check
  the env var on `nexora-frontend`.

---

## 9. Scaling & production hardening

### Free tier reality check

- Free **Postgres** expires after 30 days → move to `basic-256mb` before then.
- Free **Key Value** has no persistence (`persistenceMode: off`).
- Free **web** services spin down after 15 min of inactivity. An open browser
  tab keeps the WebSocket chain awake (heartbeats count as traffic); Kafka
  consumers pause while asleep and resume on the next request.
- Free **pservs are not allowed** (Render restriction) — that's why the
  free-tier blueprint uses web services for everything.
- Each free web service gets its own public URL; user data is JWT-protected
  and internal routes require the `SERVICE_SECRET` trust header.

### Recommended production config

```yaml
databases:
  - name: nexora-postgres
    plan: basic-256mb   # + persistence
services:
  - type: keyvalue
    name: nexora-redis
    persistenceMode: journal-snapshot
```

### Scaling services

```yaml
# in render.yaml, under any service:
numInstances: 2
# or autoscaling (requires a Pro workspace):
scaling:
  minInstances: 1
  maxInstances: 3
  targetCPUPercent: 70
```

The websocket-gateway scales horizontally for free (Redis pub/sub decouples
instances; the api-gateway round-robins `WS_GATEWAY_URLS` — add the new
instance's hostport to that var after scaling). Kafka consumers scale with
consumer groups (`KAFKA_MESSAGE_EVENTS_GROUP`).

### Tuning knobs (env vars with defaults)

| Variable | Default | Used by |
|----------|---------|---------|
| `WS_HEARTBEAT_TIMEOUT_MS` | `90000` | websocket-gateway |
| `WS_HEARTBEAT_CHECK_INTERVAL_MS` | `30000` | websocket-gateway |
| `PRESENCE_TTL_SECONDS` / `PRESENCE_GRACE_SECONDS` | `90` / `30` | websocket-gateway |
| `DLQ_MAX_ATTEMPTS` / `DLQ_BASE_DELAY_MS` / `DLQ_JITTER_MAX_MS` | `5` / `1000` / `500` | delivery-service |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `7d` | auth-service |

---

## 10. Troubleshooting & FAQ

**Q: Blueprint sync fails with "free plan not available for private services".**
The free-tier blueprint uses `type: web` for every compute service (free plan
is not allowed on pservs) — make sure you haven't changed a service back to
`pserv` without also setting a paid plan.

**Q: Services crash-loop at first boot.**
Expected while Postgres/Redis provision (retries last ~60s). If it keeps
crashing: check `DATABASE_URL`/`REDIS_URL` are the injected internal values,
and that the service's region matches the databases' region.

**Q: `fromService` references fail validation.**
If you renamed a service in the Dashboard, update `render.yaml` names to match,
or delete the renamed service. Service names are immutable after creation —
don't rename services in the Dashboard; change them in the blueprint instead.

**Q: How do I update the deployment after changing code?**
Push to `main` → `autoDeployTrigger: commit` redeploys changed services. To
apply blueprint config changes, open the blueprint → **Sync**.

**Q: Roll back a bad deploy?**
Render keeps previous deploys — each service has a **Deploys** tab with "Revert
to this deploy".

**Q: Can I run the same stack locally?**
Yes — `docker compose up --build` uses the same Dockerfiles and env semantics
(docs in [README.md](README.md#quick-start)); CI (`npm test`) exercises the
same code against real Postgres/Redis/Kafka/MinIO.

**Q: What does CI check?**
`.github/workflows/ci.yml`: lint + render.yaml validation, the full test suite
against real infrastructure, and a build of all 11 Docker images.

**Q: Where do I set custom domains?**
Each web service supports `domains:` in the blueprint (or Dashboard → Settings).
The api-gateway and frontend are the only services that need them.
