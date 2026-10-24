import type { Context } from "../types.ts";
import { HttpError } from "../errors.ts";
import { ProviderError, type ModelProvider } from "../model/index.ts";

/** Maps an agent run failure to an HttpError without leaking provider details. */
export function agentRunError(err: unknown, ctx: Context, model: ModelProvider): unknown {
  if (err instanceof HttpError) return err;
  if (err instanceof Error && err.name === "AbortError") return new HttpError(504, "agent_timeout");
  if (err instanceof ProviderError) {
    console.error(`[${ctx.id}] upstream (${model.name})`, err.status, err.message);
    return new HttpError(502, "upstream_error", "Model provider error");
  }
  return err;
}
