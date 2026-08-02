import { useNavigate } from "react-router-dom";
import { useStore } from "../store.js";
import Avatar from "../components/Avatar.jsx";
import { ThemeToggle, useTheme } from "../components/ThemeProvider.jsx";

/**
 * Settings — a real, styled destination (not a dead link). Account info comes
 * from the session; theme control is shared with the rest of the app.
 */
export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useStore((s) => s.user);
  const session = useStore((s) => s.session);
  const signOut = useStore((s) => s.signOut);
  const { theme } = useTheme();

  const email = session?.user?.email ?? user?.email ?? "—";

  return (
    <div
      className="flex h-screen flex-col overflow-hidden font-sans"
      style={{ background: "var(--nm-bg)", color: "var(--nm-text)" }}
    >
      <header className="nm-raised-sm flex shrink-0 items-center gap-3 px-4 py-3">
        <button
          onClick={() => navigate("/app")}
          className="nm-icon-btn h-9 w-9"
          title="Back to chats"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <h1 className="text-lg font-bold">Settings</h1>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl space-y-4 px-4 py-6">
          {/* Profile */}
          <section className="nm-card p-5">
            <div className="flex items-center gap-4">
              <Avatar id={user?.id} name={user?.username} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-bold">{user?.username ?? "…"}</p>
                <p className="truncate text-sm" style={{ color: "var(--nm-text-muted)" }}>{email}</p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between text-sm">
              <span style={{ color: "var(--nm-text-muted)" }}>Account ID</span>
              <span className="font-mono text-xs break-all" style={{ color: "var(--nm-text-faint)" }}>
                {user?.id ?? "—"}
              </span>
            </div>
          </section>

          {/* Appearance */}
          <section className="nm-card flex items-center justify-between p-5">
            <div>
              <p className="text-sm font-semibold">Appearance</p>
              <p className="text-xs" style={{ color: "var(--nm-text-muted)" }}>
                {theme === "dark" ? "Dark mode" : "Light mode"}
              </p>
            </div>
            <ThemeToggle />
          </section>

          {/* Account */}
          <section className="nm-card p-5">
            <p className="mb-3 text-sm font-semibold">Account</p>
            <button
              onClick={() => {
                signOut();
                navigate("/");
              }}
              className="nm-raised-sm w-full rounded-2xl py-3 text-sm font-medium transition hover:opacity-80"
              style={{ color: "var(--nm-error)" }}
            >
              Sign out
            </button>
          </section>

          {/* About */}
          <section className="nm-card p-5 text-center">
            <p className="font-display text-xl font-bold">
              Nexora<span style={{ color: "var(--nm-accent)" }}>.</span>
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--nm-text-faint)" }}>
              v0.1.0 · demo build
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
