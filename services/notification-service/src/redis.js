import { createClient } from "redis";
import { config } from "./config.js";

export const redis = createClient({ url: config.redisUrl });

export async function connectRedis() {
  await redis.connect();
}

export const presenceKey = (userId) => `${config.presenceKeyPrefix}${userId}`;

/** True when the websocket-gateway holds a live connection for the user. */
export async function isOnline(userId) {
  return (await redis.exists(presenceKey(userId))) === 1;
}
