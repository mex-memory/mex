import { MachineJobActionRequestSchema } from "@mex/hub-contracts/machine";
import { Hono, type Context } from "hono";
import { generateCookie, getCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { readBoundedJson } from "../http/request.js";
import { validateHubRequestPath, type HubAssetManifest } from "../static/assets.js";
import { HubEvents } from "./events.js";
import { HomeData } from "./home.js";
import { changeHubJob, readHubJobs } from "./jobs.js";
import { checkHost, checkWrite, HubRequestError, isBootstrapToken, type HubSession, type HubSessions, type RequestAddress } from "./security.js";
import { consumeBootstrap, keepHubOpen, TAB_KEEPALIVE_MS, type HubMode } from "./state.js";

/**
 * The machine Hub's HTTP surface. Every request passes the Host check; every API request
 * except the handshake and sign-in needs a session; every write needs Origin plus CSRF.
 * Reads open record.db read-only; the few writes use a short-lived writer.
 */

export const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; "
  + "form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'";

export interface MachineHubOptions extends LocationOptions {
  readonly sessions: HubSessions;
  readonly homeId: string;
  readonly version: string;
  readonly mode: HubMode;
  readonly assets?: HubAssetManifest;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

interface Variables {
  requestId: string;
  address: RequestAddress;
  session: HubSession;
}

export function createMachineHubApp(options: MachineHubOptions) {
  const app = new Hono<{ Variables: Variables }>();
  const now = options.now ?? Date.now;
  const location: LocationOptions = { home: options.home, cache: options.cache, isNetwork: options.isNetwork };
  const withWriter = <T>(use: (writer: RecordWriter) => T): T => {
    const writer = openRecord(location);
    try { return use(writer); } finally { writer.close(); }
  };

  const home = new HomeData(location, now);
  const keepOpen = () => withWriter((writer) => keepHubOpen(writer, now() + TAB_KEEPALIVE_MS));
  const events = new HubEvents(location, home, now, keepOpen);

  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    context.set("requestId", requestId);
    try {
      context.set("address", checkHost(context.req.raw.headers, { env: options.env }));
    } catch (error) {
      const response = isPageNavigation(context) && error instanceof HubRequestError && error.title === "Wrong address"
        ? wrongAddressPage()
        : problem(context, error);
      applySecurityHeaders(response, requestId);
      return response;
    }
    await next();
    applySecurityHeaders(context.res, requestId);
  });

  app.onError((error, context) => {
    const response = problem(context, error);
    applySecurityHeaders(response, context.get("requestId") ?? randomUUID());
    return response;
  });

  // Unauthenticated: lets `mex hub` confirm that a port holds this home's Hub, of this version.
  app.get("/api/v1/hello", (context) => context.json({ app: "mex-hub", version: options.version, homeId: options.homeId, mode: options.mode }));

  app.post("/api/v1/session/bootstrap", async (context) => {
    checkWrite(context.req.raw.headers, context.get("address"), undefined);
    const body = await readBoundedJson(context.req.raw, 1_024) as { token?: unknown };
    const token = body?.token;
    if (!isBootstrapToken(token) || !withWriter((writer) => consumeBootstrap(writer, token, now()))) {
      throw new HubRequestError(401, "UNAUTHORIZED", "Sign-in link used or expired",
        "Each link works once, for 5 minutes. Run `mex hub` for a new one.");
    }
    const { session, cookie } = options.sessions.create();
    context.header("set-cookie", sessionCookie(options.sessions, session, cookie));
    return context.json({ csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() }, 201);
  });

  app.use("/api/*", async (context, next) => {
    const session = options.sessions.verify(getCookie(context, options.sessions.cookieName));
    if (session === undefined) {
      throw new HubRequestError(401, "UNAUTHORIZED", "Sign in from the terminal", "Open the Hub with `mex hub` to sign in on this browser.");
    }
    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      checkWrite(context.req.raw.headers, context.get("address"), session);
    }
    context.set("session", session);
    home.touch();
    await next();
  });

  app.get("/api/v1/session", (context) => {
    let session = context.get("session");
    const renewed = options.sessions.renew(session);
    if (renewed) {
      session = renewed.session;
      context.header("set-cookie", sessionCookie(options.sessions, renewed.session, renewed.cookie));
    }
    return context.json({
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      version: options.version,
      mode: options.mode,
      homePath: recordLocation({ ...location, create: false }).home,
    });
  });

  app.post("/api/v1/session/heartbeat", (context) => {
    keepOpen();
    return context.body(null, 204);
  });

  app.get("/api/v1/projects", (context) => context.json({ projects: listProjects(location) }));

  app.get("/api/v1/home", (context) => context.json(home.get(context.req.query("tz"))));

  app.get("/api/v1/jobs", (context) => context.json(readHubJobs(location)));

  app.post("/api/v1/jobs/:id/actions", async (context) => {
    const parsed = MachineJobActionRequestSchema.safeParse(await readBoundedJson(context.req.raw, 1_024));
    if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid job action", "Choose a job action and provide its current state.");
    const result = changeHubJob(location, withWriter, options.env, context.req.param("id"), parsed.data);
    if (result.status === 404) throw new HubRequestError(404, "INVALID_REQUEST", "Job not found", "That job no longer exists.");
    if (result.status === 409) return problem(context,
      new HubRequestError(409, "JOB_CONFLICT", "The job changed", "Refresh Jobs to see its current state."), { job: result.job });
    return context.json(result.job);
  });

  app.get("/api/v1/events", (context) => {
    const cookie = getCookie(context, options.sessions.cookieName);
    return events.open(context.req.raw.signal, () => options.sessions.verify(cookie) !== undefined, context.req.method === "HEAD");
  });

  app.all("/api/*", () => {
    throw new HubRequestError(404, "INVALID_REQUEST", "Not found", "The Hub has no such resource.");
  });

  app.get("*", (context) => {
    if (options.assets === undefined) {
      throw new HubRequestError(404, "INVALID_REQUEST", "Not found", "The Hub's pages are not built.");
    }
    const path = validateHubRequestPath(context.req.raw.url);
    const requested = path === "/" ? "/index.html" : path;
    const shell = !options.assets.has(requested)
      && context.req.header("accept")?.includes("text/html") === true
      && !requested.slice(requested.lastIndexOf("/") + 1).includes(".");
    const asset = options.assets.read(shell ? "/index.html" : requested);
    return new Response(asset.bytes as BodyInit, { headers: { "content-type": asset.contentType, "cache-control": asset.cacheControl } });
  });

  return Object.assign(app, { close() {
    events.close();
    home.close();
  } });
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "git" | "folder";
  readonly shared: boolean;
  readonly provisional: "unborn" | "shallow" | null;
  readonly checkouts: readonly { path: string; state: "on" | "off" | "off until"; offUntil: string | null; exists: boolean }[];
}

/** Every project this home knows, for the repo switcher. Read-only; empty before first use. */
export function listProjects(location: LocationOptions): ProjectSummary[] {
  const reader = openRecordReadOnly(location);
  if (!reader) return [];
  try {
    const projects = reader.all<{ id: string; root_path: string; kind: "git" | "folder"; shared: number }>("SELECT id, root_path, kind, shared FROM projects");
    const checkouts = reader.all<{ project_id: string; path: string; state: "on" | "off" | "off until"; off_until: string | null; provisional: "unborn" | "shallow" | null }>("SELECT project_id, path, state, off_until, provisional FROM checkouts ORDER BY path");
    const byProject = new Map<string, typeof checkouts>();
    for (const row of checkouts) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
    return projects.map((project) => {
      const rows = byProject.get(project.id) ?? [];
      return {
        id: project.id,
        name: basename(project.root_path) || project.root_path,
        kind: project.kind,
        shared: project.shared === 1,
        provisional: rows.find((row) => row.provisional !== null)?.provisional ?? null,
        checkouts: rows.map((row) => ({ path: row.path, state: row.state, offUntil: row.off_until, exists: existsSync(row.path) })),
      };
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  } finally {
    reader.close();
  }
}

function sessionCookie(sessions: HubSessions, session: HubSession, value: string): string {
  return generateCookie(sessions.cookieName, value, { httpOnly: true, sameSite: "Strict", path: "/api/v1", maxAge: sessions.maxAgeSeconds(session) });
}

function problem(context: Context, error: unknown, extensions?: { job: import("@mex/hub-contracts/machine").MachineJob }): Response {
  const known = error instanceof HubRequestError
    || (typeof (error as { status?: unknown })?.status === "number" && typeof (error as { code?: unknown })?.code === "string");
  const status = known ? (error as { status: number }).status : 500;
  const body = {
    type: "about:blank",
    title: known ? ((error as { title?: string }).title ?? "Request failed") : "The Hub hit an error",
    status,
    code: known ? (error as { code: string }).code : "INTERNAL_ERROR",
    detail: known ? (error as Error).message : "Try again. If it keeps happening, run `mex doctor`.",
    requestId: context.get("requestId"),
    ...extensions,
  };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json; charset=UTF-8" } });
}

function applySecurityHeaders(response: Response, requestId: string): void {
  response.headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-request-id", requestId);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/")) response.headers.set("cache-control", "no-store");
}

function isPageNavigation(context: Context): boolean {
  return (context.req.method === "GET" || context.req.method === "HEAD")
    && !context.req.path.startsWith("/api/")
    && context.req.header("accept")?.includes("text/html") === true;
}

/** Plain HTML with no script or inline style, so the CSP still holds. */
function wrongAddressPage(): Response {
  const body = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="UTF-8" /><title>Open the MEX Hub from the terminal</title></head><body>',
    "<h1>Open the MEX Hub from the terminal</h1>",
    "<p>The MEX Hub only answers at <code>127.0.0.1</code> on this machine.</p>",
    "<p>Run <code>mex hub</code> and open the link it prints.</p>",
    "</body></html>",
  ].join("\n");
  return new Response(body, { status: 400, headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" } });
}
