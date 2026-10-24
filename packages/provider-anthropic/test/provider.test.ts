import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type ModelRequest } from "@agent-engine/core";
import { AnthropicProvider } from "../src/index.ts";

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 100,
  signal: new AbortController().signal,
  ...over,
});
const fake = (content: unknown[], stop_reason = "end_turn") =>
  ({ content, stop_reason, stop_details: null, usage: { input_tokens: 5, output_tokens: 7 } }) as never;

test("request shape: model, effort, fallback, token cap", async () => {
  let seen: any;
  const p = new AnthropicProvider({ create: async (params) => ((seen = params), fake([{ type: "text", text: "yo" }])) });
  const res = await p.generate(req());
  assert.equal(seen.model, "claude-opus-5-5");
  assert.deepEqual(seen.output_config, { effort: "medium" });
  assert.equal(seen.fallbacks, "default");
  assert.equal(seen.max_tokens, 100);
  assert.equal(seen.tools, undefined);
  assert.deepEqual(res, { content: [{ type: "text", text: "yo" }], stopReason: "end", usage: { inputTokens: 5, outputTokens: 7 }, refusalCategory: null, raw: [{ type: "text", text: "yo" }] });
});

test("maps tool calls and results both ways; replays raw assistant turn", async () => {
  let seen: any;
  const raw = [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "add", input: { a: 1 } }];
  const p = new AnthropicProvider({ create: async (params) => ((seen = params), fake([{ type: "text", text: "ok" }])) });
  await p.generate(
    req({
      tools: [{ name: "add", description: "d", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "add", input: { a: 1 } }], raw },
        { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "2", isError: false }] },
      ],
    }),
  );
  assert.deepEqual(seen.messages[1].content, raw);
  assert.deepEqual(seen.messages[2].content, [{ type: "tool_result", tool_use_id: "t1", content: "2", is_error: false }]);
  assert.deepEqual(seen.tool_choice, { type: "auto" });

  const tc = await new AnthropicProvider({ create: async () => fake([{ type: "tool_use", id: "x", name: "add", input: { a: 2 } }], "tool_use") }).generate(req());
  assert.equal(tc.stopReason, "tool_use");
  assert.deepEqual(tc.content, [{ type: "tool_call", id: "x", name: "add", input: { a: 2 } }]);
});

test("refusal maps with category; API errors become ProviderError", async () => {
  const refusal = { ...(fake([], "refusal") as object), stop_details: { type: "refusal", category: "cyber" } } as never;
  const r = await new AnthropicProvider({ create: async () => refusal }).generate(req());
  assert.deepEqual([r.stopReason, r.refusalCategory], ["refusal", "cyber"]);

  const failing = new AnthropicProvider({ create: async () => { throw new Anthropic.InternalServerError(500, { type: "error" }, "boom", new Headers()); } });
  await assert.rejects(failing.generate(req()), (e) => e instanceof ProviderError && e.status === 500);
});

test("fallback can be disabled", async () => {
  let seen: any;
  await new AnthropicProvider({ fallback: false, create: async (params) => ((seen = params), fake([])) }).generate(req());
  assert.equal(seen.fallbacks, undefined);
  assert.equal(seen.betas, undefined);
});
