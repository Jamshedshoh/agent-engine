import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApiKeys, parseModel, parsePort, parsePositiveInt } from "../src/config.ts";

test("parses keys, users and roles", () => {
  assert.deepEqual(parseApiKeys(" k1=alice:admin ; k2=bob:viewer,builder ;"), {
    k1: { id: "alice", roles: ["admin"] },
    k2: { id: "bob", roles: ["viewer", "builder"] },
  });
});

test("rejects empty, malformed and duplicate entries without echoing keys", () => {
  assert.throws(() => parseApiKeys(undefined), /empty/);
  assert.throws(() => parseApiKeys("  ;  "), /empty/);
  for (const bad of ["secret-key", "secret-key=alice", "secret-key=:admin", "secret key=alice:admin"]) {
    assert.throws(() => parseApiKeys(bad), (e: Error) => /entry 1/.test(e.message) && !e.message.includes("secret"));
  }
  assert.throws(() => parseApiKeys("k=a:admin;k=b:viewer"), /entry 2 repeats/);
});

test("model choice defaults to ollama and rejects anything else", () => {
  assert.equal(parseModel(undefined), "ollama");
  assert.equal(parseModel(""), "ollama");
  assert.equal(parseModel(" Simulated "), "simulated");
  assert.throws(() => parseModel("anthropic"), /MODEL must be/);
});

test("positive integers", () => {
  assert.equal(parsePositiveInt("N", undefined), undefined);
  assert.equal(parsePositiveInt("N", "8192"), 8192);
  assert.throws(() => parsePositiveInt("N", "0"), /N must be/);
  assert.throws(() => parsePositiveInt("N", "1.5"), /N must be/);
});

test("port defaults and validation", () => {
  assert.equal(parsePort(undefined, 3000), 3000);
  assert.equal(parsePort("8081", 3000), 8081);
  assert.throws(() => parsePort("abc", 3000), /PORT/);
  assert.throws(() => parsePort("70000", 3000), /PORT/);
});
