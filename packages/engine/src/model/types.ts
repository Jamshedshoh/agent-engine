/** Provider-neutral model interface. The engine and agent runner depend only on this. */

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "tool_call"; id: string; name: string; input: unknown };
export type ToolResultPart = { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };
export type ContentPart = TextPart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
  /** Provider-native form of an assistant turn. Adapters may use it to replay turns losslessly. */
  raw?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: { type: "object"; [k: string]: unknown };
}

export interface ModelRequest {
  /** Provider-specific model id; adapters fall back to their own default. */
  model?: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  signal: AbortSignal;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal";

export interface ModelResponse {
  content: ContentPart[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
  refusalCategory?: string | null;
  raw?: unknown;
}

export interface ModelProvider {
  readonly name: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** Thrown by providers for upstream failures. The engine maps it to 502 without leaking details. */
export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.status = status;
  }
}
