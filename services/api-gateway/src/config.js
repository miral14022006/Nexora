export const config = {
  port: Number(process.env.PORT ?? 3000),
  serviceName: process.env.SERVICE_NAME ?? "api-gateway",
  authUrl: process.env.AUTH_SERVICE_URL ?? "http://localhost:3001",
  userUrl: process.env.USER_SERVICE_URL ?? "http://localhost:3002",
  groupUrl: process.env.GROUP_SERVICE_URL ?? "http://localhost:3003",
  chatUrl: process.env.CHAT_SERVICE_URL ?? "http://localhost:3004",
  mediaUrl: process.env.MEDIA_SERVICE_URL ?? "http://localhost:3010",
  gatewayHttpUrl:
    process.env.GATEWAY_HTTP_URL ?? "http://localhost:3008",
  wsUrls: (process.env.WS_GATEWAY_URLS ?? "ws://localhost:3008").split(","),
  internalSecret: process.env.SERVICE_SECRET ?? "dev-internal-secret",
};
