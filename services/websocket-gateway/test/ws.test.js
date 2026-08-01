import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";
import { connectRedis, redis, presenceKey } from "../src/redis.js";

const SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-only-access-secret";
const INSTANCE_1 = `ws://localhost:${process.env.PORT ?? 3008}/ws`;
const INSTANCE_2 = `ws://websocket-gateway-2:3009/ws`;

const signToken = (userId, username) =>
  jwt.sign({ userId, username }, SECRET, { expiresIn: "15m" });

function connect(url, userId, username) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${signToken(userId, username)}`);
    const messages = [];
    let closeCode = null;
    const timer = setTimeout(() => reject(new Error("connect timeout")), 8000);

    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.on("close", (code) => {
      closeCode = code;
    });
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, messages, get closeCode() { return closeCode; } });
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function connectExpectingClose(url, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}?token=${token}`);
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on("error", () => {});
  });
}

async function waitFor(messages, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = messages.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout waiting for message: " + JSON.stringify(messages));
}

async function insertMessage(senderId, recipientId, content, createdAt) {
  const res = await pool.query(
    `INSERT INTO messages (type, sender_id, recipient_id, content, created_at)
     VALUES ('DIRECT', $1, $2, $3, $4) RETURNING *`,
    [senderId, recipientId, content, createdAt ?? new Date()]
  );
  return res.rows[0];
}

async function insertStatus(messageId, userId, status) {
  await pool.query(
    `INSERT INTO message_status (message_id, user_id, status)
     VALUES ($1, $2, $3) ON CONFLICT (message_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
    [messageId, userId, status]
  );
}

let alice, bob;

beforeAll(async () => {
  await initDb();
  await connectRedis();

  const users = await Promise.all(
    ["alice", "bob"].map((name, i) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [`${name}_${Date.now()}_${i}`, `${name}_${Date.now()}@nexora.dev`, "hash"]
      )
    )
  );
  alice = users[0].rows[0];
  bob = users[1].rows[0];
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM message_status WHERE user_id = ANY($1)`,
    [[alice.id, bob.id]]
  );
  await pool.query("DELETE FROM messages WHERE sender_id = ANY($1)", [
    [alice.id, bob.id],
  ]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [
    [alice.id, bob.id],
  ]);
  await pool.query("DELETE FROM message_status WHERE user_id = ANY($1)", [
    [alice.id, bob.id],
  ]);
  await redis.quit();
  await pool.end();
});

describe("handshake", () => {
  it("accepts a valid token and announces presence", async () => {
    const conn = await connect(INSTANCE_1, bob.id, bob.username);
    await waitFor(conn.messages, (m) => m.type === "presence");

    expect(conn.messages[0]).toMatchObject({
      type: "presence",
      payload: { userId: bob.id, status: "online" },
    });

    const presence = await redis.get(presenceKey(bob.id));
    expect(presence).toBe("online");

    conn.ws.close();
    await new Promise((r) => setTimeout(r, 600));

    const ttl = await redis.ttl(presenceKey(bob.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30); // grace TTL, not full online TTL
  });

  it("rejects an invalid token with close code 4001", async () => {
    const forged = jwt.sign(
      { userId: bob.id, username: bob.username },
      "wrong-secret",
      { expiresIn: "15m" }
    );
    const result = await connectExpectingClose(INSTANCE_1, forged);
    expect(result.code).toBe(4001);
  });
});

describe("horizontal scaling: pub/sub decouples sender from instance", () => {
  it("delivers live events to a user connected on instance 2", async () => {
    const conn = await connect(INSTANCE_2, bob.id, bob.username);
    await waitFor(conn.messages, (m) => m.type === "presence");

    // Simulate a Delivery-Service event: publish the client envelope onto the
    // user's Redis deliver channel. Neither this test nor the publisher knows
    // (or cares) which gateway instance holds the socket.
    const envelope = {
      type: "message",
      payload: {
        id: crypto.randomUUID(),
        type: "DIRECT",
        senderId: alice.id,
        recipientId: bob.id,
        groupId: null,
        content: "live on instance 2",
        createdAt: new Date().toISOString(),
      },
    };
    await redis.publish(`deliver:${bob.id}`, JSON.stringify(envelope));

    const received = await waitFor(conn.messages, (m) => m.type === "message");
    expect(received.payload.content).toBe("live on instance 2");

    conn.ws.close();
  });

  it("delivers live events to a user connected on instance 1", async () => {
    const conn = await connect(INSTANCE_1, bob.id, bob.username);
    await waitFor(conn.messages, (m) => m.type === "presence");

    const envelope = {
      type: "message",
      payload: {
        id: crypto.randomUUID(),
        type: "DIRECT",
        senderId: alice.id,
        recipientId: bob.id,
        groupId: null,
        content: "live on instance 1",
        createdAt: new Date().toISOString(),
      },
    };
    await redis.publish(`deliver:${bob.id}`, JSON.stringify(envelope));

    const received = await waitFor(conn.messages, (m) => m.type === "message");
    expect(received.payload.content).toBe("live on instance 1");

    conn.ws.close();
  });

  it("delivers only to the owning user's channel (channel isolation)", async () => {
    const carol = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, username`,
      [`carol_${Date.now()}`, `carol_${Date.now()}@nexora.dev`, "hash"]
    );
    const carolConn = await connect(INSTANCE_1, carol.rows[0].id, carol.rows[0].username);
    await waitFor(carolConn.messages, (m) => m.type === "presence");

    // Publish for bob (who is NOT connected on instance 1) while carol holds
    // a socket on instance 1 — carol must not see it.
    await redis.publish(
      `deliver:${bob.id}`,
      JSON.stringify({
        type: "message",
        payload: { id: crypto.randomUUID(), content: "for bob only" },
      })
    );

    await new Promise((r) => setTimeout(r, 400));
    expect(carolConn.messages.filter((m) => m.type === "message")).toHaveLength(0);

    carolConn.ws.close();
    await pool.query("DELETE FROM users WHERE id = $1", [carol.rows[0].id]);
  });
});

describe("reconnect backlog", () => {
  it("flushes PENDING messages in order and batch-marks them DELIVERED", async () => {
    const older = await insertMessage(alice.id, bob.id, "backlog one", new Date(Date.now() - 5000));
    const newer = await insertMessage(alice.id, bob.id, "backlog two", new Date());
    await insertStatus(older.id, bob.id, "PENDING");
    await insertStatus(newer.id, bob.id, "PENDING");

    const conn = await connect(INSTANCE_1, bob.id, bob.username);

    const first = await waitFor(
      conn.messages,
      (m) => m.type === "message" && m.payload.content === "backlog one"
    );
    const second = await waitFor(
      conn.messages,
      (m) => m.type === "message" && m.payload.content === "backlog two"
    );

    expect(first.payload.id).toBe(older.id);
    expect(second.payload.id).toBe(newer.id);

    // Wait for the batch update, then verify both rows are DELIVERED.
    await new Promise((r) => setTimeout(r, 500));
    const statuses = await pool.query(
      `SELECT status FROM message_status WHERE user_id = $1 AND status <> 'PENDING'`,
      [bob.id]
    );
    expect(statuses.rows).toHaveLength(2);
    expect(statuses.rows.every((r) => r.status === "DELIVERED")).toBe(true);

    conn.ws.close();
  });
});

describe("heartbeat", () => {
  it("answers ping with pong", async () => {
    const conn = await connect(INSTANCE_1, bob.id, bob.username);
    await waitFor(conn.messages, (m) => m.type === "presence");

    conn.ws.send(JSON.stringify({ type: "ping" }));
    const pong = await waitFor(conn.messages, (m) => m.type === "pong");
    expect(pong.type).toBe("pong");

    conn.ws.close();
  });
});

describe("typing relay", () => {
  it("relays a typing envelope from alice to bob across instances", async () => {
    const aliceConn = await connect(INSTANCE_1, alice.id, alice.username);
    const bobConn = await connect(INSTANCE_2, bob.id, bob.username);
    await waitFor(aliceConn.messages, (m) => m.type === "presence");
    await waitFor(bobConn.messages, (m) => m.type === "presence");

    aliceConn.ws.send(
      JSON.stringify({
        type: "typing",
        payload: { chatId: "conv-1", userId: alice.id, recipientId: bob.id },
      })
    );

    const typing = await waitFor(bobConn.messages, (m) => m.type === "typing");
    expect(typing.payload).toMatchObject({
      chatId: "conv-1",
      userId: alice.id,
      recipientId: bob.id,
    });

    aliceConn.ws.close();
    bobConn.ws.close();
  });

  it("fans a group typing envelope out to every listed recipient", async () => {
    const carol = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, username`,
      [`carol_typing_${Date.now()}`, `carol_typing_${Date.now()}@nexora.dev`, "hash"]
    );
    const aliceConn = await connect(INSTANCE_1, alice.id, alice.username);
    const bobConn = await connect(INSTANCE_1, bob.id, bob.username);
    const carolConn = await connect(INSTANCE_2, carol.rows[0].id, carol.rows[0].username);
    await waitFor(aliceConn.messages, (m) => m.type === "presence");
    await waitFor(bobConn.messages, (m) => m.type === "presence");
    await waitFor(carolConn.messages, (m) => m.type === "presence");

    aliceConn.ws.send(
      JSON.stringify({
        type: "typing",
        payload: { chatId: "group-1", userId: alice.id, recipientIds: [bob.id, carol.rows[0].id] },
      })
    );

    const bobTyping = await waitFor(bobConn.messages, (m) => m.type === "typing");
    const carolTyping = await waitFor(carolConn.messages, (m) => m.type === "typing");
    expect(bobTyping.payload.chatId).toBe("group-1");
    expect(carolTyping.payload.chatId).toBe("group-1");
    // The sender must not receive their own typing echo.
    expect(aliceConn.messages.filter((m) => m.type === "typing")).toHaveLength(0);

    aliceConn.ws.close();
    bobConn.ws.close();
    carolConn.ws.close();
    await pool.query("DELETE FROM users WHERE id = $1", [carol.rows[0].id]);
  });
});

describe("ack", () => {
  it("marks a DELIVERED message as READ on client ack", async () => {
    const msg = await insertMessage(alice.id, bob.id, "read me");
    await insertStatus(msg.id, bob.id, "DELIVERED");

    const conn = await connect(INSTANCE_1, bob.id, bob.username);
    await waitFor(conn.messages, (m) => m.type === "presence");

    conn.ws.send(JSON.stringify({ type: "ack", payload: { messageId: msg.id } }));

    await new Promise((r) => setTimeout(r, 400));
    const row = await pool.query(
      `SELECT status FROM message_status WHERE message_id = $1 AND user_id = $2`,
      [msg.id, bob.id]
    );
    expect(row.rows[0].status).toBe("READ");

    conn.ws.close();
  });
});

describe("live presence relay", () => {
  // Redis may still be settling right after a stack recreate; the default
  // 5s vitest timeout has occasionally cut this multi-connect test short.
  it("announces a new connection to already-online users", async () => {
    const bobConn = await connect(INSTANCE_1, bob.id, bob.username);
    await waitFor(bobConn.messages, (m) => m.type === "presence");
    const aliceConn = await connect(INSTANCE_2, alice.id, alice.username);
    await waitFor(aliceConn.messages, (m) => m.type === "presence");

    const event = await waitFor(
      bobConn.messages,
      (m) => m.type === "presence" && m.payload.userId === alice.id
    );
    expect(event.payload.status).toBe("online");

    aliceConn.ws.close();
    const offline = await waitFor(
      bobConn.messages,
      (m) => m.type === "presence" && m.payload.userId === alice.id && m.payload.status === "offline"
    );
    expect(offline.payload.status).toBe("offline");

    bobConn.ws.close();
  }, 15000);
});

describe("GET /presence", () => {
  const HTTP = INSTANCE_1.replace("ws://", "http://").replace(/\/ws$/, "");

  it("reports online/offline for requested user ids", async () => {
    const aliceConn = await connect(INSTANCE_1, alice.id, alice.username);
    await waitFor(aliceConn.messages, (m) => m.type === "presence");
    await redis.del(presenceKey(bob.id));

    const res = await fetch(
      `${HTTP}/presence?userIds=${alice.id},${bob.id}`,
      { headers: { Authorization: `Bearer ${signToken(bob.id, bob.username)}` } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presence[alice.id]).toBe("online");
    expect(body.presence[bob.id]).toBe("offline");

    aliceConn.ws.close();
  });

  it("rejects requests without a valid token", async () => {
    const res = await fetch(`${HTTP}/presence?userIds=${alice.id}`);
    expect(res.status).toBe(401);
  });
});
