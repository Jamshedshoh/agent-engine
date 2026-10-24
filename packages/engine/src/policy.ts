/** Master requirements: global input/output limits no handler can bypass. */
export interface MasterPolicy {
  input: {
    maxHeaderBytes: number;
    maxHeaderCount: number;
    maxBodyBytes: number;
    allowedMethods: string[];
    allowedContentTypes: string[];
    requiredHeaders: string[];
    bodyTimeoutMs: number;
  };
  output: {
    maxBodyBytes: number;
    allowedContentTypes: string[];
    /** Top-level fields every JSON object response must contain. */
    requiredFields: string[];
    /** Top-level fields stripped from every JSON object response. */
    redactFields: string[];
  };
  rate: {
    perUserPerMin: number;
  };
  agent: {
    maxPromptChars: number;
    /** Model round-trips per run. */
    maxTurns: number;
    /** Output tokens summed over all turns of one run. */
    maxOutputTokens: number;
    maxToolResultBytes: number;
    /** Wall-clock limit for one run. */
    timeoutMs: number;
  };
}

export type PolicyOverrides = {
  [K in keyof MasterPolicy]?: Partial<MasterPolicy[K]>;
};

export const defaultPolicy: MasterPolicy = {
  input: {
    maxHeaderBytes: 8 * 1024,
    maxHeaderCount: 50,
    maxBodyBytes: 1024 * 1024,
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedContentTypes: ["application/json", "text/plain", "application/x-www-form-urlencoded"],
    requiredHeaders: [],
    bodyTimeoutMs: 10_000,
  },
  output: {
    maxBodyBytes: 1024 * 1024,
    allowedContentTypes: ["application/json", "text/plain", "text/event-stream"],
    requiredFields: [],
    redactFields: ["password", "secret", "apiKey"],
  },
  rate: { perUserPerMin: 120 },
  agent: {
    maxPromptChars: 20_000,
    maxTurns: 8,
    maxOutputTokens: 32_000,
    maxToolResultBytes: 16 * 1024,
    timeoutMs: 120_000,
  },
};

export function resolvePolicy(overrides: PolicyOverrides = {}): MasterPolicy {
  return {
    input: { ...defaultPolicy.input, ...overrides.input },
    output: { ...defaultPolicy.output, ...overrides.output },
    rate: { ...defaultPolicy.rate, ...overrides.rate },
    agent: { ...defaultPolicy.agent, ...overrides.agent },
  };
}
