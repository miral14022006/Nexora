# Nexora Live Demo Walkthrough

This guide walks through the features of the Nexora chat platform, demonstrating its real-time capabilities, failure handling, and distributed systems architecture in a local Docker Compose environment.

## Prerequisites

1. Ensure Docker Desktop (or equivalent) is running.
2. In the project root, start the entire stack:
   ```bash
   docker compose up -d --build
   ```
3. Wait ~15 seconds for all services (especially Kafka and Postgres) to become healthy.

## Step 1: Sign up and Login
1. Open two browser windows side-by-side:
   - Window A: `http://localhost:5173/signup`
   - Window B: (Incognito or another browser profile) `http://localhost:5173/signup`
2. In Window A, sign up as **Alice** (`alice@example.com`, password `Password123!`).
3. In Window B, sign up as **Bob** (`bob@example.com`, password `Password123!`).
4. Both windows will automatically log in and land on the main chat interface.

*Under the hood: The `api-gateway` routes the requests to the `auth-service`, which persists users in Postgres and issues JWTs.*

## Step 2: User Search and Direct Messages
1. In Window A (Alice), click **New Chat** and type `bob`.
2. Select Bob from the search results.
3. Type a message: "Hello Bob!" and send it.
4. Watch Window B (Bob). The message appears instantly.

*Under the hood:*
* - `chat-service` writes the message to Postgres with a gapless `sequence_no` and publishes an event to Kafka.*
* - `delivery-service` consumes the Kafka event, writes a `PENDING` delivery status, and pushes the message to Redis Pub/Sub.*
* - The `websocket-gateway` receives the Pub/Sub message and delivers it to Bob's active WebSocket connection.*

## Step 3: Read Receipts
1. Note the checkmarks under Alice's sent message:
   - One checkmark (✓): Sent (persisted in DB).
   - Two gray checkmarks (✓✓): Delivered to Bob's active socket.
2. When Bob clicks into the chat with Alice, the gray checkmarks turn **blue** (✓✓), indicating Bob has read the message.

*Under the hood: Bob's client sends an ack. The `websocket-gateway` publishes a receipt to Redis. The `delivery-service` updates the DB to `READ` and fans out a `delivery_update` WebSocket event back to Alice.*

## Step 4: Group Chat and Fan-out
1. In Window A (Alice), click **New Chat** and select **Create Group**.
2. Name the group "Project Team".
3. Inside the group, click **Group** in the header to view members. Type Bob's username and add him.
4. Bob instantly sees the new group appear in his sidebar.
5. Alice sends a message to the group. Bob receives it live.
6. Bob reads it, and Alice receives a read receipt.

*Under the hood: Group fan-out happens on write. `delivery-service` creates a delivery row for every member and publishes live updates to online members.*

## Step 5: Network Failure & Optimistic Retries
1. In Window A (Alice), open Browser DevTools (F12) -> Network tab.
2. Change the network throttling from "No throttling" to **Offline**.
3. Alice types and sends: "Can you read this?"
4. The message appears instantly for Alice but remains in a `PENDING` state (grayed out) with a temporary ID.
5. Watch the console: the frontend composer attempts to send with exponential backoff (1s, 2s, 4s).
6. After 4 failed attempts, the message turns red and says **"Failed to send — tap to retry"**.
7. Change the network throttling back to **No throttling**.
8. Tap the failed message. The message sends successfully, checkmarks appear, and Bob receives it.

*Under the hood: The frontend implements optimistic UI. It retries idempotently using a generated `client_msg_id`. The server guarantees the message is inserted at most once.*

## Step 6: Gateway Failover (Graceful Degradation)
1. Stop one of the WebSocket gateway instances:
   ```bash
   docker compose stop websocket-gateway
   ```
2. One of the browser windows will disconnect. It will automatically attempt to reconnect with backoff.
3. Because the `api-gateway` routes `/ws` requests round-robin, the disconnected client will seamlessly connect to the surviving `websocket-gateway-2` instance.
4. Send a message between Alice and Bob to verify that real-time communication continues uninterrupted.

## Step 7: Offline Backlog Delivery
1. In Window B (Bob), completely close the browser tab.
2. In Window A (Alice), send 3 rapid messages to Bob: "One", "Two", "Three".
3. Notice that Alice's checkmarks stay at single ✓ (Sent) because Bob is offline.
4. Reopen Window B and log back in as Bob.
5. Bob instantly receives "One", "Two", and "Three" in the correct order.
6. Alice's checkmarks instantly update to ✓✓ (Delivered) and then blue ✓✓ (Read).

*Under the hood: When Bob reconnects, the gateway performs a **backlog flush**. It queries all `PENDING` messages for Bob, delivers them in order, and marks them as `DELIVERED` in a batch.*
