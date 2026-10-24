import type { Middleware } from "../types.ts";
import { HttpError } from "../errors.ts";

/** Outermost stage: turns any thrown error into a small JSON response. */
export const errorHandler = (): Middleware => async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    const e = err instanceof HttpError ? err : null;
    if (!e) console.error(`[${ctx.id}]`, err);
    const status = e?.status ?? 500;
    const payload = Buffer.from(
      JSON.stringify({ error: { code: e?.code ?? "internal_error", message: e ? e.message : "Internal error", requestId: ctx.id } }),
    );
    ctx.response = {
      status,
      headers: { ...(e?.headers ?? {}), "content-type": "application/json" },
      data: undefined,
      payload,
    };
  }
};
