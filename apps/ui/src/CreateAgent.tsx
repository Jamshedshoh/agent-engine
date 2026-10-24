import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type Agent, type Api, type Effort, type Tool } from "./api.ts";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function CreateAgent(props: { api: Api; onCreated: (a: Agent) => void; onCancel: () => void; onUnauthorized: () => void }) {
  const { api, onUnauthorized } = props;
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [name, setName] = useState("");
  const [system, setSystem] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listTools().then(setTools, (err) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setTools([]);
    });
  }, [api, onUnauthorized]);

  const toggle = (n: string) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createAgent({
        name: name.trim(),
        system,
        tools: picked,
        ...(model.trim() && { model: model.trim() }),
        ...(effort && { effort }),
      });
      props.onCreated(agent);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      if (err instanceof ApiError && err.status === 403) setError("Your key isn't allowed to create agents.");
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>New agent</h2>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required autoFocus placeholder="e.g. research-helper" />
      </label>
      <label className="field">
        <span>System prompt</span>
        <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={5} placeholder="How should this agent behave?" />
      </label>

      <fieldset className="field">
        <legend>Tools</legend>
        {tools === null && <p className="muted small-text">Loading tools…</p>}
        {tools?.length === 0 && <p className="muted small-text">No tools available to your key.</p>}
        {tools?.map((t) => (
          <label key={t.name} className="check">
            <input type="checkbox" checked={picked.includes(t.name)} onChange={() => toggle(t.name)} />
            <span>
              <code>{t.name}</code> <span className="muted">{t.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="row">
        <label className="field grow">
          <span>Model (optional)</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={128} placeholder="provider default" />
        </label>
        <label className="field">
          <span>Effort</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value as Effort | "")}>
            <option value="">default</option>
            {EFFORTS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create agent"}
        </button>
      </div>
    </form>
  );
}
