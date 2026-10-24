import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createApi, type Agent } from "./api.ts";
import { Login } from "./Login.tsx";
import { CreateAgent } from "./CreateAgent.tsx";
import { AgentView } from "./AgentView.tsx";

const KEY_STORAGE = "agent-engine.key";

// The API key lives in sessionStorage only: it survives a reload, not a closed tab.
function loadKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}
function saveKey(key: string | null) {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // storage blocked: the key just won't survive a reload
  }
}

export function App() {
  const [key, setKey] = useState(loadKey);
  const signIn = (k: string) => {
    saveKey(k);
    setKey(k);
  };
  const signOut = useCallback(() => {
    saveKey(null);
    setKey(null);
  }, []);

  if (!key) return <Login onSignIn={signIn} />;
  return <Workspace key={key} apiKey={key} onSignOut={signOut} />;
}

type Selection = { kind: "agent"; id: string } | { kind: "new" } | null;

function Workspace({ apiKey, onSignOut }: { apiKey: string; onSignOut: () => void }) {
  const api = useMemo(() => createApi(apiKey), [apiKey]);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  const onApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      else setError(err instanceof Error ? err.message : String(err));
    },
    [onSignOut],
  );

  const refresh = useCallback(async () => {
    try {
      const list = await api.listAgents();
      setAgents(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setError(null);
    } catch (err) {
      onApiError(err);
    }
  }, [api, onApiError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = selection?.kind === "agent" ? agents?.find((a) => a.id === selection.id) : undefined;

  const removed = useCallback((id: string) => {
    setAgents((list) => list?.filter((a) => a.id !== id) ?? null);
    setSelection((s) => (s?.kind === "agent" && s.id === id ? null : s));
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <header className="sidebar-head">
          <span className="brand">Agent Engine</span>
          <button className="ghost small" onClick={onSignOut} title="Forget this API key">
            Sign out
          </button>
        </header>
        <button className="primary block" onClick={() => setSelection({ kind: "new" })}>
          + New agent
        </button>
        <div className="list-head">
          <span>Agents</span>
          <button className="ghost small" onClick={() => void refresh()} aria-label="Refresh agents">
            Refresh
          </button>
        </div>
        {error && <p className="error small-text">{error}</p>}
        <nav className="agent-list">
          {agents === null && !error && <p className="muted small-text">Loading…</p>}
          {agents?.length === 0 && <p className="muted small-text">No agents yet. Create one to start.</p>}
          {agents?.map((a) => (
            <button
              key={a.id}
              className={`agent-item${selection?.kind === "agent" && selection.id === a.id ? " active" : ""}`}
              onClick={() => setSelection({ kind: "agent", id: a.id })}
            >
              <span className="agent-name">{a.name}</span>
              <span className="muted small-text">
                {a.tools.length ? a.tools.join(", ") : "no tools"} · {a.ownerId}
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {selection?.kind === "new" && (
          <CreateAgent
            api={api}
            onUnauthorized={onSignOut}
            onCancel={() => setSelection(null)}
            onCreated={(agent) => {
              setAgents((list) => [agent, ...(list ?? [])]);
              setSelection({ kind: "agent", id: agent.id });
            }}
          />
        )}
        {selected && <AgentView key={selected.id} api={api} agent={selected} onDeleted={removed} onUnauthorized={onSignOut} />}
        {selection?.kind !== "new" && !selected && (
          <div className="empty">
            <h2>Pick an agent</h2>
            <p className="muted">Choose an agent on the left to chat with it and watch it work, or create a new one.</p>
          </div>
        )}
      </main>
    </div>
  );
}
