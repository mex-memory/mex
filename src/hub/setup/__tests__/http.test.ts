import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHubApp } from "../../app.js";
import { HubSessionManager } from "../../security/session.js";
import { createSetupHubServices } from "../services.js";

const ORIGIN = "http://127.0.0.1:48123";
const HOST = "127.0.0.1:48123";
const BOOTSTRAP = Buffer.alloc(32, 7).toString("base64url");

const roots: string[] = [];
beforeEach(() => vi.stubEnv("MEX_HOME", fixture()));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { /* Windows can hold a sqlite handle briefly. */ }
  }
});

describe("Hub setup HTTP", () => {
  it("keeps completion reads empty and protects installation and contact actions", async () => {
    const root = fixture();
    const { services, setup } = createSetupHubServices(root);
    const install = vi.spyOn(setup, "installGlobally").mockResolvedValue({ ...setup.installation(), state: "running" });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"success":true}'));
    vi.stubGlobal("fetch", fetch);
    const app = appWith({ services, setup });
    const { cookie, csrfToken } = await authenticatedSession(app);
    const headers = { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json", "x-mex-csrf": csrfToken };
    for (const path of ["contact", "setup/installation"]) {
      expect((await app.request(`${ORIGIN}/api/v1/${path}`, { headers: { host: HOST } })).status).toBe(401);
      expect((await app.request(`${ORIGIN}/api/v1/${path}`, { headers: { host: HOST, cookie } })).status).toBe(200);
    }
    expect(existsSync(join(process.env.MEX_HOME!, ".mex"))).toBe(false);
    for (const [path, body] of [["contact", { email: "person@example.com" }], ["contact/preference", { status: "skipped" }], ["setup/installation", {}]] as const) {
      for (const bad of [{ ...headers, "x-mex-csrf": "" }, { ...headers, origin: "https://example.com" }]) {
        expect((await app.request(`${ORIGIN}/api/v1/${path}`, { method: "POST", headers: bad, body: JSON.stringify(body) })).status).toBe(403);
      }
      expect((await app.request(`${ORIGIN}/api/v1/${path}?extra=true`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
      expect((await app.request(`${ORIGIN}/api/v1/${path}`, { method: "POST", headers, body: JSON.stringify({ ...body, command: "arbitrary" }) })).status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
    const started = await app.request(`${ORIGIN}/api/v1/setup/installation`, { method: "POST", headers, body: "{}" });
    expect(started.status).toBe(202); expect(install).toHaveBeenCalledOnce();
    const sent = await app.request(`${ORIGIN}/api/v1/contact`, { method: "POST", headers, body: '{"email":"person@example.com"}' });
    expect(sent.status).toBe(200); expect(await sent.json()).toMatchObject({ ok: true, status: "submitted" });
    expect(fetch).toHaveBeenCalledOnce();
    await setup.shutdown();
  });
  it("hides setup routes when the process is not in setup mode", async () => {
    const app = appWith();
    const { cookie } = await authenticatedSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/setup`, {
      headers: { host: HOST, cookie },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("reports needs_git without writing a scaffold", async () => {
    const root = fixture();
    const { services, setup } = createSetupHubServices(root);
    const app = appWith({ services, setup });
    const { cookie } = await authenticatedSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/setup`, {
      headers: { host: HOST, cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { hasGit: boolean; stage: string };
    expect(body).toMatchObject({
      hasGit: false,
      hasScaffold: false,
      stage: "needs_git",
      ready: false,
    });
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it("requires CSRF and refuses code-repo setup without git", async () => {
    const root = fixture();
    const { services, setup } = createSetupHubServices(root);
    const app = appWith({ services, setup });
    const { cookie, csrfToken } = await authenticatedSession(app);

    const noCsrf = await app.request(`${ORIGIN}/api/v1/setup`, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ mode: "agent-memory", tools: ["cursor"] }),
    });
    expect(noCsrf.status).toBe(403);

    const codeRepo = await app.request(`${ORIGIN}/api/v1/setup`, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json", "x-mex-csrf": csrfToken },
      body: JSON.stringify({ mode: "code-repo", tools: [] }),
    });
    expect(codeRepo.status).toBe(400);
    expect(await codeRepo.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("starts agent-memory setup and pauses at population", { timeout: 30_000 }, async () => {
    const root = fixture();
    const { services, setup } = createSetupHubServices(root);
    const app = appWith({ services, setup });
    const { cookie, csrfToken } = await authenticatedSession(app);
    const started = await app.request(`${ORIGIN}/api/v1/setup`, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json", "x-mex-csrf": csrfToken },
      body: JSON.stringify({ mode: "agent-memory", tools: ["cursor"] }),
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ status: "running" });

    await vi.waitFor(() => {
      expect(setup.snapshot().status).toBe("paused");
    }, { timeout: 20_000 });

    const run = await app.request(`${ORIGIN}/api/v1/setup/run`, {
      headers: { host: HOST, cookie },
    });
    expect(run.status).toBe(200);
    const body = await run.json() as { status: string; prompt: string | null; populated: boolean };
    expect(body).toMatchObject({ status: "paused", populated: false });
    expect(body.prompt?.length).toBeGreaterThan(20);
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it("rejects HEAD on the setup event stream", async () => {
    const root = fixture();
    const { services, setup } = createSetupHubServices(root);
    const app = appWith({ services, setup });
    const { cookie } = await authenticatedSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/setup/events`, {
      method: "HEAD",
      headers: { host: HOST, cookie },
    });
    expect(response.status).toBe(405);
  });

  it("protects cancellation with origin, CSRF, and strict input checks", async () => {
    const { services, setup } = createSetupHubServices(fixture());
    const cancel = vi.spyOn(setup, "cancel");
    const app = appWith({ services, setup });
    const { cookie, csrfToken } = await authenticatedSession(app);
    const headers = {
      host: HOST, origin: ORIGIN, cookie,
      "content-type": "application/json", "x-mex-csrf": csrfToken,
    };
    const missingCsrf = { ...headers };
    delete (missingCsrf as Partial<typeof headers>)["x-mex-csrf"];
    for (const request of [
      { headers: missingCsrf, body: "{}", suffix: "", status: 403 },
      { headers: { ...headers, origin: "https://example.test" }, body: "{}", suffix: "", status: 403 },
      { headers, body: '{"pid":123}', suffix: "", status: 400 },
      { headers, body: "{}", suffix: "?force=true", status: 400 },
    ]) {
      const response = await app.request(`${ORIGIN}/api/v1/setup/cancel${request.suffix}`, {
        method: "POST", headers: request.headers, body: request.body,
      });
      expect(response.status).toBe(request.status);
    }
    expect(cancel).not.toHaveBeenCalled();
    const response = await app.request(`${ORIGIN}/api/v1/setup/cancel`, {
      method: "POST", headers, body: "{}",
    });
    expect(response.status).toBe(202);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ status: "idle" });
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-setup-http-"));
  roots.push(root);
  return root;
}

function appWith(overrides: { services?: ReturnType<typeof createSetupHubServices>["services"]; setup?: ReturnType<typeof createSetupHubServices>["setup"] } = {}) {
  let random = 20;
  const { services } = overrides.setup
    ? { services: overrides.services! }
    : createSetupHubServices(fixture());
  return createHubApp({
    security: new HubSessionManager({
      bootstrapToken: BOOTSTRAP,
      expectedOrigin: ORIGIN,
      random: (size) => new Uint8Array(size).fill(random++),
    }),
    services: overrides.services ?? services,
    ...(overrides.setup === undefined ? {} : { setup: overrides.setup }),
    requestId: () => "00000000-0000-4000-8000-000000000001",
  });
}

async function authenticatedSession(app: ReturnType<typeof createHubApp>) {
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ token: BOOTSTRAP }),
  });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("bootstrap did not set a cookie");
  const session = await app.request(`${ORIGIN}/api/v1/session`, {
    headers: { host: HOST, cookie },
  });
  const { csrfToken } = await session.json() as { csrfToken: string };
  return { cookie, csrfToken };
}
