import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedModel, ProviderError, type ModelRequest } from "../src/index.ts";

const tools = [
  { name: "get_current_time", description: "time", inputSchema: { type: "object" as const, properties: {} } },
  { name: "add", description: "add", inputSchema: { type: "object" as const, properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
];
const req = (prompt: string, over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "",
  messages: [{ role: "user", content: prompt }],
  tools,
  maxTokens: 1000,
  signal: new AbortController().signal,
  ...over,
});
const sim = new SimulatedModel();

test("calls matching tools with inputs filled from the prompt", async () => {
  const r = await sim.generate(req("please add 2 and 3"));
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.content.map((p) => p.type === "tool_call" && [p.name, p.input]), [["add", { a: 2, b: 3 }]]);
  const t = await sim.generate(req("what time is it?"));
  assert.deepEqual(t.content.map((p) => p.type === "tool_call" && p.name), ["get_current_time"]);
});

test("skips a tool whose required inputs cannot be filled; echoes otherwise", async () => {
  const r = await sim.generate(req("add things"));
  assert.equal(r.stopReason, "end");
  assert.deepEqual(r.content, [{ type: "text", text: "[simulated] You said: add things" }]);
});

test("summarizes tool results on the next turn", async () => {
  const first = await sim.generate(req("add 1 and 2"));
  const call = first.content[0]!;
  assert.equal(call.type, "tool_call");
  const r = await sim.generate(
    req("add 1 and 2", {
      messages: [
        { role: "user", content: "add 1 and 2" },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", toolCallId: (call as { id: string }).id, content: "3" }] },
      ],
    }),
  );
  assert.deepEqual(r.content, [{ type: "text", text: "[simulated] Tool results: add -> 3" }]);
  assert.equal(r.stopReason, "end");
});

test("magic prompts: refusal, error, long output hits max_tokens", async () => {
  const refused = await sim.generate(req("simulate:refuse"));
  assert.deepEqual([refused.stopReason, refused.refusalCategory], ["refusal", "simulated"]);
  await assert.rejects(sim.generate(req("simulate:error")), ProviderError);
  const long = await sim.generate(req("simulate:long", { maxTokens: 50 }));
  assert.deepEqual([long.stopReason, long.usage.outputTokens], ["max_tokens", 50]);
});

test("custom respond hook and abort support", async () => {
  const scripted = new SimulatedModel({ respond: (_r, turn) => ({ content: [{ type: "text", text: `turn ${turn}` }], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } }) });
  assert.equal(((await scripted.generate(req("x"))).content[0] as { text: string }).text, "turn 1");
  const ac = new AbortController();
  const slow = new SimulatedModel({ latencyMs: 1000 });
  const p = slow.generate(req("x", { signal: ac.signal }));
  ac.abort();
  await assert.rejects(p);
});
