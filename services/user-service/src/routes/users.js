import { Router } from "express";
import { z } from "zod";
import { gatewayOnly } from "@nexora/internal-auth";
import { pool } from "../db/pool.js";

export function createUsersRouter() {
  const router = Router();

  // Every route is only reachable through the API gateway, which has already
  // verified the access token and attached the user context headers.
  router.use(gatewayOnly);

  const searchSchema = z.object({
    q: z.string().trim().min(1, "q is required").max(50),
  });

  /**
   * GET /users/search?q= — username/email prefix search used by the "new
   * chat" picker. Excludes the caller; results never include secrets.
   */
  router.get(
    "/users/search",
    (req, res, next) => {
      const parsed = searchSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      req.parsedQuery = parsed.data;
      next();
    },
    async (_req, res) => {
      const q = _req.parsedQuery.q;
      const me = _req.user.userId;

      const result = await pool.query(
        `SELECT id, username, created_at
         FROM users
         WHERE id <> $1 AND username ILIKE $2
         ORDER BY username
         LIMIT 20`,
        [me, `${q}%`]
      );

      res.json({
        users: result.rows.map((row) => ({
          id: row.id,
          username: row.username,
          createdAt: row.created_at,
        })),
      });
    }
  );
  /**
   * GET /users/me — returns full profile for the authenticated user
   */
  router.get("/users/me", async (req, res) => {
    const me = req.user.userId;
    const result = await pool.query(
      `SELECT id, username, email, created_at FROM users WHERE id = $1`,
      [me]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: user.created_at,
      },
    });
  });

  const patchSchema = z.object({
    username: z.string().trim().min(3).max(50).optional(),
  });

  /**
   * PATCH /users/me — update current user profile
   */
  router.patch("/users/me", async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    }
    const { username } = parsed.data;
    const me = req.user.userId;

    if (!username) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    try {
      const result = await pool.query(
        `UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username, email, created_at`,
        [username, me]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      const user = result.rows[0];
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          createdAt: user.created_at,
        },
      });
    } catch (err) {
      if (err.code === "23505" && err.constraint === "users_username_key") {
        return res.status(409).json({ error: "Username already taken" });
      }
      throw err;
    }
  });

  /**
   * GET /users/:id — returns public profile for another user
   */
  router.get("/users/:id", async (req, res) => {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, username, created_at FROM users WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        createdAt: user.created_at,
      },
    });
  });

  return router;
}
