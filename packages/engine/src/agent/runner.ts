import type { Context } from "../types.ts";
import type { AgentTool } from "./tools.ts";
import type { ChatMessage, ModelProvider, ToolCallPart, ToolResultPart, ToolSpec } from "../model/types.ts";

export interface AgentDefinition {
  name: string;
  system: string;
  tools: AgentTool[];
  /** Provider-specific model id. Omit to use the provider's default. */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type AgentStatus = "completed" | "refused" | "truncated" | "max_turns" | "budget_exhausted";

export interface AgentResult {
  status: AgentStatus;
  text: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: { name: string; ok: boolean }[];
  /** Set when status is "refused". */
  refusalCategory?: string | null;
}

const MAX_TOKENS_PER_TURN = 16_000;

export async function runAgent(opts: {
  agent: AgentDefinition;
  model: ModelProvider;
  ctx: Context;
  prompt: string;
}): Promise<AgentResult> {
  const { agent, model, ctx } = opts;
  const limits = ctx.policy.agent;

  // Access control reaches into the agent: the model only learns about tools the caller may use.
  const tools = agent.tools.filter((t) => ctx.can(t.permission));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs: ToolSpec[] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.jsonSchema }));

  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt }];
  const result: AgentResult = { status: "completed", text: "", turns: 0, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [] };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limits.timeoutMs);
  // The client going away should also stop spending tokens.
  const onClose = () => !ctx.res.writableEnded && abort.abort();
  ctx.res.once("close", onClose);

  try {
    while (true) {
      if (result.turns >= limits.maxTurns) return { ...result, status: "max_turns" };
      const remaining = limits.maxOutputTokens - result.usage.outputTokens;
      if (remaining <= 0) return { ...result, status: "budget_exhausted" };

      const response = await model.generate({
        model: agent.model,
        system: agent.system,
        messages,
        tools: specs,
        maxTokens: Math.min(MAX_TOKENS_PER_TURN, remaining),
        effort: agent.effort ?? "medium",
        signal: abort.signal,
      });

      result.turns++;
      result.usage.inputTokens += response.usage.inputTokens;
      result.usage.outputTokens += response.usage.outputTokens;
      result.text = response.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

      if (response.stopReason === "refusal") {
        return { ...result, status: "refused", refusalCategory: response.refusalCategory ?? null };
      }
      if (response.stopReason === "max_tokens") return { ...result, status: "truncated" };
      if (response.stopReason !== "tool_use") return result;

      messages.push({ role: "assistant", content: response.content, raw: response.raw });

      const calls = response.content.filter((p): p is ToolCallPart => p.type === "tool_call");
      const toolResults = await Promise.all(calls.map((c) => executeTool(c, byName, ctx, limits.maxToolResultBytes, result)));
      messages.push({ role: "user", content: toolResults });
    }
  } finally {
    clearTimeout(timer);
    ctx.res.off("close", onClose);
  }
}

async function executeTool(
  call: ToolCallPart,
  byName: Map<string, AgentTool>,
  ctx: Context,
  maxBytes: number,
  result: AgentResult,
): Promise<ToolResultPart> {
  const fail = (message: string): ToolResultPart => {
    result.toolCalls.push({ name: call.name, ok: false });
    return { type: "tool_result", toolCallId: call.id, isError: true, content: message };
  };

  const tool = byName.get(call.name);
  if (!tool) return fail(`Unknown tool: ${call.name}`);
  try {
    let out = await tool.execute(call.input, ctx);
    if (Buffer.byteLength(out) > maxBytes) out = Buffer.from(out).subarray(0, maxBytes).toString("utf8") + "\n[truncated]";
    result.toolCalls.push({ name: call.name, ok: true });
    return { type: "tool_result", toolCallId: call.id, content: out };
  } catch (err) {
    console.error(`[${ctx.id}] tool ${call.name} failed:`, err);
    // Validation errors help the model self-correct; other failures stay generic.
    const isValidation = err instanceof Error && err.name === "ZodError";
    return fail(isValidation ? `Invalid input: ${(err as Error).message}` : "Tool execution failed");
  }
}
