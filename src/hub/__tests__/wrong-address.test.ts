import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubApp } from "../app.js";
import { createLocalHubReadServices } from "../services.js";
import { HubSessionManager } from "../security/session.js";

const ORIGIN = "http://127.0.0.1:48125";
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function app() {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-wrong-address-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  const unused = async (): Promise<never> => { throw new Error("The Host check must not reach Team workflows."); };
  return createHubApp({ security: new HubSessionManager({ bootstrapToken: TOKEN, expectedOrigin: ORIGIN }),
    services: createLocalHubReadServices({ projectRoot: root, scaffoldId: "wrong-address-fixture", jobs: { list: () => ({ items: [] }) },
      team: { getMember: unused, listMembers: unused, getCurrentActor: unused, getActivity: unused,
        listActivity: unused, previewIdentityActivity: unused, applyIdentityActivity: unused } }) });
}

const page = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

describe("Hub opened at a wrong address (#276)", () => {
  it("shows a browser a readable page with the Hub address and how to get a new link", async () => {
    const response = await app().request("http://localhost:48125/", { headers: { host: "localhost:48125", ...page } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain(`<a href="${ORIGIN}/">${ORIGIN}/</a>`);
    expect(html).toContain("The request Host does not match the bound local Hub address.");
    expect(html).toContain("<code>mex hub</code>");
    expect(html).toContain("<code>mex setup --browser</code>");
    expect(html).not.toContain("<script");
  });

  it("keeps the JSON problem for API, asset, and non-browser requests", async () => {
    const hub = app();
    for (const [path, headers] of [
      ["/api/v1/session", page],
      ["/assets/index.js", { accept: "*/*" }],
      ["/", { accept: "application/json" }],
    ] as const) {
      const response = await hub.request(`http://localhost:48125${path}`, { headers: { host: "localhost:48125", ...headers } });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=UTF-8");
      expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST", title: "Invalid Host header" });
    }
  });

  it("still refuses proxied page requests, now with the readable page", async () => {
    const response = await app().request(`${ORIGIN}/`, {
      headers: { host: "127.0.0.1:48125", "x-forwarded-for": "203.0.113.9", ...page },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("The local Hub does not accept forwarded or proxy request headers.");
  });

  it("leaves requests at the Hub address unchanged", async () => {
    const response = await app().request(`${ORIGIN}/api/v1/session`, { headers: { host: "127.0.0.1:48125", ...page } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
