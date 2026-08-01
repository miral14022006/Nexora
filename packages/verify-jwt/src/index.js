import jwt from "jsonwebtoken";

/**
 * Verifies an access token and returns its payload ({ userId, username }),
 * or throws if the token is invalid/expired. Used by the Express middleware
 * below and by the websocket-gateway during the WS handshake.
 */
export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}

/**
 * Express middleware that protects a route with a Nexora access token.
 * Reads `Authorization: Bearer <token>`, verifies the JWT signature with
 * JWT_ACCESS_SECRET, and attaches `req.user = { userId, username }` on success.
 * Responds 401 with a clear message otherwise.
 */
export function verifyAccessToken(req, res, next) {
  const header = req.headers.authorization ?? "";

  if (!header.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or malformed Authorization header" });
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    return res
      .status(401)
      .json({ error: "Missing or malformed Authorization header" });
  }

  try {
    const payload = verifyToken(token);
    req.user = { userId: payload.userId, username: payload.username };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired access token" });
  }
}

export default verifyAccessToken;
