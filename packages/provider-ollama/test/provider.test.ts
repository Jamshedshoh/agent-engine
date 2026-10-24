import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, type ModelRequest } from "@agent-engine/core";
import { OllamaProvider } from "../src/index.ts";

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 100,
  signal: new AbortController().signal,
  ...over,
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A provider whose transport records the request and answers with `body`. */
function fake(body: unknown, status = 200) {
  const seen: { url?: string; body?: any } = {};
  const provider = new OllamaProvider({
    baseUrl: "http://ollama:11434/",
    numCtx: 8192,
    fetch: async (url, init) => {
      seen.url = String(url);
      seen.body = JSON.parse(String(init!.body));
      return reply(body, status);
    },
  });
  return { provider, seen };
}

test("request shape: endpoint, default model, system, token cap, context", async () => {
  const { provider, seen } = fake({ message: { role: "assistant", content: "yo" }, done_reason: "stop", prompt_eval_count: 5, eval_count: 7 });
  const res = await provider.generate(req());
  assert.equal(seen.url, "http://ollama:11434/api/chat");
  assert.equal(seen.body.model, "qwen2.5:0.5b");
  assert.equal(seen.body.stream, false);
  assert.deepEqual(seen.body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
  assert.deepEqual(seen.body.options, { num_predict: 100, num_ctx: 8192 });
  assert.equal(seen.body.tools, undefined);
  assert.deepEqual(res, { content: [{ type: "text", text: "yo" }], stopReason: "end", usage: { inputTokens: 5, outputTokens: 7 } });
});

test("maps tool calls and results both ways", async () => {
  const { provider, seen } = fake({ message: { role: "assistant", content: "5" } });
  await provider.generate(
    req({
      model: "llama3.2:3b",
      tools: [{ name: "add", description: "d", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "adding" }, { type: "tool_call", id: "t1", name: "add", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "2" }, { type: "tool_result", toolCallId: "zz", content: "bad", isError: true }] },
      ],
    }),
  );
  assert.equal(seen.body.model, "llama3.2:3b");
  assert.deepEqual(seen.body.tools, [{ type: "function", function: { name: "add", description: "d", parameters: { type: "object" } } }]);
  assert.deepEqual(seen.body.messages.slice(2), [
    { role: "assistant", content: "adding", tool_calls: [{ id: "t1", function: { name: "add", arguments: { a: 1 } } }] },
    { role: "tool", content: "2", tool_name: "add" },
    { role: "tool", content: "Error: bad" },
  ]);

  const tc = await fake({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "add", arguments: { a: 2 } } }] } }).provider.generate(req());
  assert.equal(tc.stopReason, "tool_use");
  assert.deepEqual(tc.content, [{ type: "tool_call", id: "call_0", name: "add", input: { a: 2 } }]);
});

test("length stop maps to max_tokens", async () => {
  const r = await fake({ message: { role: "assistant", content: "par" }, done_reason: "length" }).provider.generate(req());
  assert.equal(r.stopReason, "max_tokens");
});

test("HTTP and network failures become ProviderError; aborts pass through", async () => {
  await assert.rejects(fake({ error: 'model "x" not found, try pulling it first' }, 404).provider.generate(req()), (e) =>
    e instanceof ProviderError && e.status === 404 && /not found/.test(e.message),
  );

  const down = new OllamaProvider({ fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.generate(req()), (e) => e instanceof ProviderError && /unreachable/.test(e.message));

  const abort = new OllamaProvider({ fetch: async () => { throw new DOMException("aborted", "AbortError"); } });
  await assert.rejects(abort.generate(req()), (e) => (e as Error).name === "AbortError");
});
