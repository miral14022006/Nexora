import { useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { chatIdOf, useStore } from "../store.js";
import Avatar from "./Avatar.jsx";

/**
 * New-chat picker: searches users via user-service (through the gateway) and
 * opens a direct conversation with the selected user.
 */
export default function NewChatModal({ onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = useStore((s) => s.user)?.id;
  const openChat = useStore((s) => s.openChat);
  const loadConversations = useStore((s) => s.loadConversations);
  const timerRef = useRef(null);

  const search = (q) => {
    const trimmed = q.trim();
    setQuery(q);
    if (!trimmed) {
      setResults([]);
      setSearched(false);
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setBusy(true);
      const res = await api.searchUsers(trimmed);
      setBusy(false);
      if (res.ok) {
        setResults(res.data.users.filter((u) => u.id !== me));
        setSearched(true);
      }
    }, 250);
  };

  const start = async (user) => {
    await loadConversations();
    openChat({ type: "DIRECT", id: user.id, name: user.username });
    onClose();
  };

  return (
    <Modal onClose={onClose} title="New chat">
      <input
        autoFocus
        value={query}
        onChange={(e) => search(e.target.value)}
        placeholder="Search by username…"
        className="nm-input w-full rounded-2xl px-4 py-3 text-[15px] outline-none"
      />
      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {busy && <p className="px-2 py-1 text-sm" style={{ color: "var(--nm-text-muted)" }}>Searching…</p>}
        {!busy && searched && results.length === 0 && (
          <p className="px-2 py-1 text-sm" style={{ color: "var(--nm-text-muted)" }}>No users found</p>
        )}
        {results.map((u) => (
          <button
            key={u.id}
            onClick={() => start(u)}
            className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:opacity-80"
            style={{ color: "var(--nm-text)" }}
          >
            <Avatar id={u.id} name={u.username} size="sm" />
            <span className="font-medium">{u.username}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function Modal({ onClose, title, children }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="nm-card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            onClick={onClose}
            className="nm-icon-btn h-8 w-8 text-sm"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
