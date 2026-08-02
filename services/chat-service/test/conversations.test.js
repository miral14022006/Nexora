import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";

const SECRET = "dev-internal-secret";
const headers = (userId, username = "tester") => ({
  "X-Nexora-Internal-Secret": SECRET,
  "X-Nexora-User-Id": userId,
  "X-Nexora-Username": username,
});

const app = createApp({
  publishMessageEvent: () => {},
  publishReadReceipt: () => {},
});

let alice, bob, carol, groupId;

// messages.sequence_no has no DB default (chat-service assigns it), so test
// fixtures supply a monotonic value.
let seq = 0;

async function send(type, senderId, recipientId, groupId, content, createdAt) {
  const result = await pool.query(
    `INSERT INTO messages (type, sender_id, recipient_id, group_id, content, sequence_no, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, sender_id, recipient_id, group_id, content, created_at`,
    [type, senderId, recipientId ?? null, groupId ?? null, content, ++seq, createdAt]
  );
  return result.rows[0];
}

beforeAll(async () => {
  await initDb();

  const salt = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ["alice", "bob", "carol"].map((name) =>
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
    [`conv group ${Date.now()}`, alice.id]
  );
  groupId = group.rows[0].id;
  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role)
     VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
    [groupId, alice.id, bob.id]
  );

  const t0 = Date.now();
  await send("DIRECT", bob.id, alice.id, null, "old from bob", new Date(t0 - 3000));
  await send("DIRECT", alice.id, bob.id, null, "latest from alice", new Date(t0 - 2000));
  await send("DIRECT", bob.id, alice.id, null, "unread from bob", new Date(t0 - 1000));
  await send("GROUP", bob.id, null, groupId, "group hello", new Date(t0 - 500));
  await send("GROUP", alice.id, null, groupId, "group reply", new Date(t0));
});

afterAll(async () => {
  await pool.query("DELETE FROM messages WHERE sender_id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await pool.query("DELETE FROM message_status WHERE user_id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await pool.query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await pool.end();
});

describe("GET /conversations", () => {
  it("returns direct and group conversations sorted by latest activity", async () => {
    const res = await request(app)
      .get("/conversations")
      .set(headers(alice.id, alice.username));

    expect(res.status).toBe(200);

    const direct = res.body.conversations.find((c) => c.type === "DIRECT");
    expect(direct).toMatchObject({
      userId: bob.id,
      name: bob.username,
    });
    expect(direct.lastMessage).toMatchObject({
      content: "unread from bob",
      senderId: bob.id,
    });

    const group = res.body.conversations.find((c) => c.type === "GROUP");
    expect(group).toMatchObject({ groupId, name: group.name ?? expect.any(String) });
    expect(group.lastMessage.content).toBe("group reply");

    expect(res.body.conversations[0].type).toBe("GROUP");
  });

  it("counts unread messages per conversation", async () => {
    const res = await request(app)
      .get("/conversations")
      .set(headers(alice.id, alice.username));

    const direct = res.body.conversations.find((c) => c.type === "DIRECT");
    expect(direct.unread).toBe(2);

    const group = res.body.conversations.find((c) => c.type === "GROUP");
    expect(group.unread).toBe(1);
  });

  it("drops unread counts once the reader marks messages as read", async () => {
    const messages = await pool.query(
      `SELECT id FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`,
      [bob.id, alice.id]
    );
    for (const row of messages.rows) {
      await pool.query(
        `INSERT INTO message_status (message_id, user_id, status, read_at)
         VALUES ($1, $2, 'READ', now())`,
        [row.id, alice.id]
      );
    }

    const res = await request(app)
      .get("/conversations")
      .set(headers(alice.id, alice.username));
    const direct = res.body.conversations.find((c) => c.type === "DIRECT");
    expect(direct.unread).toBe(0);
  });

  it("includes groups with no messages yet", async () => {
    const empty = await pool.query(
      `INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id`,
      [`empty group ${Date.now()}`, bob.id]
    );
    await pool.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
      [empty.rows[0].id, alice.id]
    );

    const res = await request(app)
      .get("/conversations")
      .set(headers(alice.id, alice.username));
    const found = res.body.conversations.find((c) => c.groupId === empty.rows[0].id);
    expect(found).toMatchObject({ lastMessage: null, unread: 0 });

    await pool.query("DELETE FROM group_members WHERE group_id = $1", [
      empty.rows[0].id,
    ]);
    await pool.query("DELETE FROM groups WHERE id = $1", [empty.rows[0].id]);
  });

  it("excludes groups the caller does not belong to", async () => {
    const res = await request(app)
      .get("/conversations")
      .set(headers(carol.id, carol.username));
    expect(res.body.conversations).toHaveLength(0);
  });

  it("requires the internal secret", async () => {
    const res = await request(app)
      .get("/conversations")
      .set("X-Nexora-User-Id", alice.id);
    expect(res.status).toBe(403);
  });
});
