# Nexora — Architecture

## Overview

Nexora is a distributed, event-driven real-time chat platform. The system is split
into small, independently deployable Node.js + Express services that communicate
over an event bus (Kafka) and share state through PostgreSQL (system of record) and
Redis (cache, pub/sub, presence, delivery bookkeeping). Real-time traffic flows
over native WebSockets through dedicated gateways.

One command brings up the whole system: `docker compose up` (see README.md).

## System diagram

```
                                                      ┌─────────────────────────┐
                          ┌───────────────────────┐   │      PostgreSQL 16      │
                          │   frontend (nginx)    │   │  users, groups, members,│
                          │   http://localhost:5173│  │  messages, message_status│
                          └───────────┬───────────┘   └───────────┬─────────────┘
                                      │  /api/* , /ws  (same origin, no CORS)
                                      ▼                           ▲
                          ┌───────────────────────┐               │
                          │      api-gateway      │               │
                          │  JWT verify · headers  │              │ reads/writes
                          │  proxy · WS upgrade    │              │
                          └───────┬───────┬───────┘               │
                        /api/auth │       │ /ws (round-robin)     │
                        /api/users│       ▼                       │
                        /api/groups└────┐                ┌────┐   │
                        /api/messages   │   ┌──────────────────────────┐
                        /api/presence   │   │  websocket-gateway 1..N  │  presence keys,
                                     ┌──┴┐  │  (ws, presence, fan-out, │  receipts, backlog
                                     │   │  │   backlog, deliver:{uid})│
                     ┌───────────────┴───┴──────────┐   └────┬─────────┘
                     │  auth · user · group · chat  │        │ Redis pub/sub
                     │  delivery · notification     │        │ deliver:{userId}
                     │  (presence: superseded)      │        │ delivery:receipts
                     └───────┬──────────────┬────────┘        │
                             │  events      │  live delivery  │
                             ▼              │  via Redis      │
                   ┌───────────────────┐    └─────────────────┘
                   │  Kafka (KRaft)    │        ┌────────────────────┐
                   │  message-events   │◀───────│   Redis 7           │
                   │  chat.message.*   │        │  presence, pub/sub  │
                   └───────────────────┘        └────────────────────┘
```

Traffic rules of thumb:

- **Everything the browser does goes through the api-gateway** (REST `/api/*` and
  WS `/ws`). No service is reachable from outside the Docker network except the
  frontend and the api-gateway.
- **HTTP is synchronous, delivery is asynchronous.** A message POST is only acked
  after the row is in Postgres **and** the Kafka publish is acknowledged; from
  there it flows through Kafka consumers, Redis pub/sub, and the gateway with no
  blocking of the client.
- **The gateway is the only component that knows socket truth**; delivery-service
  owns the durable delivery/receipt state; chat-service owns message rows; Kafka
  is the reliable ordering backbone; Redis pub/sub is the low-latency live path.

## Stack decisions

| Concern          | Choice                                       | Notes                                                                |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Backend          | Node.js 22 + Express 4 (ESM)                 | Every service is a standalone app reading config from env vars only  |
| Frontend         | Vite + React + Tailwind CSS                  | Served via nginx in production containers                            |
| System of record | PostgreSQL 16                                | Users, groups, messages, memberships                                 |
| Cache / pub-sub  | Redis 7                                      | Presence, delivery status, session store, pub/sub                    |
| Event bus        | Apache Kafka 3.8 (single node)               | Reliable, ordered, replayable message flow                           |
| Kafka mode       | **KRaft** (no ZooKeeper)                     | Modern single-node setup; controller + broker roles on one node      |
| Realtime         | Native WebSockets (Node `ws` or built-in)    | Through websocket-gateway only                                       |
| Auth             | JWT (access + refresh)                       | Stateless access tokens, Redis-backed refresh sessions               |
| Deploy           | Docker Compose (dev)                         | Shared network, named volumes for postgres, redis, kafka data        |

### Kafka topics

| Topic                    | Partitions | Producer                | Consumers                            | Status     |
| ------------------------ | ---------- | ----------------------- | ------------------------------------ | ---------- |
| `message-events`         | 3          | chat-service            | delivery-service, notification-svc     | Live    |
| `chat.message.delivered` | 1          | delivery-service        | chat-service                           | Live    |
| `chat.message.read`      | 1          | delivery-service        | chat-service                           | Live    |
| `presence.changed`       | —          | presence-service        | websocket-gateway, notification-svc  | Planned    |
| `user.registered`        | —          | auth-service            | user-service, notification-svc       | Planned    |
| `group.updated`          | —          | group-service           | user-service, chat-service           | Planned    |

- Topics are created on first boot by the one-shot `kafka-init` container
  (`kafka-topics.sh --if-not-exists`); `message-events` gets 3 partitions
  (`KAFKA_MESSAGE_EVENTS_PARTITIONS`), replication factor 1 (single broker).
- Kafka client is **kafkajs** in every service that touches Kafka.

## Data model

One shared PostgreSQL database (`nexora`); each service owns its tables and
recreates the tables it only *reads* (users, groups, members) idempotently so a
fresh database boots with zero manual steps. `initDb` runs under a Postgres
advisory lock, so concurrent replicas never race DDL.

```
users                  (owned: auth-service; read: everyone)
  id uuid PK · username text UNIQUE · email text UNIQUE · password_hash bcrypt
  created_at timestamptz

refresh_tokens         (owned: auth-service)
  id uuid PK · token_hash sha256(text) · user_id FK users · expires_at
  revoked bool · created_at

groups                 (owned: group-service; read: chat, delivery, notification)
  id uuid PK · name text · avatar_url text (reserved) · owner_id FK users CASCADE
  created_at

group_members          (owned: group-service; read: chat, delivery, notification)
  (group_id FK groups CASCADE, user_id FK users CASCADE) PK
  role text CHECK (admin|member) · joined_at

messages               (owned: chat-service; read: delivery, websocket-gateway)
  id uuid PK · type text CHECK (DIRECT|GROUP) · sender_id FK users CASCADE
  recipient_id uuid NULL FK users CASCADE   -- set for DIRECT
  group_id uuid NULL FK groups CASCADE      -- set for GROUP
  content text · created_at
  indexes: (sender_id, created_at), (recipient_id, created_at), (group_id, created_at)
message_status         (owned: delivery-service; written: gateway, chat-service)
  (message_id FK messages CASCADE, user_id FK users CASCADE) PK
  status message_status_type ENUM (PENDING|SENT|DELIVERED|READ) · read_at NULL
  updated_at · index (user_id, status) -- gateway backlog flush

media                  (owned: media-service)
  id uuid PK · owner_id FK users CASCADE · filename text · content_type text
  size bigint · storage_key text UNIQUE (owner/{mediaId}-{filename} in MinIO)
  status text CHECK (uploading|ready|failed) · created_at
  index (owner_id, created_at DESC) · uploads cascade away with the user

presence:{userId}      (Redis, gateway-owned, TTL 90s heartbeat-refreshed,
                        30s grace on disconnect) → "online" | absent = offline
```

Presence fan-out is a **publish + seed** pair: on connect/disconnect the
gateway publishes the change to every other online user's deliver channel
(pure Redis pub/sub — instances need no knowledge of each other), **and** the
connecting socket is seeded with the current online snapshot. The seed closes
the connect/broadcast race (a user connecting at the same instant as another
could otherwise miss their presence change); whichever of the two connect/broadcast
paths runs second always lands.

The `message_status` row is the single source of truth for delivery state. The
state machine is **forward-only and enforced at the database layer**: `status`
is a Postgres enum whose declared order *is* the rank — `PENDING(0) → SENT(1) →
DELIVERED(2) → READ(3)` — and every writer advances a row with a
`WHERE status < $new` comparison (enum ordering). An out-of-order or duplicated
event (Kafka redelivery, network reordering) can therefore never regress a row:
a stale `delivered` after `read` is a no-op, while a `read` may jump a
still-`PENDING` row straight to `READ` instead of being dropped. `READ` is
terminal.

### Message flow: synchronous ingestion, asynchronous delivery

```
Client ──> API Gateway ──> chat-service (HTTP POST /messages) ──> PostgreSQL
                             │  insert row (source of truth)
                             │  publish awaited; publish failure => 5xx
                             ▼
                      Kafka: message-events (3 partitions, keyed by conversation id)
                             │
                             ▼
              delivery-service ──> websocket-gateway fan-out, receipts
```

Chat ingestion is synchronous (the HTTP response is returned only after the row is
persisted **and** the Kafka publish is acknowledged). Delivery is fully
asynchronous: `message-events` consumers (delivery-service, notification-service) process delivery, receipts, and fan-out offline.

Delivery is **at-least-once with an idempotent live fast-path**: the consumer
acks only after inserting `message_status` rows and live-publishing; if it
crashes between the two, Kafka redelivers the event. Redelivery never double-
delivers — the INSERT is `ON CONFLICT DO NOTHING`, and only newly-inserted
recipients (plus rows still `PENDING`, i.e. pushed by a crashed attempt and
never receipted) are live-published again; rows already at DELIVERED/READ are
skipped. The frontend additionally dedupes by message id.

## Service matrix

| Service            | Port | Purpose                                  | Status     |
| ------------------ | ---- | ---------------------------------------- | ---------- |
| api-gateway        | 3000 | HTTP entry point, JWT verify, WS upgrade | Implemented |
| auth-service       | 3001 | Register/login, JWT issuance & refresh   | Implemented |
| user-service       | 3002 | User search (new-chat picker)            | Implemented |
| group-service      | 3003 | Groups, memberships, roles               | Implemented |
| chat-service       | 3004 | Conversations, messages, history         | Implemented |
| delivery-service   | 3005 | Delivery/receipt states, fan-out bookkeeping | Implemented |
| presence-service   | 3006 | (superseded — presence lives in websocket-gateway) | Superseded |
| notification-service | 3007 | Push, email, in-app notifications        | Implemented |
| websocket-gateway  | 3008 | WS connections, presence, fan-out        | Implemented |
| media-service      | 3010 | Pre-signed uploads, media metadata, signed delivery URLs | Implemented |
| minio              | 9000 | S3-compatible object storage (media files) | Implemented |
| frontend           | 5173 | Chat UI                                  | Implemented |

## Message flows

### 1. Direct message — recipient online

```
A ──POST /api/messages (gateway)──▶ chat-service ──insert──▶ Postgres (messages)
                                       │ publish awaited
                                       ▼
                                 Kafka message-events (key: recipientId)
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                  delivery-service              notification-service
                  1. INSERT message_status        (recipient online ⇒ skip)
                     (PENDING) for recipient
                  2. presence key exists ⇒
                     PUBLISH deliver:{B}          ┌──────────────────────────┐
                     (live fast-path)             │ websocket-gateway holds B │
                          └──────────────────────▶│ push {type:"message"}     │
                                                  └──────────────────────────┘
```

- Recipient B's UI appends the message, bumps the conversation, and if the chat
  is open sends `PATCH /api/messages/:id/read`.
- The gateway reports `delivered` on `delivery:receipts` when it pushes to B's
  socket; delivery-service advances PENDING → DELIVERED (guarded) and pushes a
  `delivery_update` tick to A (sender sees ✓✓) and emits `chat.message.delivered`.
- B's `ack` (or the PATCH) advances DELIVERED → READ; a `delivery_update` / 
  `read_receipt` tick reaches A (blue ✓✓).

### 2. Direct message — recipient offline

- delivery-service inserts the PENDING row but the presence key is absent ⇒ no
  live push. notification-service logs a `PUSH STUB` for the offline recipient.
- On B's reconnect the gateway runs the **backlog flush** (flow 4): PENDING rows
  are pushed in order and advanced to DELIVERED in a batch. Everything is
  delivered, nothing is lost, and ordering is preserved.

### 3. Group message — fan-out

```
A ──POST /api/messages {groupId}──▶ chat-service (A must be a member)
                                       │ insert + publish (key: groupId)
                                       ▼
                                 Kafka message-events
                                       │
                                       ▼
                                 delivery-service
                                 1. INSERT PENDING row for EVERY member except A
                                 2. for each member with a presence key:
                                    PUBLISH deliver:{memberId}
                                      │
                                      ▼ (each gateway instance holds its own sockets)
                                    fan-out reaches every online member
- read receipts fan out too: PATCH read / ack ⇒ delivery_update to A + other members;
  chat-service PATCH pushes read_receipt to sender/other members via deliver channels.
```

### 4. Reconnect — backlog delivery

```
Client                    Gateway (any instance)          Redis                   PostgreSQL
  │   ws://…/ws?token=JWT     │                            │                          │
  │──────────────────────────▶│ verify JWT — fail ⇒ close 4001                         │
  │                           │ SET presence:{uid} online EX 90                        │
  │                           │───────────────────────────▶│                          │
  │◀──────────────────────────│ {type:"presence", payload:{userId,status:"online"}}    │
  │                           │ SUBSCRIBE deliver:{uid}     │                          │
  │                           │───────────────────────────▶│                          │
  │                           │ SELECT PENDING msgs ⋈ messages ORDER BY created_at    │
  │                           │─────────────────────────────────────────────────────▶│
  │                           │◀─────────────── rows ───────────────────────────────│
  │◀──────────────────────────│ {type:"message",…} × N (in order)                     │
  │                           │ UPDATE message_status SET status='DELIVERED' (batch) │
  │                           │─────────────────────────────────────────────────────▶│
```

### 5. Read receipts

The per-recipient state machine (rank = enum declaration order, enforced by the
`WHERE status < $new` guard on every writer):

```
PENDING(0) ──> SENT(1) ──> DELIVERED(2) ──> READ(3)
    │            │              │
    └────────────┴─── jump ─────┘        any higher rank may replace any lower
                                         rank; no lower rank may replace a
                                         higher one (READ is terminal)
```

- **SENT** is the sender's own row, written by chat-service in the same
  transaction that persists the message (accepted and queued). Recipient rows
  start at **PENDING**, written by delivery-service when the `message.created`
  event lands.
- Two paths converge on this machine:
  - **Socket ack** (fast path): client renders the message, sends `{type:"ack",
    messageId}` → gateway writes `READ` (rank-guarded: jumps PENDING/`SENT`
    straight to READ) + publishes a `read` receipt on `delivery:receipts` →
    delivery-service (idempotently) advances state and emits `chat.message.read`
    on Kafka + pushes `delivery_update` ticks.
  - **HTTP PATCH** (visible-chat path): `PATCH /api/messages/:id/read` on
    chat-service marks `READ` and pushes a `read_receipt` envelope to the
    sender/other members over `deliver:` channels.

Transitions are guarded by the rank comparison (`WHERE status < $new`), so a
duplicate or out-of-order event can never downgrade `READ` → `DELIVERED` — and
a `read` receipt that lands before its `delivered` advances a still-`PENDING`
row straight to `READ` instead of being dropped. No-op receipts still emit the
at-least-once Kafka event (the socket truth is recorded regardless) but do not
push a `delivery_update` tick, so a stale `delivered` can't regress the
sender's ✓✓ ticks. Clients apply the same forward-only rule: `delivery_update`
patches that would lower the displayed rank are ignored.

### 6. Typing indicator (lowest-latency path)

Deliberately bypasses Kafka and the database entirely: client → gateway
`{type:"typing", payload:{chatId, userId, recipientId|recipientIds, isTyping}}`
→ gateway republishes to each target's `deliver:{userId}` channel → recipient's
gateway instance pushes it down the socket. Nothing persisted. Measured
round-trip in the dev stack: ~50ms.

## Reliability: retries & dead-letter queue

### Consumer-side (delivery-service, `message-events`)

- Every event is processed with **exponential backoff + jitter**: 1s, 2s, 4s,
  8s (the exponent is capped at 2³) + up to 500ms jitter, **max 5 attempts**,
  then the event is given up on. A single bad event (Redis blip, DB hiccup)
  blocks the consumer loop for at most ~15s — never indefinitely, and it is
  never silently dropped.
- `processWithRetry` in `delivery-service/src/kafka.js` owns the policy; the
  Redis client runs with `disableOfflineQueue` so a broken Redis produces a
  fast failure (and thus a retry) instead of hanging on a queued command.
- **Dead-letter queue:** after exhausting the attempts, the event is published
  to `message-events-dlq` (created by `kafka-init`) with full context:
  `{ eventType: "dlq", originalEvent, error, attempts, at, consumer }`, keyed
  by `messageId`. A DLQ publish failure is logged loudly — best effort, never
  a crash.
- **Inspection:** `node scripts/dlq-inspect.mjs` (recent messages,
  `--follow` to stream) — run it inside the compose network (the broker
  advertises its in-network name; see the header comment for exact commands),
  usable straight from the demo.
- All services attach `error` listeners to their Redis clients, so a Redis
  outage degrades instead of crashing: chat-service keeps persisting messages
  (only live delivery and receipts go dark), and delivery-service fails fast
  into the retry/DLQ path above.
- The Kafka receipt event is still emitted regardless of retry outcome:
  gateway receipts remain at-least-once and idempotent at the consumer.

### Client-side (send path)

- The composer implements **optimistic UI**: messages immediately appear in the chat with a `PENDING` status and a temporary ID (`client_msg_id`).
- It retries a failed `POST /messages` with the same policy (1s, 2s, 4s + jitter, max 4 attempts) **reusing the same `client_msg_id` on every attempt**.
- If an earlier attempt persisted the message but the response was lost, the server's idempotency key `UNIQUE (sender_id, client_msg_id)` plus the pre-check returns the existing `message_id` safely.
- On success, the UI patches the temporary message with the real server `id` and `createdAt`, and bumps it to `SENT`.
- If all attempts fail, the UI marks the message as `FAILED`, and the user can tap it to manually restart the retry loop.
- 4xx responses (validation, membership) are never retried — they cannot fix themselves; only network failures, 429, and 5xx are retried.

## Media Service

Media (images, docs, audio, short video) is a separate service in front of
**MinIO**, an S3-compatible object store, running in the same compose stack —
no cloud account required. Chat servers never proxy file bytes: the browser
PUTs straight to object storage using a pre-signed URL.

### Upload flow (pre-signed, never proxied)

```
Composer ──POST /api/media/upload-url──▶ media-service
    │  {filename, content_type, size}     │ 1. validate type + size (MVP allowlist,
    │                                     │    per-kind caps: image 15MB, audio 15MB,
    │                                     │    video 100MB, pdf 10MB, text 2MB;
    │                                     │    video: mp4/mov/webm, image: jpeg/png/
    │                                     │    gif/webp)
    │                                     │ 2. INSERT media row (status 'uploading',
    │                                     │    media_type stored explicitly as
    │                                     │    IMAGE/VIDEO/... — never re-inferred
    │                                     │    from the MIME at render time)
    │                                     │ 3. presign PUT (60s, 1 object = 1 UUID)
    │  ◀── 201 {upload_id, upload_url} ───┘
    │
    │  PUT <upload_url>  ─────────────────▶ MinIO   (browser↔storage directly)
    │  POST /api/media/:id/confirm ───────▶ media-service
    │        { }                            │ statObject: actual size must equal
    │                                       │ the declared size AND the per-kind cap
    │                                       │ → 'ready' | 'failed'
    │
    └── POST /api/messages {content: JSON {text, media:{media_id, filename,
                                            content_type, size}}}
```

- The `media` table is the authoritative record of each upload (owner, type,
  size, storage key, status `uploading|ready|failed`) — independent of the
  message that references it. Message content stays tiny (a JSON envelope);
  deleting the sender's account cascades the row (objects are cleaned by the
  service on cancel; orphaned-object GC is a noted gap).
- **Video is first-class**: videos upload through the exact same pre-signed
  path as images (client claim → PUT → confirm) and are delivered through
  signed GET URLs — chat servers never proxy file bytes. The 100MB cap is the
  limit actually enforced in `validators/media.js`; lower it there if the
  MinIO instance is storage-constrained. The frontend renders videos with a
  native `<video controls>` player (no custom player), images inline with a
  tap-to-open full-size lightbox.
- Two MinIO endpoints are configured: the internal DNS name for
  server-side operations and the browser-reachable host (`localhost` for the
  demo) embedded in presigned URLs — S3 v4 signatures bind the host, so the
  URL host must be the one the client actually resolves.
- The client retries the whole sequence (`request → PUT → confirm`) with
  backoff; the message itself is sent with the usual `client_msg_id`
  idempotency, so an interrupted send can never duplicate the chat message.

### Delivery flow ("CDN-style")

```
Recipient UI ──GET /api/media/:id/url──▶ media-service
    │   (any authenticated user; must be 'ready')  ──presign GET (10 min)──▶
    ◀── {get_url, expires_in} ──▶ <img src={get_url}> / download link
```

Images render inline (tap opens a full-size lightbox); videos render in an
inline native `<video>` player; everything else renders as a download link
with filename + size. The frontend caches signed URLs per media id and
re-mints only on expiry.

### Emoji

Emoji need no backend support — they are plain unicode code points in the
normal `content` TEXT column (the chat-service validator is a plain string
check with no character-set restriction, so nothing strips or rejects them).
The composer's emoji button opens a real picker using
**`emoji-picker-react`** (v4, `frontend/package.json`); picking an emoji
inserts it at the caret position in the textarea. Messages that are
emoji-only (detected client-side with a unicode regex, presentation only)
render reaction-style: larger glyph, tighter neomorphic bubble, timestamp
badge — consistent across light and dark mode since the browser renders the
emoji itself.

### Simplifications for the demo (explicitly out of scope)

- **MinIO instead of S3** — same S3 API/signing model; swapping in a real
  bucket is a config change.
- **No real CDN** — in production a CDN (CloudFront/Cloudflare) would sit in
  front of the signed GET URLs; the architecture already treats object
  retrieval as a signed, time-limited fetch so a CDN is a drop-in.
- **No malware/virus scanning and no magic-byte sniffing** — the allowlist is
  enforced on the client's *claim* (content_type + size) at issuance and
  against the actual object size at confirm, but the bytes are not inspected.
  **Noted gap, not implemented.**
- **No video thumbnail generation (this pass)** — ffmpeg is not present in
  the media-service image, so no poster frame is extracted on upload. Videos
  show a generic play-icon placeholder until the signed URL resolves, then a
  native `<video controls>` player (browsers render the first frame once
  metadata loads). The media envelope/table has no thumbnail slot wired up;
  adding one later means ffmpeg in the Dockerfile, a poster object in
  storage, and a `poster` attribute on the player.
- **Coarse download ACL** — any authenticated user can mint a signed URL;
  media ids are unguessable UUIDs and URLs expire in 10 minutes. Restricting
  minting to conversation participants is the production design (checked in
  chat-service, which knows membership).

## Group Chat Fan-out Strategy

Nexora uses **fan-out-on-write** by design for delivering group messages. At the time of message creation, the delivery-service iterates over all current group members and writes a `message_status` row (in `PENDING` state) for each member, while also pushing a live WebSocket event to their Redis channel.

**Why this strategy?**
For small to medium group sizes (e.g., up to a few hundred members), fan-out-on-write is highly efficient. It keeps read operations extremely fast and straightforward (users just query `message_status` for their own ID) and avoids complex read-time aggregation logic. 

**Next Steps at Scale (10K+ members):**
For very large or "hot" groups (e.g., announcements channels or large communities with 10K+ members), fan-out-on-write becomes a bottleneck, causing massive database bloat (one row per member per message) and fan-out latency. At that scale, the architecture would need to transition these specific groups to **fan-out-on-read**. In a fan-out-on-read model, the system stores only one copy of the message, and recipients dynamically fetch it when they open the channel, tracking their read progress via a single "high-water mark" cursor rather than individual message status rows. Nexora's current architecture uses fan-out-on-write for simplicity and responsiveness within expected MVP constraints.

## Distributed-systems concepts demonstrated

| Concept | Where in Nexora |
| --- | --- |
| **Event-driven architecture** | Messages are a `message.created` event on Kafka; delivery, notifications, and feed updates are decoupled consumers reacting to it |
| **Pub/sub fan-out** | Redis `deliver:{userId}` channels: any service (delivery-service, chat-service, another gateway) publishes to a channel name without knowing which instance holds the socket — the correct instance delivers, the rest drop the frame |
| **Asynchronous, ordered processing** | `message-events` is keyed by conversation id → Kafka guarantees per-conversation order; consumers are independently scaleable (consumer groups) |
| **Horizontal scaling** | Stateless websocket-gateway + producer-only chat-service scale with `--scale`; scaling proof: `services/websocket-gateway/test/ws.test.js` delivers cross-instance with zero instance knowledge |
| **Fault tolerance / DLQ-style safety** | Publish is awaited (failure ⇒ 5xx, never a silent drop); consumers run `fromBeginning` with idempotent upserts (`ON CONFLICT DO NOTHING`) and recreated-table init, so replays/reconnects are safe; per-event processing retries with capped exponential backoff + jitter and moves exhausted events to a real `message-events-dlq` topic (`scripts/dlq-inspect.mjs`); rank-guarded (forward-only) status transitions make duplicate and out-of-order events harmless; gateway receipts are at-least-once and deduped on the consumer side |
| **Offline backlog / at-least-once delivery** | `message_status` PENDING rows are flushed in order on reconnect and batch-advanced to DELIVERED |
| **Idempotent processing** | `ON CONFLICT` upserts, `WHERE status < $new` rank-guarded state machine (a Postgres enum ordering), `--if-not-exists` topic creation, advisory-locked DDL; client retries reuse the same `client_msg_id` (server `UNIQUE (sender_id, client_msg_id)` + pre-check) so a lost response can never create a duplicate message |
| **Pre-signed uploads / storage offloading** | chat servers never proxy file bytes: the browser PUTs directly to MinIO via a short-lived pre-signed URL, and the media row keeps the authoritative metadata; delivery re-signs a 10-minute GET URL per render ("CDN-style", see Media Service) |
| **Read/eventual consistency** | Postgres is the system of record; Redis holds only ephemeral presence/pub-sub state (TTL'd, loss-tolerant); the UI is updated by events, never by polling state |
| **Graceful degradation** | A dead gateway instance costs only the sockets on it — clients reconnect (backoff) to another instance via the api-gateway round-robin; presence stays "online" during a 30s grace window so blips don't flap the UI |
| **JWT stateless auth + trusted internal network** | Only the gateway verifies JWTs; downstream trust comes from a shared internal secret + injected user headers — a service is never directly reachable from outside |

## Per-service design

### api-gateway
- **Status:** implemented
- **Responsibility:** the single public entry point for the SPA. Verifies access tokens, forwards the authenticated user to downstream services via trusted headers, and upgrades `/ws` to a websocket-gateway instance.
- **Trust model:** downstream services never verify JWTs themselves; the gateway verifies `Authorization: Bearer` with `@nexora/verify-jwt`, then re-authenticates each request with `X-Nexora-Internal-Secret` (`SERVICE_SECRET`, default `dev-internal-secret`) + `X-Nexora-User-Id` / `X-Nexora-Username` headers (`@nexora/internal-auth` `gatewayOnly` middleware).
- **Proxy map** (path prefix rewritten to the downstream route; e.g. `/api/groups` → `/groups`):
  | Public path              | Downstream target        | Auth                              |
  | ------------------------ | ------------------------ | --------------------------------- |
  | /api/auth/*              | auth-service             | passthrough (auth-service verifies its own tokens) |
  | /api/users/*             | user-service             | verify + inject user context      |
  | /api/groups/*            | group-service            | verify + inject user context      |
  | /api/messages/*          | chat-service             | verify + inject user context      |
  | /api/conversations       | chat-service             | verify + inject user context      |
  | /api/presence            | websocket-gateway (HTTP) | passthrough (gateway verifies the Bearer token itself) |
  | /ws                      | websocket-gateway (WS)   | upgrade, round-robin across instances |
- **Endpoints:** `GET /health`.
- **Tests:** `npm test` — fake backends verify passthrough, header injection, 401 on bad/missing tokens, path rewriting, and WS upgrades (including dropping non-`/ws` upgrades).

### auth-service
- **Status:** implemented
- **Responsibility:** user registration, password authentication, JWT issuance, refresh-token rotation and revocation.
- **Owned data:**
  - `users` — `id` (uuid), `username` (unique), `email` (unique), `password_hash` (bcrypt, 10 rounds), `created_at`
  - `refresh_tokens` — `id`, `token_hash` (sha256 of the raw token), `user_id` (FK), `expires_at`, `revoked`, `created_at`
- **Endpoints:**
  | Method | Path          | Body                    | Response                                            |
  | ------ | ------------- | ----------------------- | --------------------------------------------------- |
  | POST   | /auth/signup  | username, email, password | 201 `{ accessToken, refreshToken, user }`          |
  | POST   | /auth/login   | email, password         | 200 `{ accessToken, refreshToken, user }`            |
  | POST   | /auth/refresh | refreshToken            | 200 `{ accessToken, refreshToken }` (rotated)        |
  | POST   | /auth/logout  | refreshToken            | 204 (token revoked)                                  |
  | GET    | /auth/me      | — (Bearer access token) | 200 `{ user: { userId, username } }` — protected dummy route |
  - Errors: `400` validation (zod), `409` duplicate email/username, `401` bad credentials / invalid or revoked token.
- **Token flow:**
  - Access token: signed with `JWT_ACCESS_SECRET`, `expiresIn: JWT_ACCESS_TTL` (15m), payload `{ userId, username }`.
  - Refresh token: signed with `JWT_REFRESH_SECRET`, `expiresIn: JWT_REFRESH_TTL` (7d), payload `{ userId, username, jti }` (jti makes every token unique). Stored server-side as sha256 hash; hash lookup makes tokens revocable.
  - On `/auth/refresh` the presented token is verified, its DB row revoked, and a brand-new pair issued (rotation).
  - On `/auth/logout` the row for the presented token is flagged `revoked = true`.
- **Shared package:** `@nexora/verify-jwt` (`packages/verify-jwt`) exports the `verifyAccessToken` middleware — decodes the Bearer token with `JWT_ACCESS_SECRET` and sets `req.user = { userId, username }`. Other services depend on it via npm workspaces.
- **Topics produced/consumed:** none yet (planned: `user.registered`).
- **Tests:** `npm test` (vitest + supertest) — covers signup → login → refresh rotation → protected route → logout revocation, plus 400/401/409 paths.

### user-service
- **Status:** implemented
- **Responsibility:** user search for the "new chat" picker. Read-only over `users` (owned by auth-service, recreated idempotently here for fresh-DB boots).
- **Trust model:** `@nexora/internal-auth` `gatewayOnly` — only reachable through the API gateway.
- **Endpoints:**
  | Method | Path           | Notes                                                        |
  | ------ | -------------- | ------------------------------------------------------------ |
  | GET    | /users/search?q= | Username prefix search (`ILIKE 'q%'`), excludes the caller, max 20 results, never exposes emails/hashes. `q` 1–50 chars (400 otherwise). |
- **Tests:** `npm test` — prefix matching, self-exclusion, validation, missing secret/user-context rejection.

### group-service
- **Status:** implemented
- **Responsibility:** group lifecycle and membership: create, list, member list with roles, add/remove members, leave.
- **Owned data:**
  - `groups` — `id`, `name`, `avatar_url` (reserved), `owner_id` (FK users, ON DELETE CASCADE), `created_at`
  - `group_members` — `(group_id, user_id)` PK, `role` (`admin`|`member`, CHECK), `joined_at`; index on `user_id`
- **Trust model:** `gatewayOnly` — only reachable through the API gateway.
- **Endpoints:**
  | Method | Path                           | Notes                                                        |
  | ------ | ------------------------------ | ------------------------------------------------------------ |
  | POST   | /groups                        | `{ name }` → 201; caller becomes `admin`.                    |
  | GET    | /groups                        | Groups the caller belongs to.                                |
  | GET    | /groups/:id/members            | Member list with roles + joined_at; members only (403 otherwise). |
  | POST   | /groups/:id/members            | `{ userId }`; admin only. Idempotent (`ON CONFLICT DO NOTHING`). |
  | DELETE | /groups/:id/members/:userId    | Admin only; the owner cannot be removed.                     |
  | POST   | /groups/:id/leave              | Caller leaves; 404 if not a member.                          |
- **Tests:** `npm test` — full CRUD, role enforcement (admin vs member), owner protection, member-only reads, internal-secret rejection.

### chat-service
- **Status:** implemented
- **Responsibility:** message ingestion (synchronous), message history, publishing `message-events` for asynchronous delivery.
- **Owned data:** 
  - `messages` — `id` (uuid), `type` (`DIRECT`|`GROUP`), `sender_id`, `recipient_id` (nullable), `group_id` (nullable), `content`, `sequence_no`, `created_at`; indexed for direct and group history queries.
  - `conversation_sequences` — `conversation_id`, `next_seq`. Used to generate gapless, per-conversation strict ordering sequence numbers atomically during message insert.
  - Reads `groups` / `group_members` (owned by group-service) for the GROUP-message membership check — shared-DB read, recreated idempotently in this service's init so a fresh DB boots correctly.
- **Trust model:** only reachable via the API Gateway (`@nexora/internal-auth`): `X-Nexora-Internal-Secret` header + injected `X-Nexora-User-Id` / `X-Nexora-Username`. Never verifies JWTs itself.
- **Kafka:** producer only, `kafkajs`. `POST /messages` inserts the row, then `await`s the publish; publish failure ⇒ `502` (row persisted, not silently dropped — delivery-service reconciles via the event stream). Partition key = conversation id (`recipientId` for DIRECT, `groupId` for GROUP) so per-conversation ordering is preserved.
- **Endpoints:**
  | Method | Path                      | Notes                                                        |
  | ------ | ------------------------- | ------------------------------------------------------------ |
  | POST   | /messages                 | `{ type, recipientId?, groupId?, content }`; DIRECT ⇒ recipientId required, GROUP ⇒ groupId required + sender must be a member (404 unknown group, 403 non-member). 200 `{ message }`. |
  | GET    | /messages/direct/:userId  | Paginated history between the caller and `:userId`, newest first. |
  | GET    | /messages/group/:groupId  | Paginated group history (members only).                      |
  | GET    | /conversations            | Sidebar feed: latest message + unread count per direct counterpart and per group the caller belongs to (groups with no messages included), sorted by most recent activity. Unread = messages not sent by me with no READ `message_status` row. |
  | PATCH  | /messages/:id/read        | Marks `message_status` READ (+ `read_at`); pushes `read_receipt` WS event to the sender / other members via Redis deliver channels. Recipient-only for DIRECT, member-only for GROUP. |
  | GET    | /messages/:id/status      | Per-user `{ userId, status, readAt }` + `counts: { delivered, read }`; participants/members only. |
  - Pagination: `?limit=` (1–100, default 50) and `?cursor=` (opaque `createdAt_id` from the previous page's `nextCursor`; keyset on `(created_at, id)`).
- **Event payload (`message-events`):**
  ```json
  {
    "eventType": "message.created",
    "messageId": "uuid",
    "senderId": "uuid",
    "type": "DIRECT",
    "recipientId": "uuid | null",
    "groupId": "uuid | null",
    "content": "...",
    "createdAt": "2026-08-01T05:50:43.322Z"
  }
  ```
- **Tests:** `npm test` (vitest + supertest) — injection-aware: publish errors ⇒ 502, membership enforcement, secret/user-context guards, pagination. Kafka publish is injected/mocked in tests; the real topic round-trip is verified via curl + `kafka-console-consumer`.

### delivery-service
- **Status:** implemented
- **Responsibility:** owns delivery/receipt state. Consumes `message-events` and turns every `message.created` into PENDING `message_status` rows for the recipients, live-fans messages to online recipients, and converts gateway receipts into durable status transitions + Kafka receipt events.
- **Owned data:** `message_status` — `(message_id, user_id)` PK, `status` (`PENDING` → `DELIVERED` → `READ`), `updated_at`; indexed on `(user_id, status)` for the gateway's backlog flush. Reads `users` / `messages` / `group_members` (owned elsewhere; recreated idempotently so a fresh DB boots). `initDb` uses a pg advisory lock so concurrent instances don't race DDL.
- **Consumption (`message-events`, group `nexora-delivery-service`, `fromBeginning`):**
  - DIRECT → one PENDING row for `recipientId`; GROUP → one PENDING row per member except the sender.
  - Rows are inserted only for recipients that still exist (guards Kafka backfill replays against deleted users); `ON CONFLICT DO NOTHING` makes replays idempotent.
  - **Live fast-path:** for every recipient whose presence key exists in Redis, the client envelope is published to `deliver:{userId}` immediately — the gateway instance holding the socket fans it out with zero instance knowledge (this is the horizontal-scaling decoupling proof: the publisher never knows which instance has the connection).
- **Receipts (Redis channel `delivery:receipts`):** the websocket-gateway reports socket-level truth:
  | receipt type | transition            | Kafka event           |
  | ------------ | --------------------- | --------------------- |
  | `delivered`  | `PENDING` → `DELIVERED` | `chat.message.delivered` |
  | `read`       | `DELIVERED` → `READ`  | `chat.message.read`     |
   - Transitions are guarded (`WHERE status = previous`) so the gateway's own direct writes and this service are idempotent and can't downgrade a `READ`. Kafka events are emitted at-least-once (duplicates expected; consumers dedupe).
  - **Live delivery ticks:** after processing a receipt, the service also pushes a `delivery_update` envelope to the message sender (DIRECT) / every other member (GROUP) over their `deliver:{userId}` channels — the frontend uses these to flip ticks to ✓✓ / blue ✓✓ in real time (no polling). Payload: `{ messageId, userId, status, readAt, conversationType, groupId, recipientId }`.
   - Receipt events are keyed by `userId`, payload `{ eventType, messageId, userId, at }` — the feed chat-service will consume to update read/delivered state in the UI.
- **Status lifecycle (end to end):** chat-service persists the row + publishes `message.created` → delivery-service writes `PENDING` (+ live push if online) → gateway delivers (live or backlog flush) and reports `delivered` → delivery-service marks `DELIVERED` + Kafka → client acks → gateway reports `read` → delivery-service marks `READ` + Kafka.
- **Tests:** `npm test` (vitest, inside the container, real Postgres + Redis, Kafka mocked) — 11 tests: online fast-path (row + live envelope), offline (row only), GROUP fan-out (members minus sender), delivered/read transitions, no-downgrade guards, idempotent duplicates, live delivery ticks to sender/other members.
- **E2E proof:** `scripts/e2e.mjs` (run inside the container) exercises the full pipeline: chat-service HTTP POST → Kafka → delivery-service → gateway socket (live + backlog + ack), asserting status transitions PENDING → DELIVERED → READ.
- **Open questions:** GROUP receipts currently per-recipient (chat-service may want per-message group aggregation later).

### presence-service
- **Status:** superseded
- **Responsibility:** originally planned as a standalone presence service; the websocket-gateway now owns presence (Redis keys, heartbeat TTL, live relay + `GET /presence`) since it is the only component that knows socket truth. The service still runs (health-only) but is not part of the data path. If a richer presence product (away states, last-seen, presence for non-friends) is ever needed, this service is the natural home.

### notification-service
- **Status:** implemented
- **Responsibility:** offline notification fan-out. Consumes `message-events`; for every recipient that is **offline at delivery time** it logs a clearly-marked `PUSH STUB` — the integration point where a real APNs / FCM / Web Push provider call would go (no provider is wired up). Online recipients are deliberately skipped: the live WebSocket path already covers them, so pushes are only for the offline case.
- **Owned data:** none (reads `users` / `group_members` to resolve recipients; both recreated idempotently).
- **Consumption (`message-events`, own group `nexora-notification-service`, `fromBeginning`):**
  - DIRECT → check `recipientId`; GROUP → all members except the sender.
  - Presence is read from the same `presence:{userId}` Redis keys the websocket-gateway maintains.
  - Recipients that no longer exist are filtered (backfill replay safety).
- **Tests:** `npm test` (vitest, real Postgres + Redis, Kafka mocked) — 4 tests: offline DIRECT ⇒ stub, online DIRECT ⇒ skip, GROUP mixed, deleted-recipient filter.
- **Open questions:** none blocking — the stub log is the single replace-the-provider point.

### websocket-gateway
- **Status:** implemented
- **Responsibility:** sole realtime entry point (native `ws`, no socket.io): authenticates WebSocket connections, maintains presence, subscribes to per-user Redis Pub/Sub channels, fan-outs live events, and flushes offline backlog on reconnect.
- **Owned data:** none (stateless). Reads `messages` + `message_status` for the backlog flush; writes `message_status.status` (`DELIVERED` on flush, `READ` on client ack) and — as the component that knows socket-level truth — **reports receipts** to delivery-service over the Redis channel `delivery:receipts` (`delivered` on live broadcast / backlog flush, `read` on ack) so delivery-service persists + emits `chat.message.delivered` / `chat.message.read` on Kafka. Both tables are recreated idempotently in its init so a fresh DB boots.
- **Presence:** Redis key `presence:{userId}` — set to `online` with EX 90s while connected (refreshed on every ping); on disconnect it is re-set with a 30s **grace TTL** so quick reconnects / network blips don't flip presence to offline. The key disappears after grace expires (treat as offline).
- **Live presence relay:** on connect/disconnect each instance publishes a `presence` envelope (`online`/`offline`) to every other online user's `deliver:{userId}` channel (Redis `SCAN presence:*`, node-redis v5 positional args), so all connected clients see presence dots change live.
- **Presence lookup:** `GET /presence?userIds=a,b` on the gateway's HTTP port (Bearer-authenticated) returns `{ presence: { [userId]: "online"|"offline" } }` — used by the frontend to seed dots for visible conversations; proxied by the API gateway at `/api/presence`.
- **Heartbeat:** client sends `{type:"ping"}` every 25s ⇒ gateway replies `{type:"pong"}` and refreshes the presence TTL. Connections idle longer than `heartbeatTimeoutMs` (90s) are closed with code 4002.
- **Horizontal scaling:** all instances subscribe to the same `deliver:{userId}` channels in Redis. A publisher (delivery-service, another gateway instance, …) only knows the channel name — never which instance holds the socket. The instance holding the user's connection delivers; the others drop it. Proof: integration test connects B on instance 2 and publishes with zero instance knowledge.
- **Connection flow:**
  1. Client opens `ws://gateway-host/ws?token={accessToken}`; JWT verified on handshake — invalid/expired ⇒ close 4001.
  2. Success ⇒ mark online, subscribe `deliver:{userId}` (once per user per instance), send `presence` envelope, flush backlog.
  3. Any message published on `deliver:{userId}` is pushed to every open socket for that user on this instance.
  4. Disconnect ⇒ if it was the last socket for the user on this instance: unsubscribe and set the 30s grace TTL.

- **WebSocket protocol** — every frame is a small JSON envelope `{ type, payload }`:

  | type          | direction       | payload                                                                         | notes                                                     |
  | ------------- | --------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
  | message       | server → client | `{ id, type, senderId, recipientId, groupId, content, createdAt }`               | live delivery **and** backlog flush (same shape)          |
  | presence      | server → client | `{ userId, status }`                                                            | own connect **and** relayed online/offline events for everyone else |
  | pong          | server → client | —                                                                               | reply to `ping`                                           |
  | ping          | client → server | —                                                                               | every 25s; refreshes presence TTL                         |
  | typing        | client → server | `{ chatId, userId, recipientId? \| recipientIds?, isTyping? }`                   | pure Pub/Sub relay (see below); envelope relayed verbatim |
  | ack           | client → server | `{ messageId }`                                                                 | client rendered the message ⇒ `DELIVERED` → `READ`        |
  | read_receipt  | server → client | `{ messageId, userId }`                                                          | pushed to sender / other members when someone marks read  |
  | delivery_update | server → client | `{ messageId, userId, status, readAt, conversationType, groupId, recipientId }` | live tick updates from delivery-service (✓✓ / blue ✓✓)  |

  Close codes: `4001` invalid/expired token · `4002` heartbeat timeout · `4003` wrong path (not `/ws`). Unknown envelope types and non-JSON frames are ignored.

- **Read-receipt state machine** (`message_status`, owned by delivery-service):

  ```
                      live fast-path publish          client ack / PATCH read
   PENDING ──────────────────────────────────────► DELIVERED ──────────────► READ
      ▲                  backlog flush (gateway)                              │
      │   message created                                                        │ read_at = now()
      │                                                                          │
      └── delivery-service inserts on message-events (recipient, member) ────────┘
  ```

  - `PENDING` — written by delivery-service when the message event is consumed; the gateway's backlog flush pushes it down the socket on reconnect and advances it to `DELIVERED` (batch UPDATE + per-message `delivered` receipt).
  - `DELIVERED` — also reached via the live fast-path: the gateway reports a `delivered` receipt whenever it pushes a message envelope to a live socket, and delivery-service advances the row (guarded `WHERE status = 'PENDING'`, so no downgrades).
  - `READ` — reached two ways: the client's WebSocket `ack` (gateway direct write + `read` receipt) or the HTTP **`PATCH /messages/:id/read`** on chat-service. Both set `read_at = now()`.
  - **Read-receipt fan-out:** chat-service's PATCH publishes `{ type: "read_receipt", payload: { messageId, userId } }` onto `deliver:{userId}` for the sender (DIRECT) or every other member (GROUP) — the same Redis Pub/Sub mechanism the gateway lives on, so read state reaches other participants in real time without a Kafka hop.
  - **Group status endpoint:** `GET /messages/:id/status` (chat-service, internal-auth, participants/members only) returns per-user `{ userId, status, readAt }` plus `counts: { delivered, read }` for the "delivered to 4/5, read by 2/5" UI.

- **Typing indicators:** the lowest-latency path in the system — **deliberately bypasses Kafka and the database**. Client sends `{ type: "typing", payload: { chatId, userId, recipientId } }` (DIRECT) or `{ recipientIds }` (GROUP); the gateway is a dumb relay: it republishes the envelope to each target's `deliver:{userId}` channel and the recipient's gateway instance pushes it down their socket. Nothing is persisted, no event is produced. (Measured e2e: ~50ms round trip in the dev stack.)

- **Reconnect / backlog sequence:**

  ```
  Client                    Gateway (any instance)          Redis                   PostgreSQL
    │   ws://…/ws?token=JWT     │                            │                          │
    │──────────────────────────▶│ verify JWT — fail ⇒ close 4001                         │
    │                           │ SET presence:{uid} online EX 90                        │
    │                           │───────────────────────────▶│                          │
    │◀──────────────────────────│ {type:"presence", payload:{userId,status:"online"}}    │
    │                           │ SUBSCRIBE deliver:{uid}     │                          │
    │                           │───────────────────────────▶│                          │
    │                           │ SELECT PENDING msgs ⋈ messages ORDER BY created_at    │
    │                           │─────────────────────────────────────────────────────▶│
    │                           │◀─────────────── rows ───────────────────────────────│
    │◀──────────────────────────│ {type:"message",…} × N (in order)                     │
    │                           │ UPDATE message_status SET status='DELIVERED' (batch) │
    │                           │─────────────────────────────────────────────────────▶│
    │        … live fan-out: any service publishes deliver:{uid} …                     │
    │                           │◀────────────── message ──────────────────────────────│
    │◀──────────────────────────│ {type:"message",…}                                   │
    │──────────────────────────▶│ {type:"ack", payload:{messageId}}                    │
    │                           │ UPDATE message_status SET status='READ'              │
    │                           │─────────────────────────────────────────────────────▶│
  ```

- **Live fan-out decoupling (horizontal-scaling proof):**

  ```
                       publisher (delivery-service, chat-service, other instance)
                                       │  PUBLISH deliver:{B}
                                       ▼
                                  Redis Pub/Sub
                                 /               \
                    SUBSCRIBE                       SUBSCRIBE
                         ▼                               ▼
              Gateway instance 1                  Gateway instance 2
              B not connected here                B connected → socket delivery
  ```

- **Tests:** `npm test` (vitest, run inside the container) — 13 integration tests against the live stack: valid-token handshake + presence + grace-TTL, invalid token ⇒ 4001, cross-instance live delivery both directions, per-channel isolation, backlog flush order + batch DELIVERED, heartbeat pong, typing relay, ack ⇒ READ, live presence relay, `GET /presence`.
- **Live demo:** `scripts/full-flow-e2e.mjs` (host-side, against `localhost:3000`) is the authoritative end-to-end proof; `scripts/live-demo.mjs` prints a compact two-instance confirmation (two clients on different gateway instances, live delivery, disconnect → backlog → DELIVERED). Run it inside the gateway container (`docker compose cp scripts/live-demo.mjs websocket-gateway:/app/scripts/`, then `docker compose exec websocket-gateway node scripts/live-demo.mjs`).
- **Open questions:** whether the gateway should also ingest outgoing messages directly (currently only `ping`/`typing`/`ack` go client → server; messages are written via chat-service HTTP).

### frontend
- **Status:** implemented
- **Stack:** React 19 + Vite 6 + Tailwind 4 (`@tailwindcss/vite`) + Zustand. Served by nginx (built assets); nginx proxies `/api/` → api-gateway and upgrades `/ws` → api-gateway → websocket-gateway (single origin, no CORS). Local dev uses the same routes via Vite's dev proxy.
- **Screens:** login/signup (tabbed, token pair persisted in `localStorage`), main chat layout: sidebar (conversations, unread badges, presence dots, sign out), chat window (day dividers, bubbles, delivery ticks, typing indicator, infinite scroll via `nextCursor`), new-chat picker (user search), group manager (create, member list with roles, add/remove, leave).
- **State (`src/store.js`, Zustand):** session, `conversations[]`, `messages[chatId]` (chat id `d:<userId>` / `g:<groupId>`), `nextCursor[chatId]`, per-chat `typing` map, `presence` map, `activeChat`, group member lists. Everything inbound from the socket goes through the store; no component-local message state.
- **Single WebSocket (`src/ws.js`):** one connection per session (`/ws?token=<accessToken>`), established on login and torn down on logout. Exponential-backoff reconnect (1s → 30s). Close code `4001` triggers one token refresh via `/api/auth/refresh` (rotation) then reconnect; a failed refresh signs the user out. Client pings every 20s to keep presence + heartbeat alive.
- **REST client (`src/api.js`):** fetch wrapper over `/api`; attaches `Authorization: Bearer`; on 401 tries a single refresh+retry, then signs out. Endpoints used: auth signup/login/refresh/logout, `/users/search`, `/groups` CRUD + members, `/messages` send/history/read/status, `/conversations`, `/presence`.
- **Envelope handling:**
  | WS event           | client action                                                                 |
  | ------------------ | ----------------------------------------------------------------------------- |
  | message            | append to the chat; bump the conversation (preview + unread); if the chat is open and it's incoming, `PATCH /messages/:id/read` (sender sees the blue tick via `read_receipt`) |
  | delivery_update    | patch the message's tick status (✓✓ delivered, blue ✓✓ read)                  |
  | read_receipt       | mark the message READ locally (PATCH path)                                    |
  | presence           | update the presence map (sidebar + chat header dots)                          |
  | typing             | show "X is typing…" (auto-clears after 4s)                                    |
  | pong               | no-op                                                                         |
  - Outbound: `ping` every 20s; `typing` (throttled to 2s; DIRECT → `recipientId`, GROUP → `recipientIds` from the group member list; `isTyping` stops when the input settles).
- **Delivery ticks:** own messages start `SENT` (✓) → `DELIVERED` (✓✓) via `delivery_update` → `READ` (blue ✓✓) via `delivery_update`/`read_receipt`.
- **Presence dots:** seeded from `GET /presence?userIds=…` when a chat opens, then kept live by WS `presence` events.
- **E2E proof:** `scripts/full-flow-e2e.mjs` (repo root, run on the host against `localhost:3000`) — signs up two users through the gateway, connects both sockets, and asserts: presence relay, user search, live direct + group delivery, ✓✓/blue-✓✓ ticks both paths, typing relay, group CRUD + roles + leave, conversations feed and history. 27 assertions, currently green.

## Scaling Beyond This Implementation

While Nexora handles horizontal scaling at the gateway and consumer tiers, the data tier currently relies on a single Postgres instance. To handle real WhatsApp-scale traffic, we would evolve the architecture toward a heavily sharded and replicated model:

### 1. Sharding the Message Store
To support millions of messages per second, the `messages` and `message_status` tables would move from a single Postgres instance to a distributed, NoSQL-style database (e.g., Cassandra, DynamoDB, or a globally sharded NewSQL DB). 
- **Partition Key:** The `conversation_id` (or a composite of `group_id` / `recipient_id`) would become the partition key. This ensures all messages for a specific chat live on the same physical shard, making history queries fast and localized.
- **Changes to Nexora:** The `chat-service` and `delivery-service` would change their data access patterns. Instead of complex JOINs, they would write denormalized rows to the distributed store. Kafka's partitioning strategy (already keyed by conversation ID) would perfectly align with this, ensuring events for a conversation land on a consumer that writes to the correct DB shard.

### 2. Per-Shard Replication & Tunable Consistency
A single Postgres instance is a single point of failure. At scale, each shard is replicated across multiple nodes (e.g., 3 replicas per shard across different availability zones).
- **Quorum Writes:** We would use a quorum-based replication model (e.g., Write=2, Read=2). When `chat-service` writes a message, it waits for at least 2 out of 3 replicas to acknowledge the write. This trades a tiny bit of latency for extreme durability and high availability. If one node dies, the system continues accepting writes.

### 3. Mitigating Hot Partitions (Viral Groups)
A "hot partition" occurs when a single `conversation_id` receives an enormous spike in traffic—like a viral announcement group with 100,000 members.
- **The Problem:** All writes for that group hit the exact same shard, overwhelming the node's CPU and disk I/O, while other shards sit idle.
- **The Solution:** We would implement **Time-Bucketing** (or compound partition keys). The partition key would become `conversation_id + time_bucket` (e.g., week or day). For insanely viral groups, we might even append a random salt to the partition key for writes, spreading the load across multiple shards, and querying them in parallel during read-time (scatter-gather). Furthermore, fan-out-on-write would be completely replaced by fan-out-on-read for these specific groups.

### 4. What Stays the Same?
- **Kafka & Event-Driven Flow:** The core event loop (`message.created` -> Delivery Service -> Redis Pub/Sub) remains identical. Kafka scales seamlessly by simply adding more partitions and consumers.
- **WebSocket Gateway:** The gateway and Redis Pub/Sub tiers remain unchanged. They are already stateless and perfectly horizontally scalable.

## Chaos Testing Checklist

To validate Nexora's resilience in its current Docker Compose setup, you can manually run the following failure scenarios. This checklist ensures the distributed systems guarantees (at-least-once delivery, forward-only state machines) hold up under duress.

- [ ] **Kill a Gateway Instance:**
  - Run `docker compose up -d --scale websocket-gateway=2`.
  - Connect a client and find which gateway it's on.
  - Run `docker stop <gateway_container>`.
  - *Expectation:* Client detects the drop, backoff-reconnects to the surviving gateway, and receives any messages sent during the gap via `flushBacklog`. Presence TTL expires gracefully.
- [ ] **Kill a Background Consumer:**
  - Run `docker stop nexora-delivery-service-1`.
  - Send messages between users.
  - *Expectation:* Messages show as sent (single tick) but not delivered.
  - Restart the service: `docker start nexora-delivery-service-1`.
  - *Expectation:* The service resumes from its Kafka offset and immediately delivers the backlog. Ticks update to ✓✓.
- [ ] **Simulate Network Partition / Redis Drop:**
  - Disconnect the `redis` container from the network temporarily.
  - *Expectation:* Gateways log connection errors but stay alive. When Redis returns, gateways reconnect. Any `PENDING` messages that missed the live Pub/Sub push will be delivered when the client next reconnects and flushes.
- [ ] **Introduce Artificial Latency:**
  - Use `tc` (traffic control) on the `postgres` container to add 500ms of latency.
  - *Expectation:* The system slows down but doesn't drop messages. Kafka producers wait for acks. Client idempotent retries (using `client_msg_id`) prevent duplicate messages if a timeout causes a retry.
