import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Signs a new access + refresh token pair for a user and persists the
 * refresh token (as a hash) so it can be revoked later.
 * Returns { accessToken, refreshToken }.
 */
export async function issueTokenPair(user) {
  const accessToken = jwt.sign(
    { userId: user.id, username: user.username },
    config.jwtAccessSecret,
    { expiresIn: config.accessTokenTtl }
  );

  const refreshToken = jwt.sign(
    { userId: user.id, username: user.username, jti: crypto.randomUUID() },
    config.jwtRefreshSecret,
    { expiresIn: config.refreshTokenTtl }
  );

  const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
  const expiresAt = new Date(decoded.exp * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [hashToken(refreshToken), user.id, expiresAt]
  );

  return { accessToken, refreshToken };
}
