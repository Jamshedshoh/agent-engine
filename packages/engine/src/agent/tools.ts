import { z } from "zod";
import type { Context } from "../types.ts";

export interface AgentTool {
  name: string;
  description: string;
  /** Permission the caller needs for the model to even see this tool. */
  permission: string;
  /** JSON Schema sent to the model. */
  jsonSchema: { type: "object"; [k: string]: unknown };
  /** Validates untrusted model output, then runs. Throws on invalid input. */
  execute(rawInput: unknown, ctx: Context): Promise<string> | string;
}

/** Defines a tool from one zod schema: it generates the model-facing schema and validates inputs. */
export function defineTool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  permission: string;
  input: S;
  run: (input: z.infer<S>, ctx: Context) => Promise<string> | string;
}): AgentTool {
  const { $schema: _omit, ...jsonSchema } = z.toJSONSchema(def.input) as Record<string, unknown>;
  return {
    name: def.name,
    description: def.description,
    permission: def.permission,
    jsonSchema: jsonSchema as AgentTool["jsonSchema"],
    execute: (raw, ctx) => def.run(def.input.parse(raw), ctx),
  };
}
