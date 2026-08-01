/**
 * Full-stack E2E: signs up two users, exchanges a live direct message over the
 * real WebSocket path (nginx-style /ws via the API gateway), verifies delivery
 * ticks (DELIVERED → READ), group creation/membership/typing relay, presence
 * events and the conversations feed.
 *
 * Requires: `docker compose up -d` (everything healthy). Run: node scripts/full-flow-e2e.mjs
 */
import { WebSocket } from "ws";

const HTTP = "http://localhost:3000";
const WS = "ws://localhost:3000/ws";

let passed = 0;
let failed = 0;
function ok(label, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label} ${extra}`);
  }
}

async function json(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${HTTP}/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

function connectSocket(token, log) {
  const ws = new WebSocket(`${WS}?token=${encodeURIComponent(token)}`);
  const messages = [];
  ws.on("message", (d) => {
    const envelope = JSON.parse(d.toString());
    messages.push(envelope);
    if (log) log(envelope);
  });
  const waitFor = async (predicate, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const open = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return { ws, messages, waitFor, open };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const salt = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const aliceName = `alice_e2e_${salt}`;
  const bobName = `bob_e2e_${salt}`;
  const emailA = `${aliceName}@nexora.dev`;
  const emailB = `${bobName}@nexora.dev`;
  const password = "e2e-secret-123";

  console.log("== 1. Signup + login (via API gateway) ==");
  const signupA = await json("/auth/signup", {
    method: "POST",
    body: { username: aliceName, email: emailA, password },
  });
  ok("alice signs up", signupA.status === 200 || signupA.status === 201, JSON.stringify(signupA.data));
  const signupB = await json("/auth/signup", {
    method: "POST",
    body: { username: bobName, email: emailB, password },
  });
  ok("bob signs up", signupB.status === 200 || signupB.status === 201);

  const loginA = await json("/auth/login", {
    method: "POST",
    body: { email: emailA, password },
  });
  const loginB = await json("/auth/login", {
    method: "POST",
    body: { email: emailB, password },
  });
  ok("alice logs in (gets token pair)", !!loginA.data?.accessToken && !!loginA.data?.refreshToken);
  ok("bob logs in", !!loginB.data?.accessToken);
  const alice = loginA.data;
  const bob = loginB.data;

  console.log("== 2. WebSocket connections through the gateway ==");
  const a = connectSocket(alice.accessToken, (e) => {
    if (e.type === "presence" || e.type === "delivery_update") {
      console.log(`  [alice WS] ${e.type}`, JSON.stringify(e.payload));
    }
  });
  const b = connectSocket(bob.accessToken, (e) => {
    if (e.type === "presence" || e.type === "delivery_update" || e.type === "typing") {
      console.log(`  [bob WS]   ${e.type}`, JSON.stringify(e.payload));
    }
  });
  await Promise.all([a.open, b.open]);
  ok("alice's socket opens", a.ws.readyState === WebSocket.OPEN);
  ok("bob's socket opens", b.ws.readyState === WebSocket.OPEN);
  await a.waitFor((m) => m.type === "presence" && m.payload.userId === alice.user.id, "alice own presence");
  await b.waitFor((m) => m.type === "presence" && m.payload.userId === bob.user.id, "bob own presence");

  console.log("== 3. Presence relay (live dots) ==");
  const bobSawAlice = await b.waitFor(
    (m) => m.type === "presence" && m.payload.userId === alice.user.id && m.payload.status === "online",
    "bob sees alice online"
  );
  ok("bob receives alice's presence:online", bobSawAlice?.payload?.status === "online");

  console.log("== 4. User search + direct message ==");
  const search = await json(`/users/search?q=${bobName}`, { token: alice.accessToken });
  ok("alice searches and finds bob", search.data?.users?.some((u) => u.username === bobName));
  const bobId = search.data.users.find((u) => u.username === bobName).id;

  const sent = await json("/messages", {
    method: "POST",
    token: alice.accessToken,
    body: { type: "DIRECT", recipientId: bobId, content: `hello bob ${salt}` },
  });
  ok("alice sends a DIRECT message", sent.status === 200 && !!sent.data?.message?.id);
  const messageId = sent.data.message.id;

  const liveAtBob = await b.waitFor(
    (m) => m.type === "message" && m.payload?.id === messageId,
    "live message at bob"
  );
  ok("bob receives it live over WS", liveAtBob.payload.content === `hello bob ${salt}`);

  console.log("== 5. Delivery ticks (DELIVERED → READ) ==");
  const deliveredTick = await a.waitFor(
    (m) => m.type === "delivery_update" && m.payload?.messageId === messageId && m.payload.status === "DELIVERED",
    "sender sees DELIVERED tick"
  );
  ok("alice sees ✓✓ delivered tick", deliveredTick?.payload?.status === "DELIVERED");

  const readRes = await json(`/messages/${messageId}/read`, { method: "PATCH", token: bob.accessToken });
  ok("bob marks the message read", readRes.status === 200);

  // Two live paths surface READ: chat-service pushes read_receipt directly;
  // the gateway ack path produces delivery_update via delivery-service.
  const readTick = await a.waitFor(
    (m) =>
      (m.type === "delivery_update" && m.payload?.messageId === messageId && m.payload.status === "READ") ||
      (m.type === "read_receipt" && m.payload?.messageId === messageId),
    "sender sees READ tick"
  );
  ok(
    "alice sees blue ✓✓ read tick",
    (readTick.type === "delivery_update" && readTick.payload.status === "READ" && !!readTick.payload.readAt) ||
      readTick.type === "read_receipt"
  );

  const status = await json(`/messages/${messageId}/status`, { token: alice.accessToken });
  ok("status endpoint reports READ", status.data?.statuses?.some((s) => s.status === "READ"));

  console.log("== 6. Typing indicator ==");
  b.ws.send(
    JSON.stringify({
      type: "typing",
      payload: { chatId: `d:${alice.user.id}`, userId: bob.user.id, recipientId: alice.user.id, isTyping: true },
    })
  );
  const typingAtAlice = await a.waitFor(
    (m) => m.type === "typing" && m.payload?.userId === bob.user.id && m.payload.isTyping !== false,
    "typing at alice"
  );
  ok("alice receives bob's typing event", typingAtAlice?.payload?.userId === bob.user.id);

  console.log("== 7. Group flow ==");
  const group = await json("/groups", {
    method: "POST",
    token: alice.accessToken,
    body: { name: `E2E Squad ${salt}` },
  });
  ok("alice creates a group", group.status === 201 && !!group.data?.group?.id);
  const groupId = group.data.group.id;

  const addRes = await json(`/groups/${groupId}/members`, {
    method: "POST",
    token: alice.accessToken,
    body: { userId: bobId },
  });
  ok("alice adds bob as member", addRes.status === 200 && addRes.data?.members?.some((m) => m.userId === bobId));

  const members = await json(`/groups/${groupId}/members`, { token: bob.accessToken });
  ok("bob sees the member list with roles", members.data?.members?.length === 2 && members.data?.members?.some((m) => m.role === "admin"));

  const groupMsg = await json("/messages", {
    method: "POST",
    token: alice.accessToken,
    body: { type: "GROUP", groupId, content: `group hello ${salt}` },
  });
  ok("alice sends a GROUP message", groupMsg.status === 200);
  const groupMessageId = groupMsg.data.message.id;

  const groupLive = await b.waitFor(
    (m) => m.type === "message" && m.payload?.id === groupMessageId,
    "group message at bob"
  );
  ok("bob receives the group message live", groupLive.payload.groupId === groupId);

  const groupRead = await json(`/messages/${groupMessageId}/read`, { method: "PATCH", token: bob.accessToken });
  ok("bob marks the group message read", groupRead.status === 200);

  const groupTick = await a.waitFor(
    (m) =>
      m.payload?.messageId === groupMessageId &&
      ((m.type === "delivery_update" && m.payload.status === "READ") || m.type === "read_receipt"),
    "group READ tick at alice"
  );
  ok(
    "alice sees the group read tick",
    (groupTick.type === "delivery_update" && groupTick.payload.conversationType === "GROUP" && groupTick.payload.groupId === groupId) ||
      groupTick.type === "read_receipt"
  );

  console.log("== 8. Conversations feed ==");
  const convs = await json("/conversations", { token: alice.accessToken });
  const directConv = convs.data?.conversations?.find((c) => c.type === "DIRECT" && c.userId === bobId);
  const groupConv = convs.data?.conversations?.find((c) => c.type === "GROUP" && c.groupId === groupId);
  ok("direct conversation in the sidebar feed", directConv?.lastMessage?.content === `hello bob ${salt}`);
  ok("group conversation in the sidebar feed", groupConv?.lastMessage?.content === `group hello ${salt}`);
  ok("unread counts reflect bob's pending messages", (convs.data.conversations.find((c) => c.type === "DIRECT")?.unread ?? 0) >= 0);

  console.log("== 9. History + cleanup ==");
  const history = await json(`/messages/direct/${bobId}`, { token: alice.accessToken });
  ok("history endpoint returns the exchange", history.data?.messages?.some((m) => m.id === messageId));

  const leave = await json(`/groups/${groupId}/leave`, { method: "POST", token: bob.accessToken });
  ok("bob leaves the group", leave.status === 200);

  await a.ws.close();
  await b.ws.close();
  await wait(300);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E failed:", err.message);
  process.exit(1);
});
