import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, getSession } from "../api.js";
import { chatIdOf, useStore } from "../store.js";
import { relativeTime } from "../format.js";
import { mediaPreview, parseMediaContent } from "../media.js";
import Avatar from "./Avatar.jsx";
import { ThemeToggle } from "./ThemeProvider.jsx";

export default function Sidebar({ onNewChat, onGroups }) {
  const user = useStore((s) => s.user);
  const conversations = useStore((s) => s.conversations);
  const activeChat = useStore((s) => s.activeChat);
  const presence = useStore((s) => s.presence);
  const typing = useStore((s) => s.typing);
  const messages = useStore((s) => s.messages);
  const signOut = useStore((s) => s.signOut);
  const openChat = useStore((s) => s.openChat);
  const navigate = useNavigate();

  const [filter, setFilter] = useState("");

  const unread = useMemo(
    () =>
      Object.fromEntries(
        conversations.map((c) => [
          chatIdOf(c.type, c.userId ?? c.groupId),
          c.unread ?? 0,
        ])
      ),
    [conversations]
  );

  const sorted = useMemo(
    () =>
      [...conversations]
        .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => {
          const at = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
          const bt = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
          return bt - at;
        }),
    [conversations, filter]
  );

  const activeKey = activeChat ? chatIdOf(activeChat.type, activeChat.id) : null;

  return (
    <aside
      className="flex h-full w-full md:w-80 flex-col"
      style={{ background: "var(--nm-bg)", color: "var(--nm-text)" }}
    >
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-6 pb-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">
          Nexora<span style={{ color: "var(--nm-accent)" }}>.</span>
        </h1>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            onClick={() => onGroups?.()}
            title="Groups"
            className="nm-icon-btn h-9 w-9"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </button>
          <button
            onClick={() => onNewChat?.()}
            title="New chat"
            className="nm-icon-btn h-9 w-9"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          </button>
        </div>
      </header>

      {/* Search */}
      <div className="px-5 pb-4">
        <div className="nm-pressed flex items-center rounded-2xl px-4 py-2.5">
          <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--nm-text-faint)" }}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search..."
            className="ml-2 w-full bg-transparent text-sm outline-none"
            style={{ color: "var(--nm-text)", "::placeholder": { color: "var(--nm-text-faint)" } }}
          />
        </div>
      </div>

      {/* Conversation list — one inset panel, rows inside */}
      <div className="nm-pressed mx-4 flex-1 overflow-y-auto rounded-2xl">
        {sorted.length === 0 && (
          <p className="px-4 py-8 text-center text-sm" style={{ color: "var(--nm-text-muted)" }}>
            No conversations yet. Start a new chat!
          </p>
        )}
        {sorted.map((c) => {
          const key = chatIdOf(c.type, c.userId ?? c.groupId);
          const count = unread[key] ?? 0;
          const last = c.lastMessage;
          const { text: lastText, media: lastMedia } = parseMediaContent(last?.content);

          let preview = "No messages yet";
          if (last) {
            if (lastMedia) preview = (
              <span className="flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                Photo
              </span>
            );
            else preview = last.senderId === user?.id ? `You: ${lastText}` : lastText;
          }

          const isTyping = typing[key] && Object.values(typing[key]).some(Boolean);
          const isOnline = c.type === "DIRECT" ? presence[c.userId] === "online" : false;

          if (isTyping) {
            preview = <span className="italic" style={{ color: "var(--nm-accent)" }}>Typing...</span>;
          }

          return (
            <button
              key={key}
              onClick={() => openChat({ type: c.type, id: c.userId ?? c.groupId, name: c.name })}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-all ${
                activeKey === key ? "nm-pressed" : "hover:opacity-80"
              }`}
              style={activeKey !== key ? { borderBottom: "1px solid var(--nm-divider)" } : undefined}
            >
              <div className="relative shrink-0">
                <Avatar id={c.userId ?? c.groupId} name={c.name} />
                {isOnline && (
                  <div
                    className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full"
                    style={{
                      borderWidth: 2,
                      borderStyle: "solid",
                      borderColor: "var(--nm-bg)",
                      backgroundColor: "var(--nm-success)",
                    }}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between mb-0.5">
                  <p className="truncate font-bold text-[14px]">{c.name}</p>
                  <span className="shrink-0 text-xs" style={{ color: "var(--nm-text-faint)" }}>
                    {last ? relativeTime(last.createdAt) : ""}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="truncate text-sm" style={{ color: "var(--nm-text-muted)" }}>
                    {preview}
                  </div>
                  {count > 0 && (
                    <span
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold"
                      style={{ background: "var(--nm-accent)", color: "var(--nm-accent-text)" }}
                    >
                      {count}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Bottom tab bar */}
      <footer className="flex items-center justify-around px-2 py-3 mt-2">
        <TabItem icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>} label="Chats" active />
        <TabItem icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>} label="Calls" />
        <TabItem icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>} label="Status" />
        <TabItem
          icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>}
          label="Sign out"
          onClick={() => { signOut(); navigate("/"); }}
        />
      </footer>
    </aside>
  );
}

function TabItem({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 p-2 rounded-xl transition ${active ? "nm-pressed" : "hover:opacity-70"}`}
      style={{ color: active ? "var(--nm-accent)" : "var(--nm-text-faint)" }}
    >
      {icon}
      <span className="text-[10px] font-bold">{label}</span>
    </button>
  );
}
