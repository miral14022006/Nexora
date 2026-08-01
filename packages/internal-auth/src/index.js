/**
 * Internal trust middleware for downstream services.
 *
 * Downstream services never verify JWTs themselves. They are only reachable
 * through the API Gateway, which:
 *   1. verifies the access token (see @nexora/verify-jwt),
 *   2. forwards the authenticated user via X-Nexora-User-Id / X-Nexora-Username
 *      request headers,
 *   3. authenticates itself with the shared X-Nexora-Internal-Secret header.
 */

export function requireInternalSecret(req, res, next) {
  const secret = process.env.SERVICE_SECRET ?? "dev-internal-secret";
  const provided = req.headers["x-nexora-internal-secret"];

  if (!provided || provided !== secret) {
    return res.status(403).json({ error: "Forbidden: internal API only" });
  }
  next();
}

export function injectAuthUser(req, res, next) {
  const userId = req.headers["x-nexora-user-id"];
  const username = req.headers["x-nexora-username"];

  if (!userId || !username) {
    return res
      .status(401)
      .json({ error: "Missing authenticated user context from gateway" });
  }

  req.user = { userId, username };
  next();
}

/**
 * Combined middleware: the service only accepts gateway-routed requests and
 * trusts the user identity the gateway attached.
 */
export function gatewayOnly(req, res, next) {
  requireInternalSecret(req, res, () => injectAuthUser(req, res, next));
}

export default gatewayOnly;
