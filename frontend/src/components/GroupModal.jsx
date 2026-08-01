import { useMemo, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import Avatar from "./Avatar.jsx";
import { Modal } from "./NewChatModal.jsx";

/**
 * Group management: create a group (owner becomes admin), add/remove members,
 * leave the group. Admin actions are only offered to users with the admin role.
 */
export default function GroupModal({ onClose }) {
  const user = useStore((s) => s.user);
  const activeChat = useStore((s) => s.activeChat);
  const groupMembers = useStore((s) => s.groupMembers);
  const loadGroupMembers = useStore((s) => s.loadGroupMembers);
  const loadConversations = useStore((s) => s.loadConversations);
  const openChat = useStore((s) => s.openChat);
  const [tab, setTab] = useState(activeChat?.type === "GROUP" ? "members" : "create");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState([]);

  const isAdmin = useMemo(() => {
    if (activeChat?.type !== "GROUP") return false;
    return (groupMembers[activeChat.id] ?? []).some(
      (m) => m.userId === user?.id && m.role === "admin"
    );
  }, [activeChat, groupMembers, user]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createGroup({ name: trimmed });
      if (!res.ok) {
        setError(res.error ?? "Failed to create group");
        return;
      }
      await loadConversations();
      openChat({ type: "GROUP", id: res.data.group.id, name: res.data.group.name });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const searchAddable = async (q) => {
    setAddQuery(q);
    if (!q.trim()) {
      setAddResults([]);
      return;
    }
    const res = await api.searchUsers(q.trim());
    if (!res.ok) return;
    const existing = new Set(
      (groupMembers[activeChat?.id] ?? []).map((m) => m.userId)
    );
    setAddResults(res.data.users.filter((u) => u.id !== user?.id && !existing.has(u.id)));
  };

  const add = async (userId) => {
    const res = await api.addMember(activeChat.id, userId);
    if (res.ok) {
      await loadGroupMembers(activeChat.id);
      setAddResults([]);
      setAddQuery("");
    } else {
      setError(res.error);
    }
  };

  const remove = async (userId) => {
    const res = await api.removeMember(activeChat.id, userId);
    if (res.ok) await loadGroupMembers(activeChat.id);
    else setError(res.error);
  };

  const leave = async () => {
    const res = await api.leaveGroup(activeChat.id);
    if (res.ok) {
      await loadConversations();
      openChat(null);
      onClose();
    } else {
      setError(res.error);
    }
  };

  const members = groupMembers[activeChat?.id] ?? [];

  return (
    <Modal onClose={onClose} title={tab === "create" ? "Create group" : activeChat?.name}>
      <div className="nm-pressed mb-4 flex rounded-2xl p-1">
        <TabButton active={tab === "create"} onClick={() => setTab("create")}>
          Create
        </TabButton>
        {activeChat?.type === "GROUP" && (
          <TabButton active={tab === "members"} onClick={() => setTab("members")}>
            Members
          </TabButton>
        )}
      </div>

      {error && (
        <div className="nm-raised-sm mb-3 rounded-2xl px-4 py-3 text-sm" style={{ color: "var(--nm-error)" }}>
          {error}
        </div>
      )}

      {tab === "create" && (
        <div className="space-y-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Group name"
            className="nm-input w-full rounded-2xl px-4 py-3 text-[15px] outline-none"
          />
          <button
            onClick={create}
            disabled={busy || !name.trim()}
            className="nm-btn-primary w-full rounded-2xl py-3 text-[15px]"
          >
            {busy ? "Creating…" : "Create group"}
          </button>
        </div>
      )}

      {tab === "members" && (
        <div className="space-y-3">
          {isAdmin && (
            <div className="space-y-2">
              <input
                value={addQuery}
                onChange={(e) => searchAddable(e.target.value)}
                placeholder="Add member (search username)…"
                className="nm-input w-full rounded-2xl px-4 py-3 text-[15px] outline-none"
              />
              {addResults.map((u) => (
                <button
                  key={u.id}
                  onClick={() => add(u.id)}
                  className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left text-sm transition hover:opacity-80"
                >
                  <Avatar id={u.id} name={u.username} size="sm" />
                  <span>{u.username}</span>
                  <span className="ml-auto font-medium" style={{ color: "var(--nm-accent)" }}>Add</span>
                </button>
              ))}
            </div>
          )}

          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex items-center gap-3 rounded-2xl px-3 py-2.5"
              >
                <Avatar id={m.userId} name={m.username} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.username}
                    {m.userId === user?.id && (
                      <span className="ml-1" style={{ color: "var(--nm-text-muted)" }}>(you)</span>
                    )}
                  </p>
                  <p className="text-[11px]" style={{ color: "var(--nm-text-muted)" }}>
                    {m.role === "admin" ? "Admin" : "Member"}
                  </p>
                </div>
                {isAdmin && m.userId !== user?.id && (
                  <button
                    onClick={() => remove(m.userId)}
                    className="text-xs transition hover:opacity-80"
                    style={{ color: "var(--nm-error)" }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>

          <button
            onClick={leave}
            className="nm-raised-sm w-full rounded-2xl py-3 text-sm font-medium transition hover:opacity-80"
            style={{ color: "var(--nm-error)" }}
          >
            Leave group
          </button>
        </div>
      )}
    </Modal>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-xl py-2 text-sm font-semibold transition ${
        active ? "nm-btn-primary" : ""
      }`}
      style={active ? undefined : { color: "var(--nm-text-muted)" }}
    >
      {children}
    </button>
  );
}
