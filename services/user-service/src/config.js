export const config = {
  port: Number(process.env.PORT ?? 3002),
  serviceName: process.env.SERVICE_NAME ?? "user-service",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://nexora:nexora@localhost:5432/nexora",
};
