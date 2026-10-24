import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { Context } from "../types.ts";
import type { Engine } from "../engine.ts";
import { runAgent, type AgentDefinition, type AgentResult, type AgentTool } from "../agent/index.ts";
import { agentRunError } from "../agent/httpErrors.ts";
import type { ChatMessage, ModelProvider } from "../model/index.ts";
import { badRequest, HttpError } from "../errors.ts";
import { KeyedMutex } from "../stores/memory.ts";

export interface AgentRecord {
  id: string;
  name: string;
  system: string;
  /** Tool names from the service's catalog. */
  tools: string[];
  model?: string;
  effort?: AgentDefinition["effort"];
  ownerId: string;
  createdAt: string;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
}

/** Store for service-managed agents and their conversations. Swap for Redis/DB by implementing the same interface. */
export interface AgentStore {
  get(id: string): Promise<AgentRecord | undefined>;
  list(): Promise<AgentRecord[]>;
  put(agent: AgentRecord): Promise<void>;
  delete(id: string): Promise<void>;
  history(id: string): Promise<HistoryEntry[]>;
  setHistory(id: string, entries: HistoryEntry[]): Promise<void>;
}

export class MemoryAgentStore implements AgentStore {
  private agents = new Map<string, AgentRecord>();
  private histories = new Map<string, HistoryEntry[]>();
  async get(id: string) {
    return this.agents.get(id);
  }
  async list() {
    return [...this.agents.values()];
  }
  async put(agent: AgentRecord) {
    this.agents.set(agent.id, agent);
  }
  async delete(id: string) {
    this.agents.delete(id);
    this.histories.delete(id);
  }
  async history(id: string) {
    return this.histories.get(id) ?? [];
  }
  async setHistory(id: string, entries: HistoryEntry[]) {
    this.histories.set(id, entries);
  }
}

/** What listeners on `GET <prefix>/:id/events` receive, one SSE event each. */
export type ServiceEvent =
  | { type: "message"; data: HistoryEntry }
  | { type: "run.started"; data: { runId: string } }
  | { type: "turn"; data: { runId: string; turn: number; usage: AgentResult["usage"] } }
  | { type: "tool_call"; data: { runId: string; name: string; ok: boolean } }
  | { type: "run.completed"; data: { runId: string } & AgentResult }
  | { type: "run.failed"; data: { runId: string; code: string } }
  | { type: "agent.deleted"; data: { agentId: string } };

export interface AgentServiceOptions {
  /** Tools agents may be built from, referenced by name. */
  tools: AgentTool[];
  store?: AgentStore;
  maxAgentsPerUser?: number;
  /** Older messages are dropped once a conversation grows past this. */
  maxHistoryMessages?: number;
  maxListenersPerAgent?: number;
}

/**
 * Permissions: agents:create, agents:read (list, inspect, history, events), agents:run,
 * agents:delete. Callers only see agents they own unless they hold agents:manage.
 */
export const AGENT_PERMISSIONS = {
  create: "agents:create",
  read: "agents:read",
  run: "agents:run",
  delete: "agents:delete",
  manage: "agents:manage",
} as const;

const HEARTBEAT_MS = 15_000;
const agentNotFound = () => new HttpError(404, "not_found", "Agent not found");

export class AgentService {
  private model: ModelProvider;
  private catalog: Map<string, AgentTool>;
  private store: AgentStore;
  private limits: { maxAgentsPerUser: number; maxHistoryMessages: number; maxListenersPerAgent: number };
  private bus = new EventEmitter().setMaxListeners(0);
  // Serializes creates per user (agent limit) and runs per agent (history consistency).
  private mutex = new KeyedMutex();

  constructor(model: ModelProvider, opts: AgentServiceOptions) {
    this.model = model;
    this.catalog = new Map(opts.tools.map((t) => [t.name, t]));
    this.store = opts.store ?? new MemoryAgentStore();
    this.limits = {
      maxAgentsPerUser: opts.maxAgentsPerUser ?? 20,
      maxHistoryMessages: opts.maxHistoryMessages ?? 40,
      maxListenersPerAgent: opts.maxListenersPerAgent ?? 10,
    };
  }

  /** Receive every event for one agent. Returns an unsubscribe function. */
  subscribe(agentId: string, fn: (event: ServiceEvent) => void): () => void {
    this.bus.on(agentId, fn);
    return () => this.bus.off(agentId, fn);
  }

  mount(engine: Engine, prefix: string): void {
    const P = AGENT_PERMISSIONS;
    const createBody = z
      .object({
        name: z.string().trim().min(1).max(64),
        system: z.string().max(engine.policy.agent.maxPromptChars).default(""),
        tools: z.array(z.string()).max(64).default([]),
        model: z.string().min(1).max(128).optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      })
      .strict();
    const promptBody = z.object({ prompt: z.string().min(1).max(engine.policy.agent.maxPromptChars) }).strict();

    engine.post(prefix, { permission: P.create, validate: validator(createBody) }, (ctx) =>
      this.create(ctx, ctx.body as z.infer<typeof createBody>),
    );
    engine.get(prefix, { permission: P.read }, async (ctx) => {
      const agents = (await this.store.list()).filter((a) => this.visible(ctx, a));
      ctx.json(200, { ok: true, agents });
    });
    // Registered before `/:id` so it wins the match; agent ids are UUIDs and never collide.
    engine.get(`${prefix}/tools`, { permission: P.read }, (ctx) => {
      const tools = [...this.catalog.values()].filter((t) => ctx.can(t.permission)).map(({ name, description }) => ({ name, description }));
      ctx.json(200, { ok: true, tools });
    });
    engine.get(`${prefix}/:id`, { permission: P.read }, async (ctx) => {
      ctx.json(200, { ok: true, agent: await this.find(ctx) });
    });
    engine.delete(`${prefix}/:id`, { permission: P.delete }, async (ctx) => {
      const agent = await this.find(ctx);
      await this.store.delete(agent.id);
      this.emit(agent.id, { type: "agent.deleted", data: { agentId: agent.id } });
      ctx.json(200, { ok: true, deleted: agent.id });
    });
    engine.get(`${prefix}/:id/messages`, { permission: P.read }, async (ctx) => {
      const agent = await this.find(ctx);
      ctx.json(200, { ok: true, messages: await this.store.history(agent.id) });
    });
    engine.post(`${prefix}/:id/messages`, { permission: P.run, validate: validator(promptBody) }, (ctx) =>
      this.send(ctx, (ctx.body as z.infer<typeof promptBody>).prompt),
    );
    engine.get(`${prefix}/:id/events`, { permission: P.read }, (ctx) => this.listen(ctx));
  }

  private async create(ctx: Context, body: Omit<AgentRecord, "id" | "ownerId" | "createdAt">) {
    const ownerId = ctx.user!.id;
    const tools = [...new Set(body.tools)];
    // A tool the caller may not use is reported the same way as one that does not exist.
    const unknown = tools.filter((n) => {
      const t = this.catalog.get(n);
      return !t || !ctx.can(t.permission);
    });
    if (unknown.length) throw badRequest(`Unknown tools: ${unknown.join(", ")}`);

    const agent = await this.mutex.run(`owner:${ownerId}`, async () => {
      const owned = (await this.store.list()).filter((a) => a.ownerId === ownerId).length;
      if (owned >= this.limits.maxAgentsPerUser) throw new HttpError(409, "agent_limit", "Agent limit reached");
      const agent: AgentRecord = { ...body, tools, id: randomUUID(), ownerId, createdAt: new Date().toISOString() };
      await this.store.put(agent);
      return agent;
    });
    ctx.json(201, { ok: true, agent });
  }

  private async send(ctx: Context, prompt: string) {
    const { id } = await this.find(ctx);
    await this.mutex.run(`agent:${id}`, async () => {
      // Re-read inside the lock: the agent may have been deleted while this request waited.
      const agent = await this.find(ctx);
      const history = await this.store.history(id);
      const runId = randomUUID();
      const asked: HistoryEntry = { role: "user", content: prompt, at: new Date().toISOString() };
      this.emit(id, { type: "message", data: asked });
      this.emit(id, { type: "run.started", data: { runId } });

      let result: AgentResult;
      try {
        result = await runAgent({
          agent: this.definition(agent),
          model: this.model,
          ctx,
          prompt,
          history: history.map((h): ChatMessage => ({ role: h.role, content: h.content })),
          onEvent: (e) =>
            this.emit(
              id,
              e.type === "turn"
                ? { type: "turn", data: { runId, turn: e.turn, usage: e.usage } }
                : { type: "tool_call", data: { runId, name: e.name, ok: e.ok } },
            ),
        });
      } catch (err) {
        const mapped = agentRunError(err, ctx, this.model);
        this.emit(id, { type: "run.failed", data: { runId, code: mapped instanceof HttpError ? mapped.code : "internal_error" } });
        throw mapped;
      }

      // Only text turns are kept, so the conversation always alternates user/assistant.
      if (result.text && (await this.store.get(id))) {
        const answer: HistoryEntry = { role: "assistant", content: result.text, at: new Date().toISOString() };
        await this.store.setHistory(id, this.trim([...history, asked, answer]));
        this.emit(id, { type: "message", data: answer });
      }
      this.emit(id, { type: "run.completed", data: { runId, ...result } });
      ctx.json(200, { ok: result.status === "completed", runId, ...result });
    });
  }

  private async listen(ctx: Context) {
    const { id } = await this.find(ctx);
    if (this.bus.listenerCount(id) >= this.limits.maxListenersPerAgent) {
      throw new HttpError(429, "too_many_listeners", "Too many listeners on this agent");
    }
    const res = ctx.stream(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    write("ready", { agentId: id });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const unsubscribe = this.subscribe(id, (e) => {
      write(e.type, e.data);
      if (e.type === "agent.deleted") res.end();
    });
    try {
      await new Promise<void>((resolve) => res.once("close", resolve));
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }

  /** The agent named by `:id`, or 404 if it does not exist or the caller may not see it. */
  private async find(ctx: Context): Promise<AgentRecord> {
    const agent = await this.store.get(ctx.params.id!);
    if (!agent || !this.visible(ctx, agent)) throw agentNotFound();
    return agent;
  }

  private visible(ctx: Context, agent: AgentRecord): boolean {
    return agent.ownerId === ctx.user!.id || ctx.can(AGENT_PERMISSIONS.manage);
  }

  private definition(agent: AgentRecord): AgentDefinition {
    return {
      name: agent.name,
      system: agent.system,
      tools: agent.tools.flatMap((n) => this.catalog.get(n) ?? []),
      model: agent.model,
      effort: agent.effort,
    };
  }

  private trim(entries: HistoryEntry[]): HistoryEntry[] {
    const kept = entries.slice(-this.limits.maxHistoryMessages);
    return kept[0]?.role === "assistant" ? kept.slice(1) : kept;
  }

  private emit(agentId: string, event: ServiceEvent) {
    this.bus.emit(agentId, event);
  }
}

function validator<S extends z.ZodType>(schema: S) {
  return (raw: unknown) => {
    const r = schema.safeParse(raw);
    if (!r.success) throw badRequest(`Invalid body: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  };
}
