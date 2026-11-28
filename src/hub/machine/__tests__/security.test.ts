import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHost, checkWrite, HubSessions } from "../security.js";
import { rotateHubSecret } from "../secret.js";

const HOST = "127.0.0.1:41917";
const ORIGIN = "http://127.0.0.1:41917";
const NOW = Date.parse("2026-11-24T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

describe("checkHost", () => {
  it.each([
    "127.0.0.1:1",
    "localhost:65535",
    "[::1]:52987",
    "127.0.0.1",
    "localhost",
    "[::1]",
  ])("accepts loopback Host %s", (host) => {
    expect(checkHost(new Headers({ host }), { env: {} })).toEqual({
      host,
      origin: "http://" + host,
    });
  });

  it.each([
    "evil.example",
    "127.0.0.1.evil.example",
    "localhost.evil",
    "",
    "127.0.0.1:0",
    "127.0.0.1:70000",
  ])("rejects Host %j", (host) => {
    expect(() => checkHost(new Headers({ host }), { env: {} }))
      .toThrow(expect.objectContaining({ status: 400, title: "Wrong address" }));
  });

  it.each([
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
  ])("rejects %s even on loopback", (name) => {
    const headers = new Headers({ host: HOST, [name]: "127.0.0.1" });
    expect(() => checkHost(headers, { env: {} }))
      .toThrow(expect.objectContaining({ status: 400, title: "Proxy headers rejected" }));
  });

  it("accepts the Codespaces forwarding Host with an HTTPS origin and a forwarded header", () => {
    const host = "x-41917.app.github.dev";
    const headers = new Headers({ host, "X-Forwarded-For": "192.0.2.1" });

    expect(checkHost(headers, { env: { CODESPACES: "true" } })).toEqual({
      host,
      origin: "https://x-41917.app.github.dev",
    });
  });

  it("uses the configured Codespaces forwarding domain", () => {
    const env = { CODESPACES: "true", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "ports.example.test" };
    const host = "x-41917.ports.example.test";
    expect(checkHost(new Headers({ host }), { env })).toEqual({
      host,
      origin: "https://x-41917.ports.example.test",
    });
    expect(() => checkHost(new Headers({ host: "x-41917.app.github.dev" }), { env }))
      .toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects the forwarding Host outside Codespaces", () => {
    expect(() => checkHost(new Headers({ host: "x-41917.app.github.dev" }), { env: {} }))
      .toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("checkWrite", () => {
  const address = { host: HOST, origin: ORIGIN };
  const forbidden = expect.objectContaining({ status: 403, code: "ORIGIN_REJECTED" });
  const session = { id: "session", csrfToken: "valid-csrf", expiresAt: NOW + DAY_MS };

  it("rejects a missing Origin", () => {
    expect(() => checkWrite(new Headers(), address, undefined)).toThrow(forbidden);
  });

  it("rejects a different loopback Origin", () => {
    const headers = new Headers({ origin: "http://localhost:41917" });
    expect(() => checkWrite(headers, address, undefined)).toThrow(forbidden);
  });

  it.each(["cross-site", "same-site"])("rejects Sec-Fetch-Site %s", (site) => {
    const headers = new Headers({ origin: ORIGIN, "sec-fetch-site": site });
    expect(() => checkWrite(headers, address, undefined)).toThrow(forbidden);
  });

  it("allows a same-origin fetch", () => {
    const headers = new Headers({ origin: ORIGIN, "sec-fetch-site": "same-origin" });
    expect(() => checkWrite(headers, address, undefined)).not.toThrow();
  });

  it("allows a request without Sec-Fetch-Site when the Origin matches", () => {
    const headers = new Headers({ origin: ORIGIN });
    expect(() => checkWrite(headers, address, undefined)).not.toThrow();
  });

  it("requires a CSRF header for a session", () => {
    const headers = new Headers({ origin: ORIGIN });
    expect(() => checkWrite(headers, address, session)).toThrow(forbidden);
  });

  it("rejects a wrong CSRF token for a session", () => {
    const headers = new Headers({ origin: ORIGIN, "x-mex-csrf": "wrong-csrf" });
    expect(() => checkWrite(headers, address, session)).toThrow(forbidden);
  });

  it("allows the session's CSRF token", () => {
    const headers = new Headers({ origin: ORIGIN, "x-mex-csrf": session.csrfToken });
    expect(() => checkWrite(headers, address, session)).not.toThrow();
  });
});

describe("HubSessions", () => {
  const homes: string[] = [];
  let home: string;
  let now: number;
  let sessions: HubSessions;

  function makeHome(): string {
    const directory = mkdtempSync(join(tmpdir(), "mex-hub-sessions-"));
    homes.push(directory);
    return directory;
  }

  beforeEach(() => {
    home = makeHome();
    now = NOW;
    sessions = new HubSessions(home, () => now);
  });

  afterEach(() => {
    for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("verifies the session it created", () => {
    const { cookie, session } = sessions.create();
    expect(sessions.verify(cookie)).toEqual(session);
    expect(session.expiresAt).toBe(NOW + 30 * DAY_MS);
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each(["id", "expiry", "MAC"] as const)("rejects a cookie with a tampered %s", (field) => {
    const { cookie } = sessions.create();
    const [id, expiry, mac] = cookie.split(".") as [string, string, string];
    const tampered = {
      id: [changeFirstCharacter(id), expiry, mac],
      expiry: [id, String(Number(expiry) + 1), mac],
      MAC: [id, expiry, changeFirstCharacter(mac)],
    };
    expect(sessions.verify(tampered[field].join("."))).toBeUndefined();
  });

  it("rejects a cookie with two parts", () => {
    const { cookie } = sessions.create();
    expect(sessions.verify(cookie.split(".", 2).join("."))).toBeUndefined();
  });

  it("rejects a cookie with four parts", () => {
    const { cookie } = sessions.create();
    expect(sessions.verify(cookie + ".extra")).toBeUndefined();
  });

  it("rejects the cookie at its expiry", () => {
    const { cookie, session } = sessions.create();
    now = session.expiresAt - 1;
    expect(sessions.verify(cookie)).toEqual(session);
    now = session.expiresAt;
    expect(sessions.verify(cookie)).toBeUndefined();
  });

  it("does not renew a session with more than 15 days left", () => {
    const { session } = sessions.create();
    now += 14 * DAY_MS;
    expect(sessions.renew(session)).toBeUndefined();
  });

  it("issues a fresh cookie with the same session identity when less than 15 days remain", () => {
    const { cookie, session } = sessions.create();
    now += 16 * DAY_MS;
    const renewed = sessions.renew(session);

    expect(renewed).toBeDefined();
    expect(renewed?.cookie).not.toBe(cookie);
    expect(sessions.verify(renewed?.cookie)).toEqual({
      ...session,
      expiresAt: now + 30 * DAY_MS,
    });
  });

  it("derives the same cookie name from the same secret", () => {
    expect(sessions.cookieName).toMatch(/^mex_hub_[A-Za-z0-9_-]+$/);
    expect(new HubSessions(home).cookieName).toBe(sessions.cookieName);
  });

  it("rejects the old cookie and changes its name on the same instance after rotation", () => {
    const originalName = sessions.cookieName;
    const { cookie, session } = sessions.create();
    expect(sessions.verify(cookie)).toEqual(session);

    rotateHubSecret(home);

    expect(sessions.verify(cookie)).toBeUndefined();
    expect(sessions.cookieName).not.toBe(originalName);
    const fresh = sessions.create();
    expect(sessions.verify(fresh.cookie)).toEqual(fresh.session);
  });

  it("uses different cookie names for different homes", () => {
    expect(new HubSessions(makeHome()).cookieName).not.toBe(sessions.cookieName);
  });
});

function changeFirstCharacter(value: string): string {
  return (value[0] === "a" ? "b" : "a") + value.slice(1);
}
