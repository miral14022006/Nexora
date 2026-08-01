import { api, getSession, setSession, wsUrl } from "./api.js";
import { chatIdOf, useStore } from "./store.js";

/**
 * Single WebSocket connection to the websocket-gateway (via the API gateway's
 * /ws upgrade), with exponential-backoff reconnection. On close code 4001 the
 * access token is refreshed once and the socket is re-established with the
 * fresh token; if refresh fails the user is signed out.
 */

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 20_000;

let socket = null;
let backoffMs = INITIAL_BACKOFF_MS;
let pingTimer = null;
let closedByUser = false;

export function connectSocket() {
  const session = getSession();
  if (!session?.accessToken) return;

  closedByUser = false;
  const url = wsUrl();

  useStore.getState().setWsStatus("connecting");
  socket = new WebSocket(url);

  socket.onopen = () => {
    backoffMs = INITIAL_BACKOFF_MS;
    useStore.getState().setWsStatus("open");
    pingTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  };

  socket.onmessage = (event) => {
    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEnvelope(envelope);
  };

  socket.onclose = (event) => {
    clearInterval(pingTimer);
    socket = null;
    if (closedByUser) return;

    // Access token invalid/expired: try one refresh, then reconnect.
    if (event.code === 4001) {
      useStore.getState().setWsStatus("connecting");
      refreshAndReconnect();
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = () => {
    // close event follows; nothing to do here.
  };
}

async function refreshAndReconnect() {
  const session = getSession();
  if (!session?.refreshToken) {
    useStore.getState().signOut();
    return;
  }
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!res.ok) {
    useStore.getState().signOut();
    return;
  }
  const tokens = await res.json();
  setSession({ ...session, ...tokens });
  connectSocket();
}

function scheduleReconnect() {
  useStore.getState().setWsStatus("reconnecting");
  setTimeout(() => {
    if (!closedByUser && getSession()?.accessToken) connectSocket();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

export function disconnectSocket() {
  closedByUser = true;
  clearInterval(pingTimer);
  socket?.close(1000, "Signed out");
  socket = null;
}

// ---------- envelope handling ----------

function handleEnvelope(envelope) {
  const store = useStore.getState();
  const me = store.user?.id;

  switch (envelope.type) {
    case "message": {
      const msg = envelope.payload;
      if (!msg?.id) return;
      const incoming = msg.senderId !== me;

      const chatId = chatIdOf(
        msg.type,
        msg.type === "DIRECT"
          ? msg.senderId === me
            ? msg.recipientId
            : msg.senderId
          : msg.groupId
      );

      store.appendMessage(msg, { incoming });
      store.bumpConversation(msg.type, msg.type === "DIRECT" ? (msg.senderId === me ? msg.recipientId : msg.senderId) : msg.groupId, {
        lastMessage: {
          id: msg.id,
          content: msg.content,
          senderId: msg.senderId,
          createdAt: msg.createdAt,
        },
        ...(incoming ? { unread: 1 } : {}),
      });

      if (incoming && store.activeChat && chatId === chatIdOf(store.activeChat.type, store.activeChat.id)) {
        // Displayed: mark read so the sender sees the blue ticks.
        api.markRead(msg.id).then(() => store.patchMessage(msg.id, { status: "READ" }));
      }
      break;
    }

    case "delivery_update": {
      const p = envelope.payload;
      if (!p?.messageId) break;
      store.patchMessage(p.messageId, {
        status: p.status,
        readAt: p.readAt ?? undefined,
        updatedBy: p.userId,
      });
      break;
    }

    case "read_receipt": {
      // chat-service pushes this directly when a reader marks a message read
      // via PATCH /messages/:id/read.
      const p = envelope.payload;
      if (!p?.messageId) break;
      store.patchMessage(p.messageId, {
        status: "READ",
        readAt: new Date().toISOString(),
        updatedBy: p.userId,
      });
      break;
    }

    case "presence": {
      const p = envelope.payload;
      if (p?.userId) store.setPresence(p.userId, p.status);
      break;
    }

    case "typing": {
      const p = envelope.payload;
      if (!p?.userId || p.userId === me) break;
      const chatId = p.chatId ?? p.recipientId ?? p.groupId;
      if (!chatId) break;
      const key = p.chatId ? p.chatId : chatIdOf("DIRECT", p.recipientId);
      store.setTyping(key, p.userId, p.isTyping !== false);
      if (p.isTyping !== false) {
        setTimeout(() => store.setTyping(key, p.userId, false), 4000);
      }
      break;
    }

    case "pong":
      // Heartbeat reply — nothing to do.
      break;

    default:
      break;
  }
}

// ---------- outbound helpers ----------

/** Notifies the peer that we are typing (throttled upstream). */
export function sendTyping(chat, isTyping) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const me = useStore.getState().user?.id;
  const payload = { chatId: chatIdOf(chat.type, chat.id), userId: me, isTyping };
  if (chat.type === "DIRECT") {
    payload.recipientId = chat.id;
  } else {
    const members = useStore.getState().groupMembers[chat.id] ?? [];
    payload.recipientIds = members.map((m) => m.userId).filter((id) => id !== me);
  }
  socket.send(JSON.stringify({ type: "typing", payload }));
}
