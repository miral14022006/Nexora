import { Kafka } from "kafkajs";
import { config } from "./config.js";

export const kafka = new Kafka({
  clientId: config.kafkaClientId,
  brokers: config.kafkaBrokers
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean),
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
