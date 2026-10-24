export class HttpError extends Error {
  status: number;
  code: string;
  headers: Record<string, string>;

  constructor(status: number, code: string, message?: string, headers: Record<string, string> = {}) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (msg?: string) => new HttpError(400, "bad_request", msg);
export const unauthorized = (msg = "Authentication required") =>
  new HttpError(401, "unauthorized", msg, { "www-authenticate": "Bearer" });
export const forbidden = (msg = "Access denied") => new HttpError(403, "forbidden", msg);
export const notFound = () => new HttpError(404, "not_found", "Route not found");
export const methodNotAllowed = (allow: string[]) =>
  new HttpError(405, "method_not_allowed", undefined, { allow: allow.join(", ") });
export const conflict = (msg?: string) => new HttpError(409, "conflict", msg);
export const payloadTooLarge = (msg = "Payload too large") => new HttpError(413, "payload_too_large", msg);
export const unsupportedMediaType = (msg = "Unsupported media type") =>
  new HttpError(415, "unsupported_media_type", msg);
export const tooManyRequests = (retryAfterSec: number) =>
  new HttpError(429, "rate_limited", undefined, { "retry-after": String(retryAfterSec) });
export const outputViolation = (msg: string) => new HttpError(500, "output_policy_violation", msg);
