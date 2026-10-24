import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Engine, defineTool, ProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from "../src/index.ts";

const text = (t: string) => ({ type: "text" as const, text: t });
const reply = (over: Partial<ModelResponse> & { content: ModelResponse["content"] }): ModelResponse => ({
  stopReason: "end",
  usage: { inputTokens: 5, outputTokens: 10 },
  ...over,
});

let server: Server;
let base: string;
let script: (ModelResponse | Error)[] = [];
let seen: ModelRequest[] = [];

const fakeModel: ModelProvider = {
  name: "fake",
  async generate(params) {
    seen.push({ ...params, messages: structuredClone(params.messages) });
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  },
};

before(async () => {
  const app = new Engine({
    auth: {
      a: { id: "alice", roles: ["builder"] },
      b: { id: "bob", roles: ["builder"] },
      v: { id: "val", roles: ["viewer"] },
      m: { id: "mona", roles: ["admin"] },
    },
    roles: {
      builder: ["agents:create", "agents:read", "agents:run", "agents:delete", "tools:math"],
      viewer: ["agents:read"],
      admin: ["*"],
    },
    model: fakeModel,
  });
  app.agentService({
    tools: [
      defineTool({ name: "add", description: "add", permission: "tools:math", input: z.object({ a: z.number(), b: z.number() }), run: ({ a, b }) => String(a + b) }),
      defineTool({ name: "secret", description: "admin only", permission: "tools:admin", input: z.object({}), run: () => "s" }),
    ],
    maxAgentsPerUser: 3,
    maxHistoryMessages: 4,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/agents`;
});
after(() => server.close());

const call = (method: string, path: string, key: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const create = async (key: string, body: unknown = { name: "helper", system: "be brief", tools: ["add"] }) => {
  const r = await call("POST", "", key, body);
  return { status: r.status, json: await r.json() };
};

/** Reads SSE events until `until` returns true. */
async function readEvents(res: Response, until: (events: { event: string; data: any }[]) => boolean) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { event: string; data: any }[] = [];
  let buf = "";
  while (!until(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (event) events.push({ event, data: data && JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

test("create, list and inspect agents", async () => {
  const { status, json } = await create("a");
  assert.equal(status, 201);
  assert.deepEqual([json.agent.name, json.agent.system, json.agent.tools, json.agent.ownerId], ["helper", "be brief", ["add"], "alice"]);

  const list = await (await call("GET", "", "a")).json();
  assert.ok(list.agents.some((x: { id: string }) => x.id === json.agent.id));
  const got = await (await call("GET", `/${json.agent.id}`, "a")).json();
  assert.equal(got.agent.id, json.agent.id);
});

test("create validates the body and hides tools the creator may not use", async () => {
  assert.equal((await create("a", { name: "" })).status, 400);
  assert.equal((await create("a", { name: "x", extra: 1 })).status, 400);
  const unknown = await create("a", { name: "x", tools: ["secret", "nope"] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error.message, /Unknown tools: secret, nope/);
  assert.equal((await create("m", { name: "x", tools: ["secret"] })).status, 201); // admin may
  assert.equal((await create("v")).status, 403); // viewer cannot create
});

test("tool catalog lists only tools the caller may use", async () => {
  const names = async (key: string) => (await (await call("GET", "/tools", key)).json()).tools.map((t: { name: string }) => t.name);
  assert.deepEqual(await names("a"), ["add"]);
  assert.deepEqual(await names("m"), ["add", "secret"]);
});

test("agents are private to their owner unless the caller holds agents:manage", async () => {
  const { json } = await create("b");
  const id = json.agent.id;
  assert.equal((await call("GET", `/${id}`, "a")).status, 404);
  assert.equal((await call("POST", `/${id}/messages`, "a", { prompt: "hi" })).status, 404);
  assert.equal((await call("DELETE", `/${id}`, "a")).status, 404);
  const aliceList = await (await call("GET", "", "a")).json();
  assert.ok(!aliceList.agents.some((x: { id: string }) => x.id === id));
  assert.equal((await call("GET", `/${id}`, "m")).status, 200);
});

test("per-user agent limit", async () => {
  const fresh = new Engine({ auth: { k: { id: "k", roles: ["r"] } }, roles: { r: ["*"] }, model: fakeModel });
  fresh.agentService({ tools: [], maxAgentsPerUser: 1 });
  const s = fresh.listen(0);
  await new Promise((r) => s.once("listening", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/services/agents`;
  const post = () => fetch(url, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: '{"name":"x"}' });
  const results = await Promise.all([post(), post(), post()]);
  s.close();
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
});

test("prompts keep conversation history, trimmed to the limit", async () => {
  const { json } = await create("a");
  const id = json.agent.id;
  seen = [];
  script = [reply({ content: [text("one")] }), reply({ content: [text("two")] }), reply({ content: [text("three")] })];
  for (const p of ["q1", "q2", "q3"]) {
    const r = await call("POST", `/${id}/messages`, "a", { prompt: p });
    assert.equal(r.status, 200);
  }
  assert.equal(seen[0]!.system, "be brief");
  assert.deepEqual(seen[0]!.tools.map((t) => t.name), ["add"]);
  assert.deepEqual(seen[2]!.messages.map((m) => m.content), ["q1", "one", "q2", "two", "q3"]);

  const { messages } = await (await call("GET", `/${id}/messages`, "a")).json();
  assert.deepEqual(messages.map((m: { content: string }) => m.content), ["q2", "two", "q3", "three"]); // maxHistoryMessages: 4
});

test("listeners receive the run as it happens, and the stream ends when the agent is deleted", async () => {
  const { json } = await create("a");
  const id = json.agent.id;
  const res = await call("GET", `/${id}/events`, "a");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/event-stream/);
  assert.ok(res.headers.get("x-request-hash"));

  script = [
    reply({ stopReason: "tool_use", content: [{ type: "tool_call", id: "t1", name: "add", input: { a: 2, b: 3 } }] }),
    reply({ content: [text("5")] }),
  ];
  const sent = call("POST", `/${id}/messages`, "a", { prompt: "2+3?" });
  const events = await readEvents(res, (ev) => ev.some((e) => e.event === "run.completed"));
  assert.equal((await sent).status, 200);
  assert.deepEqual(events.map((e) => e.event), ["ready", "message", "run.started", "turn", "tool_call", "turn", "message", "run.completed"]);
  assert.deepEqual(events[4]!.data.name, "add");
  assert.equal(events.at(-1)!.data.text, "5");

  const listener = await call("GET", `/${id}/events`, "a");
  const ended = readEvents(listener, () => false);
  assert.equal((await call("DELETE", `/${id}`, "a")).status, 200);
  assert.deepEqual((await ended).map((e) => e.event), ["ready", "agent.deleted"]);
  assert.equal((await call("GET", `/${id}`, "a")).status, 404);
});

test("provider failures surface as 502 and a run.failed event", async () => {
  const { json } = await create("a");
  const id = json.agent.id;
  const res = await call("GET", `/${id}/events`, "a");
  script = [new ProviderError("key=sk-xxx", 500)];
  const r = await call("POST", `/${id}/messages`, "a", { prompt: "hi" });
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes("sk-xxx"));
  const events = await readEvents(res, (ev) => ev.some((e) => e.event === "run.failed"));
  assert.equal(events.at(-1)!.data.code, "upstream_error");
  const { messages } = await (await call("GET", `/${id}/messages`, "a")).json();
  assert.deepEqual(messages, []);
});
