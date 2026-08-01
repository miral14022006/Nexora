export const config = {
  port: Number(process.env.PORT ?? 3008),
  serviceName: process.env.SERVICE_NAME ?? "websocket-gateway",
  wsPath: process.env.WS_PATH ?? "/ws",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://nexora:nexora@localhost:5432/nexora",
  // Client sends a ping every 25s; this is how long presence stays "online"
  // without a ping before the connection is treated as dead.
  heartbeatTimeoutMs: Number(process.env.WS_HEARTBEAT_TIMEOUT_MS ?? 90_000),
  heartbeatCheckIntervalMs: Number(
    process.env.WS_HEARTBEAT_CHECK_INTERVAL_MS ?? 30_000
  ),
  // Presence key TTL while connected (refreshed on every ping).
  presenceTtlSeconds: Number(process.env.PRESENCE_TTL_SECONDS ?? 90),
  // Grace period after a disconnect: presence stays "online" for this long so
  // quick reconnects / network blips don't flip the user to offline.
  presenceGraceSeconds: Number(process.env.PRESENCE_GRACE_SECONDS ?? 30),
  // Redis channel where socket-level delivery truth is reported for
  // delivery-service to persist + fan out (chat.message.delivered/read).
  receiptChannel: process.env.DELIVERY_RECEIPT_CHANNEL ?? "delivery:receipts",
};
