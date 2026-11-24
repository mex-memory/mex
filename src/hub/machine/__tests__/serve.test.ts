import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRecord, type RecordWriter } from "../../../record/index.js";
import { VERSION } from "../../../version.js";
import { startMachineHub, type RunningMachineHub } from "../serve.js";
import { candidatePorts, mintBootstrap, readBound, type HubMode } from "../state.js";

const NOW = Date.parse("2026-11-24T00:00:00.000Z");

describe("startMachineHub", () => {
  let home: string;
  let writer: RecordWriter;
  let occupant: Server | undefined;
  const hubs: RunningMachineHub[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mex-hub-serve-"));
    writer = openRecord({ home, cache: home, isNetwork: () => false });
    occupant = undefined;
  });

  afterEach(async () => {
    try {
      const closing = hubs.splice(0).map((hub) => hub.close());
      const server = occupant;
      if (server?.listening) {
        closing.push(new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }));
      }
      await Promise.all(closing);
    } finally {
      writer?.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  async function start(port: number, mode: HubMode = "terminal") {
    const hub = await startMachineHub({ home, cache: home, assetRoot: null, port, mode, env: {}, now: () => NOW });
    hubs.push(hub);
    return hub;
  }

  it("chooses a fallback port, leaves its occupant alone, and publishes the bound address", async () => {
    occupant = createServer((socket) => socket.destroy());
    occupant.listen(0, "127.0.0.1");
    await once(occupant, "listening");
    const address = occupant.address();
    if (!address || typeof address === "string") throw new Error("Expected an occupied TCP port.");

    const hub = await start(address.port, "background");
    expect(hub.preferred).toBe(address.port);
    expect(hub.port).not.toBe(address.port);
    expect(candidatePorts(address.port).slice(1)).toContain(hub.port);
    expect(occupant.listening).toBe(true);
    expect(occupant.address()).toEqual(address);
    expect(readBound(writer)).toEqual({
      port: hub.port,
      pid: process.pid,
      version: VERSION,
      homeId: hub.homeId,
      mode: "background",
      at: new Date(NOW).toISOString(),
    });

    await hub.close();
    expect(readBound(writer)).toBeUndefined();
    expect(occupant.listening).toBe(true);
  });

  it("keeps bookmarks signed in after restarting the Hub at the same home", async () => {
    const first = await start(0);
    const token = mintBootstrap(writer, NOW);
    const bootstrap = await fetch(first.origin + "/api/v1/session/bootstrap", {
      method: "POST",
      headers: { origin: first.origin, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    expect(bootstrap.status).toBe(201);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Bootstrap did not return a session cookie.");
    const session = await bootstrap.json() as { csrfToken: string; expiresAt: string };

    await first.close();
    const restarted = await start(0);
    expect(restarted.homeId).toBe(first.homeId);
    const response = await fetch(restarted.origin + "/api/v1/session", {
      headers: { cookie, connection: "close" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(session);
  });
});
