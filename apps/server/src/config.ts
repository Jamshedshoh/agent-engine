import type { User } from "@agent-engine/core";

/**
 * Parses API_KEYS: `key=userId:role1,role2;key2=userId2:role`.
 * Error messages name the entry's position, never the key itself.
 */
export function parseApiKeys(spec: string | undefined): Record<string, User> {
  const keys: Record<string, User> = {};
  const entries = (spec ?? "").split(";").map((e) => e.trim()).filter(Boolean);
  entries.forEach((entry, i) => {
    const m = /^([^=\s]+)=([^:\s]+):([\w:*,-]+)$/.exec(entry);
    if (!m) throw new Error(`API_KEYS entry ${i + 1} is not "key=userId:role1,role2"`);
    const [, key, id, roles] = m;
    if (keys[key!]) throw new Error(`API_KEYS entry ${i + 1} repeats an earlier key`);
    keys[key!] = { id: id!, roles: roles!.split(",").filter(Boolean) };
  });
  if (!entries.length) throw new Error("API_KEYS is empty: set at least one `key=userId:role`");
  return keys;
}

/** MODEL: "ollama" (default) or "simulated". */
export function parseModel(value: string | undefined): "ollama" | "simulated" {
  const v = (value ?? "").trim().toLowerCase() || "ollama";
  if (v !== "ollama" && v !== "simulated") throw new Error(`MODEL must be "ollama" or "simulated", got "${value}"`);
  return v;
}

export function parsePositiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be 0-65535, got "${value}"`);
  return port;
}
