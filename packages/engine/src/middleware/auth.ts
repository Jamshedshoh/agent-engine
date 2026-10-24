import { createHash } from "node:crypto";
import type { Context, Middleware, User } from "../types.ts";
import { forbidden, tooManyRequests, unauthorized } from "../errors.ts";

export type Authenticator = (ctx: Context) => Promise<User | null> | User | null;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Bearer API keys. Only SHA-256 digests are kept in memory. */
export function apiKeyAuthenticator(keys: Record<string, User>): Authenticator {
  const byDigest = new Map(Object.entries(keys).map(([key, user]) => [sha256(key), user]));
  return (ctx) => {
    const m = /^Bearer (.+)$/.exec(ctx.headers.authorization ?? "");
    return m ? (byDigest.get(sha256(m[1]!)) ?? null) : null;
  };
}

/** Step 1: identify the user (401 if unknown). */
export const authenticate = (authenticator: Authenticator): Middleware => async (ctx, next) => {
  const user = await authenticator(ctx);
  if (!user) throw unauthorized();
  ctx.user = user;
  await next();
};

/** role -> permissions. Supports "*" and "prefix:*". */
export type RoleMap = Record<string, string[]>;

export function hasPermission(roles: string[], map: RoleMap, needed: string): boolean {
  return roles.some((r) =>
    (map[r] ?? []).some((p) => p === "*" || p === needed || (p.endsWith(":*") && needed.startsWith(p.slice(0, -1)))),
  );
}

/** Step 2: authorize against the resolved route (403 if no access). Deny by default. */
export const authorize = (map: RoleMap): Middleware => async (ctx, next) => {
  if (!ctx.user || !ctx.route || !hasPermission(ctx.user.roles, map, ctx.route.permission)) throw forbidden();
  await next();
};

/** Fixed-window per-user rate limit. */
export const rateLimit = (): Middleware => {
  const windows = new Map<string, { start: number; count: number }>();
  return async (ctx, next) => {
    const now = Date.now();
    const id = ctx.user!.id;
    let w = windows.get(id);
    if (!w || now - w.start >= 60_000) windows.set(id, (w = { start: now, count: 0 }));
    if (++w.count > ctx.policy.rate.perUserPerMin) throw tooManyRequests(Math.ceil((w.start + 60_000 - now) / 1000));
    await next();
  };
};
