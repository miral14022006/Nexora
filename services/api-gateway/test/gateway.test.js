import http from "node:http";
import jwt from "jsonwebtoken";
import request from "supertest";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.JWT_ACCESS_SECRET = "test-access-secret";

const { createApp } = await import("../src/app.js");

// ---- fake backends ---------------------------------------------------------

function startFakeHttp(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        url: () => `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

const received = {
  auth: [],
  user: [],
  group: [],
  chat: [],
};

let authFake, userFake, groupFake, chatFake, wsFake, gatewayServer;

beforeAll(async () => {
  authFake = await startFakeHttp((req, res, body) => {
    received.auth.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "auth", url: req.url }));
  });
  userFake = await startFakeHttp((req, res, body) => {
    received.user.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "user", url: req.url }));
  });
  groupFake = await startFakeHttp((req, res) => {
    received.group.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "group", url: req.url }));
  });
  chatFake = await startFakeHttp((req, res) => {
    received.chat.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "chat", url: req.url }));
  });

  // Fake WS backend recording upgrades.
  let upgradeCount = 0;
  wsFake = await new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
      upgradeCount += 1;
      socket.on("message", (data) => socket.send(`echo:${data}`));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, count: () => upgradeCount });
    });
  });

  const app = createApp({
    authUrl: authFake.url(),
    userUrl: userFake.url(),
    groupUrl: groupFake.url(),
    chatUrl: chatFake.url(),
    internalSecret: "test-internal-secret",
    wsUrls: [`ws://127.0.0.1:${wsFake.port}`],
  });

  gatewayServer = await new Promise((resolve) => {
    const server = http.createServer(app);
    app.attachWs(server);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
});

afterAll(async () => {
  gatewayServer?.close();
  authFake?.server.close();
  userFake?.server.close();
  groupFake?.server.close();
  chatFake?.server.close();
  wsFake?.server.close();
});

const token = jwt.sign(
  { userId: "11111111-1111-1111-1111-111111111111", username: "alice" },
  process.env.JWT_ACCESS_SECRET,
  { expiresIn: "1h" }
);
const badToken = jwt.sign({ userId: "x" }, "wrong-secret");

const gatewayPort = () => gatewayServer.address().port;

describe("HTTP proxy", () => {
  it("passes /api/auth/* through without header injection", async () => {
    const res = await request(`http://127.0.0.1:${gatewayPort()}`)
      .post("/api/auth/login")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "a@b.c", password: "secret" });

    expect(res.status).toBe(200);
    const hit = received.auth.at(-1);
    expect(hit.url).toBe("/auth/login");
    expect(hit.headers["x-nexora-user-id"]).toBeUndefined();
    expect(hit.headers["x-nexora-internal-secret"]).toBeUndefined();
    expect(JSON.parse(hit.body)).toEqual({ email: "a@b.c", password: "secret" });
  });

  it("injects user context + internal secret into authenticated routes", async () => {
    const res = await request(`http://127.0.0.1:${gatewayPort()}`)
      .get("/api/users/search?q=al")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("/users/search?q=al");
    const hit = received.user.at(-1);
    expect(hit.headers["x-nexora-user-id"]).toBe(tokenUser().userId);
    expect(hit.headers["x-nexora-username"]).toBe("alice");
    expect(hit.headers["x-nexora-internal-secret"]).toBe("test-internal-secret");
  });

  it("proxies group and message routes to the right services", async () => {
    await request(`http://127.0.0.1:${gatewayPort()}`)
      .post("/api/groups")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Team" });
    expect(received.group.at(-1).url).toBe("/groups");

    await request(`http://127.0.0.1:${gatewayPort()}`)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${token}`);
    expect(received.chat.at(-1).url).toBe("/conversations");

    await request(`http://127.0.0.1:${gatewayPort()}`)
      .patch("/api/messages/abc/read")
      .set("Authorization", `Bearer ${token}`);
    expect(received.chat.at(-1).url).toBe("/messages/abc/read");
  });

  it("rejects authenticated routes without a valid token", async () => {
    const res = await request(`http://127.0.0.1:${gatewayPort()}`)
      .get("/api/users/search?q=al");
    expect(res.status).toBe(401);

    const bad = await request(`http://127.0.0.1:${gatewayPort()}`)
      .get("/api/users/search?q=al")
      .set("Authorization", `Bearer ${badToken}`);
    expect(bad.status).toBe(401);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await request(`http://127.0.0.1:${gatewayPort()}`).get("/nope");
    expect(res.status).toBe(404);
  });
});

describe("WebSocket upgrade", () => {
  it("proxies /ws upgrades to the websocket-gateway", async () => {
    const ws = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${gatewayPort()}/ws?token=abc`);
      client.on("open", () => resolve(client));
      client.on("error", reject);
    });

    await new Promise((resolve) => {
      ws.on("message", (data) => {
        expect(data.toString()).toBe("echo:hello");
        resolve();
      });
      ws.send("hello");
    });

    expect(wsFake.count()).toBeGreaterThan(0);
    ws.close();
  });

  it("drops upgrades on non-/ws paths", async () => {
    const failed = await new Promise((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${gatewayPort()}/other`);
      client.on("unexpected-response", () => resolve("dropped"));
      client.on("error", () => resolve("dropped"));
      client.on("open", () => resolve("connected"));
    });
    expect(failed).toBe("dropped");
  });
});

function tokenUser() {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}
