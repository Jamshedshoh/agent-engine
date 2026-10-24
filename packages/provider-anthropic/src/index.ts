import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type ChatMessage,
  type ContentPart,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@agent-engine/core";

type Create = (params: Anthropic.Beta.MessageCreateParamsNonStreaming, opts: { signal: AbortSignal }) => Promise<Anthropic.Beta.BetaMessage>;

export interface AnthropicProviderOptions {
  /** Defaults to `new Anthropic()` (ANTHROPIC_API_KEY or an `ant auth login` profile). */
  client?: Anthropic;
  /** Used when the request names no model. */
  defaultModel?: string;
  /** Server-side refusal fallback ("default" routing). On by default. */
  fallback?: boolean;
  /** Override the transport (tests). */
  create?: Create;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private create: Create;
  private defaultModel: string;
  private fallback: boolean;

  constructor(opts: AnthropicProviderOptions = {}) {
    const client = opts.client ?? (opts.create ? undefined : new Anthropic());
    this.create = opts.create ?? ((params, o) => client!.beta.messages.create(params, o));
    this.defaultModel = opts.defaultModel ?? "claude-opus-5-5";
    this.fallback = opts.fallback ?? true;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.create(
        {
          model: req.model ?? this.defaultModel,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          ...(req.tools.length
            ? {
                tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool["input_schema"] })),
                tool_choice: { type: "auto" as const },
              }
            : {}),
          output_config: { effort: req.effort ?? "medium" },
          ...(this.fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: req.signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new ProviderError(err.message, err.status, { cause: err });
      throw err; // aborts and unexpected errors pass through
    }
    return fromAnthropic(res);
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => {
    // Replay the provider-native assistant turn (keeps thinking blocks intact).
    if (m.role === "assistant" && m.raw) return { role: "assistant", content: m.raw as Anthropic.Beta.BetaContentBlockParam[] };
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    return { role: m.role, content: m.content.map(toBlock) };
  });
}

function toBlock(p: ContentPart): Anthropic.Beta.BetaContentBlockParam {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "tool_call":
      return { type: "tool_use", id: p.id, name: p.name, input: p.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: p.toolCallId, content: p.content, is_error: p.isError };
  }
}

export function fromAnthropic(res: Anthropic.Beta.BetaMessage): ModelResponse {
  const content: ContentPart[] = res.content.flatMap((b): ContentPart[] => {
    if (b.type === "text") return [{ type: "text", text: b.text }];
    if (b.type === "tool_use") return [{ type: "tool_call", id: b.id, name: b.name, input: b.input }];
    return [];
  });
  const stopReason =
    res.stop_reason === "tool_use" ? "tool_use" : res.stop_reason === "max_tokens" ? "max_tokens" : res.stop_reason === "refusal" ? "refusal" : "end";
  return {
    content,
    stopReason,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    refusalCategory: res.stop_details?.category ?? null,
    raw: res.content,
  };
}
