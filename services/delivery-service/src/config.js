export const config = {
  port: Number(process.env.PORT ?? 3005),
  serviceName: process.env.SERVICE_NAME ?? "delivery-service",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://nexora:nexora@localhost:5432/nexora",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  kafkaBrokers: process.env.KAFKA_BROKERS ?? "kafka:9092",
  kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "nexora-delivery-service",
  messageTopic: process.env.KAFKA_MESSAGE_EVENTS_TOPIC ?? "message-events",
  consumerGroupId:
    process.env.KAFKA_MESSAGE_EVENTS_GROUP ?? "nexora-delivery-service",
  deliveredTopic: process.env.KAFKA_DELIVERED_TOPIC ?? "chat.message.delivered",
  readTopic: process.env.KAFKA_READ_TOPIC ?? "chat.message.read",
  dlqTopic: process.env.KAFKA_DLQ_TOPIC ?? "message-events-dlq",
  // Per-event retry: exponential backoff (1s, 2s, 4s, 8s capped) + jitter,
  // then the event is moved to the DLQ instead of being dropped or blocking
  // the consumer forever.
  dlqMaxAttempts: Number(process.env.DLQ_MAX_ATTEMPTS ?? 5),
  dlqBaseDelayMs: Number(process.env.DLQ_BASE_DELAY_MS ?? 1000),
  dlqJitterMaxMs: Number(process.env.DLQ_JITTER_MAX_MS ?? 500),
  // Redis channel where the websocket-gateway reports socket-level truth
  // (message pushed to a live socket / client ack).
  receiptChannel: process.env.DELIVERY_RECEIPT_CHANNEL ?? "delivery:receipts",
  presenceKeyPrefix: process.env.PRESENCE_KEY_PREFIX ?? "presence:",
};
