import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";

const app = createApp();

const now = Date.now();
const username = `tester_${now}`;
const email = `tester_${now}@nexora.dev`;
const password = "S3cureP@ssw0rd!";

let signupResult;
let loginTokens;

beforeAll(async () => {
  await initDb();
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE email = $1", [email]);
  await pool.end();
});

describe("POST /auth/signup", () => {
  it("creates a user and returns tokens + user", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ username, email, password });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.id).toBeTruthy();
    expect(res.body.user.username).toBe(username);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.password).toBeUndefined();
    signupResult = res.body;
  });

  it("rejects an invalid body with 400", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ username: "x", email: "not-an-email", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects a duplicate email with 409", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ username: `${username}_2`, email, password });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });

  it("rejects a duplicate username with 409", async () => {
    const res = await request(app)
      .post("/auth/signup")
      .send({ username, email: `other_${now}@nexora.dev`, password });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/username/i);
  });
});

describe("GET /auth/me (protected dummy route)", () => {
  it("allows access with a valid access token", async () => {
    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${signupResult.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.userId).toBe(signupResult.user.id);
    expect(res.body.user.username).toBe(username);
  });

  it("rejects requests without a token", async () => {
    const res = await request(app).get("/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authorization/i);
  });

  it("rejects an invalid token", async () => {
    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", "Bearer not-a-real-token");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid|expired/i);
  });
});

describe("POST /auth/login", () => {
  it("rejects a wrong password with 401", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email, password: "WrongPassword123!" });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("rejects an unknown email with 401", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: `nobody_${now}@nexora.dev`, password });

    expect(res.status).toBe(401);
  });

  it("logs in with valid credentials and returns tokens", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.id).toBe(signupResult.user.id);
    loginTokens = res.body;
  });
});

describe("POST /auth/refresh", () => {
  it("rotates the refresh token and returns a new pair", async () => {
    const rotatedOutToken = loginTokens.refreshToken;

    const res = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: rotatedOutToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(rotatedOutToken);
    loginTokens = res.body;
    globalThis.__rotatedOutRefreshToken = rotatedOutToken;
  });

  it("rejects a rotated-out refresh token with 401", async () => {
    const res = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: globalThis.__rotatedOutRefreshToken });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/refresh token/i);
  });

  it("rejects a garbage refresh token with 401", async () => {
    const res = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: "garbage" });

    expect(res.status).toBe(401);
  });

  it("rejects a refresh token whose user was deleted", async () => {
    const ghostUsername = `ghost_${now}`;
    const ghost = await request(app)
      .post("/auth/signup")
      .send({ username: ghostUsername, email: `ghost_${now}@nexora.dev`, password });

    await pool.query("DELETE FROM users WHERE id = $1", [ghost.body.user.id]);

    const res = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: ghost.body.refreshToken });

    expect(res.status).toBe(401);

    const after = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: ghost.body.refreshToken });

    expect(after.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("invalidates the refresh token", async () => {
    const res = await request(app)
      .post("/auth/logout")
      .send({ refreshToken: loginTokens.refreshToken });

    expect(res.status).toBe(204);

    const after = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: loginTokens.refreshToken });

    expect(after.status).toBe(401);
  });

  it("still allows the access token until it expires", async () => {
    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${loginTokens.accessToken}`);

    expect(res.status).toBe(200);
  });
});
