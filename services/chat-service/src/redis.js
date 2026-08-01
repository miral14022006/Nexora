import { createClient } from "redis";
import { config } from "./config.js";

export const redis = createClient({ url: config.redisUrl });

// A dropped Redis connection emits 'error' — without a listener node-redis
// throws, which crashes the whole service (and its restart loop then can't
// boot either, because startup also needs Redis). Log it and keep running:
// commands fail fast (or queue per client config) and callers handle them.
redis.on("error", (err) => {
  console.error(`[chat-service] redis error:`, err.message);
});

export async function connectRedis() {
  await redis.connect();
}

export const deliverChannel = (userId) => `deliver:${userId}`;

/**
 * Pushes a read_receipt envelope onto the deliver channel of every target
 * user. The websocket-gateway instance holding each target's socket fans it
 * out — no instance knowledge, no Kafka hop.
 */
export async function publishReadReceipt(messageId, userId, targetUserIds) {
  const envelope = JSON.stringify({
    type: "read_receipt",
    payload: { messageId, userId },
  });
  await Promise.all(
    targetUserIds.map((target) => redis.publish(deliverChannel(target), envelope))
  );
}
