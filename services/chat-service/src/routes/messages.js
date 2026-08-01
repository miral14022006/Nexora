import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { gatewayOnly } from "@nexora/internal-auth";
import { pool } from "../db/pool.js";
import { publishMessageEvent as realPublish } from "../kafka.js";
import { publishReadReceipt as realReadReceipt } from "../redis.js";
import {
  asyncHandler,
  createMessageSchema,
  historyQuerySchema,
  validate,
  validateParams,
  validateQuery,
} from "../validators/messages.js";

export function createMessagesRouter({
  publishMessageEvent = realPublish,
  publishReadReceipt = realReadReceipt,
} = {}) {
  const router = Router();

  router.use(gatewayOnly);

  const uuidParam = z.string().uuid("Must be a valid UUID");
  const directHistorySchema = z.object({ userId: uuidParam });
  const groupHistorySchema = z.object({ groupId: uuidParam });

  function toMessage(row) {
    return {
      id: row.id,
      type: row.type,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      groupId: row.group_id,
      content: row.content,
      sequenceNo: row.sequence_no,
      clientMsgId: row.client_msg_id,
      membershipVersion: row.membership_version,
      createdAt: row.created_at,
    };
  }

  function encodeCursor(row) {
    return `${row.created_at.toISOString()}_${row.id}`;
  }

  function decodeCursor(cursor) {
    const [createdAt, id] = cursor.split("_");
    return { createdAt, id };
  }

  async function assertGroupMembership(userId, groupId, res) {
    const group = await pool.query(`SELECT id, membership_version FROM groups WHERE id = $1`, [
      groupId,
    ]);
    if (group.rows.length === 0) {
      res.status(404).json({ error: "Group not found" });
      return false;
    }

    const member = await pool.query(
      `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (member.rows.length === 0) {
      res.status(403).json({ error: "You are not a member of this group" });
      return false;
    }
    return group.rows[0].membership_version;
  }

  async function assertMessageParticipant(userId, message, res) {
    if (message.type === "GROUP") {
      return assertGroupMembership(userId, message.group_id, res);
    }
    if (message.sender_id !== userId && message.recipient_id !== userId) {
      res.status(403).json({ error: "You are not part of this conversation" });
      return false;
    }
    return true;
  }

  router.post(
    "/messages",
    validate(createMessageSchema),
    asyncHandler(async (req, res) => {
      const { type, recipientId, groupId, content } = req.body;
      const senderId = req.user.userId;

      // Idempotency contract: a client-generated client_msg_id lets the server
      // dedupe retries. Only an explicit client_msg_id enables dedupe — the
      // conversation_id is a target alias, not a retry key.
      const clientSuppliedKey = req.body.client_msg_id ?? null;
      const finalRecipientId = type === "DIRECT"
        ? (recipientId ?? req.body.conversation_id ?? null)
        : null;
      const finalGroupId = type === "GROUP"
        ? (groupId ?? req.body.conversation_id ?? null)
        : null;

      let membershipVersion = null;
      if (type === "GROUP") {
        membershipVersion = await assertGroupMembership(senderId, finalGroupId, res);
        if (!membershipVersion) return;
      }

      const fetchById = async (messageId) => {
        const hit = await pool.query(
          `SELECT id, type, sender_id, recipient_id, group_id, content, client_msg_id, sequence_no, membership_version, created_at
           FROM messages WHERE id = $1`,
          [messageId]
        );
        return hit.rows[0] ?? null;
      };

      const fetchByClientKey = async () => {
        const hit = await pool.query(
          `SELECT id, type, sender_id, recipient_id, group_id, content, client_msg_id, sequence_no, membership_version, created_at
           FROM messages WHERE sender_id = $1 AND client_msg_id = $2`,
          [senderId, clientSuppliedKey]
        );
        return hit.rows[0] ?? null;
      };

      // Deliver one message: publish to Kafka, then send the response. The
      // publish is safe to repeat for an already-stored message because the
      // delivery-service insert is ON CONFLICT-idempotent (and its live Redis
      // publish only fires for rows that were actually inserted).
      const deliver = async (message) => {
        try {
          await publishMessageEvent(message);
        } catch (err) {
          console.error(
            `[chat-service] failed to publish message ${message.id} to Kafka:`,
            err.message
          );
          return res.status(502).json({
            error: "Message saved but event publish failed",
          });
        }
        res.status(200).json({ message: toMessage(message) });
      };

      if (clientSuppliedKey) {
        const existing = await fetchByClientKey();
        if (existing) {
          console.warn(
            `[chat-service] dedupe hit: message ${existing.id} already exists for ` +
              `sender ${senderId} with client_msg_id ${clientSuppliedKey} — returning existing`
          );
          return deliver(existing);
        }
      }

      const key = clientSuppliedKey ?? randomUUID();
      if (!clientSuppliedKey) {
        console.warn(
          `[chat-service] message from sender ${senderId} has no client_msg_id — ` +
            `generated ${key} server-side; client retries will not be deduped`
        );
      }

      let message = null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const convId = type === "GROUP"
          ? `g:${finalGroupId}`
          : `d:${[senderId, finalRecipientId].sort().join("_")}`;

        const seqRes = await client.query(
          `INSERT INTO conversation_sequences (conversation_id, next_seq)
           VALUES ($1, 2)
           ON CONFLICT (conversation_id) DO UPDATE SET next_seq = conversation_sequences.next_seq + 1
           RETURNING next_seq - 1 AS assigned_seq`,
          [convId]
        );
        const assignedSeq = seqRes.rows[0].assigned_seq;

        const inserted = await client.query(
          `INSERT INTO messages (type, sender_id, recipient_id, group_id, content, client_msg_id, sequence_no, membership_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, type, sender_id, recipient_id, group_id, content, client_msg_id, sequence_no, membership_version, created_at`,
          [type, senderId, finalRecipientId, finalGroupId, content, key, assignedSeq, membershipVersion]
        );
        message = inserted.rows[0];
        // The sender's own row starts at SENT — the message is persisted and
        // queued for delivery (step 2 of the 4-state machine; recipient rows
        // start at PENDING, written by delivery-service when the event lands).
        await client.query(
          `INSERT INTO message_status (message_id, user_id, status)
           VALUES ($1, $2, 'SENT')
           ON CONFLICT (message_id, user_id) DO NOTHING`,
          [message.id, senderId]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.code === "23505") {
          const winner = await fetchByClientKey();
          if (winner) {
            console.warn(
              `[chat-service] unique-violation retry: concurrent duplicate of ` +
                `message ${winner.id} for client_msg_id ${clientSuppliedKey} — returning existing`
            );
            return deliver(winner);
          }
        }
        throw err;
      } finally {
        client.release();
      }

      return deliver(message);
    })
  );

  router.get(
    "/messages/direct/:userId",
    validateParams(directHistorySchema),
    validateQuery(historyQuerySchema),
    asyncHandler(async (req, res) => {
      const me = req.user.userId;
      const other = req.params.userId;
      const limit = req.query.limit ?? 50;
      const { createdAt, id } = req.query.cursor
        ? decodeCursor(req.query.cursor)
        : { createdAt: null, id: null };

      const result = await pool.query(
        `SELECT id, type, sender_id, recipient_id, group_id, content, created_at
         FROM messages
         WHERE (
           (sender_id = $1 AND recipient_id = $2)
           OR (sender_id = $2 AND recipient_id = $1)
         )
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
         ORDER BY sequence_no DESC
         LIMIT $5`,
        [me, other, createdAt, id, limit]
      );

      const messages = result.rows.map(toMessage);
      const nextCursor =
        messages.length === limit ? encodeCursor(result.rows.at(-1)) : null;

      res.json({ messages, nextCursor });
    })
  );

  router.get(
    "/messages/group/:groupId",
    validateParams(groupHistorySchema),
    validateQuery(historyQuerySchema),
    asyncHandler(async (req, res) => {
      const groupId = req.params.groupId;

      const ok = await assertGroupMembership(req.user.userId, groupId, res);
      if (!ok) return;

      const limit = req.query.limit ?? 50;
      const { createdAt, id } = req.query.cursor
        ? decodeCursor(req.query.cursor)
        : { createdAt: null, id: null };

      const result = await pool.query(
        `SELECT id, type, sender_id, recipient_id, group_id, content, created_at
         FROM messages
         WHERE group_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
         ORDER BY sequence_no DESC
         LIMIT $4`,
        [groupId, createdAt, id, limit]
      );

      const messages = result.rows.map(toMessage);
      const nextCursor =
        messages.length === limit ? encodeCursor(result.rows.at(-1)) : null;

      res.json({ messages, nextCursor });
    })
  );

  /**
   * GET /conversations — sidebar feed: the latest message (and unread count)
   * per direct counterpart and per group the caller belongs to, sorted by
   * most recent activity.
   */
  router.get(
    "/conversations",
    asyncHandler(async (req, res) => {
      const me = req.user.userId;

      const direct = await pool.query(
        `SELECT DISTINCT ON (other_id)
                other_id, id, content, sender_id, created_at
         FROM (
           SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END
                    AS other_id, id, content, sender_id, created_at
           FROM messages
           WHERE (sender_id = $1 OR recipient_id = $1) AND type = 'DIRECT'
         ) t
         ORDER BY other_id, created_at DESC, id DESC`,
        [me]
      );

      const groups = await pool.query(
        `SELECT g.id, g.name, m.id AS message_id, m.content, m.sender_id, m.created_at
         FROM groups g
         JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
         LEFT JOIN LATERAL (
           SELECT id, content, sender_id, created_at
           FROM messages
           WHERE group_id = g.id
           ORDER BY created_at DESC, id DESC
           LIMIT 1
         ) m ON true`,
        [me]
      );

      const directUnread = await pool.query(
        `SELECT other_id, COUNT(*)::int AS unread
         FROM (
           SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END
                    AS other_id, id
           FROM messages
           WHERE (sender_id = $1 OR recipient_id = $1)
             AND type = 'DIRECT'
             AND sender_id <> $1
             AND NOT EXISTS (
               SELECT 1 FROM message_status ms
               WHERE ms.message_id = messages.id AND ms.user_id = $1
                 AND ms.status = 'READ'
             )
         ) t
         GROUP BY other_id`,
        [me]
      );

      const groupUnread = await pool.query(
        `SELECT group_id, COUNT(*)::int AS unread
         FROM messages
         WHERE type = 'GROUP'
           AND sender_id <> $1
           AND group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)
           AND NOT EXISTS (
             SELECT 1 FROM message_status ms
             WHERE ms.message_id = messages.id AND ms.user_id = $1
               AND ms.status = 'READ'
           )
         GROUP BY group_id`,
        [me]
      );

      const directUnreadMap = new Map(
        directUnread.rows.map((r) => [r.other_id, r.unread])
      );
      const groupUnreadMap = new Map(
        groupUnread.rows.map((r) => [r.group_id, r.unread])
      );

      const counterpartIds = direct.rows.map((r) => r.other_id);
      const users = counterpartIds.length
        ? await pool.query(
            `SELECT id, username FROM users WHERE id = ANY($1)`,
            [counterpartIds]
          )
        : { rows: [] };
      const userMap = new Map(users.rows.map((r) => [r.id, r.username]));

      const conversations = [
        ...direct.rows.map((row) => ({
          type: "DIRECT",
          userId: row.other_id,
          name: userMap.get(row.other_id) ?? "Unknown",
          lastMessage:
            row.id === null
              ? null
              : {
                  id: row.id,
                  content: row.content,
                  senderId: row.sender_id,
                  createdAt: row.created_at,
                },
          unread: directUnreadMap.get(row.other_id) ?? 0,
        })),
        ...groups.rows.map((row) => ({
          type: "GROUP",
          groupId: row.id,
          name: row.name,
          lastMessage:
            row.message_id === null
              ? null
              : {
                  id: row.message_id,
                  content: row.content,
                  senderId: row.sender_id,
                  createdAt: row.created_at,
                },
          unread: groupUnreadMap.get(row.id) ?? 0,
        })),
      ];

      conversations.sort((a, b) => {
        const at = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
        const bt = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
        return bt - at;
      });

      res.json({ conversations });
    })
  );

  /**
   * PATCH /messages/:id/read — the reader's client marks the message as
   * viewed: status READ + read_at. A read_receipt WS event is pushed to the
   * sender (and other group members) via the gateway's deliver channels.
   */
  router.patch(
    "/messages/:id/read",
    validateParams(z.object({ id: uuidParam })),
    asyncHandler(async (req, res) => {
      const readerId = req.user.userId;
      const message = await pool.query(
        `SELECT id, type, sender_id, recipient_id, group_id FROM messages WHERE id = $1`,
        [req.params.id]
      );
      if (message.rows.length === 0) {
        return res.status(404).json({ error: "Message not found" });
      }
      const msg = message.rows[0];

      // Only the recipient (DIRECT) or a group member (GROUP) can mark read.
      if (msg.type === "DIRECT" && msg.recipient_id !== readerId) {
        return res.status(403).json({ error: "Only the recipient can mark a DIRECT message as read" });
      }
      if (msg.type === "GROUP") {
        const ok = await assertGroupMembership(readerId, msg.group_id, res);
        if (!ok) return;
      }

      await pool.query(
        `INSERT INTO message_status (message_id, user_id, status, read_at)
         VALUES ($1, $2, 'READ', now())
         ON CONFLICT (message_id, user_id)
         DO UPDATE SET status = 'READ', read_at = now(), updated_at = now()`,
        [msg.id, readerId]
      );

      const targets =
        msg.type === "GROUP"
          ? (
              await pool.query(
                `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2`,
                [msg.group_id, readerId]
              )
            ).rows.map((r) => r.user_id)
          : [msg.sender_id];

      try {
        await publishReadReceipt(msg.id, readerId, targets);
      } catch (err) {
        console.error(
          `[chat-service] failed to push read_receipt for ${msg.id}:`,
          err.message
        );
      }

      res.json({
        messageId: msg.id,
        status: "READ",
        readAt: new Date().toISOString(),
      });
    })
  );

  /**
   * GET /messages/:id/status — per-user delivery/read state for a message
   * (frontend renders "delivered to N/M, read by K/M").
   */
  router.get(
    "/messages/:id/status",
    validateParams(z.object({ id: uuidParam })),
    asyncHandler(async (req, res) => {
      const message = await pool.query(
        `SELECT id, type, sender_id, recipient_id, group_id FROM messages WHERE id = $1`,
        [req.params.id]
      );
      if (message.rows.length === 0) {
        return res.status(404).json({ error: "Message not found" });
      }
      const msg = message.rows[0];

      const ok = await assertMessageParticipant(req.user.userId, msg, res);
      if (!ok) return;

      const statuses = await pool.query(
        `SELECT ms.user_id, ms.status, ms.read_at
         FROM message_status ms
         WHERE ms.message_id = $1
         ORDER BY ms.user_id`,
        [msg.id]
      );

      res.json({
        messageId: msg.id,
        type: msg.type,
        statuses: statuses.rows.map((row) => ({
          userId: row.user_id,
          role: row.user_id === msg.sender_id ? "sender" : "recipient",
          status: row.status,
          readAt: row.read_at,
        })),
        counts: {
          // All four states of the forward-only machine: the sender's own row
          // is SENT (persisted), recipient rows start at PENDING and advance
          // to DELIVERED then READ; `delivered` counts reached at least
          // DELIVERED, `read` is a subset of it.
          pending: statuses.rows.filter((r) => r.status === "PENDING").length,
          sent: statuses.rows.filter((r) => r.status === "SENT").length,
          delivered: statuses.rows.filter((r) =>
            ["DELIVERED", "READ"].includes(r.status)
          ).length,
          read: statuses.rows.filter((r) => r.status === "READ").length,
        },
      });
    })
  );

  return router;
}
