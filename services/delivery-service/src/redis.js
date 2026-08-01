import { createClient } from "redis";
import { config } from "./config.js";

// disableOfflineQueue: when Redis is unreachable, commands must FAIL FAST so
// the consumer's retry/DLQ path sees an error instead of hanging forever on a
// queued command.
export const redis = createClient({
  url: config.redisUrl,
  disableOfflineQueue: true,
});
// Separate client for pub/sub mode (a subscribed client can't run other
// commands), mirroring the websocket-gateway pattern.
export const pubsub = redis.duplicate();

// A dropped Redis connection emits 'error' — without a listener node-redis
// throws, which crashes the whole service (and its restart loop then can't
// boot either, because startup also needs Redis). Log it and keep running:
// with disableOfflineQueue, commands fail fast and the consumer's
// retry/DLQ path handles the outage.
for (const client of [redis, pubsub]) {
  client.on("error", (err) => {
    console.error(`[${config.serviceName}] redis error:`, err.message);
  });
}

export async function connectRedis() {
  await Promise.all([redis.connect(), pubsub.connect()]);
}

export const presenceKey = (userId) => `${config.presenceKeyPrefix}${userId}`;
export const deliverChannel = (userId) => `deliver:${userId}`;

/** True when the gateway holds a live connection for the user. */
export async function isOnline(userId) {
  return (await redis.exists(presenceKey(userId))) === 1;
}

/** Live fast-path: pushes the client envelope onto the user's deliver channel. */
export async function publishDeliver(userId, envelope) {
  await redis.publish(deliverChannel(userId), JSON.stringify(envelope));
}

/**
 * Subscribes this process to the gateway's receipt channel. The gateway emits
 * a receipt every time it delivers a message to a live socket or receives an
 * ack — delivery-service turns those into DB state + Kafka events.
 */
export async function subscribeReceipts(onReceipt) {
  await pubsub.subscribe(config.receiptChannel, (message) => {
    try {
      onReceipt(JSON.parse(message));
    } catch {
      // ignore malformed frames
    }
  });
}
