import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRecord, type RecordWriter } from "../../../record/index.js";
import { VERSION } from "../../../version.js";
import { BackgroundHubHost } from "../host.js";
import { readBound, type BoundHub } from "../state.js";

const NOW = Date.parse("2026-11-24T00:00:00.000Z");
const LEASE_END = NOW + 60_000;
const HUB_UNTIL = new Date(LEASE_END).toISOString();
const IDLE_MS = 30_000;

describe("BackgroundHubHost", () => {
  let home: string;
  let writer: RecordWriter;
  let host: BackgroundHubHost;
  let log: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mex-hub-host-"));
    writer = openRecord({ home, cache: home, isNetwork: () => false });
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES('hub','port','41975')").run();
    log = [];
    host = new BackgroundHubHost({ home, cache: home, log: (line) => log.push(line) });
  });

  afterEach(async () => {
    try {
      await host?.stop();
    } finally {
      writer?.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  function hello(port: number): Promise<Response> {
    return fetch("http://127.0.0.1:" + port + "/api/v1/hello", {
      headers: { connection: "close" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function start(): Promise<BoundHub> {
    await host.tick(HUB_UNTIL, NOW, IDLE_MS);
    expect(host.running, log.join("\n")).toBe(true);
    const bound = readBound(writer);
    if (!bound) throw new Error("The background Hub did not publish its address.");
    expect(bound).toMatchObject({ pid: process.pid, version: VERSION, mode: "background" });

    const response = await hello(bound.port);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      app: "mex-hub",
      version: VERSION,
      homeId: bound.homeId,
      mode: "background",
    });
    return bound;
  }

  async function expectStopped(port: number): Promise<void> {
    expect(host.running).toBe(false);
    expect(readBound(writer)).toBeUndefined();
    await expect(hello(port)).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
  }

  it("starts for a future hub_until and stops after the idle grace period", async () => {
    const bound = await start();

    await host.tick(HUB_UNTIL, LEASE_END + IDLE_MS, IDLE_MS);
    expect(host.running).toBe(true);
    expect(readBound(writer)).toEqual(bound);

    await host.tick(HUB_UNTIL, LEASE_END + IDLE_MS + 1, IDLE_MS);
    await expectStopped(bound.port);
  });

  it("stops immediately when hub_until becomes null", async () => {
    const bound = await start();
    await host.tick(null, NOW + 1, IDLE_MS);
    await expectStopped(bound.port);
  });

  // Regression: stop() during an in-flight startup returns before the Hub binds and leaves it running.
  it("does not leave a Hub running when stop overlaps startup", async () => {
    const starting = host.tick(HUB_UNTIL, NOW, IDLE_MS);
    await Promise.all([starting, host.stop()]);

    expect(host.running).toBe(false);
    expect(readBound(writer)).toBeUndefined();
  });
});
