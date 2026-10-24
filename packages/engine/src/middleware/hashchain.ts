import { createHash } from "node:crypto";
import type { Middleware } from "../types.ts";
import { conflict } from "../errors.ts";
import { KeyedMutex, type HashStore } from "../stores/memory.ts";

export const GENESIS_HASH = "0".repeat(64);

/**
 * Per-user tamper-evident chain:
 *   hash_n = SHA-256(hash_{n-1} | method | path+query | content-type | sha256(body))
 * The response carries hash_{n-1} (X-Prev-Request-Hash) and hash_n (X-Request-Hash).
 * Clients may send X-Expected-Prev-Hash to detect missed or forged requests (409).
 * The chain advances once the request is authenticated, authorized and parsed,
 * even if the handler later fails.
 */
export const hashChain = (store: HashStore): Middleware => {
  const mutex = new KeyedMutex();
  return async (ctx, next) => {
    const userId = ctx.user!.id;
    const bodyDigest = createHash("sha256").update(ctx.rawBody).digest("hex");

    await mutex.run(userId, async () => {
      const prev = (await store.get(userId)) ?? GENESIS_HASH;
      const expected = ctx.headers["x-expected-prev-hash"];
      if (typeof expected === "string" && expected !== prev) throw conflict("Previous request hash mismatch");

      const hash = createHash("sha256")
        .update([prev, ctx.method, ctx.req.url ?? ctx.path, ctx.headers["content-type"] ?? "", bodyDigest].join("\n"))
        .digest("hex");
      await store.set(userId, hash);
      ctx.prevHash = prev;
      ctx.hash = hash;
    });

    await next();
  };
};
