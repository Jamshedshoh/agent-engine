import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Context, Handler, Middleware, Route } from "./types.ts";
import { compose } from "./compose.ts";
import { Router } from "./router.ts";
import { resolvePolicy, type MasterPolicy, type PolicyOverrides } from "./policy.ts";
import { errorHandler } from "./middleware/errorHandler.ts";
import { limitsOut } from "./middleware/limitsOut.ts";
import { limitsIn } from "./middleware/limitsIn.ts";
import { authenticate, authorize, rateLimit, apiKeyAuthenticator, hasPermission, type Authenticator, type RoleMap } from "./middleware/auth.ts";
import { parser } from "./middleware/parser.ts";
import { hashChain } from "./middleware/hashchain.ts";
import { MemoryHashStore, type HashStore } from "./stores/memory.ts";
import type { User } from "./types.ts";
import { runAgent, type AgentDefinition } from "./agent/index.ts";
import { ProviderError, type ModelProvider } from "./model/index.ts";
import { z } from "zod";
import { badRequest, HttpError } from "./errors.ts";

export interface EngineOptions {
  policy?: PolicyOverrides;
  /** Pass a custom Authenticator, or a map of API key -> User. */
  auth: Authenticator | Record<string, User>;
  roles: RoleMap;
  hashStore?: HashStore;
  /** Model backing agent routes: any ModelProvider (SimulatedModel, an Anthropic adapter, ...). Required to register agent routes. */
  model?: ModelProvider;
}

type RouteOpts = Pick<Route, "maxBodyBytes" | "validate"> & { permission: string };

export class Engine {
  readonly policy: MasterPolicy;
  private roles: RoleMap;
  private model?: ModelProvider;
  private router = new Router();
  private pipeline: (ctx: Context) => Promise<void>;
  private head: Middleware[];
  private tail: Middleware;
  private userMiddleware: Middleware[] = [];

  constructor(opts: EngineOptions) {
    this.policy = resolvePolicy(opts.policy);
    this.roles = opts.roles;
    this.model = opts.model;
    const authenticator = typeof opts.auth === "function" ? opts.auth : apiKeyAuthenticator(opts.auth);

    const resolveRoute: Middleware = async (ctx, next) => {
      const { route, params } = this.router.resolve(ctx.method, ctx.path);
      ctx.route = route;
      ctx.params = params;
      await next();
    };
    const dispatch: Middleware = async (ctx) => {
      await ctx.route!.handler(ctx);
    };

    // Order matters: cheap head checks and identity come before any body is read.
    this.head = [
      errorHandler(),
      limitsOut(),
      limitsIn(),
      authenticate(authenticator),
      rateLimit(),
      resolveRoute,
      authorize(opts.roles),
      parser(),
      hashChain(opts.hashStore ?? new MemoryHashStore()),
    ];
    this.tail = dispatch;
    this.pipeline = compose([...this.head, this.tail]);
  }

  /** Middleware that runs after auth, parsing and hash chaining, before the handler. */
  use(mw: Middleware): this {
    this.userMiddleware.push(mw);
    this.pipeline = compose([...this.head, ...this.userMiddleware, this.tail]);
    return this;
  }

  route(method: string, pattern: string, opts: RouteOpts, handler: Handler): this {
    this.router.add({ method, pattern, handler, ...opts });
    return this;
  }

  get = (p: string, o: RouteOpts, h: Handler) => this.route("GET", p, o, h);
  post = (p: string, o: RouteOpts, h: Handler) => this.route("POST", p, o, h);

  /**
   * POST route that runs an agent on `{ prompt }`. The agent only sees tools the caller
   * is permitted to use, and every run is bounded by the master policy's `agent` limits.
   */
  agent(pattern: string, opts: { permission: string; agent: AgentDefinition; maxBodyBytes?: number }): this {
    const model = this.model;
    if (!model) throw new Error("Engine: pass a `model` (ModelProvider) in the options to register agent routes");
    const body = z.object({ prompt: z.string().min(1).max(this.policy.agent.maxPromptChars) }).strict();
    return this.post(
      pattern,
      {
        permission: opts.permission,
        maxBodyBytes: opts.maxBodyBytes,
        validate: (raw) => {
          const r = body.safeParse(raw);
          if (!r.success) throw badRequest(`Invalid body: ${r.error.issues.map((i) => i.message).join("; ")}`);
          return r.data;
        },
      },
      async (ctx) => {
        try {
          const result = await runAgent({
            agent: opts.agent,
            model,
            ctx,
            prompt: (ctx.body as { prompt: string }).prompt,
          });
          ctx.json(200, { ok: result.status === "completed", ...result });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if (err instanceof Error && err.name === "AbortError") throw new HttpError(504, "agent_timeout");
          if (err instanceof ProviderError) {
            console.error(`[${ctx.id}] upstream (${model.name})`, err.status, err.message);
            throw new HttpError(502, "upstream_error", "Model provider error");
          }
          throw err;
        }
      },
    );
  }

  /** Raw Node request listener, usable with http.createServer or in tests. */
  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const ctx = this.createContext(req, res);
    await this.pipeline(ctx);
    const r = ctx.response ?? {
      status: 500,
      headers: { "content-type": "application/json" },
      data: undefined,
      payload: Buffer.from('{"error":{"code":"no_response"}}'),
    };
    const headers: Record<string, string> = {
      ...r.headers,
      "x-request-id": ctx.id,
      "content-length": String(r.payload?.length ?? 0),
    };
    if (ctx.prevHash) headers["x-prev-request-hash"] = ctx.prevHash;
    if (ctx.hash) headers["x-request-hash"] = ctx.hash;
    res.writeHead(r.status, headers);
    res.end(r.payload);
  };

  listen(port: number, cb?: () => void): Server {
    const server = createServer({ maxHeaderSize: this.policy.input.maxHeaderBytes }, (req, res) => {
      this.handle(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.requestTimeout = this.policy.input.bodyTimeoutMs * 2;
    return server.listen(port, cb);
  }

  private createContext(req: IncomingMessage, res: ServerResponse): Context {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ctx: Context = {
      id: randomUUID(),
      req,
      res,
      method: (req.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      policy: this.policy,
      can: (permission) => !!ctx.user && hasPermission(ctx.user.roles, this.roles, permission),
      params: {},
      rawBody: Buffer.alloc(0),
      body: undefined,
      state: {},
      json(status, data, headers = {}) {
        ctx.response = { status, data, headers: { "content-type": "application/json", ...headers } };
      },
      text(status, data, headers = {}) {
        ctx.response = { status, data, headers: { "content-type": "text/plain", ...headers } };
      },
    };
    return ctx;
  }
}
