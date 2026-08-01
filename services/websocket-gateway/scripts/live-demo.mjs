/**
 * Live confirmation of the websocket-gateway realtime flow:
 *
 *   1. Live delivery   — A and B connected on DIFFERENT gateway instances;
 *                        publish to deliver:{B} (as delivery-service would)
 *                        ⇒ B's socket receives it live, with no knowledge of
 *                        which instance holds B's connection.
 *   2. Offline backlog — B disconnects, a message lands PENDING, B reconnects
 *                        ⇒ backlog is flushed in order and batch-marked
 *                        DELIVERED.
 *
 * Runs from inside a gateway container (see ARCHITECTURE.md § websocket-gateway):
 *   docker cp services/websocket-gateway/scripts/live-demo.mjs \
 *     nexora-websocket-gateway:/app/services/websocket-gateway/scripts/
 *   docker compose exec websocket-gateway node scripts/live-demo.mjs
 */
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";
import { connectRedis, deliverChannel, redis } from "../src/redis.js";

const SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-only-access-secret";
const INSTANCE_1 = `ws://localhost:${process.env.PORT ?? 3008}/ws`;
const INSTANCE_2 = "ws://websocket-gateway-2:3009/ws";

const signToken = (userId, username) =>
  jwt.sign({ userId, username }, SECRET, { expiresIn: "15m" });

function connect(url, userId, username) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${signToken(userId, username)}`);
    const messages = [];
    const timer = setTimeout(() => reject(new Error(`connect timeout to ${url}`)), 8000);
    ws.on("message", (data) => {
      const env = JSON.parse(data.toString());
      messages.push(env);
      console.log(`      ${username} <-- ${JSON.stringify(env).slice(0, 160)}`);
    });
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, messages, username });
    });
    ws.on("error", reject);
  });
}

const waitFor = (conn, predicate, label, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const hit = conn.messages.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) {
        return reject(new Error(`timeout waiting for ${label} — got: ${JSON.stringify(conn.messages)}`));
      }
      setTimeout(poll, 50);
    };
    poll();
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let alice, bob;
let exitCode = 0;

try {
  await initDb();
  await connectRedis();

  const stamp = Date.now();
  const users = await Promise.all(
    [
      ["demo_alice", `demo_alice_${stamp}@nexora.dev`],
      ["demo_bob", `demo_bob_${stamp}@nexora.dev`],
    ].map(([username, email]) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [username, email, "hash"]
      )
    )
  );
  alice = users[0].rows[0];
  bob = users[1].rows[0];

  const insertMessage = (senderId, recipientId, content, createdAt = new Date()) =>
    pool.query(
      `INSERT INTO messages (type, sender_id, recipient_id, content, created_at)
       VALUES ('DIRECT', $1, $2, $3, $4) RETURNING id, content, created_at`,
      [senderId, recipientId, content, createdAt]
    ).then((r) => r.rows[0]);

  const insertStatus = (messageId, userId, status) =>
    pool.query(
      `INSERT INTO message_status (message_id, user_id, status)
       VALUES ($1, $2, $3) ON CONFLICT (message_id, user_id)
       DO UPDATE SET status = EXCLUDED.status`,
      [messageId, userId, status]
    );

  const envelopeFor = (row, senderId, recipientId) => ({
    type: "message",
    payload: {
      id: row.id,
      type: "DIRECT",
      senderId,
      recipientId,
      groupId: null,
      content: row.content,
      createdAt: row.created_at,
    },
  });

  console.log("== 1. LIVE DELIVERY (A on instance 1, B on instance 2) ==");
  const aConn = await connect(INSTANCE_1, alice.id, alice.username);
  const bConn = await connect(INSTANCE_2, bob.id, bob.username);
  await waitFor(aConn, (m) => m.type === "presence", "A presence");
  await waitFor(bConn, (m) => m.type === "presence", "B presence");

  const live = await insertMessage(alice.id, bob.id, "hello B, this is live");
  await insertStatus(live.id, bob.id, "DELIVERED");
  console.log("  chat-service: message row persisted; delivery-service publishes to", deliverChannel(bob.id));
  await redis.publish(deliverChannel(bob.id), JSON.stringify(envelopeFor(live, alice.id, bob.id)));

  const liveReceived = await waitFor(
    bConn,
    (m) => m.type === "message" && m.payload.content === "hello B, this is live",
    "live message on B's socket (instance 2)"
  );
  console.log(`  PASS — B received the live message on instance 2 (sent from ${aConn.username} on instance 1):`, JSON.stringify(liveReceived.payload));

  console.log("\n== 2. OFFLINE BACKLOG (B disconnects, messages queue PENDING) ==");
  bConn.ws.close();
  await sleep(400);

  const m1 = await insertMessage(alice.id, bob.id, "backlog one", new Date(Date.now() - 5000));
  const m2 = await insertMessage(alice.id, bob.id, "backlog two", new Date(Date.now() - 1000));
  await insertStatus(m1.id, bob.id, "PENDING");
  await insertStatus(m2.id, bob.id, "PENDING");
  console.log("  B offline: 2 messages persisted as PENDING (m1 older than m2)");

  const bConn2 = await connect(INSTANCE_2, bob.id, bob.username);
  const first = await waitFor(bConn2, (m) => m.type === "message" && m.payload.content === "backlog one", "backlog one");
  const second = await waitFor(bConn2, (m) => m.type === "message" && m.payload.content === "backlog two", "backlog two");
  console.log(`  PASS — B reconnected and received backlog in order: "${first.payload.content}" → "${second.payload.content}"`);

  await sleep(500);
  const statuses = await pool.query(
    `SELECT status FROM message_status WHERE user_id = $1 AND message_id IN ($2, $3)`,
    [bob.id, m1.id, m2.id]
  );
  const allDelivered = statuses.rows.every((r) => r.status === "DELIVERED");
  console.log(`  PASS — backlog rows batch-marked DELIVERED: ${statuses.rows.map((r) => r.status).join(", ")}`);

  console.log("\n== RESULT ==");
  console.log(allDelivered ? "LIVE DELIVERY + BACKLOG FLUSH: both confirmed" : "FAILURE — statuses not DELIVERED");
} catch (err) {
  console.error("\nDEMO FAILED:", err);
  exitCode = 1;
} finally {
  if (alice) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[alice.id, bob.id]]).catch(() => {});
  }
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(exitCode);
}
