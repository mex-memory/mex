import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRecord, projectIdentity, type RecordWriter } from "../../../record/index.js";
import { createMachineHubApp } from "../app.js";
import { rotateHubSecret } from "../secret.js";
import { HubSessions } from "../security.js";
import { ensureHomeId, keepHubOpen, mintBootstrap } from "../state.js";

const HOST = "127.0.0.1:41917";
const ORIGIN = "http://" + HOST;
const VERSION = "test-version";
const NOW = Date.parse("2026-11-24T00:00:00.000Z");
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

describe("the machine Hub HTTP app", () => {
  let home: string;
  let writer: RecordWriter;
  let sessions: HubSessions;
  let homeId: string;
  let app: ReturnType<typeof createMachineHubApp>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mex-hub-app-"));
    const location = { home, cache: home, isNetwork: () => false };
    writer = openRecord(location);
    homeId = ensureHomeId(writer);
    const now = () => NOW;
    sessions = new HubSessions(home, now);
    app = createMachineHubApp({ ...location, homeId, sessions, version: VERSION, mode: "terminal", env: {}, now });
  });

  afterEach(() => {
    writer?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", HOST);
    const response = await app.request(ORIGIN + path, { ...init, headers });

    const csp = response.headers.get("content-security-policy");
    expect(csp, path).toContain("default-src 'self'");
    expect(csp, path).not.toMatch(/http/i);
    expect(response.headers.get("x-frame-options"), path).toBe("DENY");
    expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
    return response;
  }

  function bootstrap(token: string, headers: Record<string, string> = { origin: ORIGIN }) {
    return request("/api/v1/session/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ token }),
    });
  }

  async function signIn(token = mintBootstrap(writer, NOW)) {
    const response = await bootstrap(token);
    expect(response.status).toBe(201);
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) throw new Error("Bootstrap did not set a session cookie.");
    const body = await response.json() as { csrfToken: string; expiresAt: string };
    return { ...body, setCookie, cookie: setCookie.split(";", 1)[0]! };
  }

  it("returns the Hub identity from hello without a cookie", async () => {
    const response = await request("/api/v1/hello");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ app: "mex-hub", version: VERSION, homeId, mode: "terminal" });
  });

  it("rejects a bad Host on hello with a problem response", async () => {
    const response = await request("/api/v1/hello", { headers: { host: "evil.example" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });

  it("serves a script-free wrong-address page for HTML navigation with a bad Host", async () => {
    const response = await request("/", { headers: { host: "evil.example", accept: "text/html" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toMatch(/mex hub/i);
    expect(body).not.toMatch(/<script/i);
  });

  it("exchanges a valid link once and sets a 30-day session cookie and CSRF token", async () => {
    const token = mintBootstrap(writer, NOW);
    const { cookie, csrfToken, expiresAt, setCookie } = await signIn(token);

    expect(cookie.startsWith(sessions.cookieName + "=")).toBe(true);
    expect(setCookie.split(/;\s*/)).toEqual(expect.arrayContaining([
      "HttpOnly", "SameSite=Strict", "Path=/api/v1", "Max-Age=" + SESSION_MAX_AGE,
    ]));
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(new Date(NOW + SESSION_MAX_AGE * 1_000).toISOString());

    const replay = await bootstrap(token);
    expect(replay.status).toBe(401);
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("rejects bootstrap without Origin and leaves the link usable", async () => {
    const token = mintBootstrap(writer, NOW);
    const response = await bootstrap(token, {});
    expect(response.status).toBe(403);
    await signIn(token);
  });

  it("rejects a non-JSON bootstrap request", async () => {
    const token = mintBootstrap(writer, NOW);
    const response = await bootstrap(token, { origin: ORIGIN, "content-type": "text/plain" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("rejects a garbage bootstrap token", async () => {
    const response = await bootstrap("garbage");
    expect(response.status).toBe(401);
  });

  it("reads the active session using its cookie", async () => {
    const { cookie, csrfToken, expiresAt } = await signIn();
    const response = await request("/api/v1/session", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ csrfToken, expiresAt, version: VERSION, mode: "terminal" });
  });

  // Regression: GET /api/v1/session omits the homePath promised by the API design.
  it("includes the MEX home path in the authenticated session response", async () => {
    const { cookie } = await signIn();
    const response = await request("/api/v1/session", { headers: { cookie } });
    const body = await response.json() as { homePath?: string };
    expect(body.homePath).toBe(writer.location.home);
  });

  // Regression: Rotating the Hub secret leaves existing unredeemed bootstrap links usable.
  it("rejects an unredeemed link minted before a secret rotation", async () => {
    const token = mintBootstrap(writer, NOW);
    rotateHubSecret(home);

    const response = await bootstrap(token);
    expect(response.status).toBe(401);
  });

  // Regression: Bootstrap signs a fresh cookie with the cached secret before the app notices a rotation.
  it("can sign in with a fresh link immediately after secret rotation", async () => {
    rotateHubSecret(home);
    const { cookie } = await signIn();

    const response = await request("/api/v1/session", { headers: { cookie } });
    expect(response.status).toBe(200);
  });

  it("extends hub_until only when the heartbeat has an Origin and CSRF token", async () => {
    const { cookie, csrfToken } = await signIn();
    const hubUntil = writer.db.prepare("SELECT hub_until FROM background WHERE id=1");
    keepHubOpen(writer, NOW + 60_000);
    const before = hubUntil.get()?.hub_until;

    const denied = await request("/api/v1/session/heartbeat", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    expect(denied.status).toBe(403);
    expect(hubUntil.get()?.hub_until).toBe(before);

    const accepted = await request("/api/v1/session/heartbeat", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-mex-csrf": csrfToken },
    });
    expect(accepted.status).toBe(204);
    expect(await accepted.text()).toBe("");
    expect(hubUntil.get()?.hub_until).toBe(new Date(NOW + 2 * 60_000).toISOString());
  });

  it("returns registered projects in name order with checkout availability", async () => {
    const zuluPath = join(home, "zulu");
    const alphaPath = join(home, "alpha");
    mkdirSync(zuluPath);
    mkdirSync(alphaPath);
    const zulu = writer.register(projectIdentity(zuluPath, () => ""));
    const alpha = writer.register(projectIdentity(alphaPath, () => ""));
    rmdirSync(zuluPath);

    const { cookie } = await signIn();
    const response = await request("/api/v1/projects", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: [
        {
          id: alpha.id, name: "alpha", kind: "folder", shared: false, provisional: null,
          checkouts: [{ path: alpha.root_path, state: "on", offUntil: null, exists: true }],
        },
        {
          id: zulu.id, name: "zulu", kind: "folder", shared: false, provisional: null,
          checkouts: [{ path: zulu.root_path, state: "on", offUntil: null, exists: false }],
        },
      ],
    });
  });

  it("returns 404 for an unknown API route when signed in", async () => {
    const { cookie } = await signIn();
    const response = await request("/api/v1/nope", { headers: { cookie } });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ status: 404, code: "INVALID_REQUEST" });
  });

  it.each([
    ["GET", "/api/v1/session"],
    ["GET", "/api/v1/projects"],
    ["GET", "/api/v1/nope"],
    ["POST", "/api/v1/session/heartbeat"],
  ])("requires a cookie on %s %s", async (method, path) => {
    const response = await request(path, { method });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("returns a 404 problem for an HTML navigation without built assets", async () => {
    const response = await request("/", { headers: { accept: "text/html" } });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 404, detail: "The Hub's pages are not built." });
  });
});
