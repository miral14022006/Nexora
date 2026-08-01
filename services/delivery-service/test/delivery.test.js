import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";
import {
  connectRedis,
  deliverChannel,
  presenceKey,
  pubsub,
  redis,
} from "../src/redis.js";
import { handleMessageCreated, handleReceipt } from "../src/delivery.js";

// Recording Kafka stand-in (real Kafka covered by the live e2e script).
const sentEvents = [];
const publishReceiptEvent = async (eventType, messageId, userId) => {
  sentEvents.push({ eventType, messageId, userId });
};

const deps = {
  pool,
  isOnline: async (userId) => (await redis.exists(presenceKey(userId))) === 1,
  publishDeliver: async (userId, envelope) =>
    redis.publish(deliverChannel(userId), JSON.stringify(envelope)),
  publishReceiptEvent,
};

const eventFor = (overrides = {}) => ({
  eventType: "message.created",
  messageId: crypto.randomUUID(),
  senderId: "00000000-0000-0000-0000-000000000000",
  type: "DIRECT",
  recipientId: "00000000-0000-0000-0000-000000000000",
  groupId: null,
  content: "hello",
  createdAt: new Date().toISOString(),
  ...overrides,
});

// Mirrors chat-service: the message row exists before the event is consumed.
async function insertMessage(event) {
  await pool.query(
    `INSERT INTO messages (id, type, sender_id, recipient_id, group_id, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.messageId,
      event.type,
      event.senderId,
      event.recipientId,
      event.groupId,
      event.content,
    ]
  );
}

async function subscribeDeliverInTest(userId) {
  const messages = [];
  await pubsub.subscribe(deliverChannel(userId), (msg) => {
    messages.push(JSON.parse(msg));
  });
  return messages;
}

async function waitFor(messages, predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = messages.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

let alice, bob, carol, groupId;

beforeAll(async () => {
  await initDb();
  await connectRedis();

  const users = await Promise.all(
    ["alice", "bob", "carol"].map((name, i) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [`${name}_${Date.now()}`, `${name}_${Date.now()}@nexora.dev`, "hash"]
      )
    )
  );
  alice = users[0].rows[0];
  bob = users[1].rows[0];
  carol = users[2].rows[0];

  const group = await pool.query(
    `INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [`delivery test group ${Date.now()}`, alice.id]
  );
  groupId = group.rows[0].id;
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role)
     VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [groupId, alice.id, bob.id, carol.id]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM message_status WHERE user_id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await pool.query("DELETE FROM messages WHERE sender_id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await pool.query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await pubsub.quit();
  await redis.quit();
  await pool.end();
});

describe("handleMessageCreated (message-events consumer)", () => {
  it("writes a PENDING row and live-publishes when the recipient is online", async () => {
    await redis.set(presenceKey(bob.id), "online", { EX: 60 });
    const bobChannel = await subscribeDeliverInTest(bob.id);
    const event = eventFor({ senderId: alice.id, recipientId: bob.id, content: "live!" });
    await insertMessage(event);

    await handleMessageCreated(event, deps);

    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(row.rows[0].status).toBe("PENDING");

    const live = await waitFor(bobChannel, (m) => m.payload?.id === event.messageId, "live envelope");
    expect(live).toMatchObject({
      type: "message",
      payload: {
        id: event.messageId,
        type: "DIRECT",
        senderId: alice.id,
        recipientId: bob.id,
        content: "live!",
      },
    });
  });

  it("writes a PENDING row but does not live-publish when the recipient is offline", async () => {
    await redis.del(presenceKey(bob.id));
    const bobChannel = await subscribeDeliverInTest(bob.id);
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });
    await insertMessage(event);

    await handleMessageCreated(event, deps);

    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(row.rows[0].status).toBe("PENDING");

    await new Promise((r) => setTimeout(r, 300));
    expect(bobChannel.filter((m) => m.payload?.id === event.messageId)).toHaveLength(0);
  });

  it("fans a GROUP message out to all members except the sender", async () => {
    await redis.set(presenceKey(bob.id), "online", { EX: 60 });
    const bobChannel = await subscribeDeliverInTest(bob.id);
    const event = eventFor({
      senderId: alice.id,
      type: "GROUP",
      recipientId: null,
      groupId,
      content: "group message",
    });
    await insertMessage(event);

    await handleMessageCreated(event, deps);

    const rows = await pool.query(
      `SELECT user_id, status FROM message_status WHERE message_id = $1`,
      [event.messageId]
    );
    const userIds = rows.rows.map((r) => r.user_id).sort();
    expect(userIds).toEqual([bob.id, carol.id].sort());
    expect(rows.rows.every((r) => r.status === "PENDING")).toBe(true);

    const live = await waitFor(bobChannel, (m) => m.payload?.id === event.messageId, "group live envelope");
    expect(live.payload.groupId).toBe(groupId);
  });

  it("does not re-publish on Kafka redelivery once the message was delivered", async () => {
    await redis.set(presenceKey(bob.id), "online", { EX: 60 });
    const bobChannel = await subscribeDeliverInTest(bob.id);
    const event = eventFor({ senderId: alice.id, recipientId: bob.id, content: "redelivered" });
    await insertMessage(event);

    await handleMessageCreated(event, deps);
    await waitFor(bobChannel, (m) => m.payload?.id === event.messageId, "first live envelope");

    // The gateway pushed the envelope and recorded the socket-level receipt.
    await pool.query(
      `UPDATE message_status SET status = 'DELIVERED' WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );

    await handleMessageCreated(event, deps); // Kafka redelivers the event

    const rows = await pool.query(
      `SELECT COUNT(*)::int AS n FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(rows.rows[0].n).toBe(1);

    await new Promise((r) => setTimeout(r, 300));
    expect(bobChannel.filter((m) => m.payload?.id === event.messageId)).toHaveLength(1);
  });

  it("re-pushes on redelivery when the row is still PENDING (crash before the push)", async () => {
    await redis.set(presenceKey(bob.id), "online", { EX: 60 });
    const bobChannel = await subscribeDeliverInTest(bob.id);
    const event = eventFor({ senderId: alice.id, recipientId: bob.id, content: "crash-recovery" });
    await insertMessage(event);

    // A previous attempt inserted the row but crashed before live-publishing.
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status)
       SELECT $1, u.id, 'PENDING' FROM users u WHERE u.id = $2`,
      [event.messageId, bob.id]
    );

    await handleMessageCreated(event, deps); // the redelivered attempt

    const live = await waitFor(bobChannel, (m) => m.payload?.id === event.messageId, "recovery live envelope");
    expect(live.payload.content).toBe("crash-recovery");

    await new Promise((r) => setTimeout(r, 300));
    expect(bobChannel.filter((m) => m.payload?.id === event.messageId)).toHaveLength(1);
  });
});

describe("handleReceipt (gateway receipts)", () => {
  it("delivered receipt: PENDING → DELIVERED + chat.message.delivered event", async () => {
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });
    await pool.query(
      `INSERT INTO messages (id, type, sender_id, recipient_id, content)
       VALUES ($1, 'DIRECT', $2, $3, $4)`,
      [event.messageId, alice.id, bob.id, event.content]
    );
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status) VALUES ($1, $2, 'PENDING')`,
      [event.messageId, bob.id]
    );
    const sent = sentEvents.length;

    await handleReceipt({ type: "delivered", messageId: event.messageId, userId: bob.id }, deps);

    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(row.rows[0].status).toBe("DELIVERED");
    expect(sentEvents[sentEvents.length - 1]).toEqual({
      eventType: "message.delivered",
      messageId: event.messageId,
      userId: bob.id,
    });
    expect(sentEvents.length).toBe(sent + 1);
  });

  it("read receipt: DELIVERED → READ + chat.message.read event", async () => {
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });
    await pool.query(
      `INSERT INTO messages (id, type, sender_id, recipient_id, content)
       VALUES ($1, 'DIRECT', $2, $3, $4)`,
      [event.messageId, alice.id, bob.id, event.content]
    );
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status) VALUES ($1, $2, 'DELIVERED')`,
      [event.messageId, bob.id]
    );

    await handleReceipt({ type: "read", messageId: event.messageId, userId: bob.id }, deps);

    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(row.rows[0].status).toBe("READ");
    expect(sentEvents[sentEvents.length - 1].eventType).toBe("message.read");
  });

  it("delivered receipt never downgrades a READ row (and emits no live tick)", async () => {
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });
    await pool.query(
      `INSERT INTO messages (id, type, sender_id, recipient_id, content)
       VALUES ($1, 'DIRECT', $2, $3, $4)`,
      [event.messageId, alice.id, bob.id, event.content]
    );
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status) VALUES ($1, $2, 'READ')`,
      [event.messageId, bob.id]
    );

    const delChannel = await subscribeDeliverInTest(alice.id);
    await handleReceipt({ type: "delivered", messageId: event.messageId, userId: bob.id }, deps);

    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(row.rows[0].status).toBe("READ");

    // The stored state is safe; the sender must also NOT receive a stale
    // "delivered" tick that would regress the ✓✓ read ticks in the UI.
    await new Promise((r) => setTimeout(r, 300));
    expect(
      delChannel.some(
        (m) =>
          m.type === "delivery_update" &&
          m.payload?.messageId === event.messageId &&
          m.payload?.status === "DELIVERED"
      )
    ).toBe(false);
  });

  it("read receipt on a PENDING row jumps straight to READ (forward-only rank)", async () => {
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });
    await pool.query(
      `INSERT INTO messages (id, type, sender_id, recipient_id, content)
       VALUES ($1, 'DIRECT', $2, $3, $4)`,
      [event.messageId, alice.id, bob.id, event.content]
    );
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status) VALUES ($1, $2, 'PENDING')`,
      [event.messageId, bob.id]
    );

    // Out-of-order processing: the read receipt lands before any delivered
    // receipt. READ(3) > PENDING(0), so the row advances — it is never lost.
    await handleReceipt({ type: "read", messageId: event.messageId, userId: bob.id }, deps);

    const row = await pool.query(
      `SELECT status, read_at FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(row.rows[0].status).toBe("READ");
    expect(row.rows[0].read_at).toBeTruthy();
  });

  it("duplicate delivered receipts are idempotent", async () => {
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });
    await pool.query(
      `INSERT INTO messages (id, type, sender_id, recipient_id, content)
       VALUES ($1, 'DIRECT', $2, $3, $4)`,
      [event.messageId, alice.id, bob.id, event.content]
    );
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status) VALUES ($1, $2, 'PENDING')`,
      [event.messageId, bob.id]
    );

    await handleReceipt({ type: "delivered", messageId: event.messageId, userId: bob.id }, deps);
    await handleReceipt({ type: "delivered", messageId: event.messageId, userId: bob.id }, deps);

    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [event.messageId, bob.id]
    );
    expect(row.rows[0].status).toBe("DELIVERED");
  });
});

describe("handleReceipt live delivery ticks", () => {
  it("pushes a delivery_update to the DIRECT sender when the message is read", async () => {
    await redis.set(presenceKey(alice.id), "online", { EX: 60 });
    const aliceChannel = await subscribeDeliverInTest(alice.id);
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });
    await pool.query(
      `INSERT INTO messages (id, type, sender_id, recipient_id, content)
       VALUES ($1, 'DIRECT', $2, $3, $4)`,
      [event.messageId, alice.id, bob.id, event.content]
    );
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status) VALUES ($1, $2, 'DELIVERED')`,
      [event.messageId, bob.id]
    );

    await handleReceipt({ type: "read", messageId: event.messageId, userId: bob.id }, deps);

    const tick = await waitFor(
      aliceChannel,
      (m) => m.type === "delivery_update" && m.payload?.messageId === event.messageId,
      "delivery tick"
    );
    expect(tick.payload).toMatchObject({
      messageId: event.messageId,
      userId: bob.id,
      status: "READ",
      conversationType: "DIRECT",
      recipientId: bob.id,
    });
    expect(tick.payload.readAt).toBeTruthy();
  });

  it("pushes delivery_update to every other member for GROUP messages", async () => {
    await redis.set(presenceKey(alice.id), "online", { EX: 60 });
    await redis.set(presenceKey(bob.id), "online", { EX: 60 });
    await redis.set(presenceKey(carol.id), "online", { EX: 60 });
    const aliceChannel = await subscribeDeliverInTest(alice.id);
    const bobChannel = await subscribeDeliverInTest(bob.id);
    const carolChannel = await subscribeDeliverInTest(carol.id);
    const event = eventFor({
      senderId: alice.id,
      type: "GROUP",
      recipientId: null,
      groupId,
      content: "group read test",
    });
    await pool.query(
      `INSERT INTO messages (id, type, sender_id, recipient_id, group_id, content)
       VALUES ($1, 'GROUP', $2, NULL, $3, $4)`,
      [event.messageId, alice.id, groupId, event.content]
    );
    await pool.query(
      `INSERT INTO message_status (message_id, user_id, status)
       VALUES ($1, $2, 'DELIVERED'), ($1, $3, 'DELIVERED')`,
      [event.messageId, bob.id, carol.id]
    );

    // bob reads it; alice (sender) and carol should get the tick, bob not.
    await handleReceipt({ type: "read", messageId: event.messageId, userId: bob.id }, deps);

    for (const [label, channel] of [["alice", aliceChannel], ["carol", carolChannel]]) {
      const tick = await waitFor(
        channel,
        (m) => m.type === "delivery_update" && m.payload?.messageId === event.messageId,
        `${label} tick`
      );
      expect(tick.payload).toMatchObject({
        status: "READ",
        userId: bob.id,
        conversationType: "GROUP",
        groupId,
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(bobChannel.filter((m) => m.type === "delivery_update")).toHaveLength(0);
  });

  it("does not push ticks when the message is unknown", async () => {
    const aliceChannel = await subscribeDeliverInTest(alice.id);
    await redis.set(presenceKey(alice.id), "online", { EX: 60 });
    const sent = sentEvents.length;

    await handleReceipt(
      { type: "read", messageId: crypto.randomUUID(), userId: bob.id },
      deps
    );

    expect(sentEvents.length).toBe(sent + 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(aliceChannel.filter((m) => m.type === "delivery_update")).toHaveLength(0);
  });
});
