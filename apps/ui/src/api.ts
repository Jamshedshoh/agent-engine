// Typed client for the engine's agent service (/services/agents). Same-origin: the dev server
// and server.ts both proxy /services to the engine.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Agent {
  id: string;
  name: string;
  system: string;
  tools: string[];
  model?: string;
  effort?: Effort;
  ownerId: string;
  createdAt: string;
}

export interface NewAgent {
  name: string;
  system?: string;
  tools?: string[];
  model?: string;
  effort?: Effort;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface Tool {
  name: string;
  description: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunResult {
  runId: string;
  status: "completed" | "refused" | "truncated" | "max_turns" | "budget_exhausted";
  text: string;
  turns: number;
  usage: Usage;
  toolCalls: { name: string; ok: boolean }[];
}

export type AgentEvent =
  | { event: "ready"; data: { agentId: string } }
  | { event: "message"; data: HistoryEntry }
  | { event: "run.started"; data: { runId: string } }
  | { event: "turn"; data: { runId: string; turn: number; usage: Usage } }
  | { event: "tool_call"; data: { runId: string; name: string; ok: boolean } }
  | { event: "run.completed"; data: RunResult }
  | { event: "run.failed"; data: { runId: string; code: string } }
  | { event: "agent.deleted"; data: { agentId: string } };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const BASE = "/services/agents";

export function createApi(key: string) {
  const auth = { authorization: `Bearer ${key}` };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? res.statusText);
    return json as T;
  }

  const path = (id: string, rest = "") => `/${encodeURIComponent(id)}${rest}`;

  return {
    listAgents: () => request<{ agents: Agent[] }>("GET", "").then((r) => r.agents),
    listTools: () => request<{ tools: Tool[] }>("GET", "/tools").then((r) => r.tools),
    createAgent: (input: NewAgent) => request<{ agent: Agent }>("POST", "", input).then((r) => r.agent),
    deleteAgent: (id: string) => request<unknown>("DELETE", path(id)),
    history: (id: string) => request<{ messages: HistoryEntry[] }>("GET", path(id, "/messages")).then((r) => r.messages),
    send: (id: string, prompt: string) => request<RunResult & { ok: boolean }>("POST", path(id, "/messages"), { prompt }),

    /**
     * Streams an agent's events until the stream ends or `signal` aborts. Uses fetch rather than
     * EventSource because EventSource cannot send the Authorization header.
     */
    async listen(id: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
      const res = await fetch(BASE + path(id, "/events"), { headers: auth, signal });
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null);
        throw new ApiError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? res.statusText);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event && data) onEvent({ event, data: JSON.parse(data) } as AgentEvent);
        }
      }
    },
  };
}

export type Api = ReturnType<typeof createApi>;
