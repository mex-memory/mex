import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubApp } from "../app.js";
import { createLocalHubReadServices } from "../services.js";
import { HubSessionManager } from "../security/session.js";

const ORIGIN = "http://127.0.0.1:48124";
const HOST = "127.0.0.1:48124";
const TOKEN = Buffer.alloc(32, 9).toString("base64url");
const PATH = "/api/v1/settings/onboarding";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-onboarding-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  const unused = async (): Promise<never> => { throw new Error("Hub tour state must not consult Team workflows."); };
  const app = createHubApp({ security: new HubSessionManager({ bootstrapToken: TOKEN, expectedOrigin: ORIGIN }),
    services: createLocalHubReadServices({ projectRoot: root, scaffoldId: "onboarding-fixture", jobs: { list: () => ({ items: [] }) },
      team: { getMember: unused, listMembers: unused, getCurrentActor: unused, getActivity: unused,
        listActivity: unused, previewIdentityActivity: unused, applyIdentityActivity: unused } }) });
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, { method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const session = await app.request(`${ORIGIN}/api/v1/session`, { headers: { host: HOST, cookie } });
  const { csrfToken } = await session.json() as { csrfToken: string };
  const get = (suffix = "") => app.request(`${ORIGIN}${PATH}${suffix}`, { headers: { host: HOST, cookie } });
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(`${ORIGIN}${PATH}`, { method: "POST",
    headers: { host: HOST, cookie, origin: ORIGIN, "content-type": "application/json", "x-mex-csrf": csrfToken, ...headers }, body: JSON.stringify(body) });
  return { root, app, get, post };
}

describe("Hub tour state", () => {
  it("reads a first run without initializing checkout-local state", async () => {
    const { root, get } = await fixture();
    const before = statSync(join(root, ".mex")).mtimeMs;
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: false });
    expect(existsSync(join(root, ".mex/local"))).toBe(false);
    expect(statSync(join(root, ".mex")).mtimeMs).toBe(before);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("records completion once in the checkout and keeps repeat calls idempotent", async () => {
    const { root, get, post } = await fixture();
    const first = await post({ completed: true });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ completed: true });
    const path = join(root, ".mex/local/hub-onboarding.json");
    const bytes = readFileSync(path);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({ schemaVersion: 1, completed: true });
    expect((await post({ completed: true })).status).toBe(200);
    expect(readFileSync(path)).toEqual(bytes);
    expect(await (await get()).json()).toEqual({ completed: true });
  });

  it("requires authenticated origin and CSRF and rejects malformed or extra fields", async () => {
    const { root, app, get, post } = await fixture();
    expect((await app.request(`${ORIGIN}${PATH}`, { headers: { host: HOST } })).status).toBe(401);
    expect((await post({ completed: true }, { origin: "https://outside.example" })).status).toBe(403);
    expect((await post({ completed: true }, { "x-mex-csrf": "wrong" })).status).toBe(403);
    for (const body of [{}, { completed: false }, { completed: "yes" }, { completed: true, path: "/private" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await get("?completed=true")).status).toBe(400);
    expect(existsSync(join(root, ".mex/local"))).toBe(false);
  });

  it("fails closed on a malformed stored state instead of reopening the tour", async () => {
    const { root, get, post } = await fixture();
    mkdirSync(join(root, ".mex/local"));
    const path = join(root, ".mex/local/hub-onboarding.json");
    writeFileSync(path, "{\"completed\":true}\n");
    expect((await get()).status).toBe(422);
    expect((await post({ completed: true })).status).toBe(422);
    expect(readFileSync(path, "utf8")).toBe("{\"completed\":true}\n");
  });
});
