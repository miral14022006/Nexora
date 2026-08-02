#!/usr/bin/env node
/**
 * Creates the Nexora Kafka topics idempotently (chat-service producer topic,
 * delivery-service consumer topics, DLQ). Safe to run against any broker,
 * including CI (retries until the broker is reachable) and cloud brokers
 * (Upstash etc. — pass KAFKA_BROKERS/KAFKA_SASL_* env vars as usual).
 *
 * Usage: node scripts/create-topics.mjs
 * Reads KAFKA_BROKERS + KAFKA_SASL_* / KAFKA_SSL from the environment.
 */
import { Kafka } from "kafkajs";

const brokers = (process.env.KAFKA_BROKERS ?? "kafka:9092")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);

const sasl = process.env.KAFKA_SASL_USERNAME
  ? {
      mechanism: process.env.KAFKA_SASL_MECHANISM || "scram-sha-256",
      username: process.env.KAFKA_SASL_USERNAME,
      password: process.env.KAFKA_SASL_PASSWORD,
    }
  : undefined;
const ssl = process.env.KAFKA_SSL === "true" ? true : !!sasl;

const topics = [
  process.env.KAFKA_MESSAGE_EVENTS_TOPIC ?? "message-events",
  process.env.KAFKA_DELIVERED_TOPIC ?? "chat.message.delivered",
  process.env.KAFKA_READ_TOPIC ?? "chat.message.read",
  process.env.KAFKA_DLQ_TOPIC ?? "message-events-dlq",
];

const kafka = new Kafka({
  clientId: "nexora-topic-bootstrap",
  brokers,
  ...(ssl ? { ssl: true } : {}),
  ...(sasl ? { sasl } : {}),
});

const admin = kafka.admin();
let attempt = 0;
const MAX_ATTEMPTS = 30;

while (true) {
  attempt++;
  try {
    await admin.connect();
    const existing = await admin.listTopics();
    const toCreate = topics.filter((t) => !existing.includes(t));
    if (toCreate.length) {
      await admin.createTopics({
        topics: toCreate.map((topic) => ({ topic })),
      });
      console.log(`created: ${toCreate.join(", ")}`);
    } else {
      console.log(`all topics already exist (${topics.join(", ")})`);
    }
    await admin.disconnect();
    process.exit(0);
  } catch (e) {
    if (attempt >= MAX_ATTEMPTS) {
      console.error(`failed to connect to Kafka at ${brokers.join(",")}: ${e.message}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
