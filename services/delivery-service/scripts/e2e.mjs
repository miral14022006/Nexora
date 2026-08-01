/**
 * Full-stack realtime proof (runs inside the delivery-service container):
 *
 *   chat-service HTTP POST → Kafka message-events → delivery-service
 *   → (recipient online) Redis deliver channel → websocket-gateway → socket
 *
 *   B connected on gateway instance 2:
 *   1. A POSTs a message via chat-service → B receives it LIVE (no instance
 *      knowledge anywhere in the delivery path).
 *   2. message_status advances PENDING → DELIVERED via the gateway's
 *      "delivered" receipt (live fast-path).
 *   3. B disconnects; A posts again → status stays PENDING.
 *   4. B reconnects → gateway flushes the backlog → DELIVERED.
 *   5. B acks → READ (via gateway receipt + delivery-service).
 *
 * Run:  docker compose exec delivery-service node scripts/e2e.mjs
 */
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";
import { connectRedis, redis } from "../src/redis.js";

const SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-only-access-secret";
const SERVICE_SECRET = process.env.SERVICE_SECRET ?? "dev-internal-secret";
const CHAT_URL = process.env.CHAT_URL ?? "http://chat-service:3004";
const GATEWAY = process.env.GATEWAY_URL ?? "ws://websocket-gateway:3008/ws";
const GATEWAY_2 = process.env.GATEWAY_2_URL ?? "ws://websocket-gateway-2:3009/ws";

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
      if (env.type === "message") {
        console.log(`      B socket <-- ${JSON.stringify(env.payload).slice(0, 140)}`);
      }
    });
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, messages });
    });
    ws.on("error", reject);
  });
}

const waitFor = (conn, predicate, label, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const hit = conn.messages.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) {
        return reject(new Error(`timeout waiting for ${label}`));
      }
      setTimeout(poll, 100);
    };
    poll();
  });

const pollStatus = async (messageId, userId, expected, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [messageId, userId]
    );
    if (row.rows[0]?.status === expected) return expected;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for status ${expected} on ${messageId}`);
};

async function postMessage(senderId, username, body) {
  const res = await fetch(`${CHAT_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Nexora-Internal-Secret": SERVICE_SECRET,
      "X-Nexora-User-Id": senderId,
      "X-Nexora-Username": username,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat-service POST failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log(`  chat-service: message persisted (${data.message.id.slice(0, 8)}…), event published to Kafka`);
  return data.message;
}

let alice, bob, exitCode = 0;

try {
  await initDb();
  await connectRedis();

  const stamp = Date.now();
  const users = await Promise.all(
    [
      ["e2e_alice", `e2e_alice_${stamp}@nexora.dev`],
      ["e2e_bob", `e2e_bob_${stamp}@nexora.dev`],
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

  console.log("== 1. LIVE: A posts while B is connected (B on gateway instance 2) ==");
  const bConn = await connect(GATEWAY_2, bob.id, bob.username);
  await waitFor(bConn, (m) => m.type === "presence", "B presence");

  const live = await postMessage(alice.id, alice.username, {
    type: "DIRECT",
    recipientId: bob.id,
    content: "e2e live message",
  });
  await waitFor(bConn, (m) => m.type === "message" && m.payload.id === live.id, "live message on B socket");
  console.log("  PASS — B received the message live");
  await pollStatus(live.id, bob.id, "DELIVERED");
  console.log("  PASS — status advanced to DELIVERED (gateway live receipt → delivery-service)");

  console.log("\n== 2. OFFLINE: B disconnects, message stays PENDING ==");
  bConn.ws.close();
  await new Promise((r) => setTimeout(r, 400));

  const pending = await postMessage(alice.id, alice.username, {
    type: "DIRECT",
    recipientId: bob.id,
    content: "e2e while B was offline",
  });
  await pollStatus(pending.id, bob.id, "PENDING");
  console.log("  PASS — status stayed PENDING while B was offline");

  console.log("\n== 3. RECONNECT: B gets the backlog, then acks to READ ==");
  const bConn2 = await connect(GATEWAY_2, bob.id, bob.username);
  const backlog = await waitFor(bConn2, (m) => m.type === "message" && m.payload.id === pending.id, "backlog message on B socket");
  console.log(`  PASS — B reconnected and received the backlog: "${backlog.payload.content}"`);
  await pollStatus(pending.id, bob.id, "DELIVERED");
  console.log("  PASS — backlog flush batch-marked DELIVERED");

  bConn2.ws.send(JSON.stringify({ type: "ack", payload: { messageId: pending.id } }));
  await pollStatus(pending.id, bob.id, "READ");
  console.log("  PASS — ack advanced status to READ (gateway receipt → delivery-service)");

  console.log("\n== RESULT: full pipeline chat → Kafka → delivery → gateway confirmed ==");
} catch (err) {
  console.error("\nE2E FAILED:", err.message);
  exitCode = 1;
} finally {
  if (alice) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[alice.id, bob.id]]).catch(() => {});
  }
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(exitCode);
}
