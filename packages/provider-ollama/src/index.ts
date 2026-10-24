import {
  ProviderError,
  type ChatMessage,
  type ContentPart,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@agent-engine/core";

/** Message shapes of Ollama's native /api/chat. */
export interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** On role "tool": which tool produced this result. */
  tool_name?: string;
}
export interface OllamaChatResponse {
  message: OllamaMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaProviderOptions {
  /** Server root, e.g. http://localhost:11434. */
  baseUrl?: string;
  /** Used when the request names no model. */
  defaultModel?: string;
  /** Context window in tokens (Ollama's num_ctx). Omit for the server default. */
  numCtx?: number;
  /** Override the transport (tests). */
  fetch?: typeof fetch;
}

export class OllamaProvider implements ModelProvider {
  readonly name = "ollama";
  private baseUrl: string;
  private defaultModel: string;
  private numCtx?: number;
  private fetch: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? "qwen2.5:0.5b";
    this.numCtx = opts.numCtx;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: req.model ?? this.defaultModel,
      stream: false,
      messages: toOllamaMessages(req.system, req.messages),
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
        : {}),
      // `effort` has no Ollama equivalent and is ignored.
      options: { num_predict: req.maxTokens, ...(this.numCtx ? { num_ctx: this.numCtx } : {}) },
    };

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err; // the runner maps aborts to timeouts
      throw new ProviderError(`Ollama unreachable at ${this.baseUrl}`, undefined, { cause: err });
    }
    if (!res.ok) {
      // Ollama reports e.g. a missing model as {"error":"model \"x\" not found, try pulling it first"}.
      const detail = await res.json().then((j: { error?: string }) => j.error, () => undefined);
      throw new ProviderError(detail ?? `Ollama returned HTTP ${res.status}`, res.status);
    }
    return fromOllama((await res.json()) as OllamaChatResponse);
  }
}

export function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = system ? [{ role: "system", content: system }] : [];
  // Tool results reference calls by id; Ollama wants the tool's name instead.
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    const calls = m.content.filter((p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call");
    if (m.role === "assistant") {
      for (const c of calls) toolNames.set(c.id, c.name);
      out.push({
        role: "assistant",
        content: text,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: (c.input ?? {}) as Record<string, unknown> } })) }
          : {}),
      });
      continue;
    }
    for (const p of m.content) {
      if (p.type === "tool_result") {
        out.push({ role: "tool", content: p.isError ? `Error: ${p.content}` : p.content, tool_name: toolNames.get(p.toolCallId) });
      }
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

export function fromOllama(res: OllamaChatResponse): ModelResponse {
  const calls = res.message.tool_calls ?? [];
  const content: ContentPart[] = [
    ...(res.message.content ? [{ type: "text" as const, text: res.message.content }] : []),
    // Older Ollama versions omit call ids; synthesize stable ones per response.
    ...calls.map((c, i) => ({ type: "tool_call" as const, id: c.id ?? `call_${i}`, name: c.function.name, input: c.function.arguments })),
  ];
  return {
    content,
    stopReason: calls.length ? "tool_use" : res.done_reason === "length" ? "max_tokens" : "end",
    usage: { inputTokens: res.prompt_eval_count ?? 0, outputTokens: res.eval_count ?? 0 },
  };
}
