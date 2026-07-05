import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../state/auth.js";

export function Login() {
  const setAuth = useAuth((s) => s.setAuth);
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(
    e: React.FormEvent | null,
    override?: { tenantSlug: string; email: string; password: string },
  ) {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const resp = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(override ?? { tenantSlug: "flare-fitness", email, password }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.success) throw new Error(json.error?.message ?? "Login failed");
      setAuth(json.data);
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      nav(next && next.startsWith("/") ? next : "/");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  function enterDemo() {
    submit(null, {
      tenantSlug: "flare-fitness",
      email: "bayan@example.com",
      password: "password1",
    });
  }

  return (
    <div className="min-h-screen min-h-[100svh] flex items-center justify-center bg-surface-secondary px-4 sm:px-6 py-8 sm:py-12">
      <div className="w-full max-w-[420px] animate-scale-in">
        <div className="text-center mb-6">
          <h1 className="text-[24px] sm:text-[28px] font-semibold tracking-[-0.02em] text-apple-text">
            The Brain
          </h1>
          <p className="text-[14px] text-apple-secondary mt-1">Flare Fitness knowledge hub</p>
        </div>

        <div className="card p-6 space-y-5">
          <button
            type="button"
            onClick={enterDemo}
            disabled={busy}
            className="btn-primary w-full !py-3 !text-[15px]"
          >
            {busy ? "Entering…" : "Enter demo"}
          </button>
          <p className="text-[12px] text-apple-tertiary text-center -mt-2">
            Signs you in as Bayan at Flare Fitness
          </p>

          <div className="flex items-center gap-3 text-[11px] uppercase tracking-widest text-apple-tertiary">
            <div className="flex-1 h-px bg-apple-separator" />
            Or sign in manually
            <div className="flex-1 h-px bg-apple-separator" />
          </div>

          <form onSubmit={(e) => submit(e)} noValidate className="space-y-3">
            <div>
              <span className="label">Email</span>
              <input
                className="input-apple"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <span className="label">Password</span>
              <input
                className="input-apple"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
              />
            </div>
            {err && (
              <p className="text-[13px] text-apple-red bg-apple-red/10 rounded-apple px-3 py-2">
                {err}
              </p>
            )}
            <button disabled={busy} className="btn-secondary w-full">
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="text-center text-[11px] text-apple-tertiary mt-5">
          Powered by <span className="text-pair font-medium">Pair</span> · ©{" "}
          {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
