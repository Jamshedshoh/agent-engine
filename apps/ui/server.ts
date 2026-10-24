// Production server: serves the built UI from dist/ and proxies /services/* to the engine,
// so the browser stays same-origin. Dependency-free; run with `node server.ts`.
import { createServer, request } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const API = new URL(process.env.API_URL ?? "http://localhost:3000");
const ROOT = join(import.meta.dirname, "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/services/")) {
    const { host: _host, ...headers } = req.headers;
    const upstream = request(
      { protocol: API.protocol, hostname: API.hostname, port: API.port, method: req.method, path: url.pathname + url.search, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":{"code":"upstream_unavailable","message":"Engine unreachable"}}');
    });
    // Closing the browser tab must also close long-lived event streams upstream.
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }

  // Resolve inside ROOT only; anything unknown falls back to index.html (single-page app).
  let file: string;
  try {
    file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  } catch {
    file = ROOT; // malformed escape
  }
  if (!file.startsWith(ROOT + sep)) file = join(ROOT, "index.html");
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) file = join(ROOT, "index.html");

  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`ui on :${PORT} -> ${API.origin}`));
