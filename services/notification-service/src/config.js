export const config = {
  port: Number(process.env.PORT ?? 3007),
  serviceName: process.env.SERVICE_NAME ?? "notification-service",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://nexora:nexora@localhost:5432/nexora",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  kafkaBrokers: process.env.KAFKA_BROKERS ?? "kafka:9092",
  kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "nexora-notification-service",
  messageTopic: process.env.KAFKA_MESSAGE_EVENTS_TOPIC ?? "message-events",
  consumerGroupId:
    process.env.KAFKA_MESSAGE_EVENTS_GROUP ?? "nexora-notification-service",
  presenceKeyPrefix: process.env.PRESENCE_KEY_PREFIX ?? "presence:",
};
