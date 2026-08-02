# Nexora

A distributed, event-driven real-time chat platform — built to demonstrate how
a production-style chat system is put together: independently deployable
microservices, an event bus, pub/sub fan-out, offline backlog delivery, and
horizontal scaling, all behind a single API gateway.

**Stack:** Node.js 22 + Express 4 (ESM) + React 19 + Zustand · PostgreSQL 16 ·
Redis 7 · Apache Kafka 3.8 (KRaft, no ZooKeeper) · native WebSockets (`ws`) ·
Docker Compose · JWT auth. Every service is a standalone Express app that reads
its configuration from environment variables only (12-factor style).

> **Architecture:** see [ARCHITECTURE.md](ARCHITECTURE.md) for the full design —
> service responsibilities, data model, all message flows, and the
> distributed-systems concepts demonstrated.
>
> **Interview demo:** see [DEMO.md](DEMO.md) for a step-by-step live walkthrough.

## Features

- Real-time 1:1 and group chat over native WebSockets
- Delivery ticks (sent ✓ → delivered ✓✓ → read blue ✓✓) updated live — no polling
- Live presence (online dots), typing indicators, unread badges
- Offline backlog: messages sent while a user is offline are delivered in order on reconnect
- Media sharing: pre-signed uploads straight to MinIO (S3-compatible), inline image
  rendering, download links with filename + size, signed time-limited delivery URLs
- Event-driven delivery: `chat-service` → Kafka → `delivery-service` → Redis pub/sub → gateway fan-out
- Horizontally scalable websocket-gateway + chat-service (`docker compose up --scale`)
- JWT auth with refresh-token rotation; single API gateway as the only public entry point

## Prerequisites

- Docker with the Compose plugin — verify with `docker compose version`
- (Optional) `node` + `npm` 20+ for running tests on the host or local dev without Docker

## Quick start

```bash
cp .env.example .env   # optional — every variable has a sane default baked in
docker compose up --build
```

This builds and starts **every** service plus PostgreSQL, Redis, Kafka, and
MinIO (object storage) on a shared Docker network. The first boot takes a few
minutes (images + npm install); subsequent boots are seconds.

Wait for everything to be healthy, then open the app:

```bash
docker compose ps            # expect (healthy) on all backend services
open http://localhost:5173   # the chat app
```

Sign up two users (e.g. in two browser windows / profiles) and chat — including
presence dots, typing indicators, and delivery ticks.

> Dependencies are ordered and health-gated: nothing starts before
> PostgreSQL / Redis / Kafka are ready, `kafka-init` creates the topics before
> consumers start, and the api-gateway waits for its downstream services. All
> services restart automatically unless stopped (`restart: unless-stopped`).

## Ports

| Port  | Host access | Service              | Notes                                        |
| ----- | ----------- | -------------------- | -------------------------------------------- |
| 5173  | public      | frontend (nginx)     | The chat app; proxies `/api` and `/ws`       |
| 3000  | public      | api-gateway          | Sole HTTP + WebSocket entry point            |
| 5432  | infra       | postgres             | System of record                             |
| 6379  | infra       | redis                | Presence, pub/sub, delivery bookkeeping      |
| 9092  | infra       | kafka                | Event bus (KRaft, single node)               |
| 9000  | infra       | minio                | S3-compatible object storage (media files)   |
| 9001  | public      | minio (console)      | MinIO web console (`nexora` / `nexora-minio-secret`) |
| 3001  | internal    | auth-service         | JWT auth, refresh rotation                   |
| 3002  | internal    | user-service         | User search                                  |
| 3003  | internal    | group-service        | Groups, memberships, roles                   |
| 3004  | internal    | chat-service         | Messages, conversations, history (scaleable) |
| 3005  | internal    | delivery-service     | Delivery/receipt state machine               |
| 3006  | internal    | presence-service     | Superseded — presence lives in the gateway   |
| 3007  | internal    | notification-service | Offline push stubs                           |
| 3008  | internal    | websocket-gateway    | WS connections, presence, fan-out (scaleable)|
| 3009  | internal    | websocket-gateway-2  | Second gateway instance (scaling proof)      |
| 3010  | internal    | media-service        | Pre-signed uploads, metadata, signed delivery URLs |

Only the frontend and api-gateway are reachable from the host. Internal
services are never directly exposed — all traffic goes through the gateway
(`/api/*`, `/ws`). `chat-service`, `media-service` and `websocket-gateway`
intentionally publish no host port so that `--scale` can run N replicas
without port conflicts. The MinIO API port is published (9000) because the
browser PUTs media straight to it via pre-signed URLs.

## Environment variables

All variables have defaults baked into `docker-compose.yml`; a plain
`docker compose up` works with no `.env`. Copy `.env.example` to `.env` and
edit when you want to override.

| Variable | Default | Description |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | `nexora` / `nexora` / `nexora` / `5432` | Postgres credentials, database, host port |
| `DATABASE_URL` | `postgres://nexora:nexora@postgres:5432/nexora` | Shared by every service (single DB, per-service tables) |
| `REDIS_PORT` / `REDIS_URL` | `6379` / `redis://redis:6379` | Redis host port / connection URL |
| `KAFKA_PORT` / `KAFKA_BROKERS` | `9092` / `kafka:9092` | Kafka host port / broker list |
| `KAFKA_MESSAGE_EVENTS_TOPIC` / `KAFKA_MESSAGE_EVENTS_PARTITIONS` | `message-events` / `3` | Primary event topic; partitions keyed by conversation |
| `KAFKA_DELIVERED_TOPIC` / `KAFKA_READ_TOPIC` | `chat.message.delivered` / `chat.message.read` | Receipt events |
| `SERVICE_SECRET` | `dev-internal-secret` | Shared secret between api-gateway and downstream services (trusted headers) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | `dev-only-access-secret` / `dev-only-refresh-secret` | Token signing secrets — **change in any non-local deploy** |
| `BCRYPT_ROUNDS` | `10` | Password hashing cost |
| `AUTH_SERVICE_URL` … `CHAT_SERVICE_URL` | `http://<service>:<port>` | api-gateway downstream targets |
| `MEDIA_SERVICE_URL` | `http://media-service:3010` | api-gateway downstream target for media |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` / `MINIO_BUCKET` | `nexora` / `nexora-minio-secret` / `nexora-media` | MinIO credentials and media bucket |
| `MINIO_INTERNAL_ENDPOINT` / `MINIO_PUBLIC_ENDPOINT` | `minio` / `localhost` | Internal DNS name vs. the browser-reachable host embedded in pre-signed URLs (point the latter at your LAN IP to test from another device) |
| `GATEWAY_HTTP_URL` | `http://websocket-gateway:3008` | Presence endpoint target |
| `WS_GATEWAY_URLS` | `ws://websocket-gateway:3008,ws://websocket-gateway-2:3009` | Comma-separated gateway instances the api-gateway round-robins `/ws` upgrades across |
| `DELIVERY_RECEIPT_CHANNEL` | `delivery:receipts` | Redis channel: gateway → delivery-service receipts |
| `PRESENCE_KEY_PREFIX` | `presence:` | Redis key prefix for presence |
| `PRESENCE_TTL_SECONDS` / `PRESENCE_GRACE_SECONDS` | `90` / `30` | Presence key TTL (heartbeat-refreshed) / grace before a disconnect counts as offline |
| `WS_HEARTBEAT_TIMEOUT_MS` | `90000` | Idle connections are closed (code 4002) after this |

## Scaling (horizontal scaling demo)

Two services are designed to scale out horizontally; the rest are singleton
coordinators (the gateway / Kafka partition keying / DB locks make this safe):

```bash
docker compose up --scale websocket-gateway=3 --scale chat-service=2
```

- **websocket-gateway** — stateless; instances share Redis pub/sub channels
  (`deliver:{userId}`) and Postgres. A publisher only knows the channel name,
  never which instance holds a socket — the instance that has the connection
  delivers, the rest drop the frame. Add replicas, no config change.
- **chat-service** — Kafka producer keyed by conversation id, so multiple
  replicas keep per-conversation ordering on the shared topic and never
  duplicate a conversation stream. Read-only shared DB.

Details that matter:

- Replicas are named `nexora-<service>-<index>` (e.g. `nexora-websocket-gateway-1`).
- The default `WS_GATEWAY_URLS` keeps working (the service DNS name
  `websocket-gateway` round-robins across all replicas; `websocket-gateway-2:3009`
  is the always-on second instance). To address replicas explicitly:

  ```bash
  WS_GATEWAY_URLS="ws://websocket-gateway-1:3008,ws://websocket-gateway-2:3008,ws://websocket-gateway-3:3008" \
    docker compose up --scale websocket-gateway=3 --scale chat-service=2
  ```

- Watch it fan out across replicas:

  ```bash
  docker compose logs -f websocket-gateway websocket-gateway-2 chat-service
  ```

- Scaling proof in code: `services/websocket-gateway/test/ws.test.js` connects a
  client to instance 2 and delivers through it with zero instance knowledge;
  the E2E script (`scripts/full-flow-e2e.mjs`) runs the whole flow against the
  scaled stack too.

To get back to the default single-instance topology:

```bash
docker compose up -d
```

## Running tests

Backend tests use vitest + supertest. 121 tests across the nine suites, plus a
27-assertion full-stack E2E. Run everything:

```bash
# (optional) fresh data
docker compose down -v && docker compose up -d

# unit + integration suites, each against the live stack (real Postgres/Redis/Kafka/MinIO)
docker compose exec auth-service npm test         # 16 tests
docker compose exec user-service npm test         # 5
docker compose exec group-service npm test        # 11
docker compose exec chat-service npm test         # 29 (13 messages + 10 receipts + 6 conversations)
docker compose exec delivery-service npm test     # 18 (13 delivery + 5 retry/DLQ)
docker compose exec notification-service npm test # 4
docker compose exec websocket-gateway npm test    # 13 (run in-container: a host-local
                                                  # Redis on 127.0.0.1 can shadow the
                                                  # container port mapping)
# media tests PUT real objects into MinIO; pre-signed URLs must resolve in
# the test container, so the public endpoint points at the internal DNS name:
docker compose exec -e MINIO_PUBLIC_ENDPOINT=minio media-service npm test  # 18

# full-stack E2E from the host (needs the stack up)
node scripts/full-flow-e2e.mjs                    # 27 assertions
```

Without Docker, run a suite from the monorepo root:

```bash
npm install
npm test --workspace services/chat-service
```

## Local development without Docker

Backend is an npm-workspace monorepo:

```bash
npm install
cd services/auth-service && npm run dev     # or npm start
```

Frontend (Vite dev server proxies `/api` and `/ws` to `localhost:3000`):

```bash
cd frontend && npm install && npm run dev    # http://localhost:5173
```

## Kafka topics

Created on first boot by the one-shot `kafka-init` container. Inspect live
events:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic message-events --from-beginning
```

| Topic | Partitions | Producer | Consumers | Purpose |
| --- | --- | --- | --- | --- |
| `message-events` | 3 | chat-service | delivery-service, notification-service | `message.created` events (keyed by conversation) |
| `chat.message.delivered` | 1 | delivery-service | chat-service (feed) | DELIVERED receipts |
| `chat.message.read` | 1 | delivery-service | chat-service (feed) | READ receipts |

## Known limitations

- **Single-node Kafka** (replication factor 1, KRaft combined broker/controller).
  Topics exist for scale-out, but a broker loss means message loss.
- **api-gateway is a single point of entry** — stateless and scaleable, but the
  default compose runs one instance. No TLS/certificates in dev (use the
  nginx frontend for browser demo; HTTPS termination is an ops add-on).
- **Messages are only created via chat-service HTTP** — the gateway currently
  relays `ping`/`typing`/`ack` client→server; it does not ingest messages.
- **notification-service stubs** push/email (`PUSH STUB` log lines) — no APNs /
  FCM provider is wired up.
- **presence-service is superseded** (health-only) — presence lives in the
  websocket-gateway. Kept in the compose file for reference.
- **GROUP receipts are per-recipient** — no per-message group aggregation yet.
- **Group chat has no message deletion/editing**, no avatar upload (column
  reserved). Media uploads support images, docs, audio and short video — see
  the Media Service section in ARCHITECTURE.md for the explicit demo
  simplifications (MinIO instead of S3, no real CDN, no virus scanning).
- **Graceful shutdown**: containers get SIGTERM; there is no explicit
  connection-drain on the gateway before exit.
- **Dev secrets**: `JWT_*` and `SERVICE_SECRET` defaults are development-only —
  override in `.env` for anything shared.

## Repo layout

```
nexora/
├── docker-compose.yml          # full stack: infra + 10 services + frontend
├── .env.example                # all tunables, with defaults
├── README.md / ARCHITECTURE.md / DEMO.md
├── package.json                # npm workspaces root (services/*, packages/*)
├── packages/verify-jwt/        # @nexora/verify-jwt — access-token middleware
├── services/                   # one Express app per service (port in name)
│   ├── api-gateway/            # 3000 — proxy, header injection, /ws upgrade
│   ├── auth-service/           # 3001 — signup/login/refresh/logout
│   ├── user-service/           # 3002 — user search
│   ├── group-service/          # 3003 — groups & memberships
│   ├── chat-service/           # 3004 — messages, conversations, history
│   ├── delivery-service/       # 3005 — delivery/receipt state machine
│   ├── presence-service/       # 3006 — superseded
│   ├── notification-service/   # 3007 — offline push stubs
│   ├── media-service/          # 3010 — pre-signed uploads, media metadata,
│   │                           #        signed delivery URLs (MinIO backend)
│   └── websocket-gateway/      # 3008 — WS, presence, fan-out, backlog
├── frontend/                   # Vite + React + Tailwind, served via nginx
├── render.yaml                 # Render IaC blueprint (see "Deploy to Render")
└── scripts/full-flow-e2e.mjs   # full-stack E2E (27 assertions)
```

---

## Deploy to Render

Nexora ships as a single Infrastructure-as-Code blueprint — [`render.yaml`](render.yaml) — that provisions the whole platform on Render in one click: frontend, API gateway, 9 private backend services, managed Postgres, managed Redis, and secret env groups. Kafka (Upstash) and S3-compatible storage are the only external pieces, wired in with credentials after deploy.

**Full walkthrough: [`DEPLOY_RENDER.md`](DEPLOY_RENDER.md)**

### Quick start

1. Provision [Upstash Kafka](https://upstash.com/kafka) (topics: `message-events`, `chat.message.delivered`, `chat.message.read`, `message-events-dlq`) and — optionally — an S3-compatible bucket.
2. Deploy the blueprint: Render Dashboard → **New Blueprint Instance** → select this repo (or the one-click button in `DEPLOY_RENDER.md`).
3. Paste the Upstash/S3 credentials into the `sync: false` prompts; everything else is auto-wired (`fromDatabase`/`fromService`/`generateValue`).

### Architecture on Render

```
Browser → nexora-frontend (web/nginx) → /api + /ws → nexora-api-gateway (web)
                                                        → 9× web/free (auth, user, group, chat, delivery,
                                                           presence, notification, media, websocket-gateway)
                                                        → nexora-postgres + nexora-redis (managed, internal)
```

- Only the **frontend** and **api-gateway** are meant to be public. The blueprint currently runs in **free-tier demo mode** (all services `web` + `free` — free services sleep after 15 min idle, and each gets a public URL; data stays JWT/SERVICE_SECRET-protected). For production, switch backend services to `pserv` + `starter` in render.yaml.
- `fromService hostport` injects bare `host:port` values; the api-gateway's `config.js` adds the scheme automatically (compose injects full URLs — one config, both environments).
- The frontend's nginx proxies relative `/api` + `/ws` to the gateway (`API_GATEWAY_UPSTREAM`, injected at boot), so no `VITE_API_BASE_URL` is needed by default.
- All services boot concurrently and retry DB/Redis connections at startup, so provisioning order never matters.

### Environment variables: auto-wired vs manual

| Variable | Source |
|----------|--------|
| `DATABASE_URL`, `REDIS_URL` | ✅ auto (`fromDatabase` / `fromService`) |
| `JWT_*`, `SERVICE_SECRET`, `BCRYPT_ROUNDS`, `NODE_ENV` | ✅ auto (`generateValue` + env group) |
| `AUTH_SERVICE_URL` … `MEDIA_SERVICE_URL`, `WS_GATEWAY_URLS`, `GATEWAY_HTTP_URL` | ✅ auto (`fromService hostport`) |
| `KAFKA_BROKERS`, `KAFKA_SASL_*` | ❌ manual (Upstash credentials) |
| `MINIO_*` | ❌ manual (S3 credentials; leave blank to run without media — media routes return 503) |
| `VITE_API_BASE_URL` | ⏭️ optional (relative-path proxying works by default) |

### Verifying the deployment

```bash
# Health check — every service exposes GET /health
curl https://api-gateway-xxxx.onrender.com/health
# → {"status":"ok"}

# Sign up through the public gateway
curl -X POST https://api-gateway-xxxx.onrender.com/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"testtest"}'
```

### Free tier notes

- Free **pservs** are not available on Render — the free-tier blueprint uses `web` + `free` for every compute service (each gets a public URL, but user data stays JWT-protected and internal routes require `SERVICE_SECRET`).
- Free Postgres expires after 30 days; free Key Value has no persistence. Swap to `basic-256mb` / `journal-snapshot` for production.
- Free web services spin down after 15 min of inactivity — WebSocket sessions and Kafka consumers pause while asleep and resume on the next request; an open browser tab keeps the chain awake. Upgrade plans in `render.yaml` for a stable deployment.
