/**
 * E2E confirmation of read receipts + typing indicators (runs inside the
 * chat-service container):
 *
 *  1. A posts a GROUP message → B (connected on gateway instance 2) gets it
 *     live via delivery-service.
 *  2. B marks it READ via PATCH /messages/:id/read → A's socket receives
 *     { type: "read_receipt" } in near-real-time (chat-service → Redis
 *     deliver channel → gateway instance 1 → A).
 *  3. GET /messages/:id/status shows per-user state + counts.
 *  4. A sends a typing envelope → B's socket receives it (pure Pub/Sub relay,
 *     no DB, no Kafka).
 *
 * Run:  docker compose exec chat-service node scripts/read-typing-e2e.mjs
 */
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";

const SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-only-access-secret";
const SERVICE_SECRET = process.env.SERVICE_SECRET ?? "dev-internal-secret";
const CHAT_URL = process.env.CHAT_URL ?? "http://chat-service:3004";
const GATEWAY_1 = process.env.GATEWAY_URL ?? "ws://websocket-gateway:3008/ws";
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
      if (env.type !== "presence") {
        console.log(`      ${username} socket <-- { type: "${env.type}" }`);
      }
    });
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, messages, username });
    });
    ws.on("error", reject);
  });
}

const waitFor = (conn, predicate, label, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const hit = conn.messages.find(predicate);
      if (hit) return resolve({ hit, latencyMs: Date.now() - deadline + timeoutMs });
      if (Date.now() > deadline) {
        return reject(new Error(`timeout waiting for ${label}`));
      }
      setTimeout(poll, 50);
    };
    poll();
  });

async function api(userId, username, method, path, body) {
  const res = await fetch(`${CHAT_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Nexora-Internal-Secret": SERVICE_SECRET,
      "X-Nexora-User-Id": userId,
      "X-Nexora-Username": username,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

let alice, bob, carol, groupId, exitCode = 0;

try {
  await initDb();

  const salt = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ["e2e_a", "e2e_b", "e2e_c"].map((name, i) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [`${name}_${salt}`, `${name}_${salt}@nexora.dev`, "hash"]
      )
    )
  );
  alice = users[0].rows[0];
  bob = users[1].rows[0];
  carol = users[2].rows[0];

  const group = await pool.query(
    `INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [`e2e group ${salt}`, alice.id]
  );
  groupId = group.rows[0].id;
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role)
     VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [groupId, alice.id, bob.id, carol.id]
  );

  console.log("== 1. LIVE GROUP MESSAGE (A on gateway 1, B on gateway 2) ==");
  const aConn = await connect(GATEWAY_1, alice.id, alice.username);
  const bConn = await connect(GATEWAY_2, bob.id, bob.username);
  await waitFor(aConn, (m) => m.type === "presence", "A presence");
  await waitFor(bConn, (m) => m.type === "presence", "B presence");

  const sent = await api(alice.id, alice.username, "POST", "/messages", {
    type: "GROUP",
    groupId,
    content: "read receipts, assemble",
  });
  const messageId = sent.message.id;
  await waitFor(bConn, (m) => m.type === "message" && m.payload.id === messageId, "live group message on B socket");
  console.log("  PASS — B received the group message live");

  console.log("\n== 2. B MARKS READ → read_receipt pushed to A's socket ==");
  const before = Date.now();
  await api(bob.id, bob.username, "PATCH", `/messages/${messageId}/read`);
  const receipt = await waitFor(
    aConn,
    (m) => m.type === "read_receipt" && m.payload.messageId === messageId,
    "read_receipt on A socket"
  );
  console.log(`  PASS — A received read_receipt (latency ${Date.now() - before}ms)`);
  console.log(`      payload: ${JSON.stringify(receipt.hit.payload)}`);

  console.log("\n== 3. GET /messages/:id/status reflects per-user state ==");
  const status = await api(alice.id, alice.username, "GET", `/messages/${messageId}/status`);
  const bobRow = status.statuses.find((s) => s.userId === bob.id);
  const carolRow = status.statuses.find((s) => s.userId === carol.id);
  console.log(`      counts: delivered ${status.counts.delivered}/${status.statuses.length}, read ${status.counts.read}`);
  console.log(`      bob: ${bobRow.status}${bobRow.readAt ? " (read_at set)" : ""} | carol: ${carolRow.status}`);
  if (bobRow.status !== "READ" || !bobRow.readAt || carolRow.status !== "PENDING") {
    throw new Error("status endpoint returned unexpected state");
  }
  console.log("  PASS — status endpoint reflects the read receipt correctly");

  console.log("\n== 4. TYPING: A types → B's socket (near-real-time, pure Pub/Sub) ==");
  const typingStart = Date.now();
  aConn.ws.send(
    JSON.stringify({
      type: "typing",
      payload: { chatId: groupId, userId: alice.id, recipientIds: [bob.id, carol.id] },
    })
  );
  await waitFor(bConn, (m) => m.type === "typing", "typing on B socket", 5000);
  console.log(`  PASS — B received typing indicator (latency ${Date.now() - typingStart}ms)`);

  console.log("\n== RESULT: read receipts + typing indicators confirmed end-to-end ==");
} catch (err) {
  console.error("\nE2E FAILED:", err.message);
  exitCode = 1;
} finally {
  if (alice) {
    await pool.query("DELETE FROM group_members WHERE group_id = $1", [groupId]).catch(() => {});
    await pool.query("DELETE FROM messages WHERE group_id = $1", [groupId]).catch(() => {});
    await pool.query("DELETE FROM groups WHERE id = $1", [groupId]).catch(() => {});
    await pool.query("DELETE FROM message_status WHERE user_id = ANY($1)", [
      [alice.id, bob.id, carol.id],
    ]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [
      [alice.id, bob.id, carol.id],
    ]).catch(() => {});
  }
  await pool.end().catch(() => {});
  process.exit(exitCode);
}
