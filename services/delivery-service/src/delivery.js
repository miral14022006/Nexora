/**
 * Core delivery logic, kept dependency-injected so tests can run it against
 * the real Postgres/Redis while mocking Kafka.
 */

const DIRECT = "DIRECT";

/**
 * Consumes a `message.created` event (from chat-service):
 *  - writes a PENDING message_status row for every recipient;
 *  - live fast-path: recipients that are online get the client envelope
 *    pushed straight onto their Redis deliver channel — the websocket-gateway
 *    instance holding their socket fans it out with zero instance knowledge.
 *
 * The live push is idempotent: on a Kafka redelivery (at-least-once), only
 * recipients that have not been served yet are pushed — just-inserted rows,
 * plus rows still PENDING (a previous attempt crashed before the push, so no
 * `delivered` receipt ever arrived). Rows already at DELIVERED/READ were
 * pushed by an earlier attempt and are never pushed again.
 *
 * deps: { pool, isOnline, publishDeliver }
 */
export async function handleMessageCreated(event, deps) {
  const { pool, isOnline, publishDeliver } = deps;

  let recipients = [];
  if (event.type === DIRECT) {
    if (event.recipientId) recipients = [event.recipientId];
  } else if (event.type === "GROUP" && event.groupId) {
    const res = await pool.query(
      `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2`,
      [event.groupId, event.senderId]
    );
    recipients = res.rows.map((r) => r.user_id);
  }
  if (recipients.length === 0) return;

  // Only insert for recipients that still exist (handles deleted users and
  // Kafka backfill replays); duplicates are no-ops.
  const inserted = await pool.query(
    `INSERT INTO message_status (message_id, user_id, status)
     SELECT $1, u.id, 'PENDING'
     FROM users u WHERE u.id = ANY($2::uuid[])
     ON CONFLICT (message_id, user_id) DO NOTHING
     RETURNING user_id`,
    [event.messageId, recipients]
  );
  const fresh = new Set(inserted.rows.map((r) => r.user_id));

  // First processing inserts every recipient, so no extra query is needed.
  // Only on a redelivery are some (or all) rows already present — find the
  // ones that are still PENDING and re-push them.
  let liveTargets = [...fresh];
  if (fresh.size < recipients.length) {
    const pending = await pool.query(
      `SELECT user_id FROM message_status
       WHERE message_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'PENDING'`,
      [event.messageId, recipients]
    );
    liveTargets = [...liveTargets, ...pending.rows.map((r) => r.user_id)];
  }

  const envelope = {
    type: "message",
    payload: {
      id: event.messageId,
      type: event.type,
      senderId: event.senderId,
      recipientId: event.recipientId ?? null,
      groupId: event.groupId ?? null,
      content: event.content,
      membershipVersion: event.membershipVersion ?? null,
      createdAt: event.createdAt,
    },
  };

  for (const userId of liveTargets) {
    if (await isOnline(userId)) {
      await publishDeliver(userId, envelope);
    }
  }
}

/**
 * Consumes a gateway receipt (socket-level truth) and turns it into durable
 * state + a Kafka event for chat-service:
 *   delivered → advances any row below DELIVERED   (publishes chat.message.delivered)
 *   read      → advances any row below READ        (publishes chat.message.read)
 *
 * The state machine is FORWARD-ONLY and enforced at the database layer: the
 * `status` column is an ordered enum (PENDING=0 < SENT=1 < DELIVERED=2 <
 * READ=3) and the UPDATE carries `status < $3` — so an out-of-order or
 * duplicated event can never regress a row (a stale `delivered` after `read`
 * is a no-op), while a `read` may jump a still-PENDING row straight to READ
 * instead of being dropped.
 *
 * The Kafka event is published regardless of whether the row transitioned:
 * the gateway records socket truth independently, and consumers get
 * at-least-once semantics. The rank guard makes the state writes idempotent.
 *
 * The live `delivery_update` envelope (sent to the message sender / other
 * group members) is only pushed when a transition actually happened — a
 * no-op receipt must not emit a tick that regresses the sender's UI.
 *
 * deps: { pool, publishReceiptEvent, publishDeliver, isOnline }
 */
export async function handleReceipt(receipt, deps) {
  const { pool, publishReceiptEvent, publishDeliver, isOnline } = deps;

  const { type, messageId, userId } = receipt ?? {};
  if (!type || !messageId || !userId) return;

  let next;
  if (type === "delivered") {
    next = "DELIVERED";
  } else if (type === "read") {
    next = "READ";
  } else {
    return;
  }

  const result = await pool.query(
    `UPDATE message_status
     SET status = $3,
         read_at = CASE WHEN $3 = 'READ' THEN now() ELSE read_at END,
         updated_at = now()
     WHERE message_id = $1 AND user_id = $2 AND status < $3::message_status_type`,
    [messageId, userId, next]
  );

  await publishReceiptEvent(
    type === "read" ? "message.read" : "message.delivered",
    messageId,
    userId
  );

  // No transition (row already at the same or a higher rank): nothing to
  // propagate live.
  if (result.rowCount === 0) return;

  // Live tick so senders see ✓✓ / blue ✓✓ without polling.
  const message = await pool.query(
    `SELECT type, sender_id, recipient_id, group_id FROM messages WHERE id = $1`,
    [messageId]
  );
  if (message.rows.length > 0) {
    const msg = message.rows[0];
    let targets = [];
    if (msg.type === "GROUP") {
      const members = await pool.query(
        `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2`,
        [msg.group_id, userId]
      );
      targets = members.rows.map((r) => r.user_id);
    } else if (msg.type === DIRECT) {
      targets = [msg.sender_id];
    }

    if (targets.length > 0) {
      const tick = {
        type: "delivery_update",
        payload: {
          messageId,
          userId,
          status: next,
          readAt: next === "READ" ? new Date().toISOString() : null,
          conversationType: msg.type,
          groupId: msg.group_id,
          recipientId: msg.recipient_id,
        },
      };
      for (const target of targets) {
        if (await isOnline(target)) {
          await publishDeliver(target, tick);
        }
      }
    }
  }
}
