/**
 * Core notification logic, dependency-injected for tests.
 *
 * For every recipient of a message that is OFFLINE at delivery time, logs a
 * clear "push notification would be sent here" stub — the marked integration
 * point where a real APNs / FCM / Web Push provider call would go. Online
 * recipients are covered by the live WebSocket path and get no push.
 *
 * deps: { pool, isOnline, log }
 */
export async function handleMessageCreated(event, deps) {
  const { pool, isOnline, log } = deps;

  let recipients = [];
  if (event.type === "DIRECT") {
    if (event.recipientId) recipients = [event.recipientId];
  } else if (event.type === "GROUP" && event.groupId) {
    const res = await pool.query(
      `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2`,
      [event.groupId, event.senderId]
    );
    recipients = res.rows.map((r) => r.user_id);
  }
  if (recipients.length === 0) return;

  // Only consider recipients that still exist (deleted users / backfill).
  const existing = await pool.query(
    `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
    [recipients]
  );

  for (const { id: userId } of existing.rows) {
    const online = await isOnline(userId);
    if (online) {
      log(
        `skip: ${userId} is online — live WebSocket delivery covers them (message ${event.messageId})`
      );
    } else {
      log(
        `PUSH STUB — ${userId} is offline: a push notification WOULD be sent for message ${event.messageId} from ${event.senderId} ` +
        `(integration point: replace this log with an APNs/FCM/WebPush provider call)`
      );
    }
  }
}
