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
const failingPublisher = () => {
  throw new Error("kafka down");
};
const app = createApp({ publishMessageEvent: (m) => publishedEvents.push(m) });
const appWithBrokenKafka = createApp({ publishMessageEvent: failingPublisher });

let alice, bob, groupId;

beforeAll(async () => {
  await initDb();

  const salt = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ["alice", "bob"].map((name, i) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [`${name}_${salt}`, `${name}_${salt}@nexora.dev`, "hash"]
      )
    )
  );
  alice = users[0].rows[0];
  bob = users[1].rows[0];

  const group = await pool.query(
    `INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [`test group ${Date.now()}`, alice.id]
  );
  groupId = group.rows[0].id;

  await pool.query(
    `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`,
    [groupId, alice.id, bob.id]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM messages WHERE sender_id = ANY($1)", [
    [alice.id, bob.id],
  ]);
  await pool.query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await pool.query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[alice.id, bob.id]]);
  await pool.end();
});

describe("POST /messages (direct)", () => {
  it("rejects requests without the internal secret", async () => {
    const res = await request(app)
      .post("/messages")
      .set("X-Nexora-User-Id", alice.id)
      .set("X-Nexora-Username", alice.username)
      .send({ type: "DIRECT", recipientId: bob.id, content: "hi" });

    expect(res.status).toBe(403);
  });

  it("rejects requests without injected user context", async () => {
    const res = await request(app)
      .post("/messages")
      .set("X-Nexora-Internal-Secret", SECRET)
      .send({ type: "DIRECT", recipientId: bob.id, content: "hi" });

    expect(res.status).toBe(401);
  });

  it("rejects DIRECT messages without recipientId", async () => {
    const res = await request(app)
      .post("/messages")
      .set(headers(alice.id))
      .send({ type: "DIRECT", content: "hi" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects GROUP messages without groupId", async () => {
    const res = await request(app)
      .post("/messages")
      .set(headers(alice.id))
      .send({ type: "GROUP", content: "hi" });

    expect(res.status).toBe(400);
  });

  it("saves a DIRECT message, publishes an event, and returns 200", async () => {
    const res = await request(app)
      .post("/messages")
      .set(headers(alice.id, alice.username))
      .send({ type: "DIRECT", recipientId: bob.id, content: "hello bob" });

    expect(res.status).toBe(200);
    expect(res.body.message.id).toBeTruthy();
    expect(res.body.message.type).toBe("DIRECT");
    expect(res.body.message.senderId).toBe(alice.id);
    expect(res.body.message.recipientId).toBe(bob.id);
    expect(res.body.message.content).toBe("hello bob");

    const dbRow = await pool.query(
      "SELECT * FROM messages WHERE id = $1",
      [res.body.message.id]
    );
    expect(dbRow.rows).toHaveLength(1);

    const event = publishedEvents.at(-1);
    expect(event).toMatchObject({
      id: res.body.message.id,
      type: "DIRECT",
      sender_id: alice.id,
      recipient_id: bob.id,
    });
  });

  it("returns 502 when the Kafka publish fails", async () => {
    const res = await request(appWithBrokenKafka)
      .post("/messages")
      .set(headers(alice.id))
      .send({ type: "DIRECT", recipientId: bob.id, content: "lost?" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/publish/i);
  });
});

describe("POST /messages (group)", () => {
  it("rejects non-members with 403", async () => {
    const outsider = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [`outsider_${Date.now()}`, `outsider_${Date.now()}@nexora.dev`, "hash"]
    );
    const outsiderId = outsider.rows[0].id;

    const res = await request(app)
      .post("/messages")
      .set(headers(outsiderId))
      .send({ type: "GROUP", groupId, content: "can I join?" });

    expect(res.status).toBe(403);

    await pool.query("DELETE FROM users WHERE id = $1", [outsiderId]);
  });

  it("returns 404 for an unknown group", async () => {
    const res = await request(app)
      .post("/messages")
      .set(headers(alice.id))
      .send({
        type: "GROUP",
        groupId: "00000000-0000-0000-0000-000000000000",
        content: "where is everyone?",
      });

    expect(res.status).toBe(404);
  });

  it("saves a GROUP message from a member", async () => {
    const res = await request(app)
      .post("/messages")
      .set(headers(bob.id, bob.username))
      .send({ type: "GROUP", groupId, content: "hello group" });

    expect(res.status).toBe(200);
    expect(res.body.message.groupId).toBe(groupId);
    expect(publishedEvents.at(-1).group_id).toBe(groupId);
  });
});

describe("GET /messages/direct/:userId", () => {
  it("returns history between the two users, newest first", async () => {
    await pool.query(
      `DELETE FROM messages WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`,
      [alice.id, bob.id]
    );

    await request(app)
      .post("/messages")
      .set(headers(bob.id, bob.username))
      .send({ type: "DIRECT", recipientId: alice.id, content: "first" });
    await request(app)
      .post("/messages")
      .set(headers(bob.id, bob.username))
      .send({ type: "DIRECT", recipientId: alice.id, content: "second" });
    await request(app)
      .post("/messages")
      .set(headers(bob.id, bob.username))
      .send({ type: "DIRECT", recipientId: alice.id, content: "third" });

    const res = await request(app)
      .get(`/messages/direct/${bob.id}?limit=2`)
      .set(headers(alice.id));

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].content).toBe("third");
    expect(res.body.messages[1].content).toBe("second");
    expect(res.body.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/messages/direct/${bob.id}?limit=2&cursor=${res.body.nextCursor}`)
      .set(headers(alice.id));

    expect(page2.status).toBe(200);
    expect(page2.body.messages).toHaveLength(1);
    expect(page2.body.messages[0].content).toBe("first");
    expect(page2.body.nextCursor).toBeNull();
  });

  it("rejects an invalid cursor", async () => {
    const res = await request(app)
      .get(`/messages/direct/${bob.id}?cursor=nope`)
      .set(headers(alice.id));

    expect(res.status).toBe(400);
  });
});

describe("GET /messages/group/:groupId", () => {
  it("returns group history for members", async () => {
    const res = await request(app)
      .get(`/messages/group/${groupId}`)
      .set(headers(alice.id));

    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThan(0);
    expect(res.body.messages.every((m) => m.groupId === groupId)).toBe(true);
  });

  it("rejects non-members with 403", async () => {
    const outsider = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [`lurker_${Date.now()}`, `lurker_${Date.now()}@nexora.dev`, "hash"]
    );
    const res = await request(app)
      .get(`/messages/group/${groupId}`)
      .set(headers(outsider.rows[0].id));

    expect(res.status).toBe(403);
    await pool.query("DELETE FROM users WHERE id = $1", [outsider.rows[0].id]);
  });
});
