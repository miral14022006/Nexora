import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import Sidebar from "../components/Sidebar.jsx";
import ChatWindow from "../components/ChatWindow.jsx";
import Composer from "../components/Composer.jsx";
import NewChatModal from "../components/NewChatModal.jsx";
import GroupModal from "../components/GroupModal.jsx";

export default function ChatPage() {
  const loadConversations = useStore((s) => s.loadConversations);
  const wsStatus = useStore((s) => s.wsStatus);
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const activeChat = useStore((s) => s.activeChat);

  const [showNewChat, setShowNewChat] = useState(false);
  const [showGroups, setShowGroups] = useState(false);

  useEffect(() => {
    loadConversations();
    const timer = setInterval(() => loadConversations(), 60_000);
    return () => clearInterval(timer);
  }, [loadConversations]);

  return (
    <div
      className="flex h-screen overflow-hidden font-sans"
      style={{ background: "var(--nm-bg)", color: "var(--nm-text)" }}
    >
      {/* Sidebar pane */}
      <div className={`h-full w-full md:w-80 md:shrink-0 md:block ${activeChat ? 'hidden' : 'block'}`}>
        <Sidebar
          onNewChat={() => setShowNewChat(true)}
          onGroups={() => setShowGroups(true)}
        />
      </div>

      {/* Chat pane */}
      <div className={`flex min-w-0 flex-1 flex-col h-full md:flex ${activeChat ? 'flex' : 'hidden'}`}>
        <ChatWindow />
        <Composer />
      </div>

      {/* Error toast */}
      {error && (
        <div
          className="nm-raised fixed bottom-4 right-4 z-50 rounded-2xl px-5 py-3 text-sm"
          style={{ color: "var(--nm-error)" }}
        >
          {error}
          <button onClick={() => setError(null)} className="ml-3 font-bold hover:opacity-70 transition">
            ✕
          </button>
        </div>
      )}

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} />}
      {showGroups && <GroupModal onClose={() => setShowGroups(false)} />}
    </div>
  );
}
