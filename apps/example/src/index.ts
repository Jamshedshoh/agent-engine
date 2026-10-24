import { z } from "zod";
import { Engine, SimulatedModel, defineTool, type ModelProvider } from "@agent-engine/core";
import { AnthropicProvider } from "@agent-engine/provider-anthropic";

// Offline by default. Set MODEL=anthropic (plus ANTHROPIC_API_KEY) to use Claude instead.
const model: ModelProvider = process.env.MODEL === "anthropic" ? new AnthropicProvider() : new SimulatedModel();
console.log(`model provider: ${model.name}`);

const app = new Engine({
  auth: {
    "dev-admin-key": { id: "alice", roles: ["admin"] },
    "dev-viewer-key": { id: "bob", roles: ["viewer"] },
  },
  roles: { admin: ["*"], viewer: ["agents:read", "agents:run", "tools:time"] },
  model,
  policy: { input: { maxBodyBytes: 64 * 1024 }, output: { requiredFields: ["ok"] } },
});

app.get("/agents/:id", { permission: "agents:read" }, (ctx) => {
  ctx.json(200, { ok: true, agent: ctx.params.id });
});

// Agent layer: runs on whichever ModelProvider was passed above.
// Viewers can run it but only see the time tool; admins also get `add`.
const assistant = {
  name: "assistant",
  system: "You are a concise assistant. Use tools when they help.",
  tools: [
    defineTool({
      name: "get_current_time",
      description: "Current UTC time as an ISO-8601 string",
      permission: "tools:time",
      input: z.object({}),
      run: () => new Date().toISOString(),
    }),
    defineTool({
      name: "add",
      description: "Add two numbers",
      permission: "tools:math",
      input: z.object({ a: z.number(), b: z.number() }),
      run: ({ a, b }) => String(a + b),
    }),
  ],
};
app.agent("/agents/assistant/run", { permission: "agents:run", agent: assistant, maxBodyBytes: 32 * 1024 });

app.listen(3000, () => console.log("agent engine on :3000"));
