import { createClient } from "redis";
import { config } from "./config.js";

export const redis = createClient({ url: config.redisUrl });
export const pubsub = redis.duplicate();

// A dropped Redis connection emits 'error' — without a listener node-redis
// throws and crashes the service. Log it and keep running.
for (const client of [redis, pubsub]) {
  client.on("error", (err) => {
    console.error(`[${config.serviceName}] redis error:`, err.message);
  });
}

export async function connectRedis() {
  await Promise.all([redis.connect(), pubsub.connect()]);
}

export const presenceKey = (userId) => `presence:${userId}`;
export const gatewayRegistryKey = (userId) => `gateway_registry:${userId}`;
export const deliverChannel = (userId) => `deliver:${userId}`;

/** Marks the user online and records the gateway instance; TTL is refreshed by heartbeats. */
export async function markOnline(userId, instanceId) {
  const multi = redis.multi();
  multi.set(presenceKey(userId), "online", { EX: config.presenceTtlSeconds });
  if (instanceId) {
    multi.set(gatewayRegistryKey(userId), instanceId, { EX: config.presenceTtlSeconds });
  }
  await multi.exec();
}

/** Refreshes the presence and registry TTL on a heartbeat ping. */
export async function refreshPresence(userId, instanceId) {
  const multi = redis.multi();
  multi.set(presenceKey(userId), "online", { EX: config.presenceTtlSeconds });
  if (instanceId) {
    multi.set(gatewayRegistryKey(userId), instanceId, { EX: config.presenceTtlSeconds });
  }
  await multi.exec();
}

/**
 * Marks the user offline with a grace-period TTL: the value stays "online"
 * for `presenceGraceSeconds` so transient disconnects don't flip presence.
 * The key disappears after the grace period (treat as offline).
 * The gateway registry key is deleted immediately since the socket is gone.
 */
export async function markOfflineGrace(userId) {
  const multi = redis.multi();
  multi.set(presenceKey(userId), "online", { EX: config.presenceGraceSeconds });
  multi.del(gatewayRegistryKey(userId));
  await multi.exec();
}

/**
 * Subscribes this process to a user's deliver channel. Every message published
 * there (by any instance or service) is handed to the callback.
 */
export async function subscribeDeliver(userId, onMessage) {
  await pubsub.subscribe(deliverChannel(userId), onMessage);
}

export async function unsubscribeDeliver(userId) {
  await pubsub.unsubscribe(deliverChannel(userId));
}

/**
 * Reports socket-level delivery truth to delivery-service: a message was
 * pushed to a live socket ("delivered") or the client acked it ("read").
 */
export async function publishReceipt(type, messageId, userId) {
  await redis.publish(
    config.receiptChannel,
    JSON.stringify({
      type,
      messageId,
      userId,
      at: new Date().toISOString(),
    })
  );
}

/** All user ids currently holding a presence key (online + grace). */
export async function onlineUserIds() {
  const ids = [];
  let cursor = "0";
  do {
    // node-redis v5 SCAN is positional: scan(cursor, pattern, count)
    const { cursor: next, keys } = await redis.scan(cursor, "presence:*", "100");
    cursor = next;
    for (const key of keys) {
      if (!key.startsWith("presence:")) continue;
      const id = key.replace(/^presence:/, "");
      if (id) ids.push(id);
    }
  } while (cursor !== "0");
  return ids;
}
