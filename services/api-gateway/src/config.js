/**
 * Normalizes an internal service reference into a full URL.
 *
 * Render's `fromService` env vars (property: hostport) inject bare
 * `host:port` values (e.g. "auth-service-abc12:3001") with NO scheme, while
 * docker-compose injects full URLs (e.g. "http://auth-service:3001"). This
 * helper adds the scheme only when missing, so both environments work.
 */
function withScheme(value, scheme) {
  if (!value) return value;
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `${scheme}://${trimmed}`;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  serviceName: process.env.SERVICE_NAME ?? "api-gateway",
  authUrl: withScheme(process.env.AUTH_SERVICE_URL ?? "http://localhost:3001", "http"),
  userUrl: withScheme(process.env.USER_SERVICE_URL ?? "http://localhost:3002", "http"),
  groupUrl: withScheme(process.env.GROUP_SERVICE_URL ?? "http://localhost:3003", "http"),
  chatUrl: withScheme(process.env.CHAT_SERVICE_URL ?? "http://localhost:3004", "http"),
  mediaUrl: withScheme(process.env.MEDIA_SERVICE_URL ?? "http://localhost:3010", "http"),
  gatewayHttpUrl: withScheme(
    process.env.GATEWAY_HTTP_URL ?? "http://localhost:3008",
    "http"
  ),
  // WS targets default to the same gateway as the HTTP presence endpoint
  // (scheme flipped to ws://), so Render's scheme-less hostport env var is
  // enough for both.
  wsUrls: (process.env.WS_GATEWAY_URLS ?? withScheme(process.env.GATEWAY_HTTP_URL ?? "ws://localhost:3008", "ws"))
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => withScheme(url, "ws")),
  internalSecret: process.env.SERVICE_SECRET ?? "dev-internal-secret",
};
