import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";
import { connectRedis, presenceKey, redis } from "../src/redis.js";
import { handleMessageCreated } from "../src/notifications.js";

const logged = [];
const deps = {
  pool,
  isOnline: async (userId) => (await redis.exists(presenceKey(userId))) === 1,
  log: (message) => logged.push(message),
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
    [`notif test group ${Date.now()}`, alice.id]
  );
  groupId = group.rows[0].id;
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role)
     VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [groupId, alice.id, bob.id, carol.id]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await redis.quit();
  await pool.end();
});

describe("handleMessageCreated (push stub decision)", () => {
  it("logs a PUSH STUB for an offline DIRECT recipient", async () => {
    await redis.del(presenceKey(bob.id));
    logged.length = 0;
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });

    await handleMessageCreated(event, deps);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("PUSH STUB");
    expect(logged[0]).toContain(bob.id);
    expect(logged[0]).toContain(event.messageId);
    expect(logged[0]).toContain("APNs/FCM");
  });

  it("does not push for an online DIRECT recipient", async () => {
    await redis.set(presenceKey(bob.id), "online", { EX: 60 });
    logged.length = 0;
    const event = eventFor({ senderId: alice.id, recipientId: bob.id });

    await handleMessageCreated(event, deps);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("skip");
    expect(logged[0]).not.toContain("PUSH STUB");
  });

  it("GROUP: stubs offline members, skips online members", async () => {
    await redis.set(presenceKey(bob.id), "online", { EX: 60 });
    await redis.del(presenceKey(carol.id));
    logged.length = 0;
    const event = eventFor({
      senderId: alice.id,
      type: "GROUP",
      recipientId: null,
      groupId,
    });

    await handleMessageCreated(event, deps);

    const stubs = logged.filter((l) => l.includes("PUSH STUB"));
    const skips = logged.filter((l) => l.includes("skip"));
    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toContain(carol.id);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain(bob.id);
  });

  it("ignores recipients that no longer exist (backfill replay)", async () => {
    const deleted = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [`ghost_${Date.now()}`, `ghost_${Date.now()}@nexora.dev`, "hash"]
    );
    await pool.query("DELETE FROM users WHERE id = $1", [deleted.rows[0].id]);
    logged.length = 0;
    const event = eventFor({ senderId: alice.id, recipientId: deleted.rows[0].id });

    await handleMessageCreated(event, deps);

    expect(logged).toHaveLength(0);
  });
});
