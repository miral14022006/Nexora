import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { AuthShell, Field, SubmitButton } from "../components/AuthShell.jsx";

export default function SignupPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (username.trim().length < 3) next.username = "Username must be at least 3 characters";
    if (!email.trim()) next.email = "Enter your email";
    else if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = "That doesn't look like an email";
    if (!password) next.password = "Enter a password";
    else if (password.length < 8) next.password = "Password must be at least 8 characters";
    if (!confirm) next.confirm = "Re-enter your password";
    else if (confirm !== password) next.confirm = "Passwords don't match";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setServerError(null);
    setBusy(true);
    try {
      const res = await api.signup({ username: username.trim(), email: email.trim(), password });
      if (!res.ok) {
        if (res.status === 409) {
          if (/username/i.test(res.error)) setErrors((prev) => ({ ...prev, username: res.error }));
          else setErrors((prev) => ({ ...prev, email: res.error }));
          return;
        }
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
      eyebrow="Nexora · Create account"
      title="Join the network"
      subtitle="A username, an email, a password — that's all it takes."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-semibold text-signal transition hover:brightness-110">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field
          id="signup-username"
          label="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
        />
        <Field
          id="signup-email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Field
          id="signup-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint="At least 8 characters"
        />
        <Field
          id="signup-confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />

        {serverError && (
          <p role="alert" className="nm-raised-sm rounded-2xl px-4 py-3 text-sm" style={{ color: "var(--nm-error)" }}>
            {serverError}
          </p>
        )}

        <SubmitButton busy={busy} label="Create account" busyLabel="Creating account…" />
      </form>
    </AuthShell>
  );
}
