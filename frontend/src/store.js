import { create } from "zustand";
import { api, getSession, setSession } from "./api.js";

/**
 * Global client store. Chat identity:
 *   direct: "d:<userId>"   group: "g:<groupId>"
 */
export const chatIdOf = (type, id) => (type === "DIRECT" ? `d:${id}` : `g:${id}`);

const STATUS_RANK = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };
const APPEND_LIMIT = 500;

function byNewest(a, b) {
  return new Date(b.createdAt) - new Date(a.createdAt);
}

export const useStore = create((set, get) => ({
  session: getSession(),
  wsStatus: "idle", // idle | connecting | open | reconnecting
  user: null,

  conversations: [],
  conversationsLoaded: false,

  messages: {}, // chatId -> message[] (newest last)
  nextCursor: {}, // chatId -> cursor | null
  loadingHistory: {}, // chatId -> bool
  maxSequence: 0,

  typing: {}, // chatId -> { userId: true }
  presence: {}, // userId -> "online" | "offline"

  activeChat: null, // { type, id, name } — id is the peer userId / groupId
  groupMembers: {}, // groupId -> member[]

  error: null,

  // ---------- session ----------

  setSession(next) {
    setSession(next); // persist to localStorage + module var (getSession source)
    set({ session: next }); // trigger App.jsx gate → navigation / WS connect
  },
  signOut() {
    api.logout().catch(() => {});
    setSession(null);
    set({
      session: null,
      user: null,
      conversations: [],
      messages: {},
      typing: {},
      presence: {},
      activeChat: null,
      wsStatus: "idle",
    });
  },

  // ---------- conversations ----------

  async loadConversations() {
    const res = await api.conversations();
    if (!res.ok) {
      if (res.status === 401) {
        get().signOut();
        return;
      }
      return;
    }
    set({ conversations: res.data.conversations, conversationsLoaded: true });
  },

  upsertConversation(conversation) {
    const { conversations, conversationsLoaded } = get();
    if (!conversationsLoaded) return;
    const rest = conversations.filter(
      (c) => !(c.type === conversation.type && (c.userId ?? c.groupId) === (conversation.userId ?? conversation.groupId))
    );
    set({ conversations: [conversation, ...rest] });
  },

  bumpConversation(type, id, patch) {
    const { conversations } = get();
    const key = (c) => (c.userId ?? c.groupId) === id;
    const existing = conversations.find((c) => c.type === type && key(c));
    if (!existing) return;
    const updated = { ...existing, ...patch };
    set({
      conversations: [
        updated,
        ...conversations.filter((c) => !(c.type === type && key(c))),
      ],
    });
  },

  // ---------- messages ----------

  appendMessage(message, { incoming = false } = {}) {
    const chatId = chatIdOf(message.type, message.type === "DIRECT" ? message.senderId === get().user?.id ? message.recipientId : message.senderId : message.groupId);
    const list = get().messages[chatId] ?? [];
    if (list.some((m) => m.id === message.id)) return;
    const next = [...list, message].slice(-APPEND_LIMIT);
    set({
      messages: { ...get().messages, [chatId]: next },
      maxSequence: Math.max(get().maxSequence, message.sequenceNo || 0),
    });
    return chatId;
  },

  async loadHistory(chatId) {
    const { activeChat, loadingHistory, nextCursor } = get();
    if (loadingHistory[chatId]) return;
    const chat = activeChat?.id === chatId ? activeChat : get().activeChat;
    if (!chat) return;
    const cursor = nextCursor[chatId];
    if (cursor === null && get().messages[chatId]?.length) return; // fully loaded

    set({ loadingHistory: { ...loadingHistory, [chatId]: true } });
    const res =
      chat.type === "DIRECT"
        ? await api.directHistory(chat.id, cursor)
        : await api.groupHistory(chat.id, cursor);
    set({ loadingHistory: { ...get().loadingHistory, [chatId]: false } });
    if (!res.ok) return;

    const existing = get().messages[chatId] ?? [];
    const known = new Set(existing.map((m) => m.id));
    const fresh = res.data.messages.filter((m) => !known.has(m.id));
    
    let localMax = get().maxSequence;
    for (const m of res.data.messages) {
      if (m.sequenceNo) localMax = Math.max(localMax, m.sequenceNo);
    }

    set({
      messages: { ...get().messages, [chatId]: [...fresh.reverse(), ...existing].slice(-APPEND_LIMIT) },
      nextCursor: { ...get().nextCursor, [chatId]: res.data.nextCursor },
      maxSequence: localMax,
    });
  },

  async retryMessage(message) {
    const { patchMessage, appendMessage } = get();
    patchMessage(message.clientMsgId, { status: "PENDING" });
    
    let res = null;
    let lastError = null;
    const SEND_MAX_ATTEMPTS = 4;
    const SEND_BASE_DELAY_MS = 1000;
    const SEND_JITTER_MAX_MS = 300;

    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      try {
        res = await api.sendMessage(message);
      } catch (err) {
        res = null;
        lastError = err;
      }

      if (res?.ok) {
        const saved = res.data.message;
        patchMessage(message.clientMsgId, { ...saved, status: "SENT" });
        const chatId = chatIdOf(message.type, message.type === "DIRECT" ? message.senderId === get().user?.id ? message.recipientId : message.senderId : message.groupId);
        get().bumpConversation(message.type, chatId, {
          lastMessage: {
            id: saved.id,
            content: saved.content,
            senderId: saved.senderId,
            createdAt: saved.createdAt,
          },
        });
        return true;
      }

      const status = res?.status ?? 0;
      if (res && status < 500 && status !== 429) {
        get().setError(res.error ?? `Failed to send message (${status})`);
        patchMessage(message.clientMsgId, { status: "FAILED" });
        return false;
      }
      if (attempt === SEND_MAX_ATTEMPTS) break;

      const delay = SEND_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * SEND_JITTER_MAX_MS);
      await new Promise((r) => setTimeout(r, delay));
    }
    
    get().setError(
      res?.status
        ? `Message not sent after ${SEND_MAX_ATTEMPTS} attempts — it was saved but delivery may be delayed`
        : `Message not sent after ${SEND_MAX_ATTEMPTS} attempts: ${lastError?.message ?? "network error"}`
    );
    patchMessage(message.clientMsgId, { status: "FAILED" });
    return false;
  },

  patchMessage(messageId, patch) {
    const { messages } = get();
    for (const [chatId, list] of Object.entries(messages)) {
      if (list.some((m) => m.id === messageId || m.clientMsgId === messageId)) {
        set({
          messages: {
            ...messages,
            [chatId]: list.map((m) => {
              if (m.id !== messageId && m.clientMsgId !== messageId) return m;
              const merged = { ...m, ...patch };
              // Forward-only state machine (PENDING → SENT → DELIVERED → READ),
              // mirroring the server-side rank guard: an out-of-order
              // delivery_update (e.g. a stale "delivered" tick arriving after
              // the UI already shows "read") must never regress display state.
              if (
                patch.status &&
                m.status &&
                (STATUS_RANK[patch.status] ?? -1) < (STATUS_RANK[m.status] ?? -1)
              ) {
                merged.status = m.status;
                merged.readAt = m.readAt;
              }
              return merged;
            }),
          },
        });
        return;
      }
    }
  },

  // ---------- active chat / read state ----------

  openChat(chat) {
    set({ activeChat: chat, typing: { ...get().typing, [chatIdOf(chat.type, chat.id)]: {} } });
    get().loadHistory(chatIdOf(chat.type, chat.id));
    if (chat.type === "GROUP") get().loadGroupMembers(chat.id);
    get().markVisibleRead(chat);
    get().seedPresence(chat);
  },

  async markVisibleRead(chat) {
    const chatKey = chatIdOf(chat.type, chat.id);
    const list = get().messages[chatKey] ?? [];
    const me = get().user?.id;
    const incomingUnread = list.filter(
      (m) => m.senderId !== me && m.status !== "READ"
    );
    for (const m of incomingUnread) {
      await api.markRead(m.id);
      get().patchMessage(m.id, { status: "READ" });
    }
    if (incomingUnread.length > 0) {
      get().bumpConversation(chat.type, chat.id, { unread: 0 });
      get().refreshUnreadCounts();
    }
  },

  async refreshUnreadCounts() {
    const res = await api.conversations();
    if (!res.ok) return;
    set({ conversations: res.data.conversations });
  },

  // ---------- presence ----------

  async seedPresence(chat) {
    const ids = [];
    if (chat.type === "DIRECT") ids.push(chat.id);
    else {
      const members = get().groupMembers[chat.id] ?? [];
      ids.push(...members.map((m) => m.userId));
    }
    const res = await api.presence(ids.filter((id) => id !== get().user?.id));
    if (!res.ok) return;
    set({ presence: { ...get().presence, ...res.data.presence } });
  },

  setPresence(userId, status) {
    set({ presence: { ...get().presence, [userId]: status } });
  },

  // ---------- typing ----------

  setTyping(chatId, userId, isTyping) {
    const current = get().typing[chatId] ?? {};
    set({
      typing: {
        ...get().typing,
        [chatId]: isTyping ? { ...current, [userId]: true } : { ...current, [userId]: false },
      },
    });
  },

  // ---------- groups ----------

  async loadGroupMembers(groupId) {
    const res = await api.groupMembers(groupId);
    if (!res.ok) return;
    set({ groupMembers: { ...get().groupMembers, [groupId]: res.data.members } });
  },

  // ---------- misc ----------

  setWsStatus(wsStatus) {
    set({ wsStatus });
  },

  setUser(user) {
    set({ user });
  },

  setError(error) {
    set({ error });
  },
}));

/** Sorted per-chat messages (newest last) — selector helper. */
export const selectMessages = (state, chatId) => [...(state.messages[chatId] ?? [])];

/** Unread badge counts per chat. */
export const selectUnread = (state) =>
  Object.fromEntries(
    state.conversations.map((c) => [chatIdOf(c.type, c.userId ?? c.groupId), c.unread ?? 0])
  );
