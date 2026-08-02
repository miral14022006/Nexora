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

const publishedEvents = [];
const readReceipts = [];
const app = createApp({
  publishMessageEvent: (m) => publishedEvents.push(m),
  publishReadReceipt: (messageId, userId, targetUserIds) => {
    readReceipts.push({ messageId, userId, targetUserIds });
  },
});

let alice, bob, carol, groupId;

// messages.sequence_no has no DB default (chat-service assigns it), so test
// fixtures supply a monotonic value.
let seq = 0;

async function insertDirectMessage(senderId, recipientId, content = "read me") {
  const res = await pool.query(
    `INSERT INTO messages (type, sender_id, recipient_id, content, sequence_no)
     VALUES ('DIRECT', $1, $2, $3, $4) RETURNING id, type, sender_id, recipient_id, group_id`,
    [senderId, recipientId, content, ++seq]
  );
  return res.rows[0];
}

async function insertGroupMessage(senderId, content = "group read me") {
  const res = await pool.query(
    `INSERT INTO messages (type, sender_id, group_id, content, sequence_no)
     VALUES ('GROUP', $1, $2, $3, $4) RETURNING id, type, sender_id, recipient_id, group_id`,
    [senderId, groupId, content, ++seq]
  );
  return res.rows[0];
}

async function insertStatus(messageId, userId, status) {
  await pool.query(
    `INSERT INTO message_status (message_id, user_id, status, read_at)
     VALUES ($1, $2, $3::message_status_type, CASE WHEN $3 = 'READ' THEN now() END)
     ON CONFLICT (message_id, user_id)
     DO UPDATE SET status = EXCLUDED.status,
                   read_at = CASE WHEN EXCLUDED.status = 'READ' THEN now() ELSE NULL END`,
    [messageId, userId, status]
  );
}

beforeAll(async () => {
  await initDb();

  const salt = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ["alice", "bob", "carol"].map((name, i) =>
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
    [`read receipts group ${Date.now()}`, alice.id]
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
  await pool.query(
    "DELETE FROM messages WHERE sender_id = ANY($1) OR recipient_id = ANY($1)",
    [[alice.id, bob.id, carol.id]]
  );
  await pool.query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [
    [alice.id, bob.id, carol.id],
  ]);
  await pool.end();
});

describe("PATCH /messages/:id/read", () => {
  it("marks a DIRECT message READ, sets read_at, pushes a read_receipt to the sender", async () => {
    readReceipts.length = 0;
    const msg = await insertDirectMessage(alice.id, bob.id);
    await insertStatus(msg.id, bob.id, "DELIVERED");

    const res = await request(app)
      .patch(`/messages/${msg.id}/read`)
      .set(headers(bob.id, bob.username));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("READ");

    const row = await pool.query(
      `SELECT status, read_at FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [msg.id, bob.id]
    );
    expect(row.rows[0].status).toBe("READ");
    expect(row.rows[0].read_at).toBeTruthy();

    expect(readReceipts).toEqual([
      { messageId: msg.id, userId: bob.id, targetUserIds: [alice.id] },
    ]);
  });

  it("forbids the sender from marking their own DIRECT message read", async () => {
    const msg = await insertDirectMessage(alice.id, bob.id);
    const res = await request(app)
      .patch(`/messages/${msg.id}/read`)
      .set(headers(alice.id));

    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown message", async () => {
    const res = await request(app)
      .patch(`/messages/00000000-0000-0000-0000-000000000000/read`)
      .set(headers(bob.id));

    expect(res.status).toBe(404);
  });

  it("GROUP: marks read and pushes a read_receipt to every other member", async () => {
    readReceipts.length = 0;
    const msg = await insertGroupMessage(carol.id);
    await insertStatus(msg.id, bob.id, "DELIVERED");

    const res = await request(app)
      .patch(`/messages/${msg.id}/read`)
      .set(headers(bob.id, bob.username));

    expect(res.status).toBe(200);
    expect(readReceipts).toHaveLength(1);
    expect(readReceipts[0].messageId).toBe(msg.id);
    expect(readReceipts[0].userId).toBe(bob.id);
    expect(readReceipts[0].targetUserIds.sort()).toEqual([alice.id, carol.id].sort());
  });

  it("forbids non-members from marking a GROUP message read", async () => {
    const outsider = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [`outside_reader_${Date.now()}`, `outside_reader_${Date.now()}@nexora.dev`, "hash"]
    );
    const msg = await insertGroupMessage(alice.id);

    const res = await request(app)
      .patch(`/messages/${msg.id}/read`)
      .set(headers(outsider.rows[0].id));

    expect(res.status).toBe(403);
    await pool.query("DELETE FROM users WHERE id = $1", [outsider.rows[0].id]);
  });
});

describe("GET /messages/:id/status", () => {
  it("returns per-user statuses and counts for a GROUP message", async () => {
    const msg = await insertGroupMessage(alice.id);
    await insertStatus(msg.id, bob.id, "READ");
    await insertStatus(msg.id, carol.id, "PENDING");

    const res = await request(app)
      .get(`/messages/${msg.id}/status`)
      .set(headers(alice.id));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      messageId: msg.id,
      type: "GROUP",
      counts: { delivered: 1, read: 1 },
    });

    const bobRow = res.body.statuses.find((s) => s.userId === bob.id);
    const carolRow = res.body.statuses.find((s) => s.userId === carol.id);
    expect(bobRow.status).toBe("READ");
    expect(bobRow.readAt).toBeTruthy();
    expect(carolRow.status).toBe("PENDING");
    expect(carolRow.readAt).toBeNull();
  });

  it("shows DELIVERED + READ in the delivered count for a DIRECT message", async () => {
    const msg = await insertDirectMessage(alice.id, bob.id);
    await insertStatus(msg.id, bob.id, "DELIVERED");

    const res = await request(app)
      .get(`/messages/${msg.id}/status`)
      .set(headers(alice.id));

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      pending: 0,
      sent: 0,
      delivered: 1,
      read: 0,
    });
  });

  it("reports the sender's own SENT row and per-recipient rank states", async () => {
    const msg = await insertDirectMessage(alice.id, bob.id);
    await insertStatus(msg.id, alice.id, "SENT");
    await insertStatus(msg.id, bob.id, "DELIVERED");

    const res = await request(app)
      .get(`/messages/${msg.id}/status`)
      .set(headers(alice.id));

    expect(res.status).toBe(200);
    const byRole = Object.fromEntries(
      res.body.statuses.map((s) => [s.role, s])
    );
    expect(byRole.sender.userId).toBe(alice.id);
    expect(byRole.sender.status).toBe("SENT");
    expect(byRole.recipient.userId).toBe(bob.id);
    expect(byRole.recipient.status).toBe("DELIVERED");
    expect(res.body.counts).toEqual({
      pending: 0,
      sent: 1,
      delivered: 1,
      read: 0,
    });
  });

  it("forbids non-members from viewing GROUP status", async () => {
    const outsider = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [`outside_viewer_${Date.now()}`, `outside_viewer_${Date.now()}@nexora.dev`, "hash"]
    );
    const msg = await insertGroupMessage(alice.id);

    const res = await request(app)
      .get(`/messages/${msg.id}/status`)
      .set(headers(outsider.rows[0].id));

    expect(res.status).toBe(403);
    await pool.query("DELETE FROM users WHERE id = $1", [outsider.rows[0].id]);
  });

  it("forbids strangers from viewing DIRECT status", async () => {
    const stranger = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [`stranger_${Date.now()}`, `stranger_${Date.now()}@nexora.dev`, "hash"]
    );
    const msg = await insertDirectMessage(alice.id, bob.id);

    const res = await request(app)
      .get(`/messages/${msg.id}/status`)
      .set(headers(stranger.rows[0].id));

    expect(res.status).toBe(403);
    await pool.query("DELETE FROM users WHERE id = $1", [stranger.rows[0].id]);
  });
});
