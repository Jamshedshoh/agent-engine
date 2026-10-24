import type { ChatMessage, ContentPart, ModelProvider, ModelRequest, ModelResponse, ToolSpec } from "./types.ts";
import { ProviderError } from "./types.ts";

export interface SimulatedModelOptions {
  /** Fixed delay per call, to mimic latency. */
  latencyMs?: number;
  /** Replace the built-in behaviour entirely. `turn` is the 1-based call count within the conversation. */
  respond?: (req: ModelRequest, turn: number) => ModelResponse | Promise<ModelResponse>;
}

const STOPWORDS = new Set(["get", "set", "the", "current", "fetch", "run", "tool"]);
const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/**
 * Deterministic, offline stand-in for a real model. Default behaviour:
 *  - calls each available tool whose name keywords appear in the prompt, filling number
 *    properties from the numbers in the prompt (in order) and string properties with the prompt;
 *  - once tool results are in, answers with a summary of them;
 *  - otherwise echoes the prompt.
 * Magic prompts: "simulate:refuse" -> refusal, "simulate:error" -> ProviderError,
 * "simulate:long" -> a long answer (to exercise max_tokens).
 */
export class SimulatedModel implements ModelProvider {
  readonly name = "simulated";
  private opts: SimulatedModelOptions;

  constructor(opts: SimulatedModelOptions = {}) {
    this.opts = opts;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (this.opts.latencyMs) await delay(this.opts.latencyMs, req.signal);
    req.signal.throwIfAborted();

    const turn = req.messages.filter((m) => m.role === "assistant").length + 1;
    const res = this.opts.respond ? await this.opts.respond(req, turn) : this.defaultRespond(req);
    return res;
  }

  private defaultRespond(req: ModelRequest): ModelResponse {
    const prompt = firstUserText(req.messages);
    const inputTokens = estimateTokens(req.system + JSON.stringify(req.messages));
    const done = (content: ContentPart[], extra: Partial<ModelResponse> = {}): ModelResponse => {
      let text = content.map((p) => (p.type === "text" ? p.text : JSON.stringify(p.type === "tool_call" ? p.input : ""))).join("");
      let outputTokens = estimateTokens(text);
      let stopReason = extra.stopReason ?? (content.some((p) => p.type === "tool_call") ? "tool_use" : "end");
      if (outputTokens > req.maxTokens) {
        // Cut the text at the token cap, like a real model would.
        text = text.slice(0, req.maxTokens * 4);
        content = [{ type: "text", text }];
        outputTokens = req.maxTokens;
        stopReason = "max_tokens";
      }
      return { content, stopReason, usage: { inputTokens, outputTokens }, ...extra };
    };

    if (/simulate:error/.test(prompt)) throw new ProviderError("simulated upstream failure", 500);
    if (/simulate:refuse/.test(prompt)) return done([], { stopReason: "refusal", refusalCategory: "simulated" });
    if (/simulate:long/.test(prompt)) return done([{ type: "text", text: "lorem ipsum ".repeat(5000) }]);

    const last = req.messages.at(-1);
    const results = last && Array.isArray(last.content) ? last.content.filter((p) => p.type === "tool_result") : [];
    if (results.length) {
      const names = new Map(callsById(req.messages));
      const summary = results.map((r) => `${names.get(r.toolCallId) ?? "tool"} -> ${r.isError ? "error: " : ""}${r.content}`).join("; ");
      return done([{ type: "text", text: `[simulated] Tool results: ${summary}` }]);
    }

    const calls = req.tools.flatMap((t, i) => {
      const input = matchTool(t, prompt);
      return input ? [{ type: "tool_call" as const, id: `sim_${i}_${Date.now().toString(36)}`, name: t.name, input }] : [];
    });
    if (calls.length) return done(calls);

    return done([{ type: "text", text: `[simulated] You said: ${prompt}` }]);
  }
}

function firstUserText(messages: ChatMessage[]): string {
  const m = messages.find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : "";
}

function* callsById(messages: ChatMessage[]): Generator<[string, string]> {
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === "tool_call") yield [p.id, p.name];
    }
  }
}

/** Returns generated input if the tool looks relevant to the prompt and its required fields can be filled. */
function matchTool(tool: ToolSpec, prompt: string): Record<string, unknown> | null {
  const keywords = tool.name.split(/[_\W]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  const lower = prompt.toLowerCase();
  if (!keywords.some((k) => new RegExp(`\\b${k.toLowerCase()}`).test(lower))) return null;

  const numbers = [...prompt.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  const required = new Set((tool.inputSchema.required ?? []) as string[]);
  const input: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(props)) {
    if (spec.type === "number" || spec.type === "integer") {
      if (numbers.length) input[key] = numbers.shift();
    } else if (spec.type === "string") input[key] = prompt;
    else if (spec.type === "boolean") input[key] = false;
    if (required.has(key) && !(key in input)) return null;
  }
  return input;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}
