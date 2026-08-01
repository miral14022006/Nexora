export const config = {
  port: Number(process.env.PORT ?? 3004),
  serviceName: process.env.SERVICE_NAME ?? "chat-service",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://nexora:nexora@localhost:5432/nexora",
  kafkaBrokers: process.env.KAFKA_BROKERS ?? "kafka:9092",
  kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "nexora-chat-service",
  messageTopic: process.env.KAFKA_MESSAGE_EVENTS_TOPIC ?? "message-events",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
};
