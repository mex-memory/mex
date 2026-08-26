// ============================================================================
// Local UI server
// ============================================================================
//
// A dependency-free node:http server that binds to loopback, serves the JSON
// API from `api.ts`, streams job progress over SSE, and serves the built React
// app with SPA fallback.
//
// It is local-only by construction: the default host is 127.0.0.1, non-loopback
// clients are refused, and the Host header is checked so a hostile page cannot
// reach the API by resolving its own name to 127.0.0.1 (DNS rebinding).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createApiRouter, type ApiRequest } from "./api.js";
import { JobRegistry } from "./jobs.js";
import { findUiAssetDir, uiAssetCandidates } from "./assets.js";
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from "./defaults.js";
import { VERSION } from "../version.js";

export interface UiServerOptions {
  /** Project directory the UI reports on. */
  root: string;
  /** Preferred port. Defaults to {@link DEFAULT_UI_PORT}. */
  port?: number;
  /** Interface to bind. Defaults to loopback; anything else is your own risk. */
  host?: string;
  /**
   * Fail instead of trying the next free port. Set when the user named a port
   * explicitly — silently moving is helpful for a default, confusing for a flag.
   */
  strictPort?: boolean;
}

export interface UiServer {
  url: string;
  port: number;
  host: string;
  /** Directory the frontend is served from, or null when it wasn't built. */
  assetDir: string | null;
  close(): Promise<void>;
}

export { DEFAULT_UI_HOST, DEFAULT_UI_PORT };

/** How many consecutive ports to try before giving up on a busy default. */
const PORT_SCAN_ATTEMPTS = 20;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Start the UI server and resolve once it is accepting connections. Reading
 * anything through this server is side-effect free; the only writes happen via
 * the explicit setup and graph-build endpoints.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const root = resolve(options.root);
  const host = options.host ?? DEFAULT_UI_HOST;
  const preferredPort = options.port ?? DEFAULT_UI_PORT;
  const assetDir = findUiAssetDir();
  const jobs = new JobRegistry();
  const router = createApiRouter({ root, jobs });

  const server = createServer((req, res) => {
    handleRequest(req, res, { root, assetDir, jobs, router, host }).catch((error: unknown) => {
      sendJson(res, 500, {
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });

  const port = await listen(server, host, preferredPort, options.strictPort === true);
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  return {
    url: `http://${formatHost(displayHost)}:${port}`,
    port,
    host,
    assetDir,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}

interface RequestDeps {
  root: string;
  assetDir: string | null;
  jobs: JobRegistry;
  router: ReturnType<typeof createApiRouter>;
  host: string;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps,
): Promise<void> {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, {
      error: { code: "FORBIDDEN", message: "mex ui only serves local requests." },
    });
    return;
  }

  if (!hasAllowedHostHeader(req, deps.host)) {
    sendJson(res, 403, {
      error: {
        code: "FORBIDDEN_HOST",
        message: "Unrecognized Host header. Open the UI via the printed localhost URL.",
      },
    });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${deps.host}`);
  const path = decodeURIComponent(url.pathname);
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "OPTIONS") {
    res.writeHead(204, { Allow: "GET, POST, OPTIONS" });
    res.end();
    return;
  }

  const streamJobId = matchJobStream(path);
  if (streamJobId) {
    streamJobProgress(res, deps.jobs, streamJobId);
    return;
  }

  if (path.startsWith("/api/")) {
    let body: unknown;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, {
          error: {
            code: "INVALID_JSON",
            message: error instanceof Error ? error.message : "Malformed JSON body.",
          },
        });
        return;
      }
    }
    const request: ApiRequest = { method, path, query: url.searchParams, body };
    const response = await deps.router(request);
    sendJson(res, response.status, response.body);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, {
      error: { code: "METHOD_NOT_ALLOWED", message: `${method} is not supported here.` },
    });
    return;
  }

  serveStatic(res, deps.assetDir, path);
}

// ── Server-sent events ──

const JOB_STREAM_PATH = /^\/api\/jobs\/([A-Za-z0-9-]+)\/stream$/;

function matchJobStream(path: string): string | null {
  return JOB_STREAM_PATH.exec(path)?.[1] ?? null;
}

/**
 * Stream a job's state on every change. The current state is sent immediately so
 * a client that connects late (or reloads) renders correctly without a separate
 * fetch, and the stream ends as soon as the job reaches a terminal state.
 */
function streamJobProgress(res: ServerResponse, jobs: JobRegistry, jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) {
    sendJson(res, 404, {
      error: { code: "NOT_FOUND", message: `No job with id ${jobId}. It may have expired.` },
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let unsubscribe = () => {};
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(keepAlive);
    res.end();
  };

  const send = (current: Parameters<Parameters<JobRegistry["subscribe"]>[1]>[0]) => {
    if (closed) return;
    res.write(`event: job\ndata: ${JSON.stringify(current)}\n\n`);
    if (current.status !== "running") finish();
  };

  // Comment frames keep intermediaries from timing the connection out during a
  // long graph build that reports no steps for a while.
  const keepAlive = setInterval(() => {
    if (!closed) res.write(": keep-alive\n\n");
  }, 15_000);

  unsubscribe = jobs.subscribe(jobId, send);
  res.on("close", finish);
  send(job);
}

// ── Static files ──

function serveStatic(res: ServerResponse, assetDir: string | null, path: string): void {
  if (!assetDir) {
    sendHtml(res, 503, missingAssetsPage());
    return;
  }

  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const target = safeJoin(assetDir, relative);

  // Traversal attempt, or a client-side route like /setup — both fall through
  // to index.html so the SPA router can take over.
  if (target && isFile(target)) {
    sendFile(res, target);
    return;
  }

  const indexPath = join(assetDir, "index.html");
  if (isFile(indexPath)) {
    sendFile(res, indexPath, { noStore: true });
    return;
  }

  sendHtml(res, 503, missingAssetsPage());
}

/** Join under `base`, returning null if the result would escape it. */
function safeJoin(base: string, relativePath: string): string | null {
  const target = normalize(join(base, relativePath));
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target === base || target.startsWith(prefix) ? target : null;
}

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function sendFile(res: ServerResponse, filePath: string, opts: { noStore?: boolean } = {}): void {
  const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  // Vite fingerprints its assets, so they are safe to cache hard. index.html
  // must never be cached or an upgraded mex would keep serving the old shell.
  const cacheControl = opts.noStore || filePath.endsWith("index.html")
    ? "no-store"
    : "public, max-age=31536000, immutable";

  res.writeHead(200, { "Content-Type": type, "Cache-Control": cacheControl });
  createReadStream(filePath)
    .on("error", () => res.end())
    .pipe(res);
}

function missingAssetsPage(): string {
  const candidates = uiAssetCandidates()
    .map((candidate) => `<li><code>${escapeHtml(candidate)}</code></li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>mex ui — frontend not built</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: #0c0d10; color: #e7e8ea; padding: 2rem;
        font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { max-width: 44rem; }
      h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
      p { color: #a7a9b0; }
      code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9em; }
      pre {
        background: #15171c; border: 1px solid #24262e; border-radius: 8px;
        padding: .85rem 1rem; overflow-x: auto;
      }
      ul { color: #7e818b; font-size: .85rem; padding-left: 1.1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>The mex web UI hasn't been built yet</h1>
      <p>The API is running, but there are no frontend assets to serve. Build them once:</p>
      <pre>npm run build:ui</pre>
      <p>Or run the Vite dev server for hot reload while working on the UI:</p>
      <pre>npm run dev:ui</pre>
      <p>Looked for <code>index.html</code> in:</p>
      <ul>${candidates}</ul>
      <p>mex ${escapeHtml(VERSION)}</p>
    </main>
  </body>
</html>`;
}

// ── Request plumbing ──

const MAX_BODY_BYTES = 1_000_000;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw.length === 0) {
        resolvePromise(undefined);
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        rejectPromise(new Error("Body is not valid JSON."));
      }
    });
    req.on("error", rejectPromise);
  });
}

function isLocalRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

/**
 * Only accept Host headers that name loopback (or the interface we bound). A
 * request arriving with an attacker-controlled hostname is a rebinding attempt.
 */
export function hasAllowedHostHeader(req: IncomingMessage, boundHost: string): boolean {
  const header = req.headers.host;
  if (!header) return false;
  const hostname = header.replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname === boundHost.toLowerCase();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Bind `server`, walking forward from `preferredPort` when the port is taken.
 * With `strict` (an explicit `--port`) a busy port is an error instead, because
 * silently landing somewhere else defeats the point of naming one.
 */
function listen(
  server: Server,
  host: string,
  preferredPort: number,
  strict: boolean,
): Promise<number> {
  const attempts = strict || preferredPort === 0 ? 1 : PORT_SCAN_ATTEMPTS;

  return new Promise<number>((resolvePromise, rejectPromise) => {
    let attempt = 0;

    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && attempt < attempts - 1) {
        attempt += 1;
        server.listen(preferredPort + attempt, host);
        return;
      }
      server.removeListener("error", onError);
      if (error.code === "EADDRINUSE") {
        rejectPromise(
          new Error(
            strict
              ? `Port ${preferredPort} is already in use. Pass a different --port.`
              : `Ports ${preferredPort}-${preferredPort + attempts - 1} are all in use. Pass --port <n>.`,
          ),
        );
        return;
      }
      if (error.code === "EACCES") {
        rejectPromise(new Error(`Not allowed to bind ${host}:${preferredPort + attempt}.`));
        return;
      }
      rejectPromise(error);
    };

    server.on("error", onError);
    server.once("listening", () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolvePromise(typeof address === "object" && address ? address.port : preferredPort);
    });
    server.listen(preferredPort, host);
  });
}
