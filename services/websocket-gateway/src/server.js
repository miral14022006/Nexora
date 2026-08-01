import http from "node:http";
import express from "express";
import { verifyToken } from "@nexora/verify-jwt";
import { config } from "./config.js";
import { attachWebSocketServer } from "./gateway.js";
import { presenceKey, redis } from "./redis.js";

export function createServer() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  /**
   * GET /presence?userIds=a,b,c — Bearer-authenticated presence lookup used by
   * the frontend to seed presence dots (live changes arrive over WS).
   */
  app.get("/presence", async (req, res) => {
    const header = req.headers.authorization ?? "";
    let token;
    if (header.startsWith("Bearer ")) token = header.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ error: "Missing or malformed Authorization header" });
    }
    try {
      verifyToken(token);
    } catch {
      return res.status(401).json({ error: "Invalid or expired access token" });
    }

    const ids = String(req.query.userIds ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);

    const results = await Promise.all(
      ids.map(async (id) => [
        id,
        (await redis.exists(presenceKey(id))) === 1 ? "online" : "offline",
      ])
    );

    res.json({ presence: Object.fromEntries(results) });
  });

  const httpServer = http.createServer(app);
  attachWebSocketServer(httpServer, app);

  return httpServer;
}
