import { useMemo } from "react";
import { getSession } from "../api.js";
import { useStore } from "../store.js";
import { formatTime } from "../format.js";
import { parseMediaContent } from "../media.js";
import Avatar from "./Avatar.jsx";
import MediaMessage from "./MediaMessage.jsx";

function Ticks({ message }) {
  const me = getSession()?.user?.id;
  if (message.senderId !== me) return null;

  const status = message.status;
  if (status === "READ") {
    return (
      <span className="ml-1 text-[10px]" title={`Read ${message.readAt ? formatTime(message.readAt) : ""}`} style={{ color: "var(--nm-accent)" }}>
        ✓✓
      </span>
    );
  }
  if (status === "DELIVERED") {
    return (
      <span className="ml-1 text-[10px]" title="Delivered" style={{ color: "var(--nm-text-muted)" }}>
        ✓✓
      </span>
    );
  }
  return (
    <span className="ml-1 text-[10px]" title="Sent" style={{ color: "var(--nm-text-faint)" }}>
      ✓
    </span>
  );
}

function DayDivider({ iso }) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  let label;
  if (d.toDateString() === today.toDateString()) label = "Today";
  else if (d.toDateString() === yesterday.toDateString()) label = "Yesterday";
  else label = d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="my-4 flex items-center justify-center">
      <span
        className="nm-raised-sm rounded-full px-4 py-1.5 text-[11px] font-medium"
        style={{ color: "var(--nm-text-muted)" }}
      >
        {label}
      </span>
    </div>
  );
}

export default function ChatWindow() {
  const user = useStore((s) => s.user);
  const activeChat = useStore((s) => s.activeChat);
  const messages = useStore((s) => s.messages);
  const nextCursor = useStore((s) => s.nextCursor);
  const loadingHistory = useStore((s) => s.loadingHistory);
  const typing = useStore((s) => s.typing);
  const presence = useStore((s) => s.presence);
  const groupMembers = useStore((s) => s.groupMembers);
  const loadHistory = useStore((s) => s.loadHistory);
  const loadGroupMembers = useStore((s) => s.loadGroupMembers);
  const seedPresence = useStore((s) => s.seedPresence);

  const chatId = activeChat ? `d:${activeChat.id}` : null;
  const groupChatId = activeChat?.type === "GROUP" ? `g:${activeChat.id}` : null;
  const key = activeChat ? (activeChat.type === "DIRECT" ? chatId : groupChatId) : null;

  const list = key ? messages[key] ?? [] : [];
  const hasOlder = key ? nextCursor[key] !== null && nextCursor[key] !== undefined : false;
  const isLoading = key ? loadingHistory[key] : false;

  const typingUsers = key ? Object.keys(typing[key] ?? {}).filter((u) => typing[key][u]) : [];
  const typingNames = typingUsers
    .map((uid) => {
      if (activeChat?.type === "GROUP") {
        return groupMembers[activeChat.id]?.find((m) => m.userId === uid)?.username ?? "Someone";
      }
      return activeChat?.name ?? "Someone";
    })
    .join(", ");

  const onScroll = (e) => {
    if (e.target.scrollTop < 40 && hasOlder && !isLoading && key) {
      loadHistory(key);
    }
  };

  const grouped = useMemo(() => {
    const out = [];
    let lastDay = null;
    for (const m of list) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) {
        out.push({ type: "divider", iso: m.createdAt });
        lastDay = day;
      }
      out.push({ type: "message", message: m });
    }
    return out;
  }, [list]);

  if (!activeChat) {
    return (
      <main
        className="hidden md:flex flex-1 items-center justify-center"
        style={{ background: "var(--nm-bg)" }}
      >
        <div className="text-center">
          <p className="text-3xl font-bold font-display" style={{ color: "var(--nm-text-faint)" }}>
            Nexora<span style={{ color: "var(--nm-accent)" }}>.</span>
          </p>
          <p className="mt-2 text-sm" style={{ color: "var(--nm-text-faint)" }}>Select a conversation to start messaging</p>
        </div>
      </main>
    );
  }

  const online =
    activeChat.type === "DIRECT" ? presence[activeChat.id] === "online" : null;
  const memberCount =
    activeChat.type === "GROUP" ? (groupMembers[activeChat.id] ?? []).length : null;

  return (
    <main className="flex min-w-0 flex-1 flex-col h-full relative" style={{ background: "var(--nm-bg)" }}>
      {/* Header */}
      <header className="nm-raised-sm flex items-center gap-3 rounded-b-2xl px-4 py-3 shrink-0 z-10">
        <button
          onClick={() => useStore.getState().openChat(null)}
          className="md:hidden nm-icon-btn h-8 w-8"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <Avatar
          id={activeChat.id}
          name={activeChat.name}
          online={online}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{activeChat.name}</p>
          <p className="text-xs">
            {online === true
              ? <span style={{ color: "var(--nm-accent)" }}>online</span>
              : online === false
                ? <span style={{ color: "var(--nm-text-faint)" }}>Offline</span>
                : memberCount !== null
                  ? <span style={{ color: "var(--nm-text-muted)" }}>{memberCount} member{memberCount === 1 ? "" : "s"}</span>
                  : " "}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="nm-icon-btn h-9 w-9" title="Voice call">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </button>
          <button className="nm-icon-btn h-9 w-9" title="Video call">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2.5"/></svg>
          </button>
        </div>
      </header>

      {/* Messages */}
      <div
        className="flex-1 space-y-2 overflow-y-auto px-4 py-4"
        onScroll={onScroll}
      >
        {isLoading && (
          <p className="py-2 text-center text-xs" style={{ color: "var(--nm-text-muted)" }}>Loading…</p>
        )}
        {!isLoading && hasOlder && (
          <button
            onClick={() => loadHistory(key)}
            className="nm-raised-sm mx-auto block rounded-full px-4 py-1.5 text-xs transition hover:opacity-80"
            style={{ color: "var(--nm-text-muted)" }}
          >
            Load earlier
          </button>
        )}
        {grouped.map((item, i) =>
          item.type === "divider" ? (
            <DayDivider key={`d-${i}`} iso={item.iso} />
          ) : (
            <MessageBubble key={item.message.id} message={item.message} />
          )
        )}
        {typingNames && (
          <p className="px-3 text-xs italic" style={{ color: "var(--nm-accent)" }}>
            {typingNames} is typing…
          </p>
        )}
      </div>
    </main>
  );
}

function MessageBubble({ message }) {
  const me = getSession()?.user?.id;
  const own = message.senderId === me;
  const { text, media } = parseMediaContent(message.content);
  const isFailed = message.status === "FAILED";
  const retryMessage = useStore((s) => s.retryMessage);

  return (
    <div className={`flex flex-col ${own ? "items-end" : "items-start"} px-1`}>
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2.5 text-[15px] ${
          own
            ? isFailed
              ? "rounded-br-sm"
              : "rounded-br-sm nm-bubble-sent"
            : "rounded-bl-sm nm-bubble-received"
        }`}
        style={
          isFailed && own
            ? { background: "var(--nm-error)", color: "#fff", boxShadow: "var(--nm-raised-sm)" }
            : undefined
        }
      >
        {media ? (
          <div className="relative">
            <MediaMessage media={media} text={text} />
            {/* Forward/share icon overlay — visual only */}
            <button className="nm-icon-btn absolute top-2 right-2 h-7 w-7 text-xs opacity-80 hover:opacity-100" title="Forward">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
            </button>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        )}
        <div className={`mt-1 flex items-center justify-end gap-1 text-[11px]`} style={{ color: "var(--nm-text-faint)" }}>
          {formatTime(message.createdAt)}
          <Ticks message={message} />
        </div>
      </div>
      {isFailed && own && (
        <button
          onClick={() => retryMessage(message)}
          className="mr-1 mt-1 text-[11px] font-medium transition hover:opacity-70"
          style={{ color: "var(--nm-error)" }}
        >
          Failed to send — tap to retry
        </button>
      )}
    </div>
  );
}
