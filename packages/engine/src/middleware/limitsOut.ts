import type { Middleware } from "../types.ts";
import { outputViolation } from "../errors.ts";

/** Master output limits: redact, require fields, check type and size, then serialize. */
export const limitsOut = (): Middleware => async (ctx, next) => {
  await next();
  const res = ctx.response;
  if (!res || res.payload) return;
  const { output } = ctx.policy;

  const type = (res.headers["content-type"] ?? "application/json").split(";")[0]!.trim().toLowerCase();
  if (!output.allowedContentTypes.includes(type)) throw outputViolation(`Content type not allowed: ${type}`);

  let payload: Buffer;
  if (type === "application/json") {
    let data = res.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      data = { ...(data as Record<string, unknown>) };
      for (const f of output.redactFields) delete (data as Record<string, unknown>)[f];
      for (const f of output.requiredFields) {
        if (!(f in (data as object))) throw outputViolation(`Response missing required field: ${f}`);
      }
    } else if (output.requiredFields.length) {
      throw outputViolation("Response must be a JSON object");
    }
    payload = Buffer.from(JSON.stringify(data ?? null));
  } else {
    payload = Buffer.from(String(res.data ?? ""));
  }

  if (payload.length > output.maxBodyBytes) throw outputViolation("Response exceeds output size limit");
  res.payload = payload;
  res.headers["content-type"] = type === "application/json" ? "application/json" : `${type}; charset=utf-8`;
};
