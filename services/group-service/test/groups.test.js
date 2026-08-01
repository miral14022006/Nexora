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

let owner, admin, member, outsider;

beforeAll(async () => {
  await initDb();

  const salt = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ["owner", "admin", "member", "outsider"].map((name) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [`${name}_${salt}`, `${name}_${salt}@nexora.dev`, "hash"]
      )
    )
  );
  owner = users[0].rows[0];
  admin = users[1].rows[0];
  member = users[2].rows[0];
  outsider = users[3].rows[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM groups WHERE id IN (SELECT group_id FROM group_members WHERE user_id = ANY($1))", [
    [owner.id, admin.id, member.id, outsider.id],
  ]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [
    [owner.id, admin.id, member.id, outsider.id],
  ]);
  await pool.end();
});

describe("groups", () => {
  let group;

  it("creates a group with the caller as admin", async () => {
    const res = await request(app)
      .post("/groups")
      .set(headers(owner.id, owner.username))
      .send({ name: "Dev Team" });

    expect(res.status).toBe(201);
    expect(res.body.group).toMatchObject({
      name: "Dev Team",
      ownerId: owner.id,
    });
    group = res.body.group;

    const members = await pool.query(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, owner.id]
    );
    expect(members.rows[0].role).toBe("admin");
  });

  it("lists only groups the caller belongs to", async () => {
    await pool.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
      [group.id, member.id]
    );

    const res = await request(app)
      .get("/groups")
      .set(headers(member.id, member.username));
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g) => g.id)).toContain(group.id);

    const outsiderRes = await request(app)
      .get("/groups")
      .set(headers(outsider.id, outsider.username));
    expect(outsiderRes.body.groups).toHaveLength(0);
  });

  it("returns the member list with roles", async () => {
    const res = await request(app)
      .get(`/groups/${group.id}/members`)
      .set(headers(member.id, member.username));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.members.map((m) => [m.userId, m]));
    expect(byId[owner.id].role).toBe("admin");
    expect(byId[member.id].role).toBe("member");
    expect(byId[member.id].username).toBe(member.username);
  });

  it("lets an admin add a member", async () => {
    const res = await request(app)
      .post(`/groups/${group.id}/members`)
      .set(headers(owner.id, owner.username))
      .send({ userId: admin.id });
    expect(res.status).toBe(200);
    expect(res.body.members.map((m) => m.userId)).toContain(admin.id);
    expect(res.body.members.find((m) => m.userId === admin.id).role).toBe("member");
  });

  it("forbids non-members from reading the member list", async () => {
    const res = await request(app)
      .get(`/groups/${group.id}/members`)
      .set(headers(outsider.id, outsider.username));
    expect(res.status).toBe(403);
  });

  it("forbids non-admin members from adding members", async () => {
    const res = await request(app)
      .post(`/groups/${group.id}/members`)
      .set(headers(member.id, member.username))
      .send({ userId: outsider.id });
    expect(res.status).toBe(403);
  });

  it("lets an admin remove a member", async () => {
    const res = await request(app)
      .delete(`/groups/${group.id}/members/${admin.id}`)
      .set(headers(owner.id, owner.username));
    expect(res.status).toBe(200);
    expect(res.body.removedUserId).toBe(admin.id);

    const members = await pool.query(
      `SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, admin.id]
    );
    expect(members.rows).toHaveLength(0);
  });

  it("forbids removing the owner", async () => {
    const res = await request(app)
      .delete(`/groups/${group.id}/members/${owner.id}`)
      .set(headers(owner.id, owner.username));
    expect(res.status).toBe(400);
  });

  it("lets a member leave the group", async () => {
    const res = await request(app)
      .post(`/groups/${group.id}/leave`)
      .set(headers(member.id, member.username));
    expect(res.status).toBe(200);
    expect(res.body.leftGroupId).toBe(group.id);
  });

  it("rejects non-members trying to leave", async () => {
    const res = await request(app)
      .post(`/groups/${group.id}/leave`)
      .set(headers(outsider.id, outsider.username));
    expect(res.status).toBe(404);
  });

  it("requires the internal secret", async () => {
    const res = await request(app)
      .post("/groups")
      .set("X-Nexora-User-Id", owner.id)
      .send({ name: "Hijack" });
    expect(res.status).toBe(403);
  });
});
