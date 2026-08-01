import { Link } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeProvider.jsx";
import HeroMesh from "../components/HeroMesh.jsx";

const FEATURES = [
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    ),
    title: "Real-Time Messaging",
    body: "Send a message and it appears instantly — direct chats and group conversations, all powered by WebSockets and event-driven delivery.",
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
    ),
    title: "Presence & Read Receipts",
    body: "See who's online in real time. Every message shows its journey: sent ✓, delivered ✓✓, and read with blue ticks.",
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
      </svg>
    ),
    title: "Media Sharing",
    body: "Share images, documents, and files. Uploads go directly to storage via pre-signed URLs — the chat server never proxies your bytes.",
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
    title: "Reliable Delivery",
    body: "Go offline, close your laptop, come back later — every message waits for you and arrives in order. Nothing gets lost.",
  },
];

const STEPS = [
  { num: "1", title: "Sign up", body: "Create an account with just a username, email, and password." },
  { num: "2", title: "Start a conversation", body: "Search for anyone on the network and send your first message." },
  { num: "3", title: "Messages arrive instantly", body: "Even across devices, reconnects, and network changes — always in order." },
];

export default function Landing() {
  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--nm-bg)", color: "var(--nm-text)" }}>
      {/* ============ NAV ============ */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <span className="font-display text-xl font-bold tracking-tight">
          Nexora<span style={{ color: "var(--nm-accent)" }}>.</span>
        </span>
        <nav className="flex items-center gap-4">
          <ThemeToggle />
          <Link to="/login" className="text-sm font-medium transition hover:opacity-70" style={{ color: "var(--nm-text-muted)" }}>
            Log in
          </Link>
          <Link
            to="/signup"
            className="nm-btn-primary rounded-2xl px-5 py-2.5 text-sm"
          >
            Sign up
          </Link>
        </nav>
      </header>

      {/* ============ SECTION 1: HERO ============ */}
      <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center gap-14 px-6 pt-10 pb-20 lg:flex-row lg:items-center lg:gap-8 lg:pt-0">
        <div className="max-w-xl flex-1 nm-animate-in">
          <p className="font-mono text-xs font-semibold tracking-[0.25em] uppercase" style={{ color: "var(--nm-accent)" }}>
            Nexora · real-time messaging
          </p>
          <h1 className="mt-5 font-display text-[clamp(2.25rem,6vw,4rem)] leading-[1.05] font-bold tracking-tight">
            Messages that move the instant you send them.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed" style={{ color: "var(--nm-text-muted)" }}>
            Nexora is a real-time messaging system. Message anyone in your network
            the moment you sign up — no setup, no invites. Create groups and one
            message reaches everyone in them. See who is online, and watch every
            message travel from sent, to delivered, to read.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link
              to="/signup"
              className="nm-btn-primary rounded-2xl px-7 py-3.5 text-center text-[15px]"
            >
              Sign up — it's free
            </Link>
            <Link
              to="/login"
              className="nm-raised rounded-2xl px-7 py-3.5 text-center text-[15px] font-semibold transition hover:opacity-80"
            >
              Log in
            </Link>
          </div>
          <p className="mt-6 font-mono text-xs tracking-wider" style={{ color: "var(--nm-text-faint)" }}>
            message → delivered → read · all live
          </p>
        </div>

        {/* Neomorphic device frame around the mesh */}
        <div className="w-full max-w-[520px] flex-shrink-0 lg:pl-6 nm-animate-in" style={{ animationDelay: "0.15s" }}>
          <div className="nm-raised-lg rounded-[32px] p-6">
            <div className="nm-pressed rounded-[24px] p-4 overflow-hidden">
              <HeroMesh />
            </div>
          </div>
        </div>
      </section>

      {/* ============ SECTION 2: FEATURES ============ */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="text-center mb-12 nm-animate-in">
          <p className="font-mono text-xs font-semibold tracking-[0.25em] uppercase" style={{ color: "var(--nm-accent)" }}>
            What you get
          </p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight md:text-4xl">
            Built for real conversations
          </h2>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <article
              key={f.title}
              className="nm-card rounded-[24px] p-7 nm-animate-in"
              style={{ animationDelay: `${i * 0.1}s` }}
            >
              <div
                className="nm-icon-btn h-14 w-14 mb-5"
                style={{ color: "var(--nm-accent)", borderRadius: 16 }}
              >
                {f.icon}
              </div>
              <h3 className="font-display text-lg font-bold tracking-tight">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--nm-text-muted)" }}>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ============ SECTION 3: HOW IT WORKS ============ */}
      <section className="mx-auto w-full max-w-4xl px-6 pb-24">
        <div className="text-center mb-12 nm-animate-in">
          <p className="font-mono text-xs font-semibold tracking-[0.25em] uppercase" style={{ color: "var(--nm-accent)" }}>
            How it works
          </p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight">
            Three steps to your first message
          </h2>
        </div>
        <div className="flex flex-col md:flex-row items-center md:items-start gap-8 md:gap-4">
          {STEPS.map((s, i) => (
            <div key={s.num} className="flex flex-col items-center text-center flex-1 nm-animate-in" style={{ animationDelay: `${i * 0.12}s` }}>
              <div
                className="nm-raised flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold mb-4"
                style={{ color: "var(--nm-accent)" }}
              >
                {s.num}
              </div>
              {i < STEPS.length - 1 && (
                <div className="hidden md:block absolute" style={{ width: 2, height: 1 }} />
              )}
              <h3 className="font-display text-lg font-bold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed max-w-[240px]" style={{ color: "var(--nm-text-muted)" }}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ============ SECTION 4: PRODUCT PREVIEW ============ */}
      <section className="mx-auto w-full max-w-4xl px-6 pb-24">
        <div className="text-center mb-12 nm-animate-in">
          <p className="font-mono text-xs font-semibold tracking-[0.25em] uppercase" style={{ color: "var(--nm-accent)" }}>
            Preview
          </p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight">
            See it in action
          </h2>
        </div>
        <div className="nm-raised-lg rounded-[32px] p-5 md:p-8 nm-animate-in">
          <div className="nm-pressed rounded-[24px] overflow-hidden">
            {/* Static mockup of chat UI */}
            <div className="flex h-[400px] md:h-[480px]">
              {/* Sidebar mock */}
              <div className="hidden md:flex w-64 flex-col p-4 gap-3" style={{ borderRight: "1px solid var(--nm-divider)" }}>
                <div className="font-display text-lg font-bold mb-2">Chats</div>
                {["Alice", "Team Project", "Bob"].map((n, i) => (
                  <div key={n} className={`nm-raised-sm rounded-2xl px-4 py-3 flex items-center gap-3 ${i === 0 ? "nm-pressed" : ""}`}>
                    <div className="h-9 w-9 rounded-full bg-teal-500 flex items-center justify-center text-white text-xs font-bold">
                      {n[0]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm truncate">{n}</p>
                      <p className="text-xs truncate" style={{ color: "var(--nm-text-muted)" }}>
                        {i === 0 ? "Hey, check this out!" : i === 1 ? "Meeting at 3pm" : "Thanks!"}
                      </p>
                    </div>
                    {i === 0 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                        style={{ background: "var(--nm-accent)" }}>2</span>
                    )}
                  </div>
                ))}
              </div>
              {/* Chat mock */}
              <div className="flex flex-1 flex-col p-4 md:p-6">
                <div className="flex items-center gap-3 mb-4 pb-3" style={{ borderBottom: "1px solid var(--nm-divider)" }}>
                  <div className="h-10 w-10 rounded-full bg-teal-500 flex items-center justify-center text-white font-bold">A</div>
                  <div>
                    <p className="font-bold text-sm">Alice</p>
                    <p className="text-xs" style={{ color: "var(--nm-accent)" }}>online</p>
                  </div>
                </div>
                <div className="flex-1 space-y-3 overflow-hidden">
                  <div className="flex justify-center">
                    <span className="nm-raised-sm rounded-full px-3 py-1 text-[10px] font-medium" style={{ color: "var(--nm-text-muted)" }}>Today</span>
                  </div>
                  <div className="flex">
                    <div className="nm-raised-sm rounded-2xl rounded-bl-sm px-4 py-2.5 max-w-[70%] text-sm">
                      Hey! Have you seen the new release? 🎉
                      <div className="text-[10px] text-right mt-1" style={{ color: "var(--nm-text-faint)" }}>10:30 AM</div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <div className="rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[70%] text-sm" style={{ background: "var(--nm-surface-tint)", boxShadow: "var(--nm-raised-sm)" }}>
                      Yes! Looks amazing. The real-time delivery is so smooth.
                      <div className="text-[10px] text-right mt-1 flex items-center justify-end gap-1" style={{ color: "var(--nm-text-faint)" }}>
                        10:31 AM <span style={{ color: "var(--nm-accent)" }}>✓✓</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex">
                    <div className="nm-raised-sm rounded-2xl rounded-bl-sm px-4 py-2.5 max-w-[70%] text-sm">
                      Right? And the offline backlog works perfectly too.
                      <div className="text-[10px] text-right mt-1" style={{ color: "var(--nm-text-faint)" }}>10:32 AM</div>
                    </div>
                  </div>
                </div>
                <div className="nm-pressed rounded-full px-4 py-2.5 mt-3 flex items-center gap-2">
                  <span className="text-sm" style={{ color: "var(--nm-text-faint)" }}>Message...</span>
                  <span className="ml-auto h-8 w-8 rounded-full flex items-center justify-center" style={{ background: "var(--nm-accent)", color: "var(--nm-accent-text)" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ SECTION 5: FINAL CTA ============ */}
      <section className="mx-auto w-full max-w-3xl px-6 pb-24">
        <div className="nm-card rounded-[32px] p-10 md:p-14 text-center nm-animate-in">
          <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            Ready to start messaging?
          </h2>
          <p className="mt-4 text-lg" style={{ color: "var(--nm-text-muted)" }}>
            Join Nexora and send your first message in under a minute.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link
              to="/signup"
              className="nm-btn-primary rounded-2xl px-8 py-3.5 text-[15px]"
            >
              Create your account
            </Link>
            <Link
              to="/login"
              className="nm-raised rounded-2xl px-8 py-3.5 text-[15px] font-semibold transition hover:opacity-80"
            >
              Log in
            </Link>
          </div>
        </div>
      </section>

      {/* ============ SECTION 6: FOOTER ============ */}
      <footer style={{ borderTop: "1px solid var(--nm-divider)" }}>
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-4 px-6 py-8 sm:flex-row sm:items-center">
          <span className="font-display text-base font-bold tracking-tight">
            Nexora<span style={{ color: "var(--nm-accent)" }}>.</span>
          </span>
          <span className="font-mono text-xs tracking-wider" style={{ color: "var(--nm-text-muted)" }}>
            real-time, distributed messaging
          </span>
          <nav className="flex gap-6">
            <Link to="/login" className="text-sm transition hover:opacity-70" style={{ color: "var(--nm-text-muted)" }}>
              Log in
            </Link>
            <Link to="/signup" className="text-sm transition hover:opacity-70" style={{ color: "var(--nm-text-muted)" }}>
              Sign up
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
