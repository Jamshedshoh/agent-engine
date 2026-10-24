import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Engine, defineTool } from "../src/index.ts";

import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from "../src/index.ts";

const msg = (over: Partial<ModelResponse> & { content: ModelResponse["content"] }, out = 10): ModelResponse => ({
  stopReason: "end",
  usage: { inputTokens: 5, outputTokens: out },
  ...over,
});
const text = (t: string) => ({ type: "text" as const, text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_call" as const, id, name, input });

let server: Server;
let base: string;
let script: ModelResponse[] = [];
let seen: ModelRequest[] = [];

const fakeModel: ModelProvider = {
  name: "fake",
  async generate(params) {
  seen.push({ ...params, messages: structuredClone(params.messages) });
  const next = script.shift();
  if (!next) throw new Error("script exhausted");
  return next;
  },
};

const agent = {
  name: "t",
  system: "sys",
  tools: [
    defineTool({ name: "add", description: "add", permission: "tools:math", input: z.object({ a: z.number(), b: z.number() }), run: ({ a, b }) => String(a + b) }),
    defineTool({ name: "boom", description: "fails", permission: "tools:math", input: z.object({}), run: () => { throw new Error("secret internals"); } }),
    defineTool({ name: "secret", description: "admin only", permission: "tools:admin", input: z.object({}), run: () => "s" }),
  ],
};

before(async () => {
  const app = new Engine({
    auth: { a: { id: "alice", roles: ["math"] }, n: { id: "nobody", roles: ["none"] } },
    roles: { math: ["agents:run", "tools:math"], none: [] },
    policy: { agent: { maxTurns: 3, maxOutputTokens: 100, maxPromptChars: 50 } },
    model: fakeModel,
  });
  app.agent("/run", { permission: "agents:run", agent });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const run = (prompt: unknown, key = "a") =>
  fetch(`${base}/run`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ prompt }) });

test("runs the tool loop and only offers permitted tools", async () => {
  script = [msg({ stopReason: "tool_use", content: [toolUse("t1", "add", { a: 2, b: 3 })] }), msg({ content: [text("5")] })];
  seen = [];
  const r = await run("2+3?");
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: j.ok, text: j.text, turns: j.turns, status: j.status }, { ok: true, text: "5", turns: 2, status: "completed" });
  assert.deepEqual(j.toolCalls, [{ name: "add", ok: true }]);
  assert.deepEqual(j.usage, { inputTokens: 10, outputTokens: 20 });
  assert.deepEqual(seen[0]!.tools.map((t) => t.name), ["add", "boom"]); // no "secret"
  const toolResult = (seen[1]!.messages.at(-1)!.content as { content: string }[])[0]!;
  assert.equal(toolResult.content, "5");
});

test("bad tool input and tool failures become error results without leaking internals", async () => {
  script = [
    msg({ stopReason: "tool_use", content: [toolUse("t1", "add", { a: "x" }), toolUse("t2", "boom", {}), toolUse("t3", "secret", {})] }),
    msg({ content: [text("done")] }),
  ];
  seen = [];
  const j = await (await run("go")).json();
  assert.deepEqual(j.toolCalls.map((c: { ok: boolean }) => c.ok), [false, false, false]);
  const results = seen[1]!.messages.at(-1)!.content as { content: string; isError: boolean }[];
  assert.ok(results.every((x) => x.isError));
  assert.match(results[0]!.content, /Invalid input/);
  assert.equal(results[1]!.content, "Tool execution failed");
  assert.match(results[2]!.content, /Unknown tool/); // forbidden tool is indistinguishable from unknown
});

test("max turns, output budget, refusal and truncation are reported, not thrown", async () => {
  const loop = () => msg({ stopReason: "tool_use", content: [toolUse("t", "add", { a: 1, b: 1 })] });
  script = [loop(), loop(), loop(), loop()];
  assert.equal((await (await run("x")).json()).status, "max_turns");

  script = [msg({ stopReason: "tool_use", content: [toolUse("t", "add", { a: 1, b: 1 })] }, 150)];
  assert.equal((await (await run("x")).json()).status, "budget_exhausted");

  script = [msg({ stopReason: "refusal", refusalCategory: "cyber", content: [] })];
  const refused = await (await run("x")).json();
  assert.deepEqual([refused.status, refused.ok, refused.refusalCategory], ["refused", false, "cyber"]);

  script = [msg({ stopReason: "max_tokens", content: [text("par")] })];
  assert.equal((await (await run("x")).json()).status, "truncated");
});

test("request shape: per-turn token cap, effort, system", async () => {
  script = [msg({ content: [text("hi")] })];
  seen = [];
  await run("hi");
  assert.equal(seen[0]!.maxTokens, 100); // min(16000, policy budget 100)
  assert.equal(seen[0]!.effort, "medium");
  assert.equal(seen[0]!.system, "sys");
  assert.equal(seen[0]!.model, undefined);
});

test("body validation and access control", async () => {
  assert.equal((await run("x".repeat(51))).status, 400); // maxPromptChars
  assert.equal((await run(123)).status, 400);
  assert.equal((await run("hi", "n")).status, 403);
  assert.equal((await fetch(`${base}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
});

test("provider failures map to 502 without leaking details", async () => {
  const failing = new Engine({
    auth: { a: { id: "u", roles: ["math"] } },
    roles: { math: ["*"] },
    model: { name: "bad", generate: async () => { throw new ProviderError("boom key=sk-xxx", 500); } },
  });
  failing.agent("/run", { permission: "agents:run", agent });
  const s = failing.listen(0);
  await new Promise((r) => s.once("listening", r));
  const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/run`, { method: "POST", headers: { authorization: "Bearer a", "content-type": "application/json" }, body: '{"prompt":"hi"}' });
  const body = await r.text();
  s.close();
  assert.equal(r.status, 502);
  assert.ok(!body.includes("sk-xxx"));
});

test("registering an agent route without a model fails fast", () => {
  const e = new Engine({ auth: {}, roles: {} });
  assert.throws(() => e.agent("/x", { permission: "p", agent }), /model/);
});
