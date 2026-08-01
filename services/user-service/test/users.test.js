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

const app = createApp();

let me, alice, bob;

beforeAll(async () => {
  await initDb();

  const salt = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ["me", "alice", "bob"].map((name) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [`${name}_${salt}`, `${name}_${salt}@nexora.dev`, "hash"]
      )
    )
  );
  me = users[0].rows[0];
  alice = users[1].rows[0];
  bob = users[2].rows[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [
    [me.id, alice.id, bob.id],
  ]);
  await pool.end();
});

describe("GET /users/search", () => {
  it("finds users by username prefix, excluding the caller", async () => {
    const res = await request(app)
      .get(`/users/search?q=${alice.username}`)
      .set(headers(me.id, me.username));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({
      id: alice.id,
      username: alice.username,
    });
    expect(res.body.users[0].password_hash).toBeUndefined();
    expect(res.body.users[0].email).toBeUndefined();
  });

  it("returns multiple matches ordered by username", async () => {
    const res = await request(app)
      .get(`/users/search?q=${alice.username.slice(0, 6)}`)
      .set(headers(me.id));

    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
  });

  it("requires a non-empty q", async () => {
    const res = await request(app).get("/users/search?q=").set(headers(me.id));
    expect(res.status).toBe(400);
  });

  it("rejects requests without the internal secret", async () => {
    const res = await request(app)
      .get(`/users/search?q=${alice.username}`)
      .set("X-Nexora-User-Id", me.id)
      .set("X-Nexora-Username", me.username);
    expect(res.status).toBe(403);
  });

  it("rejects requests without user context", async () => {
    const res = await request(app)
      .get(`/users/search?q=${alice.username}`)
      .set("X-Nexora-Internal-Secret", SECRET);
    expect(res.status).toBe(401);
  });
});
