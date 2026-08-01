import { Kafka } from "kafkajs";
import { config } from "./config.js";

// Cloud brokers (Upstash Kafka) require SASL + TLS. When KAFKA_SASL_USERNAME
// is set, kafkajs authenticates with SCRAM; otherwise plain TCP for local dev.
const sasl = process.env.KAFKA_SASL_USERNAME
  ? {
      mechanism: process.env.KAFKA_SASL_MECHANISM || "scram-sha-256",
      username: process.env.KAFKA_SASL_USERNAME,
      password: process.env.KAFKA_SASL_PASSWORD,
    }
  : undefined;
const ssl = process.env.KAFKA_SSL === "true" ? true : !!sasl;

export const kafka = new Kafka({
  clientId: config.kafkaClientId,
  brokers: config.kafkaBrokers
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean),
  ...(ssl ? { ssl: true } : {}),
  ...(sasl ? { sasl } : {}),
});

let producerPromise;

export function getProducer() {
  if (!producerPromise) {
    const producer = kafka.producer();
    producerPromise = producer.connect().then(() => producer);
  }
  return producerPromise;
}

/**
 * Emits a receipt event for chat-service consumers: a message was delivered
 * to a live socket or read by the recipient. Keyed by userId.
 */
export async function publishReceiptEvent(eventType, messageId, userId) {
  const producer = await getProducer();
  const topic =
    eventType === "message.read" ? config.readTopic : config.deliveredTopic;
  await producer.send({
    topic,
    messages: [
      {
        key: userId,
        value: JSON.stringify({
          eventType,
          messageId,
          userId,
          at: new Date().toISOString(),
        }),
      },
    ],
  });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Publishes a failed event (with full error context) to the dead-letter
 * topic so it can be inspected instead of being dropped silently.
 */
export async function publishToDlq(payload) {
  const producer = await getProducer();
  await producer.send({
    topic: config.dlqTopic,
    messages: [
      {
        key: payload.originalEvent?.messageId,
        value: JSON.stringify(payload),
      },
    ],
  });
}

/**
 * Per-event processing with retry: exponential backoff + jitter
 * (1s, 2s, 4s, 8s… capped) up to `maxAttempts`, then the event is moved to
 * the DLQ. A single bad event therefore blocks the consumer loop for at most
 * a few seconds per attempt — it can never wedge it indefinitely, and it is
 * never silently dropped.
 *
 * All parameters are injectable so tests can run without timers or Kafka.
 */
export async function processWithRetry(event, handler, options = {}) {
  const {
    maxAttempts = config.dlqMaxAttempts,
    baseDelayMs = config.dlqBaseDelayMs,
    jitterMaxMs = config.dlqJitterMaxMs,
    sleep = defaultSleep,
    publishToDlq: sendToDlq = publishToDlq,
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await handler(event);
      if (attempt > 1) {
        console.log(
          `[${config.serviceName}] recovered event ${event.messageId ?? "(no id)"} on attempt ${attempt}`
        );
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      // 1s, 2s, 4s, 8s… — the exponent is capped so huge attempt counts never
      // produce unbounded waits.
      const delay =
        baseDelayMs * 2 ** Math.min(attempt - 1, 3) +
        Math.floor(Math.random() * jitterMaxMs);
      console.warn(
        `[${config.serviceName}] event ${event.messageId ?? "(no id)"} failed ` +
          `(attempt ${attempt}/${maxAttempts}) — retrying in ${delay}ms: ${err.message}`
      );
      await sleep(delay);
    }
  }

  const dlqPayload = {
    eventType: "dlq",
    originalEvent: event,
    error: lastError?.message ?? String(lastError),
    attempts: maxAttempts,
    at: new Date().toISOString(),
    consumer: config.serviceName,
  };
  try {
    await sendToDlq(dlqPayload);
    console.error(
      `[${config.serviceName}] event ${event.messageId ?? "(no id)"} moved to DLQ ` +
        `(${config.dlqTopic}) after ${maxAttempts} attempts: ${dlqPayload.error}`
    );
  } catch (dlqErr) {
    // Best effort: if the DLQ itself is unreachable the event is logged
    // loudly rather than crashing the consumer loop.
    console.error(
      `[${config.serviceName}] DLQ publish FAILED — event ${event.messageId ?? "(no id)"} would be lost:`,
      dlqErr.message
    );
  }
}

/** Connects the producer; failures are non-fatal (retried on first send). */
export async function connectKafka() {
  try {
    await getProducer();
    console.log(`[${config.serviceName}] connected to Kafka (${config.kafkaBrokers})`);
  } catch (err) {
    console.error(
      `[${config.serviceName}] Kafka connect failed (will retry on first send):`,
      err.message
    );
  }
}

/**
 * Starts the message-events consumer. Each `message.created` event is handed
 * to `handleMessageCreated` through `processWithRetry` (backoff + DLQ), so a
 * transient failure (Redis blip, DB hiccup) never wedges the loop and an
 * event that exhausts its attempts lands in the DLQ, not the void.
 * `fromBeginning` means events produced while this service was down are
 * picked up on restart (backfill).
 */
export async function startMessageConsumer(handleMessageCreated) {
  const consumer = kafka.consumer({ groupId: config.consumerGroupId });
  await consumer.connect();
  await consumer.subscribe({ topic: config.messageTopic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch {
        return; // ignore malformed events
      }
      if (event.eventType === "message.created") {
        await processWithRetry(event, handleMessageCreated);
      }
    },
  });
  return consumer;
}
