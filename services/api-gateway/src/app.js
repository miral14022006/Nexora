import express from "express";
import httpProxy from "http-proxy";
import { verifyAccessToken } from "@nexora/verify-jwt";
import { config } from "./config.js";

/**
 * API gateway: single public entry point for the SPA.
 *
 *  - /api/auth/*      → auth-service (token flows; auth-service verifies its
 *                       own JWTs, no header injection needed)
 *  - /api/users/*     → user-service
 *  - /api/groups/*    → group-service
 *  - /api/messages/*  → chat-service
 *  - /api/conversations → chat-service
 *  - /api/media/*     → media-service
 *  - /api/presence    → websocket-gateway (verifies its own Bearer token)
 *
 * For authenticated services the gateway verifies the Bearer access token and
 * re-authenticates the request to the downstream service with the shared
 * internal secret + user-context headers (see packages/internal-auth).
 *
 *  - /ws              → websocket-gateway (round-robin across instances).
 */

const PROXY_ROUTES = {
  // auth-service mounts its router at /auth (full path /auth/login, …)
  "/api/auth": { target: null, auth: false, strip: "/api" },
  "/api/users": { target: null, auth: true, strip: "/api" },
  "/api/groups": { target: null, auth: true, strip: "/api" },
  "/api/messages": { target: null, auth: true, strip: "/api" },
  "/api/conversations": { target: null, auth: true, strip: "/api" },
  "/api/media": { target: null, auth: true, strip: "/api" },
  "/api/presence": { target: null, auth: false, strip: "/api/presence" },
};

export function createApp({
  authUrl = config.authUrl,
  userUrl = config.userUrl,
  groupUrl = config.groupUrl,
  chatUrl = config.chatUrl,
  mediaUrl = config.mediaUrl,
  gatewayHttpUrl = config.gatewayHttpUrl,
  internalSecret = config.internalSecret,
  wsUrls = config.wsUrls,
} = {}) {
  PROXY_ROUTES["/api/auth"].target = authUrl;
  PROXY_ROUTES["/api/users"].target = userUrl;
  PROXY_ROUTES["/api/groups"].target = groupUrl;
  PROXY_ROUTES["/api/messages"].target = chatUrl;
  PROXY_ROUTES["/api/conversations"].target = chatUrl;
  PROXY_ROUTES["/api/media"].target = mediaUrl;
  PROXY_ROUTES["/api/presence"].target = gatewayHttpUrl;

  const proxy = httpProxy.createProxyServer({});
  proxy.on("error", (err, _req, res) => {
    if (res && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad gateway" }));
    } else if (res) {
      res.end();
    } else {
      console.error("[api-gateway] proxy error:", err.message);
    }
  });

  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  for (const [prefix, route] of Object.entries(PROXY_ROUTES)) {
    const handler = (req, res) => {
      if (route.auth) {
        // Re-authenticate the request to the downstream service: the gateway
        // has already verified the Bearer token (verifyAccessToken), so the
        // user context is forwarded as trusted headers + shared secret.
        req.headers["x-nexora-user-id"] = req.user.userId;
        req.headers["x-nexora-username"] = req.user.username;
        req.headers["x-nexora-internal-secret"] = internalSecret;
      }
      // Express mounts strip the matched prefix from req.url; rebuild the
      // downstream path from originalUrl (e.g. /api/groups -> /groups,
      // /api/auth/login -> /login).
      req.url = req.originalUrl.replace(new RegExp(`^${route.strip}`), "") || "/";
      proxy.web(req, res, { target: route.target, changeOrigin: true });
    };
    if (route.auth) {
      app.use(prefix, verifyAccessToken, handler);
    } else {
      app.use(prefix, handler);
    }
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // WS round-robin across gateway instances.
  let wsCounter = 0;

  app.attachWs = function attachWs(server) {
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/ws" && !req.url.startsWith("/ws?")) {
        socket.destroy();
        return;
      }
      const target = wsUrls[wsCounter % wsUrls.length];
      wsCounter += 1;
      proxy.ws(req, socket, head, { target, changeOrigin: true });
    });
  };

  return app;
}
