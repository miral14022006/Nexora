import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { AuthShell, Field, SubmitButton } from "../components/AuthShell.jsx";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!email.trim()) next.email = "Enter your email";
    if (!password) next.password = "Enter your password";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setServerError(null);
    setBusy(true);
    try {
      const res = await api.login({ email: email.trim(), password });
      if (!res.ok) {
        setServerError(res.error ?? "Something went wrong");
        return;
      }
      useStore.getState().setSession(res.data);
      useStore.getState().setUser(res.data.user);
      navigate("/app", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Nexora · Sign in"
      title="Back to the conversation"
      subtitle="Your chats, presence and receipts are waiting."
      footer={
        <>
          New to Nexora?{" "}
          <Link to="/signup" className="font-semibold text-signal transition hover:brightness-110">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field
          id="login-email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Field
          id="login-password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />

        {serverError && (
          <p role="alert" className="nm-raised-sm rounded-2xl px-4 py-3 text-sm" style={{ color: "var(--nm-error)" }}>
            {serverError}
          </p>
        )}

        <SubmitButton busy={busy} label="Log in" busyLabel="Signing in…" />
      </form>
    </AuthShell>
  );
}
