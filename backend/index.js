/**
 * Nexora Unified Backend Launcher
 *
 * Boots every microservice inside a single Node.js process so the entire
 * backend can be deployed as ONE Render Web Service.
 *
 * The API Gateway listens on the PORT env var (Render assigns this) and
 * proxies to downstream services on localhost ports. Each service's existing
 * config.js already defaults to localhost:PORT when env vars are unset, so
 * no service code needs to change.
 *
 * External dependencies (Postgres, Redis, Kafka) are configured via env vars
 * in the Render Dashboard.
 */

// ── Internal ports (match each service's default) ────────────────────────────
const INTERNAL_PORTS = {
  auth: 3001,
  user: 3002,
  group: 3003,
  chat: 3004,
  delivery: 3005,
  notification: 3007,
  websocketGateway: 3008,
  media: 3010,
};

// ── Ensure downstream env vars point to localhost ────────────────────────────
// The api-gateway's config.js reads these to know where to proxy. In Docker
// Compose they point to Docker DNS names; here they point to localhost.
function setDefaultEnv(key, value) {
  if (!process.env[key]) process.env[key] = value;
}

setDefaultEnv("AUTH_SERVICE_URL", `http://localhost:${INTERNAL_PORTS.auth}`);
setDefaultEnv("USER_SERVICE_URL", `http://localhost:${INTERNAL_PORTS.user}`);
setDefaultEnv("GROUP_SERVICE_URL", `http://localhost:${INTERNAL_PORTS.group}`);
setDefaultEnv("CHAT_SERVICE_URL", `http://localhost:${INTERNAL_PORTS.chat}`);
setDefaultEnv("MEDIA_SERVICE_URL", `http://localhost:${INTERNAL_PORTS.media}`);
setDefaultEnv(
  "GATEWAY_HTTP_URL",
  `http://localhost:${INTERNAL_PORTS.websocketGateway}`
);
setDefaultEnv(
  "WS_GATEWAY_URLS",
  `ws://localhost:${INTERNAL_PORTS.websocketGateway}`
);

// ── Shared retry helper ──────────────────────────────────────────────────────
async function withRetry(fn, { attempts = 20, delayMs = 3000, label } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(
        `[unified-backend] ${label ?? "startup"} failed (attempt ${attempt}/${attempts}):`,
        err.message
      );
      if (attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ── Boot sequence ────────────────────────────────────────────────────────────
async function main() {
  const gatewayPort = Number(process.env.PORT ?? 3000);

  console.log("[unified-backend] ═══════════════════════════════════════");
  console.log("[unified-backend]  Nexora Unified Backend");
  console.log("[unified-backend] ═══════════════════════════════════════");

  // ── 1. Initialize all databases (shared Postgres, idempotent schemas) ────
  console.log("[unified-backend] Initializing databases...");

  const { initDb: initAuthDb } = await import(
    "../services/auth-service/src/db/init.js"
  );
  const { initDb: initUserDb } = await import(
    "../services/user-service/src/db/init.js"
  );
  const { initDb: initGroupDb } = await import(
    "../services/group-service/src/db/init.js"
  );
  const { initDb: initChatDb } = await import(
    "../services/chat-service/src/db/init.js"
  );
  const { initDb: initDeliveryDb } = await import(
    "../services/delivery-service/src/db/init.js"
  );
  const { initDb: initNotificationDb } = await import(
    "../services/notification-service/src/db/init.js"
  );
  const { initDb: initWsGatewayDb } = await import(
    "../services/websocket-gateway/src/db/init.js"
  );
  const { initDb: initMediaDb } = await import(
    "../services/media-service/src/db/init.js"
  );

  await withRetry(
    async () => {
      await initAuthDb();
      await initUserDb();
      await initGroupDb();
      await initChatDb();
      await initDeliveryDb();
      await initNotificationDb();
      await initWsGatewayDb();
      await initMediaDb();
    },
    { label: "database init" }
  );
  console.log("[unified-backend] ✓ All database schemas initialized");

  // ── 2. Connect Redis (for services that need it) ────────────────────────
  console.log("[unified-backend] Connecting to Redis...");

  const { connectRedis: connectChatRedis } = await import(
    "../services/chat-service/src/redis.js"
  );
  const { connectRedis: connectDeliveryRedis } = await import(
    "../services/delivery-service/src/redis.js"
  );
  const { connectRedis: connectNotificationRedis } = await import(
    "../services/notification-service/src/redis.js"
  );
  const { connectRedis: connectWsGatewayRedis } = await import(
    "../services/websocket-gateway/src/redis.js"
  );

  await withRetry(connectChatRedis, { label: "chat-service redis" });
  await withRetry(connectDeliveryRedis, { label: "delivery-service redis" });
  await withRetry(connectNotificationRedis, { label: "notification-service redis" });
  await withRetry(connectWsGatewayRedis, { label: "websocket-gateway redis" });
  console.log("[unified-backend] ✓ Redis connected");

  // ── 3. Connect Kafka (lazy — non-fatal) ─────────────────────────────────
  console.log("[unified-backend] Connecting to Kafka...");

  const { connectKafka: connectChatKafka } = await import(
    "../services/chat-service/src/kafka.js"
  );
  const { connectKafka: connectDeliveryKafka } = await import(
    "../services/delivery-service/src/kafka.js"
  );

  await connectChatKafka();
  await connectDeliveryKafka();
  console.log("[unified-backend] ✓ Kafka connected (or will lazy-retry)");

  // ── 4. MinIO bucket setup (optional, graceful degradation) ──────────────
  const { config: mediaConfig } = await import(
    "../services/media-service/src/config.js"
  );
  if (mediaConfig.minio.enabled) {
    const { ensureBucket } = await import(
      "../services/media-service/src/minio.js"
    );
    try {
      await ensureBucket();
      console.log("[unified-backend] ✓ MinIO bucket ready");
    } catch (err) {
      console.warn(
        "[unified-backend] MinIO bucket setup failed (media routes will 503):",
        err.message
      );
    }
  } else {
    console.log("[unified-backend] MinIO not configured — media routes will 503");
  }

  // ── 5. Start downstream HTTP services (bound to localhost 127.0.0.1) ────
  console.log("[unified-backend] Starting downstream services...");

  // Auth service
  const { createApp: createAuthApp } = await import(
    "../services/auth-service/src/app.js"
  );
  const authApp = createAuthApp();
  authApp.listen(INTERNAL_PORTS.auth, "127.0.0.1", () =>
    console.log(`[unified-backend]   auth-service       → 127.0.0.1:${INTERNAL_PORTS.auth}`)
  );

  // User service
  const { createApp: createUserApp } = await import(
    "../services/user-service/src/app.js"
  );
  const userApp = createUserApp();
  userApp.listen(INTERNAL_PORTS.user, "127.0.0.1", () =>
    console.log(`[unified-backend]   user-service       → 127.0.0.1:${INTERNAL_PORTS.user}`)
  );

  // Group service
  const { createApp: createGroupApp } = await import(
    "../services/group-service/src/app.js"
  );
  const groupApp = createGroupApp();
  groupApp.listen(INTERNAL_PORTS.group, "127.0.0.1", () =>
    console.log(`[unified-backend]   group-service      → 127.0.0.1:${INTERNAL_PORTS.group}`)
  );

  // Chat service (needs Kafka publisher + Redis read-receipt publisher)
  const { publishMessageEvent } = await import(
    "../services/chat-service/src/kafka.js"
  );
  const { publishReadReceipt } = await import(
    "../services/chat-service/src/redis.js"
  );
  const { createApp: createChatApp } = await import(
    "../services/chat-service/src/app.js"
  );
  const chatApp = createChatApp({ publishMessageEvent, publishReadReceipt });
  chatApp.listen(INTERNAL_PORTS.chat, "127.0.0.1", () =>
    console.log(`[unified-backend]   chat-service       → 127.0.0.1:${INTERNAL_PORTS.chat}`)
  );

  // Media service
  const { createApp: createMediaApp } = await import(
    "../services/media-service/src/app.js"
  );
  const mediaApp = createMediaApp();
  mediaApp.listen(INTERNAL_PORTS.media, "127.0.0.1", () =>
    console.log(`[unified-backend]   media-service      → 127.0.0.1:${INTERNAL_PORTS.media}`)
  );

  // ── 6. Start WebSocket Gateway ──────────────────────────────────────────
  const { createServer: createWsServer } = await import(
    "../services/websocket-gateway/src/server.js"
  );
  const wsServer = createWsServer();
  wsServer.listen(INTERNAL_PORTS.websocketGateway, "127.0.0.1", () =>
    console.log(
      `[unified-backend]   websocket-gateway  → 127.0.0.1:${INTERNAL_PORTS.websocketGateway}`
    )
  );

  // ── 7. Start delivery-service background workers ────────────────────────
  const { pool: deliveryPool } = await import(
    "../services/delivery-service/src/db/pool.js"
  );
  const {
    isOnline: deliveryIsOnline,
    publishDeliver,
    subscribeReceipts,
  } = await import("../services/delivery-service/src/redis.js");
  const { publishReceiptEvent } = await import(
    "../services/delivery-service/src/kafka.js"
  );
  const { handleMessageCreated, handleReceipt } = await import(
    "../services/delivery-service/src/delivery.js"
  );
  const { startMessageConsumer: startDeliveryConsumer } = await import(
    "../services/delivery-service/src/kafka.js"
  );

  const deliveryDeps = {
    pool: deliveryPool,
    isOnline: deliveryIsOnline,
    publishDeliver,
    publishReceiptEvent,
  };

  await subscribeReceipts((receipt) => {
    handleReceipt(receipt, deliveryDeps).catch((err) =>
      console.error("[delivery-service] receipt handler error:", err.message)
    );
  });
  console.log("[unified-backend]   delivery-service   → receipts listener active");

  // Retry Kafka consumer start (Kafka may take a moment)
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await startDeliveryConsumer((event) =>
        handleMessageCreated(event, deliveryDeps)
      );
      console.log("[unified-backend]   delivery-service   → Kafka consumer active");
      break;
    } catch (err) {
      console.error(
        `[unified-backend] delivery consumer failed (attempt ${attempt}/15):`,
        err.message
      );
      if (attempt === 15) {
        console.error("[unified-backend] delivery consumer gave up — messages won't be delivered until restart");
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ── 8. Start notification-service background workers ────────────────────
  const { pool: notificationPool } = await import(
    "../services/notification-service/src/db/pool.js"
  );
  const { isOnline: notificationIsOnline } = await import(
    "../services/notification-service/src/redis.js"
  );
  const { handleMessageCreated: handleNotification } = await import(
    "../services/notification-service/src/notifications.js"
  );
  const { startMessageConsumer: startNotificationConsumer } = await import(
    "../services/notification-service/src/kafka.js"
  );

  const notificationDeps = {
    pool: notificationPool,
    isOnline: notificationIsOnline,
    log: (msg) => console.log(`[notification-service] ${msg}`),
  };

  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await startNotificationConsumer((event) =>
        handleNotification(event, notificationDeps)
      );
      console.log(
        "[unified-backend]   notification-svc   → Kafka consumer active"
      );
      break;
    } catch (err) {
      console.error(
        `[unified-backend] notification consumer failed (attempt ${attempt}/15):`,
        err.message
      );
      if (attempt === 15) {
        console.error("[unified-backend] notification consumer gave up");
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ── 9. Start the API Gateway (public entry point) ───────────────────────
  const http = await import("node:http");
  const { createApp: createGatewayApp } = await import(
    "../services/api-gateway/src/app.js"
  );

  const gatewayApp = createGatewayApp();
  const gatewayServer = http.createServer(gatewayApp);
  gatewayApp.attachWs(gatewayServer);

  gatewayServer.listen(gatewayPort, "0.0.0.0", () => {
    console.log("[unified-backend] ═══════════════════════════════════════");
    console.log(
      `[unified-backend]  API Gateway (public) → 0.0.0.0:${gatewayPort}`
    );
    console.log("[unified-backend]  All services running ✓");
    console.log("[unified-backend] ═══════════════════════════════════════");
  });
}

main().catch((err) => {
  console.error("[unified-backend] Fatal startup error:", err);
  process.exit(1);
});
