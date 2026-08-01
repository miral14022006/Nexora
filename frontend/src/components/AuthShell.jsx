import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeProvider.jsx";

export function Field({ label, id, type = "text", value, onChange, error, hint, autoComplete }) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1.5 block text-sm font-medium" style={{ color: "var(--nm-text)" }}>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`nm-input w-full rounded-2xl px-4 py-3 text-[15px] outline-none transition`}
        style={error ? { boxShadow: `var(--nm-pressed), inset 0 0 0 2px var(--nm-error)` } : undefined}
      />
      {error ? (
        <span id={`${id}-error`} role="alert" className="mt-1.5 block text-sm" style={{ color: "var(--nm-error)" }}>
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-sm" style={{ color: "var(--nm-text-muted)" }}>{hint}</span>
      ) : null}
    </label>
  );
}

export function AuthShell({ eyebrow, title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--nm-bg)", color: "var(--nm-text)" }}>
      <header className="mx-auto flex w-full max-w-md items-center justify-between px-6 pt-8">
        <Link to="/" className="inline-block font-display text-xl font-bold tracking-tight hover:opacity-80 transition">
          Nexora<span style={{ color: "var(--nm-accent)" }}>.</span>
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="nm-card w-full max-w-md p-8">
          <p className="font-mono text-xs font-semibold tracking-[0.25em] uppercase" style={{ color: "var(--nm-accent)" }}>{eyebrow}</p>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight">{title}</h1>
          <p className="mt-2" style={{ color: "var(--nm-text-muted)" }}>{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>

      <footer className="mx-auto w-full max-w-md px-6 pb-8 text-center">
        <p className="text-sm" style={{ color: "var(--nm-text-muted)" }}>{footer}</p>
      </footer>
    </div>
  );
}

export function SubmitButton({ busy, label, busyLabel }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="nm-btn-primary w-full rounded-2xl px-6 py-3 text-[15px] transition"
    >
      {busy ? busyLabel : label}
    </button>
  );
}
