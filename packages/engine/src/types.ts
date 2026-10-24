import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from "node:http";
import type { MasterPolicy } from "./policy.ts";

export interface User {
  id: string;
  roles: string[];
}

export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  /** Handler-provided data; serialized by the output-limits stage. */
  data: unknown;
  /** Final bytes, set by the output-limits stage. */
  payload?: Buffer;
}

export interface Route {
  method: string;
  pattern: string;
  /** Required permission, e.g. "agents:run". Mandatory: routes are deny-by-default. */
  permission: string;
  handler: Handler;
  /** Optional stricter-than-master body limit. */
  maxBodyBytes?: number;
  /** Optional body validator; return the (possibly transformed) body or throw. */
  validate?: (body: unknown) => unknown;
}

export interface Context {
  id: string;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  policy: MasterPolicy;
  user?: User;
  /** True if the authenticated user holds the permission (via their roles). */
  can(permission: string): boolean;
  route?: Route;
  params: Record<string, string>;
  rawBody: Buffer;
  body: unknown;
  /** Hash of the previous request in this user's chain. */
  prevHash?: string;
  /** Hash of this request (next request's prevHash). */
  hash?: string;
  state: Record<string, unknown>;
  response?: EngineResponse;
  json(status: number, data: unknown, headers?: Record<string, string>): void;
  text(status: number, data: string, headers?: Record<string, string>): void;
  /**
   * Writes the head now and hands back the raw response for incremental writes (e.g. SSE).
   * The content type must be allowed by the output policy; size and field rules do not apply.
   */
  stream(status: number, headers: Record<string, string> & { "content-type": string }): ServerResponse;
  /** Set once stream() has written the head. */
  streaming?: boolean;
}

export type Next = () => Promise<void>;
export type Middleware = (ctx: Context, next: Next) => Promise<void>;
export type Handler = (ctx: Context) => Promise<void> | void;
