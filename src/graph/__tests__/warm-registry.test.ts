import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { rebuildGraph } from "../maintenance.js";
import { graphLocation, readGraphPointer } from "../storage.js";
import { readGraphState } from "../jobs.js";
import { verifyGraph } from "../verify.js";
import { WarmRegistry, type WarmHost } from "../warm-registry.js";
import type { WarmEditResult } from "../warm.js";

// The warm registry in the background process: cooling queues the cold
// refresh, an edit the warm path cannot take waits for quiet and then queues
// one, the memory cap closes the least recently edited checkout, and a
// repository whose full-rebuild check differed stays cold.

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeCheckout {
  closed = false;
  lastEditAt: number;
  constructor(private readonly clock: () => number, private readonly status: WarmEditResult["status"] = "published") { this.lastEditAt = clock(); }
  async edit(paths: string[]): Promise<WarmEditResult> {
    this.lastEditAt = this.clock();
    return { status: this.status, files: paths, ms: 1, phases: {}, ...(this.status === "cold" ? { reason: "test" } : {}) };
  }
  close(): void { this.closed = true; }
}

function host(clock: { now: number }, status: WarmEditResult["status"] = "published") {
  const refreshes: Array<[string, string]> = [];
  const opened: FakeCheckout[] = [];
  const value: WarmHost = {
    clock: () => clock.now,
    queueRefresh: (projectId, checkout) => refreshes.push([projectId, checkout]),
    open: () => {
      const checkout = new FakeCheckout(() => clock.now, status);
      opened.push(checkout);
      return checkout;
    },
  };
  return { value, refreshes, opened };
}

function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-warm-registry-"));
  roots.push(root);
  return root;
}

const settings = { capMb: 1024, coolMs: 15 * 60_000, quietMs: 2 * 60_000, probeMs: 60 * 60_000 };

describe("warm registry", () => {
  beforeEach(() => vi.stubEnv("MEX_GRAPH_STORAGE", "v5"));
  afterEach(() => vi.unstubAllEnvs());

  it("queues a normal refresh for v4 edits", async () => {
    vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
    const clock = { now: 1_000_000 };
    const { value, refreshes, opened } = host(clock);
    const registry = new WarmRegistry(value, settings);
    const root = emptyRoot();
    registry.note("p", root, ["a.ts"]);
    await registry.run();
    expect(opened).toEqual([]);
    clock.now += settings.quietMs;
    await registry.run();
    expect(refreshes).toEqual([["p", root]]);
  });
  it("cools a checkout after 15 minutes without an edit and queues its cold refresh after quiet", async () => {
    const clock = { now: 1_000_000 };
    const { value, refreshes, opened } = host(clock);
    const registry = new WarmRegistry(value, settings);
    const root = emptyRoot();
    registry.note("p", root, ["a.ts"]);
    await registry.run();
    expect(registry.warmCheckouts).toBe(1);
    clock.now += 14 * 60_000;
    await registry.run();
    expect(registry.warmCheckouts).toBe(1);
    clock.now += 2 * 60_000;
    await registry.run();
    expect(opened[0]!.closed).toBe(true);
    // Cooling at 16 minutes: the last edit is long quiet, so the refresh is queued at once.
    expect(refreshes).toEqual([["p", root]]);
  });

  it("queues a cold refresh for an edit the warm path cannot take, once edits are quiet", async () => {
    const clock = { now: 2_000_000 };
    const { value, refreshes } = host(clock, "cold");
    const registry = new WarmRegistry(value, settings);
    const root = emptyRoot();
    registry.note("p", root, ["a.ts"]);
    await registry.run();
    expect(registry.warmCheckouts).toBe(0);
    clock.now += 60_000;
    registry.note("p", root, ["a.ts"]);
    await registry.run();
    clock.now += 90_000;
    await registry.run();
    expect(refreshes).toEqual([]);
    clock.now += 60_000;
    await registry.run();
    expect(refreshes).toEqual([["p", root]]);
  });

  it("closes the least recently edited checkout over the memory cap", async () => {
    const clock = { now: 3_000_000 };
    const { value, opened } = host(clock);
    const registry = new WarmRegistry(value, { ...settings, capMb: 100 });
    const first = emptyRoot();
    const second = emptyRoot();
    registry.note("p", first, ["a.ts"]);
    await registry.run();
    clock.now += 1_000;
    registry.note("q", second, ["b.ts"]);
    registry.setServerRss(300);
    await registry.run();
    expect(opened[0]!.closed).toBe(true);
    expect(opened[1]!.closed).toBe(false);
    expect(registry.warmCheckouts).toBe(1);
  });

  it("turns the warm path off when a full rebuild differs, and keeps the repository cold", async () => {
    vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
    const root = emptyRoot();
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
    await rebuildGraph(root);
    const index = graphLocation(root).directory;
    expect((await verifyGraph(root)).status).toBe("match");
    expect(readGraphState(index)?.warm).toBe("on");
    const outcome = await verifyGraph(root, {
      afterBuild: (candidate) => {
        const db = openSqlite(candidate);
        try { db.prepare("UPDATE file_row_digests SET digest = 'forced' WHERE path = 'src/a.ts'").run(); } finally { db.close(); }
      },
    });
    expect(outcome).toMatchObject({ status: "differ", differing: ["src/a.ts"] });
    expect(readGraphState(index)).toMatchObject({ warm: "off", differing: ["src/a.ts"] });
    expect(readGraphPointer(graphLocation(root))).toBeTruthy();

    vi.stubEnv("MEX_GRAPH_STORAGE", undefined);
    const clock = { now: 4_000_000 };
    const { value, refreshes, opened } = host(clock);
    const registry = new WarmRegistry(value, settings);
    registry.note("p", root, ["src/a.ts"]);
    await registry.run();
    expect(opened).toEqual([]);
    clock.now += 3 * 60_000;
    await registry.run();
    expect(refreshes).toEqual([["p", root]]);
  }, 120_000);
});
