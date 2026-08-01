import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { verifyAccessToken } from "@nexora/verify-jwt";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { hashToken, issueTokenPair } from "../services/tokenService.js";
import {
  asyncHandler,
  loginSchema,
  logoutSchema,
  refreshSchema,
  signupSchema,
  validate,
} from "../validators/auth.js";

const router = Router();

function toPublicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at,
  };
}

router.post(
  "/signup",
  validate(signupSchema),
  asyncHandler(async (req, res) => {
    const { username, email, password } = req.body;

    const existing = await pool.query(
      `SELECT id, username, email FROM users WHERE email = $1 OR username = $2`,
      [email, username]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.email === email) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      return res.status(409).json({ error: "This username is already taken" });
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    const inserted = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at`,
      [username, email, passwordHash]
    );

    const user = inserted.rows[0];
    const tokens = await issueTokenPair(user);

    res.status(201).json({ ...tokens, user: toPublicUser(user) });
  })
);

router.post(
  "/login",
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const found = await pool.query(
      `SELECT id, username, email, password_hash, created_at FROM users WHERE email = $1`,
      [email]
    );

    if (found.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = found.rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const tokens = await issueTokenPair(user);
    res.json({ ...tokens, user: toPublicUser(user) });
  })
);

router.post(
  "/refresh",
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
    } catch {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    const found = await pool.query(
      `SELECT rt.id, rt.token_hash, rt.user_id, rt.expires_at, rt.revoked,
              u.id IS NOT NULL AS user_exists
       FROM refresh_tokens rt
       LEFT JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [hashToken(refreshToken)]
    );

    const record = found.rows[0];
    if (
      !record ||
      record.revoked ||
      new Date(record.expires_at).getTime() < Date.now()
    ) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    if (!record.user_exists) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked = true WHERE id = $1`,
        [record.id]
      );
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    await pool.query(
      `UPDATE refresh_tokens SET revoked = true WHERE id = $1`,
      [record.id]
    );

    const tokens = await issueTokenPair({
      id: decoded.userId,
      username: decoded.username,
    });

    res.json(tokens);
  })
);

router.post(
  "/logout",
  validate(logoutSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    const result = await pool.query(
      `UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1 AND revoked = false`,
      [hashToken(refreshToken)]
    );

    res.status(204).end();
  })
);

router.get(
  "/me",
  verifyAccessToken,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

export default router;
