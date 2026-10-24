import { useState, type FormEvent } from "react";
import { ApiError, createApi } from "./api.ts";

export function Login({ onSignIn }: { onSignIn: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    setBusy(true);
    setError(null);
    try {
      await createApi(k).listAgents();
      onSignIn(k);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("That key isn't recognized.");
      else if (err instanceof ApiError && err.status === 403) setError("That key can't read agents.");
      else setError(err instanceof Error ? err.message : "Couldn't reach the engine.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>Agent Engine</h1>
        <p className="muted">Sign in with an API key to create, prompt and watch agents.</p>
        <label className="field">
          <span>API key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary block" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Sign in"}
        </button>
        <p className="muted small-text">
          Unless <code>API_KEYS</code> is set, the dev keys are <code>dev-admin-key</code> and <code>dev-viewer-key</code>.
        </p>
      </form>
    </div>
  );
}
