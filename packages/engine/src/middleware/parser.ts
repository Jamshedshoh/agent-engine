import type { Middleware } from "../types.ts";
import { badRequest, HttpError, payloadTooLarge, unsupportedMediaType } from "../errors.ts";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Streams the body with a hard byte cap, then parses by content type. */
export const parser = (): Middleware => async (ctx, next) => {
  const { input } = ctx.policy;
  const limit = Math.min(input.maxBodyBytes, ctx.route?.maxBodyBytes ?? Infinity);

  const declared = Number(ctx.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw payloadTooLarge();

  if (!BODY_METHODS.has(ctx.method)) {
    ctx.rawBody = Buffer.alloc(0);
    ctx.body = undefined;
    return next();
  }

  const type = (ctx.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const hasBody = declared > 0 || ctx.headers["transfer-encoding"] !== undefined;
  if (hasBody && !input.allowedContentTypes.includes(type)) throw unsupportedMediaType();

  ctx.rawBody = await readBody(ctx.req, limit, input.bodyTimeoutMs);

  let body: unknown = undefined;
  const text = ctx.rawBody.toString("utf8");
  if (ctx.rawBody.length > 0) {
    if (type === "application/json") {
      try {
        body = JSON.parse(text);
      } catch {
        throw badRequest("Malformed JSON");
      }
    } else if (type === "application/x-www-form-urlencoded") {
      body = Object.fromEntries(new URLSearchParams(text));
    } else {
      body = text;
    }
  }
  ctx.body = ctx.route?.validate ? ctx.route.validate(body) : body;
  await next();
};

function readBody(req: import("node:http").IncomingMessage, limit: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => done(new HttpError(408, "body_timeout")), timeoutMs);
    const done = (err?: Error) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", done);
      if (err) {
        req.resume(); // discard the rest so the error response can be sent
        reject(err);
      } else resolve(Buffer.concat(chunks));
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) return done(payloadTooLarge());
      chunks.push(c);
    };
    const onEnd = () => done();
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", done);
  });
}
