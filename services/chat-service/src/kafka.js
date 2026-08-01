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
 * Publishes the full message payload to the `message-events` topic.
 * The call is awaited: any publish failure propagates to the caller, which
 * must surface it as a 5xx rather than silently dropping the event.
 * The message key is the conversation id so ordering per conversation is
 * preserved across the topic's partitions.
 */
export async function publishMessageEvent(message) {
  const producer = await getProducer();
  await producer.send({
    topic: config.messageTopic,
    messages: [
      {
        key: message.recipient_id ?? message.group_id ?? message.sender_id,
        value: JSON.stringify({
          eventType: "message.created",
          messageId: message.id,
          senderId: message.sender_id,
          type: message.type,
          recipientId: message.recipient_id ?? null,
          groupId: message.group_id ?? null,
          content: message.content,
          createdAt: message.created_at,
        }),
      },
    ],
  });
}

export async function connectKafka() {
  try {
    await getProducer();
    console.log(`[${config.serviceName}] connected to Kafka (${config.kafkaBrokers})`);
  } catch (err) {
    console.error(
      `[${config.serviceName}] Kafka connect failed (will retry on first publish):`,
      err.message
    );
  }
}
