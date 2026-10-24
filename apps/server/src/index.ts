import { z } from "zod";
import { Engine, SimulatedModel, defineTool, type ModelProvider } from "@agent-engine/core";
import { OllamaProvider } from "@agent-engine/provider-ollama";
import { parseApiKeys, parseModel, parsePort, parsePositiveInt } from "./config.ts";

// Configuration comes from the environment:
//   API_KEYS        `key=userId:role1,role2;...` (required)
//   MODEL           "ollama" (default) or "simulated" (offline, no model server)
//   OLLAMA_URL      default http://localhost:11434
//   OLLAMA_MODEL    default qwen2.5:0.5b (must already be pulled into Ollama)
//   OLLAMA_NUM_CTX  context window in tokens; default is the Ollama server's
//   PORT            default 3000
const model: ModelProvider =
  parseModel(process.env.MODEL) === "ollama"
    ? new OllamaProvider({
        baseUrl: process.env.OLLAMA_URL || undefined,
        defaultModel: process.env.OLLAMA_MODEL || undefined,
        numCtx: parsePositiveInt("OLLAMA_NUM_CTX", process.env.OLLAMA_NUM_CTX),
      })
    : new SimulatedModel();
const port = parsePort(process.env.PORT, 3000);

const app = new Engine({
  auth: parseApiKeys(process.env.API_KEYS),
  roles: {
    admin: ["*"],
    builder: ["agents:create", "agents:read", "agents:run", "agents:delete", "tools:time", "tools:math"],
    viewer: ["agents:read", "agents:run", "tools:time"],
  },
  model,
  policy: { input: { maxBodyBytes: 64 * 1024 }, output: { requiredFields: ["ok"] } },
});

// Tools that agents created through the service can pick by name.
app.agentService({
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
});

const detail = model instanceof OllamaProvider ? ` ${process.env.OLLAMA_MODEL || "qwen2.5:0.5b"} @ ${process.env.OLLAMA_URL || "http://localhost:11434"}` : "";
const server = app.listen(port, () => console.log(`agent engine on :${port} (model provider: ${model.name}${detail})`));

// Node as PID 1 in a container ignores SIGTERM by default; stop promptly instead of being killed.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections(); // open event streams would otherwise hold close() forever
  });
}
