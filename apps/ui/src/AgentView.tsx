import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, type Agent, type AgentEvent, type Api, type HistoryEntry } from "./api.ts";

type LiveState = "connecting" | "live" | "offline";
type Activity = { id: number; at: Date; text: string; tone?: "ok" | "bad" };

const MAX_ACTIVITY = 200;
const sameEntry = (a: HistoryEntry, b: HistoryEntry) => a.at === b.at && a.role === b.role && a.content === b.content;

export function AgentView(props: { api: Api; agent: Agent; onDeleted: (id: string) => void; onUnauthorized: () => void }) {
  const { api, agent } = props;
  const [messages, setMessages] = useState<HistoryEntry[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [live, setLive] = useState<LiveState>("connecting");
  const [running, setRunning] = useState<{ turn: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcript = useRef<HTMLDivElement>(null);

  // Keep callbacks in refs so the stream doesn't reconnect when the parent re-renders.
  const cb = useRef(props);
  cb.current = props;

  const log = (text: string, tone?: Activity["tone"]) =>
    setActivity((a) => [{ id: Math.random(), at: new Date(), text, tone }, ...a].slice(0, MAX_ACTIVITY));

  const loadHistory = async () => {
    try {
      setMessages(await api.history(agent.id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) cb.current.onUnauthorized();
      else if (err instanceof ApiError && err.status === 404) cb.current.onDeleted(agent.id);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [agent.id]);

  // Listen to the agent's event stream, reconnecting with backoff if it drops.
  useEffect(() => {
    const ctrl = new AbortController();
    const handle = (e: AgentEvent) => {
      switch (e.event) {
        case "ready":
          setLive("live");
          break;
        case "message":
          setMessages((m) => (m.some((x) => sameEntry(x, e.data)) ? m : [...m, e.data]));
          break;
        case "run.started":
          setRunning({ turn: 0 });
          log("Run started");
          break;
        case "turn":
          setRunning({ turn: e.data.turn });
          log(`Turn ${e.data.turn} · ${e.data.usage.inputTokens} in / ${e.data.usage.outputTokens} out tokens`);
          break;
        case "tool_call":
          log(`Tool ${e.data.name} ${e.data.ok ? "succeeded" : "failed"}`, e.data.ok ? "ok" : "bad");
          break;
        case "run.completed":
          setRunning(null);
          log(`Run ${e.data.status.replace("_", " ")} after ${e.data.turns} turn${e.data.turns === 1 ? "" : "s"}`, e.data.status === "completed" ? "ok" : "bad");
          break;
        case "run.failed":
          setRunning(null);
          log(`Run failed: ${e.data.code}`, "bad");
          break;
        case "agent.deleted":
          cb.current.onDeleted(agent.id);
          break;
      }
    };

    void (async () => {
      let attempt = 0;
      while (!ctrl.signal.aborted) {
        setLive("connecting");
        try {
          await api.listen(agent.id, (e) => {
            attempt = 0;
            handle(e);
          }, ctrl.signal);
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError) {
            if (err.status === 401) return cb.current.onUnauthorized();
            if (err.status === 404) return cb.current.onDeleted(agent.id);
            if (err.status === 403) return setLive("offline");
          }
        }
        if (ctrl.signal.aborted) return;
        setLive("offline");
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt++, 15_000)));
      }
    })();
    return () => ctrl.abort();
  }, [api, agent.id]);

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending, running]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || pending) return;
    setPending(prompt);
    setDraft("");
    setError(null);
    try {
      const result = await api.send(agent.id, prompt);
      if (result.status !== "completed") setError(`The run ended early: ${result.status.replace("_", " ")}.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return props.onUnauthorized();
      if (err instanceof ApiError && err.status === 403) setError("Your key isn't allowed to run agents.");
      else if (err instanceof ApiError && err.status === 502) setError("The model provider returned an error. Check the engine logs.");
      else setError(err instanceof Error ? err.message : String(err));
      setDraft(prompt);
    } finally {
      setPending(null);
      setRunning(null);
      // Reconcile with the server in case the stream missed anything.
      await loadHistory();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  async function remove() {
    if (!confirm(`Delete agent "${agent.name}"? Its conversation is deleted too.`)) return;
    try {
      await api.deleteAgent(agent.id);
      props.onDeleted(agent.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError("Your key isn't allowed to delete agents.");
      else setError(err instanceof Error ? err.message : String(err));
    }
  }

  // The stream usually echoes the prompt back first; until then, show it optimistically.
  const last = messages.at(-1);
  const showPending = pending && !(last?.role === "user" && last.content === pending);

  return (
    <div className="agent-view">
      <section className="chat">
        <header className="chat-head">
          <div>
            <h2>{agent.name}</h2>
            <p className="muted small-text">
              {agent.tools.length ? `Tools: ${agent.tools.join(", ")}` : "No tools"}
              {agent.model && ` · ${agent.model}`}
              {agent.effort && ` · effort ${agent.effort}`}
            </p>
          </div>
          <div className="row">
            <span className={`live ${live}`} title="Event stream status">
              {live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Offline"}
            </span>
            <button className="ghost danger small" onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </header>

        <div className="transcript" ref={transcript}>
          {agent.system && (
            <div className="system">
              <span className="label">System</span>
              {agent.system}
            </div>
          )}
          {messages.length === 0 && !pending && <p className="muted center">No messages yet. Say something below.</p>}
          {messages.map((m) => (
            <div key={`${m.at}-${m.role}`} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {showPending && <div className="bubble user pending">{pending}</div>}
          {(pending || running) && (
            <div className="bubble assistant thinking" aria-live="polite">
              Thinking{running && running.turn > 0 ? ` · turn ${running.turn}` : ""}…
            </div>
          )}
        </div>

        {error && <p className="error chat-error">{error}</p>}
        <form className="composer" onSubmit={send}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${agent.name}…  (Enter to send, Shift+Enter for a new line)`}
            rows={2}
            disabled={!!pending}
          />
          <button className="primary" disabled={!draft.trim() || !!pending}>
            Send
          </button>
        </form>
      </section>

      <aside className="activity">
        <h3>Activity</h3>
        <p className="muted small-text">Live events from this agent, including runs started by other people.</p>
        {activity.length === 0 && <p className="muted small-text">Nothing yet.</p>}
        <ol>
          {activity.map((a) => (
            <li key={a.id} className={a.tone}>
              <time>{a.at.toLocaleTimeString()}</time>
              <span>{a.text}</span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
