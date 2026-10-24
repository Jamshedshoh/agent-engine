import type { Route } from "./types.ts";
import { methodNotAllowed, notFound } from "./errors.ts";

interface Compiled {
  route: Route;
  regex: RegExp;
  keys: string[];
}

export class Router {
  private routes: Compiled[] = [];

  add(route: Route): void {
    if (!route.permission) throw new Error(`Route ${route.method} ${route.pattern} must declare a permission`);
    const keys: string[] = [];
    const source = route.pattern
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ route: { ...route, method: route.method.toUpperCase() }, regex: new RegExp(`^${source}/?$`), keys });
  }

  resolve(method: string, path: string): { route: Route; params: Record<string, string> } {
    const allowed: string[] = [];
    for (const { route, regex, keys } of this.routes) {
      const m = regex.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route, params };
    }
    throw allowed.length ? methodNotAllowed(allowed) : notFound();
  }
}
