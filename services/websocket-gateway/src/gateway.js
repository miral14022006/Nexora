import { WebSocketServer, WebSocket } from "ws";
import { verifyToken } from "@nexora/verify-jwt";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import {
  deliverChannel,
  markOfflineGrace,
  markOnline,
  onlineUserIds,
  publishReceipt,
  refreshPresence,
  subscribeDeliver,
  unsubscribeDeliver,
  redis,
} from "./redis.js";

// Close codes (1000-2999 are protocol-reserved; we use 4xxx app codes)
export const CLOSE_CODES = {
  INVALID_TOKEN: 4001,
  HEARTBEAT_TIMEOUT: 4002,
  NOT_ON_WS_PATH: 4003,
};

// userId -> Set<ws> for every connection held by THIS instance
const connections = new Map();
// userIds this instance has a pub/sub subscription for
const subscribedUsers = new Set();
const instanceId = randomUUID();

function registerConnection(ws) {
  const set = connections.get(ws.userId) ?? new Set();
  set.add(ws);
  connections.set(ws.userId, set);
}

function unregisterConnection(ws) {
  const set = connections.get(ws.userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    connections.delete(ws.userId);
    return true; // last connection for this user on this instance
  }
  return false;
}

function broadcast(userId, data) {
  const set = connections.get(userId);
  if (!set) return 0;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      sent++;
    }
  }
  return sent;
}

/**
 * Callback for a message published on a user's deliver channel (by
 * delivery-service, another gateway instance relaying typing, …). Pushes it
 * down every open socket for the user on this instance; if a message envelope
 * was actually delivered, reports a "delivered" receipt so delivery-service
 * can advance PENDING → DELIVERED and emit chat.message.delivered.
 */
function onDeliverMessage(userId, raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }

  const sent = broadcast(userId, raw);
  if (sent > 0 && envelope.type === "message" && envelope.payload?.id) {
    publishReceipt("delivered", envelope.payload.id, userId).catch(() => {});
  }
}

function sendPresence(ws, userId, status) {
  ws.send(JSON.stringify({ type: "presence", payload: { userId, status } }));
}

/**
 * Live presence fan-out: on connect/disconnect this instance publishes a
 * presence envelope to every other online user's deliver channel, so all
 * connected clients see presence dots change without polling.
 */
async function broadcastPresence(userId, status) {
  const envelope = JSON.stringify({
    type: "presence",
    payload: { userId, status },
  });
  const ids = await onlineUserIds();
  await Promise.all(
    ids
      .filter((id) => id !== userId)
      .map((id) => redis.publish(deliverChannel(id), envelope))
  );
}

/**
 * Seeds the connecting socket with the current online set.
 *
 * `broadcastPresence` only reaches users whose presence key already exists at
 * publish time, so a fresh connection could miss users that came online just
 * before it. Seeding closes that race: whichever of the two users connects
 * later either receives the seed (if the other is already online) or its own
 * broadcast (if it connected first) — one of the two paths always lands.
 */
async function seedPresence(ws, userId) {
  const ids = await onlineUserIds();
  for (const id of ids) {
    if (id === userId || ws.readyState !== WebSocket.OPEN) continue;
    ws.send(
      JSON.stringify({ type: "presence", payload: { userId: id, status: "online" } })
    );
  }
}

/**
 * Flushes PENDING messages for the user: pushes them down the socket in
 * chronological order, then batch-updates the rows to DELIVERED.
 * If lastSeq is provided, fetches any message strictly newer than lastSeq
 * or still marked PENDING.
 */
async function flushBacklog(ws, lastSeq = 0) {
  const result = await pool.query(
    `SELECT m.id, m.type, m.sender_id, m.recipient_id, m.group_id, m.content, m.created_at
     FROM message_status ms
     JOIN messages m ON m.id = ms.message_id
     WHERE ms.user_id = $1 AND (ms.status = 'PENDING' OR m.sequence_no > $2)
     ORDER BY m.sequence_no ASC`,
    [ws.userId, lastSeq]
  );

  const rows = result.rows;
  if (rows.length === 0) return;

  for (const row of rows) {
    if (ws.readyState !== WebSocket.OPEN) return; // aborted: rows stay PENDING
      ws.send(
        JSON.stringify({
          type: "message",
          payload: {
            id: row.id,
            type: row.type,
            senderId: row.sender_id,
            recipientId: row.recipient_id,
            groupId: row.group_id,
            content: row.content,
            createdAt: row.created_at,
          },
        })
      );
  }

  if (ws.readyState === WebSocket.OPEN) {
    await pool.query(
      `UPDATE message_status SET status = 'DELIVERED', updated_at = now()
       WHERE user_id = $1 AND status = 'PENDING'`,
      [ws.userId]
    );
    // Report socket-level truth so delivery-service persists + emits
    // chat.message.delivered for each flushed message.
    for (const row of rows) {
      publishReceipt("delivered", row.id, ws.userId).catch(() => {});
    }
    console.log(
      `[${config.serviceName}] backlog: ${rows.length} message(s) flushed for ${ws.userId}`
    );
  }
}

async function handleClientMessage(ws, raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return; // ignore non-JSON frames
  }

  switch (envelope.type) {
    case "ping":
      await refreshPresence(ws.userId, instanceId);
      ws.send(JSON.stringify({ type: "pong" }));
      break;

    case "typing": {
      // { type: "typing", payload: { chatId, userId, recipientId?|recipientIds? } }
      // Lowest-latency path in the system: pure Pub/Sub relay, no DB, no Kafka.
      // DIRECT chats carry recipientId; GROUP chats may fan out via
      // recipientIds (the gateway stays a dumb relay — it never resolves
      // group members on the hot path).
      const { payload } = envelope;
      if (!payload?.userId) break;
      const targets = payload.recipientIds ?? (payload.recipientId ? [payload.recipientId] : []);
      if (targets.length === 0) break;
      await Promise.all(
        targets
          .filter((target) => target !== payload.userId)
          .map((target) =>
            redis.publish(deliverChannel(target), JSON.stringify(envelope))
          )
      );
      break;
    }

    case "ack": {
      // { type: "ack", payload: { messageId } } — client displayed the message.
      // Forward-only: the rank guard (`status < 'READ'`) lets a fast ack jump
      // a still-PENDING row straight to READ and makes stale acks no-ops.
      const { payload } = envelope;
      if (payload?.messageId) {
        await pool.query(
          `UPDATE message_status SET status = 'READ', read_at = now(), updated_at = now()
           WHERE user_id = $1 AND message_id = $2 AND status < 'READ'::message_status_type`,
          [ws.userId, payload.messageId]
        );
        publishReceipt("read", payload.messageId, ws.userId).catch(() => {});
      }
      break;
    }

    default:
      break; // unknown envelope types are ignored
  }
}

async function handleConnection(ws, lastSeq) {
  const { userId, username } = ws.user;

  registerConnection(ws);
  await markOnline(userId, instanceId);
  sendPresence(ws, userId, "online");
  seedPresence(ws, userId).catch((err) =>
    console.error(`[${config.serviceName}] presence seed failed:`, err.message)
  );
  broadcastPresence(userId, "online").catch((err) =>
    console.error(`[${config.serviceName}] presence broadcast failed:`, err.message)
  );

  // Subscribe this instance to the user's deliver channel (once per user).
  // Messages published there by any service/instance are forwarded to every
  // open socket this instance holds for the user.
  if (!subscribedUsers.has(userId)) {
    await subscribeDeliver(userId, (message) => onDeliverMessage(userId, message));
    subscribedUsers.add(userId);
  }

  await flushBacklog(ws, lastSeq);

  ws.on("message", (data) => {
    handleClientMessage(ws, data.toString()).catch((err) =>
      console.error(`[${config.serviceName}] message handler error:`, err.message)
    );
  });

  ws.on("close", async () => {
    const wasLast = unregisterConnection(ws);
    if (wasLast) {
      subscribedUsers.delete(userId);
      await unsubscribeDeliver(userId).catch(() => {});
      await markOfflineGrace(userId);
      broadcastPresence(userId, "offline").catch((err) =>
        console.error(`[${config.serviceName}] presence broadcast failed:`, err.message)
      );
      console.log(
        `[${config.serviceName}] ${username} (${userId}) disconnected, presence in grace period`
      );
    }
  });

  ws.on("error", (err) => {
    console.error(`[${config.serviceName}] socket error for ${userId}:`, err.message);
  });

  console.log(
    `[${config.serviceName}] ${username} (${userId}) connected on :${config.port}`
  );
}

/**
 * Attaches the WebSocket server to an existing HTTP server.
 * Handshake: GET /ws?token=<accessToken>; invalid token => close 4001.
 */
export function attachWebSocketServer(httpServer, app) {
  const wss = new WebSocketServer({ noServer: true });

  // Heartbeat: connections that haven't pinged within the timeout are treated
  // as dead — terminated and sent through the disconnect (grace) path.
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - ws.lastPingAt > config.heartbeatTimeoutMs) {
        ws.close(CLOSE_CODES.HEARTBEAT_TIMEOUT, "Heartbeat timeout");
        ws.terminate();
      }
    }
  }, config.heartbeatCheckIntervalMs);
  heartbeatTimer.unref();

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, "http://localhost");

    if (pathname !== config.wsPath) {
      socket.write(
        "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"
      );
      socket.destroy();
      return;
    }

    const token = searchParams.get("token");
    const lastSeq = parseInt(searchParams.get("last_received_sequence") || "0", 10);
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      // Accept the upgrade so we can reject with a proper WS close code.
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_CODES.INVALID_TOKEN, "Invalid or expired token");
      });
      return;
    }

    req.nexoraUser = {
      userId: payload.userId,
      username: payload.username,
    };

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = req.nexoraUser;
      ws.userId = payload.userId;
      ws.username = payload.username;
      ws.lastPingAt = Date.now();
      handleConnection(ws, lastSeq).catch((err) => {
        console.error(`[${config.serviceName}] connect error:`, err.message);
        ws.close(CLOSE_CODES.INVALID_TOKEN, "Connection setup failed");
      });
    });
  });

  wss.on("close", () => clearInterval(heartbeatTimer));

  return wss;
}
