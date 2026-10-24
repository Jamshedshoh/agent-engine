import type { Middleware } from "../types.ts";
import { HttpError, payloadTooLarge } from "../errors.ts";

/** Master input limits that can be checked from the head alone. Runs before auth and body read. */
export const limitsIn = (): Middleware => async (ctx, next) => {
  const { input } = ctx.policy;

  if (!input.allowedMethods.includes(ctx.method)) {
    throw new HttpError(405, "method_not_allowed", undefined, { allow: input.allowedMethods.join(", ") });
  }

  const raw = ctx.req.rawHeaders;
  if (raw.length / 2 > input.maxHeaderCount) throw new HttpError(431, "too_many_headers");
  let bytes = 0;
  for (const s of raw) bytes += Buffer.byteLength(s);
  if (bytes > input.maxHeaderBytes) throw new HttpError(431, "headers_too_large");

  for (const h of input.requiredHeaders) {
    if (!ctx.headers[h.toLowerCase()]) throw new HttpError(400, "missing_header", `Missing required header: ${h}`);
  }

  // Reject early on declared size so oversized bodies are never read.
  const declared = Number(ctx.headers["content-length"]);
  if (Number.isFinite(declared) && declared > input.maxBodyBytes) throw payloadTooLarge();

  await next();
};
