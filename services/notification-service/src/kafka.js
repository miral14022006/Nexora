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

/**
 * Starts the message-events consumer. Each `message.created` event is handed
 * to `handleMessageCreated`. Own consumer group (independent of
 * delivery-service) so notification fan-out is unaffected by delivery load.
 * `fromBeginning` covers events produced while the service was down.
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
        await handleMessageCreated(event);
      }
    },
  });
  return consumer;
}
