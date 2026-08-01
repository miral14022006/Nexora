import { Router } from "express";
import { z } from "zod";
import { gatewayOnly } from "@nexora/internal-auth";
import { pool } from "../db/pool.js";

const uuid = z.string().uuid("Must be a valid UUID");

export function createGroupsRouter() {
  const router = Router();

  router.use(gatewayOnly);

  async function assertMember(userId, groupId, res) {
    const member = await pool.query(
      `SELECT gm.role FROM group_members gm WHERE gm.group_id = $1 AND gm.user_id = $2`,
      [groupId, userId]
    );
    if (member.rows.length === 0) {
      res.status(403).json({ error: "You are not a member of this group" });
      return null;
    }
    return member.rows[0].role;
  }

  async function assertAdmin(userId, groupId, res) {
    const role = await assertMember(userId, groupId, res);
    if (role !== "admin") {
      res.status(403).json({ error: "Only admins can do that" });
      return false;
    }
    return true;
  }

  function toMember(row) {
    return {
      userId: row.user_id,
      username: row.username,
      role: row.role,
      joinedAt: row.joined_at,
    };
  }

  /** POST /groups { name } — creates a group; the caller becomes admin. */
  router.post(
    "/groups",
    async (req, res) => {
      const parsed = z
        .object({ name: z.string().trim().min(1).max(100) })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const group = await client.query(
          `INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id, created_at`,
          [parsed.data.name, req.user.userId]
        );
        await client.query(
          `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
          [group.rows[0].id, req.user.userId]
        );
        await client.query("COMMIT");
        res.status(201).json({
          group: {
            id: group.rows[0].id,
            name: group.rows[0].name,
            ownerId: group.rows[0].owner_id,
            createdAt: group.rows[0].created_at,
          },
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  );

  /** GET /groups — groups the caller belongs to. */
  router.get("/groups", async (req, res) => {
    const result = await pool.query(
      `SELECT g.id, g.name, g.owner_id, g.created_at, gm.role
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [req.user.userId]
    );
    res.json({
      groups: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        ownerId: row.owner_id,
        role: row.role,
        createdAt: row.created_at,
      })),
    });
  });

  /** GET /groups/:id/members — member list with roles. */
  router.get(
    "/groups/:id/members",
    async (req, res) => {
      const parsed = uuid.safeParse(req.params.id);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid group id" });
      }
      const role = await assertMember(req.user.userId, parsed.data, res);
      if (role === null) return;

      const result = await pool.query(
        `SELECT gm.user_id, u.username, gm.role, gm.joined_at
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1
         ORDER BY gm.joined_at ASC`,
        [parsed.data]
      );
      res.json({
        groupId: parsed.data,
        members: result.rows.map(toMember),
      });
    }
  );

  /** POST /groups/:id/members { userId } — admin adds a member. */
  router.post(
    "/groups/:id/members",
    async (req, res) => {
      const groupId = req.params.id;
      const body = z.object({ userId: uuid }).safeParse(req.body);
      if (!uuid.safeParse(groupId).success || !body.success) {
        return res.status(400).json({ error: "Validation failed" });
      }
      const admin = await assertAdmin(req.user.userId, groupId, res);
      if (!admin) return;

      await pool.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, body.data.userId]
      );
      await pool.query(
        `UPDATE groups SET membership_version = membership_version + 1 WHERE id = $1`,
        [groupId]
      );

      const result = await pool.query(
        `SELECT gm.user_id, u.username, gm.role, gm.joined_at
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1 ORDER BY gm.joined_at ASC`,
        [groupId]
      );
      res.json({ members: result.rows.map(toMember) });
    }
  );

  /** DELETE /groups/:id/members/:userId — admin removes a member. */
  router.delete(
    "/groups/:id/members/:userId",
    async (req, res) => {
      const { id, userId } = req.params;
      if (!uuid.safeParse(id).success || !uuid.safeParse(userId).success) {
        return res.status(400).json({ error: "Invalid id" });
      }
      const admin = await assertAdmin(req.user.userId, id, res);
      if (!admin) return;

      const owner = await pool.query(
        `SELECT owner_id FROM groups WHERE id = $1`,
        [id]
      );
      if (owner.rows.length === 0) {
        return res.status(404).json({ error: "Group not found" });
      }
      if (owner.rows[0].owner_id === userId) {
        return res.status(400).json({ error: "The owner cannot be removed" });
      }

      const removed = await pool.query(
        `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 RETURNING user_id`,
        [id, userId]
      );
      if (removed.rows.length > 0) {
        await pool.query(
          `UPDATE groups SET membership_version = membership_version + 1 WHERE id = $1`,
          [id]
        );
      }
      if (removed.rows.length === 0) {
        return res.status(404).json({ error: "Member not found" });
      }
      res.json({ removedUserId: userId });
    }
  );

  /** POST /groups/:id/leave — the caller leaves the group. */
  router.post(
    "/groups/:id/leave",
    async (req, res) => {
      const parsed = uuid.safeParse(req.params.id);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid group id" });
      }
      const removed = await pool.query(
        `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 RETURNING user_id`,
        [parsed.data, req.user.userId]
      );
      if (removed.rows.length > 0) {
        await pool.query(
          `UPDATE groups SET membership_version = membership_version + 1 WHERE id = $1`,
          [parsed.data]
        );
      }
      if (removed.rows.length === 0) {
        return res.status(404).json({ error: "You are not a member of this group" });
      }
      res.json({ leftGroupId: parsed.data });
    }
  );

  return router;
}
