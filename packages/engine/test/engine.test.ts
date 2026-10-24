import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { Engine, GENESIS_HASH } from "../src/index.ts";

let server: Server;
let base: string;

const A = { authorization: "Bearer admin-key" };
const C = { authorization: "Bearer carol-key" };
const V = { authorization: "Bearer viewer-key" };

before(async () => {
  const app = new Engine({
    auth: { "admin-key": { id: "alice", roles: ["admin"] }, "viewer-key": { id: "bob", roles: ["viewer"] }, "carol-key": { id: "carol", roles: ["viewer"] } },
    roles: { admin: ["*"], viewer: ["agents:read"] },
    policy: { input: { maxBodyBytes: 100 }, output: { maxBodyBytes: 200, requiredFields: ["ok"] } },
  });
  app.get("/agents/:id", { permission: "agents:read" }, (ctx) => ctx.json(200, { ok: true, id: ctx.params.id, password: "x" }));
  app.post("/echo", { permission: "agents:run" }, (ctx) => ctx.json(200, { ok: true, body: ctx.body }));
  app.get("/big", { permission: "agents:read" }, (ctx) => ctx.json(200, { ok: true, pad: "x".repeat(500) }));
  app.get("/nofield", { permission: "agents:read" }, (ctx) => ctx.json(200, { nope: 1 }));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("401 without credentials, 403 without permission", async () => {
  assert.equal((await fetch(`${base}/agents/1`)).status, 401);
  assert.equal((await fetch(`${base}/echo`, { method: "POST", headers: { ...V, "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/agents/1`, { headers: V })).status, 200);
});

test("redacts fields and returns request id", async () => {
  const r = await fetch(`${base}/agents/7`, { headers: A });
  const j = await r.json();
  assert.deepEqual(j, { ok: true, id: "7" });
  assert.ok(r.headers.get("x-request-id"));
});

test("parses JSON body; rejects bad JSON and bad content type", async () => {
  const h = { ...A, "content-type": "application/json" };
  const ok = await fetch(`${base}/echo`, { method: "POST", headers: h, body: '{"a":1}' });
  assert.deepEqual((await ok.json()).body, { a: 1 });
  assert.equal((await fetch(`${base}/echo`, { method: "POST", headers: h, body: "{bad" })).status, 400);
  assert.equal((await fetch(`${base}/echo`, { method: "POST", headers: { ...A, "content-type": "image/png" }, body: "x" })).status, 415);
});

test("input body limit -> 413", async () => {
  const r = await fetch(`${base}/echo`, { method: "POST", headers: { ...A, "content-type": "text/plain" }, body: "x".repeat(500) });
  assert.equal(r.status, 413);
});

test("output limits -> 500 on oversize or missing required field", async () => {
  assert.equal((await fetch(`${base}/big`, { headers: A })).status, 500);
  assert.equal((await fetch(`${base}/nofield`, { headers: A })).status, 500);
});

test("hash chain: prev hash returned, chained, per user, and verifiable", async () => {
  const first = await fetch(`${base}/agents/1`, { headers: C });
  assert.equal(first.headers.get("x-prev-request-hash"), GENESIS_HASH);
  const h1 = first.headers.get("x-request-hash")!;

  const expected = createHash("sha256")
    .update([GENESIS_HASH, "GET", "/agents/1", "", createHash("sha256").update("").digest("hex")].join("\n"))
    .digest("hex");
  assert.equal(h1, expected);

  const second = await fetch(`${base}/agents/1`, { headers: C });
  assert.equal(second.headers.get("x-prev-request-hash"), h1);

  const stale = await fetch(`${base}/agents/1`, { headers: { ...C, "x-expected-prev-hash": GENESIS_HASH } });
  assert.equal(stale.status, 409);
});

test("404 and 405", async () => {
  assert.equal((await fetch(`${base}/nope`, { headers: A })).status, 404);
  assert.equal((await fetch(`${base}/echo`, { method: "GET", headers: A })).status, 405);
});
