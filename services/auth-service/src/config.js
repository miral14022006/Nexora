export const config = {
  port: Number(process.env.PORT ?? 3001),
  serviceName: process.env.SERVICE_NAME ?? "auth-service",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://nexora:nexora@localhost:5432/nexora",
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? "dev-only-access-secret",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev-only-refresh-secret",
  accessTokenTtl: process.env.JWT_ACCESS_TTL ?? "15m",
  refreshTokenTtl: process.env.JWT_REFRESH_TTL ?? "7d",
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 10),
};
